/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to localhost by default (use --host to override).
 * CORS is restricted to localhost, private/LAN networks, and the deployed site.
 */

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'crypto';
import { loadMeta, listRegisteredRepos, getStoragePath, getStoragePaths } from '../storage/repo-manager.js';
import {
  executeQuery,
  executePrepared,
  executeWithReusedStatement,
  closeLbug,
  withLbugDb,
} from '../core/lbug/lbug-adapter.js';
import { isWriteQuery, releaseAllForPath } from '../core/lbug/pool-adapter.js';
import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'gitnexus-shared';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { JobManager } from './analyze-job.js';
import { WikiJobManager } from './wiki-job.js';
import { extractRepoName, getCloneDir, cloneOrPull } from './git-clone.js';
import { prepareArchiveWorkspace, prepareGitWorkspace } from './import-workspace.js';
import {
  authenticateUser,
  createUser,
  deleteSession,
  getUserBySessionToken,
  initializeAuthStore,
  listUsers,
  type AuthUser,
  type AuthRole,
} from './auth-store.js';
import {
  deleteProductHistoryEntry,
  findProductHistoryEntry,
  listProductHistoryByUser,
  readProductHistory,
  type ProductHistoryEntry,
  upsertProductHistoryEntry,
} from './product-history.js';
import { runProductBuildWorkflow } from '../cli/product-build.js';
import { WikiGenerator } from '../core/wiki/generator.js';
import { resolveLLMConfig } from '../core/wiki/llm-client.js';
import { createEncryptedBundle, createWikiPassword } from './chinese-wiki.js';
import { initializePlatform, mountPlatformEndpoints } from './platform/index.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');

const getBearerToken = (req: express.Request): string | null => {
  const authHeader = req.get('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const getAuthenticatedUser = (req: express.Request): AuthUser | null => {
  const token = getBearerToken(req);
  if (!token) return null;
  return getUserBySessionToken(token);
};

const requireAuthenticatedUser = (req: express.Request, res: express.Response): AuthUser | null => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return user;
};

const requireAdminUser = (req: express.Request, res: express.Response): AuthUser | null => {
  const user = requireAuthenticatedUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return user;
};

/**
 * Run `runFullAnalysis` in a forked child process (analyze-worker.js).
 *
 * Forking is critical because LadybugDB's native module may hold an OS-level
 * file lock even after `await db.close()` returns, until the V8 garbage
 * collector finalises the native object. When analysis runs in-process the
 * lock can linger, blocking the subsequent `gitnexus wiki` open.
 * A child process exit unconditionally releases all OS file handles.
 */
async function runAnalyzeInWorker(
  repoPath: string,
  options: { force?: boolean; embeddings?: boolean; skipAgentsMd?: boolean },
  hooks: {
    onProgress?: (phase: string, percent: number, message: string) => void;
    onLog?: (...args: any[]) => void;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Resolve the worker entry point.
    // When running from the compiled dist/ tree the URL resolves to a real .js
    // file and we can fork it directly.  When running from source via tsx the
    // URL resolves to a .ts file that doesn't exist as .js, so we fork through
    // tsx instead, which handles TypeScript transparently.
    const workerJsPath = fileURLToPath(new URL('./analyze-worker.js', import.meta.url));
    const workerTsPath = fileURLToPath(new URL('./analyze-worker.ts', import.meta.url));

    // Detect source-mode vs compiled-mode: if the URL path contains '/src/'
    // we are running under tsx and must use the .ts file via tsx.
    const isSourceMode = workerJsPath.replace(/\\/g, '/').includes('/src/');
    // In source mode, load tsx's ESM hook via --import so the forked child can
    // execute TypeScript files.  The hook path must use the file:// scheme on
    // all platforms (required on Windows where drive letters are not valid URL
    // schemes for the Node ESM loader).
    const tsxLoaderUrl = new URL(
      './node_modules/tsx/dist/esm/index.mjs',
      // Resolve relative to the package root (two levels up from src/server/).
      new URL('../../', import.meta.url),
    ).href;
    const [workerPath, forkOptions]: [string, import('child_process').ForkOptions] = isSourceMode
      ? [
          workerTsPath,
          {
            execPath: process.execPath,
            execArgv: ['--max-old-space-size=8192', '--import', tsxLoaderUrl],
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          },
        ]
      : [
          workerJsPath,
          {
            execArgv: ['--max-old-space-size=8192'],
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          },
        ];

    const child = fork(workerPath, [], forkOptions);

    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    child.on('message', (msg: any) => {
      if (msg.type === 'progress') {
        if (msg.percent >= 0) {
          hooks.onProgress?.(msg.phase, msg.percent, msg.message);
        } else {
          hooks.onLog?.(msg.message);
        }
      } else if (msg.type === 'complete') {
        settle(resolve);
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.message ?? 'Analyze worker failed')));
      }
    });

    child.on('error', (err) => settle(() => reject(err)));
    child.on('exit', (code, signal) => {
      // Safety net in case the worker exits without sending complete/error.
      if (signal) {
        settle(() => reject(new Error(`Analyze worker killed by signal ${signal}`)));
      } else if (code !== 0 && code !== null) {
        settle(() => reject(new Error(`Analyze worker exited with code ${code}`)));
      } else {
        settle(resolve);
      }
    });

    child.send({ type: 'start', repoPath, options });
  });
}

/**
 * Determine whether an HTTP Origin header value is allowed by CORS policy.
 *
 * Permitted origins:
 * - No origin (non-browser requests such as curl or server-to-server calls)
 * - http://localhost:<port> — local development
 * - http://127.0.0.1:<port> — loopback alias
 * - RFC 1918 private/LAN networks (any port):
 *     10.0.0.0/8      → 10.x.x.x
 *     172.16.0.0/12   → 172.16.x.x – 172.31.x.x
 *     192.168.0.0/16  → 192.168.x.x
 * - https://gitnexus.vercel.app — the deployed GitNexus web UI
 *
 * @param origin - The value of the HTTP `Origin` request header, or `undefined`
 *                 when the header is absent (non-browser request).
 * @returns `true` if the origin is allowed, `false` otherwise.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    // Non-browser requests (curl, server-to-server) have no Origin header
    return true;
  }

  if (
    origin.startsWith('http://localhost:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://[::1]:') ||
    origin === 'http://[::1]' ||
    origin === 'https://gitnexus.vercel.app'
  ) {
    return true;
  }

  // RFC 1918 private network ranges — allow any port on these hosts.
  // We parse the hostname out of the origin URL and check against each range.
  let hostname: string;
  let protocol: string;
  try {
    const parsed = new URL(origin);
    hostname = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    // Malformed origin — reject
    return false;
  }

  // Only allow HTTP(S) origins — reject ftp://, file://, etc.
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }

  const [a, b] = octets;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12  →  172.16.x.x – 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
};

const buildGraph = async (
  includeContent = false,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = includeContent
          ? `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
          : `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = includeContent
          ? `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
          : `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: includeContent ? row.content : undefined,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`,
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships };
};

/**
 * Mount an SSE progress endpoint for a JobManager.
 * Handles: initial state, terminal events, heartbeat, event IDs, client disconnect.
 */
const mountSSEProgress = (app: express.Express, routePath: string, jm: JobManager) => {
  app.get(routePath, (req, res) => {
    const job = jm.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, send event and close
    if (job.status === 'complete' || job.status === 'failed') {
      eventId++;
      res.write(
        `id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
          repoName: job.repoName,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Heartbeat to detect zombie connections
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    // Subscribe to progress updates
    const unsubscribe = jm.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const eventJob = jm.getJob(req.params.jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              repoName: eventJob?.repoName,
              error: eventJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};

const statusFromError = (err: any): number => {
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  initializeAuthStore();
  const app = express();
  app.disable('x-powered-by');

  // CORS: allow localhost, private/LAN networks, and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  // Disallowed origins get the response without Access-Control-Allow-Origin,
  // so the browser blocks it. We pass `false` instead of throwing an Error to
  // avoid crashing into Express's default error handler (which returned 500).
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // Initialize and mount the GitNexus Platform (PostgreSQL, JWT auth, project CRUD, queue)
  if (process.env.DATABASE_URL) {
    try {
      await initializePlatform();
      mountPlatformEndpoints(app);
      console.log('[server] Platform routes mounted at /api/platform');
    } catch (err) {
      console.warn('[server] Platform initialization failed (PostgreSQL may not be available):', err);
      console.warn('[server] Continuing without platform routes — original API still works');
    }
  }

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);
  const jobManager = new JobManager();
  const wikiJobManager = new WikiJobManager();

  // Shared repo lock — prevents concurrent analyze + embed on the same repo path,
  // which would corrupt LadybugDB (analyze calls closeLbug + initLbug while embed has queries in flight).
  const activeRepoPaths = new Set<string>();

  const acquireRepoLock = (repoPath: string): string | null => {
    if (activeRepoPaths.has(repoPath)) {
      return `Another job is already active for this repository`;
    }
    activeRepoPaths.add(repoPath);
    return null;
  };

  const releaseRepoLock = (repoPath: string): void => {
    activeRepoPaths.delete(repoPath);
  };

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find((r) => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // SSE heartbeat — clients connect to detect server liveness instantly.
  // When the server shuts down, the TCP connection drops and the client's
  // EventSource fires onerror immediately (no polling delay).
  app.get('/api/heartbeat', (_req, res) => {
    // Use res.set() instead of res.writeHead() to preserve CORS headers from middleware
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    // Send initial ping so the client knows it connected
    res.write(':ok\n\n');

    // Keep-alive ping every 15s to prevent proxy/firewall timeout
    const interval = setInterval(() => res.write(':ping\n\n'), 15_000);

    _req.on('close', () => clearInterval(interval));
  });

  // Server info: version and launch context (npx / global / local dev)
  app.get('/api/info', (_req, res) => {
    const execPath = process.env.npm_execpath ?? '';
    const argv0 = process.argv[1] ?? '';
    let launchContext: 'npx' | 'global' | 'local';
    if (
      execPath.includes('npx') ||
      argv0.includes('_npx') ||
      process.env.npm_config_prefix?.includes('_npx')
    ) {
      launchContext = 'npx';
    } else if (argv0.includes('node_modules')) {
      launchContext = 'local';
    } else {
      launchContext = 'global';
    }
    res.json({ version: pkg.version, launchContext, nodeVersion: process.version });
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!username || !password) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
      }

      const result = authenticateUser(username, password);
      if (!result) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Login failed' });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const user = requireAuthenticatedUser(req, res);
    if (!user) return;
    res.json({ user });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = getBearerToken(req);
    if (token) {
      deleteSession(token);
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/users', (req, res) => {
    const user = requireAdminUser(req, res);
    if (!user) return;
    res.json({ users: listUsers() });
  });

  app.post('/api/auth/users', (req, res) => {
    const user = requireAdminUser(req, res);
    if (!user) return;

    try {
      const created = createUser({
        username: typeof req.body?.username === 'string' ? req.body.username : '',
        password: typeof req.body?.password === 'string' ? req.body.password : '',
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : undefined,
        role: (req.body?.role === 'admin' ? 'admin' : 'user') as AuthRole,
      });
      res.status(201).json({ user: created });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create user' });
    }
  });

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(
        repos.map((r) => ({
          name: r.name,
          path: r.path,
          indexedAt: r.indexedAt,
          lastCommit: r.lastCommit,
          stats: r.stats,
        })),
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list repos' });
    }
  });

  app.post(
    '/api/product/import/archive',
    express.raw({ type: '*/*', limit: '512mb' }),
    async (req, res) => {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      try {
        const filename =
          typeof req.query.filename === 'string' && req.query.filename.trim()
            ? req.query.filename.trim()
            : 'uploaded-repository.zip';

        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: 'Request body must contain an archive file (.zip, .tar.gz, .tgz, .tar.bz2, .tar.xz)' });
          return;
        }

        const imported = await prepareArchiveWorkspace(req.body, filename);
        res.json(imported);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to import archive' });
      }
    },
  );

  app.post('/api/product/import/repository', async (req, res) => {
    const user = requireAuthenticatedUser(req, res);
    if (!user) return;
    try {
      const repoName =
        typeof req.body?.repoName === 'string' ? String(req.body.repoName).trim() : '';
      const branch = typeof req.body?.branch === 'string' ? String(req.body.branch).trim() : '';

      if (!repoName || !branch) {
        res.status(400).json({ error: 'Both "repoName" and "branch" are required' });
        return;
      }

      const imported = await prepareGitWorkspace(repoName, branch);
      res.json(imported);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to import repository' });
    }
  });

  app.get('/api/product/history', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      const includeAll = req.query.scope === 'all' && user.role === 'admin';
      const history = includeAll ? await readProductHistory() : await listProductHistoryByUser(user.id);
      res.json({ history });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load product history' });
    }
  });

  app.delete('/api/product/history/:entryId', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      const entryId = req.params.entryId;
      const deleted = await deleteProductHistoryEntry(entryId, user.id, user.role === 'admin');
      if (!deleted) {
        res.status(404).json({ error: 'Entry not found or not authorised' });
        return;
      }

      // Best-effort cleanup of local files
      const pathsToRemove: string[] = [];
      if (deleted.repoPath) pathsToRemove.push(deleted.repoPath);
      if (deleted.wikiDir) pathsToRemove.push(deleted.wikiDir);
      if (deleted.previousVersions) {
        for (const ver of deleted.previousVersions) {
          if (ver.repoPath) pathsToRemove.push(ver.repoPath);
          if (ver.wikiDir) pathsToRemove.push(ver.wikiDir);
        }
      }
      await Promise.all(
        pathsToRemove.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {})),
      );

      res.json({ ok: true, deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete history entry' });
    }
  });

  app.post('/api/product/wiki', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      const repoName = typeof req.body?.repoName === 'string' ? String(req.body.repoName).trim() : '';
      const repoPath = typeof req.body?.repoPath === 'string' ? String(req.body.repoPath).trim() : '';
      const sourceLabel =
        typeof req.body?.sourceLabel === 'string' ? String(req.body.sourceLabel).trim() : repoName;
      const branch = typeof req.body?.branch === 'string' ? String(req.body.branch).trim() : undefined;
      const normalizedSourceType: ProductHistoryEntry['sourceType'] =
        req.body?.sourceType === 'archive' ? 'archive' : 'git';
      const llmModel = typeof req.body?.model === 'string' ? String(req.body.model).trim() : undefined;
      const llmBaseUrl = typeof req.body?.baseUrl === 'string' ? String(req.body.baseUrl).trim() : undefined;
      const llmApiKey = typeof req.body?.apiKey === 'string' ? String(req.body.apiKey).trim() : undefined;

      if (!repoName || !repoPath) {
        res.status(400).json({ error: 'Both "repoName" and "repoPath" are required' });
        return;
      }

      const mcpEndpoint = `${req.protocol}://${req.get('host')}/api/mcp`;
      const repoLockKey = getStoragePath(repoPath);
      const lockErr = acquireRepoLock(repoLockKey);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      try {
        console.log(
          `[wiki] workflow=cli-direct cwd=${repoPath} command=gitnexus wiki -f`,
        );
        const { storagePath, lbugPath } = getStoragePaths(repoPath);
        const llmConfig = await resolveLLMConfig({
          ...(llmModel && { model: llmModel }),
          ...(llmBaseUrl && { baseUrl: llmBaseUrl }),
          ...(llmApiKey && { apiKey: llmApiKey }),
        });
        console.log(`[wiki] model=${llmConfig.model} baseUrl=${llmConfig.baseUrl}`);
        const generator = new WikiGenerator(repoPath, storagePath, lbugPath, llmConfig, { force: true });
        await generator.run();

        const wikiDir = path.join(storagePath, 'wiki');

        // Generate index.md linking all wiki pages
        const wikiFiles = (await fs.readdir(wikiDir).catch(() => [] as string[])).filter(
          (f) => f.endsWith('.md') && f !== 'index.md',
        );
        const indexContent = [
          `# ${repoName} Wiki Index`,
          '',
          wikiFiles.map((f) => `- [${f.replace(/\.md$/, '')}](./${f})`).join('\n'),
          '',
        ].join('\n');
        await fs.writeFile(path.join(wikiDir, 'index.md'), indexContent, 'utf-8');

        const wikiPassword = createWikiPassword();
        const wikiBundlePath = await createEncryptedBundle(wikiDir, repoName, wikiPassword);

        const meta = await loadMeta(storagePath);

        const historyEntry: ProductHistoryEntry = {
          id: randomUUID(),
          userId: user.id,
          userName: user.displayName,
          repoName,
          repoPath,
          sourceType: normalizedSourceType,
          sourceLabel,
          branch,
          importedAt: new Date().toISOString(),
          wikiDir,
          wikiBundlePath,
          wikiPassword,
          mcpEndpoint,
          mcpRepoName: repoName,
          stats: meta?.stats,
        };

        await upsertProductHistoryEntry(historyEntry);
        res.json({ entry: historyEntry });
      } finally {
        releaseRepoLock(repoLockKey);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate Chinese wiki' });
    }
  });

  // ── Async wiki generation job ────────────────────────────────────────────

  app.post('/api/product/wiki/async', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;

      const repoName = typeof req.body?.repoName === 'string' ? String(req.body.repoName).trim() : '';
      const repoPath = typeof req.body?.repoPath === 'string' ? String(req.body.repoPath).trim() : '';
      const sourceLabel =
        typeof req.body?.sourceLabel === 'string' ? String(req.body.sourceLabel).trim() : repoName;
      const branch = typeof req.body?.branch === 'string' ? String(req.body.branch).trim() : undefined;
      const normalizedSourceType: ProductHistoryEntry['sourceType'] =
        req.body?.sourceType === 'archive' ? 'archive' : 'git';
      const llmModel = typeof req.body?.model === 'string' ? String(req.body.model).trim() : undefined;
      const llmBaseUrl = typeof req.body?.baseUrl === 'string' ? String(req.body.baseUrl).trim() : undefined;
      const llmApiKey = typeof req.body?.apiKey === 'string' ? String(req.body.apiKey).trim() : undefined;

      if (!repoName || !repoPath) {
        res.status(400).json({ error: 'Both "repoName" and "repoPath" are required' });
        return;
      }

      const mcpEndpoint = `${req.protocol}://${req.get('host')}/api/mcp`;

      // Create a preliminary history entry so the project appears in history immediately
      // (before wiki generation completes). Will be updated by upsertProductHistoryEntry
      // at the end of the wiki job with full wiki data.
      try {
        const { storagePath: prelimStoragePath } = getStoragePaths(repoPath);
        const prelimMeta = await loadMeta(prelimStoragePath);
        const prelimEntry: ProductHistoryEntry = {
          id: randomUUID(),
          userId: user.id,
          userName: user.displayName,
          repoName,
          repoPath,
          sourceType: normalizedSourceType,
          sourceLabel,
          branch,
          importedAt: new Date().toISOString(),
          mcpEndpoint,
          mcpRepoName: repoName,
          stats: prelimMeta?.stats,
        };
        await upsertProductHistoryEntry(prelimEntry);
      } catch {
        // Best-effort — don't block wiki job if preliminary upsert fails
      }

      const job = wikiJobManager.createJob({ repoName, repoPath });
      res.json({ jobId: job.id });

      // Run wiki generation asynchronously (do NOT await)
      void (async () => {
        const repoLockKey = getStoragePath(repoPath);
        const lockErr = acquireRepoLock(repoLockKey);
        if (lockErr) {
          wikiJobManager.updateJob(job.id, {
            status: 'failed',
            error: lockErr,
          });
          return;
        }

        try {
          wikiJobManager.updateJob(job.id, {
            status: 'running',
            progress: { phase: 'init', percent: 2, message: '连接知识图谱...' },
          });

          const { storagePath, lbugPath } = getStoragePaths(repoPath);
          const llmConfig = await resolveLLMConfig({
            ...(llmModel && { model: llmModel }),
            ...(llmBaseUrl && { baseUrl: llmBaseUrl }),
            ...(llmApiKey && { apiKey: llmApiKey }),
          });

          console.log(
            `[wiki-async:${job.id}] workflow=cli-direct cwd=${repoPath} command=gitnexus wiki --force --model ${llmConfig.model} --base-url ${llmConfig.baseUrl}`,
          );
          console.log(`[wiki-async:${job.id}] model=${llmConfig.model} baseUrl=${llmConfig.baseUrl}`);

          const WIKI_LOCK_MAX_ATTEMPTS = 5;
          const WIKI_LOCK_RETRY_DELAY_MS = 10_000;
          let wikiAttempt = 0;
          let lastWikiError: Error | null = null;
          let lastWikiLogPercent = -1;
          while (wikiAttempt < WIKI_LOCK_MAX_ATTEMPTS) {
            try {
              const generator = new WikiGenerator(repoPath, storagePath, lbugPath, llmConfig, {
                force: true,
              }, (phase: string, percent: number, message: string) => {
                // Only log when percent actually changes to avoid noisy streaming updates
                if (percent !== lastWikiLogPercent) {
                  lastWikiLogPercent = percent;
                  console.log(
                    `[wiki-async:${job.id}] step="${message}" percent=${percent}`,
                  );
                }
                wikiJobManager.updateJob(job.id, {
                  progress: { phase, percent, message },
                });
              });
              await generator.run();
              lastWikiError = null;
              break;
            } catch (wikiErr: any) {
              lastWikiError = wikiErr instanceof Error ? wikiErr : new Error(String(wikiErr));
              const isLockErr =
                lastWikiError.message.includes('Could not set lock') ||
                lastWikiError.message.includes('LadybugDB unavailable') ||
                lastWikiError.message.includes('IO exception');
              wikiAttempt++;
              if (!isLockErr || wikiAttempt >= WIKI_LOCK_MAX_ATTEMPTS) break;
              console.warn(
                `[wiki-async:${job.id}] lock conflict on attempt ${wikiAttempt}, retrying in ${WIKI_LOCK_RETRY_DELAY_MS / 1000}s...`,
              );
              // Force-close any stale pool connections to this lbugPath so the
              // next open attempt gets a clean file handle (avoids re-locking on stale DB).
              releaseAllForPath(lbugPath);
              wikiJobManager.updateJob(job.id, {
                progress: {
                  phase: 'waiting',
                  percent: 2,
                  message: `等待资源释放，第 ${wikiAttempt} 次重试...`,
                },
              });
              await new Promise<void>((r) => setTimeout(r, WIKI_LOCK_RETRY_DELAY_MS));
            }
          }
          if (lastWikiError) throw lastWikiError;

          console.log(`[wiki-async:${job.id}] step="打包加密文档" percent=95`);
          wikiJobManager.updateJob(job.id, {
            progress: { phase: 'packaging', percent: 95, message: '打包加密文档...' },
          });

          const wikiDir = path.join(storagePath, 'wiki');

          // Generate index.md
          const wikiFiles = (await fs.readdir(wikiDir).catch(() => [] as string[])).filter(
            (f) => f.endsWith('.md') && f !== 'index.md',
          );
          const indexContent = [
            `# ${repoName} Wiki Index`,
            '',
            wikiFiles.map((f) => `- [${f.replace(/\.md$/, '')}](./${f})`).join('\n'),
            '',
          ].join('\n');
          await fs.writeFile(path.join(wikiDir, 'index.md'), indexContent, 'utf-8');

          const wikiPassword = createWikiPassword();
          const wikiBundlePath = await createEncryptedBundle(wikiDir, repoName, wikiPassword);
          const meta = await loadMeta(storagePath);

          const historyEntry: ProductHistoryEntry = {
            id: randomUUID(),
            userId: user.id,
            userName: user.displayName,
            repoName,
            repoPath,
            sourceType: normalizedSourceType,
            sourceLabel,
            branch,
            importedAt: new Date().toISOString(),
            wikiDir,
            wikiBundlePath,
            wikiPassword,
            mcpEndpoint,
            mcpRepoName: repoName,
            stats: meta?.stats,
          };

          await upsertProductHistoryEntry(historyEntry);

          console.log(`[wiki-async:${job.id}] completed successfully`);
          wikiJobManager.updateJob(job.id, {
            status: 'complete',
            entry: historyEntry as unknown as Record<string, unknown>,
          });
        } catch (err: any) {
          console.error(`[wiki-async:${job.id}] failed:`, err);
          wikiJobManager.updateJob(job.id, {
            status: 'failed',
            error: err?.message ?? 'Wiki generation failed',
          });
        } finally {
          releaseRepoLock(repoLockKey);
        }
      })();
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to start wiki job' });
    }
  });

  app.get('/api/product/wiki/jobs/:jobId/progress', (req, res) => {
    const job = wikiJobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Wiki job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current progress immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, emit final event and close
    if (wikiJobManager.isTerminal(job.status)) {
      eventId++;
      const eventName = job.status === 'complete' ? 'complete' : 'failed';
      res.write(
        `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify({
          entry: job.entry,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    const unsubscribe = wikiJobManager.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const latestJob = wikiJobManager.getJob(req.params.jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              entry: latestJob?.entry,
              error: latestJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/product/history/:entryId/wiki', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      const entry = await findProductHistoryEntry(req.params.entryId);
      const canAccess = !!entry && (user.role === 'admin' || entry.userId === user.id);
      if (!canAccess || !entry) {
        res.status(404).json({ error: 'History entry not found' });
        return;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${entry.repoName}-wiki.zip"`,
      );
      res.sendFile(entry.wikiBundlePath);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to download wiki bundle' });
    }
  });

  // Wiki online preview: returns all markdown pages as a JSON object { pages, repoName }
  app.get('/api/product/history/:entryId/wiki/preview', async (req, res) => {
    try {
      const user = requireAuthenticatedUser(req, res);
      if (!user) return;
      const entry = await findProductHistoryEntry(req.params.entryId);
      const canAccess = !!entry && (user.role === 'admin' || entry.userId === user.id);
      if (!canAccess || !entry) {
        res.status(404).json({ error: 'History entry not found' });
        return;
      }

      if (!entry.wikiDir) {
        res.status(404).json({ error: 'Wiki not generated yet' });
        return;
      }

      let files: string[] = [];
      try {
        const { readdir, readFile: fsReadFile } = await import('fs/promises');
        files = await readdir(entry.wikiDir);
        const pages: Record<string, string> = {};
        for (const file of files.filter((f) => f.endsWith('.md'))) {
          const content = await fsReadFile(`${entry.wikiDir}/${file}`, 'utf-8');
          pages[file.replace(/\.md$/, '')] = content;
        }
        res.json({ repoName: entry.repoName, pages });
      } catch {
        res.status(404).json({ error: 'Wiki files not found' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load wiki preview' });
    }
  });

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get repo info' });
    }
  });

  // Delete a repo — removes index, clone dir (if any), and unregisters it
  app.delete('/api/repo', async (req, res) => {
    try {
      const repoName = requestedRepo(req);
      if (!repoName) {
        res.status(400).json({ error: 'Missing repo name' });
        return;
      }
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Acquire repo lock — prevents deleting while analyze/embed is in flight
      const lockKey = getStoragePath(entry.path);
      const lockErr = acquireRepoLock(lockKey);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      try {
        // Close any open LadybugDB handle before deleting files
        try {
          await closeLbug();
        } catch {}

        // 1. Delete the .gitnexus index/storage directory
        const storagePath = getStoragePath(entry.path);
        await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});

        // 2. Delete the cloned repo dir if it lives under ~/.gitnexus/repos/
        const cloneDir = getCloneDir(entry.name);
        try {
          const stat = await fs.stat(cloneDir);
          if (stat.isDirectory()) {
            await fs.rm(cloneDir, { recursive: true, force: true });
          }
        } catch {
          /* clone dir may not exist (local repos) */
        }

        // 3. Unregister from the global registry
        const { unregisterRepo } = await import('../storage/repo-manager.js');
        await unregisterRepo(entry.path);

        // 4. Reinitialize backend to reflect the removal
        await backend.init().catch(() => {});

        res.json({ deleted: entry.name });
      } finally {
        releaseRepoLock(lockKey);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete repo' });
    }
  });

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const includeContent = req.query.includeContent === 'true';
      const graph = await withLbugDb(lbugPath, async () => buildGraph(includeContent));
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      if (isWriteQuery(cypher)) {
        res.status(403).json({ error: 'Write queries are not allowed via the HTTP API' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search (supports mode: 'hybrid' | 'semantic' | 'bm25', and optional enrichment)
  app.post('/api/search', async (req, res) => {
    try {
      const query = (req.body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;
      const mode: string = req.body.mode ?? 'hybrid';
      const enrich: boolean = req.body.enrich !== false; // default true

      const results = await withLbugDb(lbugPath, async () => {
        let searchResults: any[];

        if (mode === 'semantic') {
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (!isEmbedderReady()) {
            return [] as any[];
          }
          const { semanticSearch: semSearch } =
            await import('../core/embeddings/embedding-pipeline.js');
          searchResults = await semSearch(executeQuery, query, limit);
          // Normalize semantic results to HybridSearchResult shape
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            score: r.score ?? 1 - (r.distance ?? 0),
            rank: i + 1,
            sources: ['semantic'],
          }));
        } else if (mode === 'bm25') {
          searchResults = await searchFTSFromLbug(query, limit);
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            rank: i + 1,
            sources: ['bm25'],
          }));
        } else {
          // hybrid (default)
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (isEmbedderReady()) {
            const { semanticSearch: semSearch } =
              await import('../core/embeddings/embedding-pipeline.js');
            searchResults = await hybridSearch(query, limit, executeQuery, semSearch);
          } else {
            searchResults = await searchFTSFromLbug(query, limit);
          }
        }

        if (!enrich) return searchResults;

        // Server-side enrichment: add connections, cluster, processes per result
        // Uses parameterized queries to prevent Cypher injection via nodeId
        const validLabel = (label: string): boolean =>
          (NODE_TABLES as readonly string[]).includes(label);

        const enriched = await Promise.all(
          searchResults.slice(0, limit).map(async (r: any) => {
            const nodeId: string = r.nodeId || r.id || '';
            const nodeLabel = nodeId.split(':')[0];
            const enrichment: { connections?: any; cluster?: string; processes?: any[] } = {};

            if (!nodeId || !validLabel(nodeLabel)) return { ...r, ...enrichment };

            // Run connections, cluster, and process queries in parallel
            // Label is validated against NODE_TABLES (compile-time safe identifiers);
            // nodeId uses $nid parameter binding to prevent injection
            const [connRes, clusterRes, procRes] = await Promise.all([
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label, c.description AS description
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[rel:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, rel.step AS step, p.stepCount AS stepCount
              ORDER BY rel.step
            `,
                { nid: nodeId },
              ).catch(() => []),
            ]);

            if (connRes.length > 0) {
              const row = connRes[0];
              const outgoing = (Array.isArray(row) ? row[0] : row.outgoing || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              const incoming = (Array.isArray(row) ? row[1] : row.incoming || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              enrichment.connections = { outgoing, incoming };
            }

            if (clusterRes.length > 0) {
              const row = clusterRes[0];
              enrichment.cluster = Array.isArray(row) ? row[0] : row.label;
            }

            if (procRes.length > 0) {
              enrichment.processes = procRes
                .map((row: any) => ({
                  id: Array.isArray(row) ? row[0] : row.id,
                  label: Array.isArray(row) ? row[1] : row.label,
                  step: Array.isArray(row) ? row[2] : row.step,
                  stepCount: Array.isArray(row) ? row[3] : row.stepCount,
                }))
                .filter((p: any) => p.id && p.label);
            }

            return { ...r, ...enrichment };
          }),
        );

        return enriched;
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const raw = await fs.readFile(fullPath, 'utf-8');

      // Optional line-range support: ?startLine=10&endLine=50
      // Returns only the requested slice (0-indexed), plus metadata.
      const startLine = req.query.startLine !== undefined ? Number(req.query.startLine) : undefined;
      const endLine = req.query.endLine !== undefined ? Number(req.query.endLine) : undefined;

      if (startLine !== undefined && Number.isFinite(startLine)) {
        const lines = raw.split('\n');
        const start = Math.max(0, startLine);
        const end =
          endLine !== undefined && Number.isFinite(endLine)
            ? Math.min(lines.length, endLine + 1)
            : lines.length;
        res.json({
          content: lines.slice(start, end).join('\n'),
          startLine: start,
          endLine: end - 1,
          totalLines: lines.length,
        });
      } else {
        res.json({ content: raw, totalLines: raw.split('\n').length });
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // Grep — regex search across file contents in the indexed repo
  // Uses filesystem-based search for memory efficiency (never loads all files into memory)
  app.get('/api/grep', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const pattern = req.query.pattern as string;
      if (!pattern) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }

      // ReDoS protection: reject overly long or dangerous patterns
      if (pattern.length > 200) {
        res.status(400).json({ error: 'Pattern too long (max 200 characters)' });
        return;
      }

      // Validate regex syntax
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gim');
      } catch {
        res.status(400).json({ error: 'Invalid regex pattern' });
        return;
      }

      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
        : 50;

      const results: { filePath: string; line: number; text: string }[] = [];
      const repoRoot = path.resolve(entry.path);

      // Get file paths from the graph (lightweight — no content loaded)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const fileRows = await withLbugDb(lbugPath, () =>
        executeQuery(`MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath`),
      );

      // Search files on disk one at a time (constant memory)
      for (const row of fileRows) {
        if (results.length >= limit) break;
        const filePath: string = row.filePath || '';
        const fullPath = path.resolve(repoRoot, filePath);

        // Path traversal guard
        if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) continue;

        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue; // File may have been deleted since indexing
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (regex.test(lines[i])) {
            results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
          regex.lastIndex = 0;
        }
      }

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Grep failed' });
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryProcessDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query process detail' });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryClusterDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // ── Analyze API ──────────────────────────────────────────────────────

  // POST /api/analyze — start a new analysis job
  app.post('/api/analyze', async (req, res) => {
    try {
      const { url: repoUrl, path: repoLocalPath, force, embeddings } = req.body;

      // Input type validation
      if (repoUrl !== undefined && typeof repoUrl !== 'string') {
        res.status(400).json({ error: '"url" must be a string' });
        return;
      }
      if (repoLocalPath !== undefined && typeof repoLocalPath !== 'string') {
        res.status(400).json({ error: '"path" must be a string' });
        return;
      }

      if (!repoUrl && !repoLocalPath) {
        res.status(400).json({ error: 'Provide "url" (git URL) or "path" (local path)' });
        return;
      }

      // Path validation: require absolute path, reject traversal (e.g. /tmp/../etc/passwd)
      if (repoLocalPath) {
        if (!path.isAbsolute(repoLocalPath)) {
          res.status(400).json({ error: '"path" must be an absolute path' });
          return;
        }
        if (path.normalize(repoLocalPath) !== path.resolve(repoLocalPath)) {
          res.status(400).json({ error: '"path" must not contain traversal sequences' });
          return;
        }
      }

      const job = jobManager.createJob({ repoUrl, repoPath: repoLocalPath });
      console.log(
        `[product-analyze] queued job=${job.id} repoUrl=${repoUrl ?? ''} repoPath=${repoLocalPath ?? ''} force=${!!force} embeddings=${!!embeddings}`,
      );

      // If job was already running (dedup), just return its id
      if (job.status !== 'queued') {
        res.status(202).json({ jobId: job.id, status: job.status });
        return;
      }

      // Mark as active synchronously to prevent race with concurrent requests
      jobManager.updateJob(job.id, { status: 'cloning' });

      // Start async work — don't await
      (async () => {
        let targetPath = repoLocalPath;
        let lastAnalyzePhaseLog = '';
        let lastAnalyzePercent = 10;
        try {
          // Clone if URL provided
          if (repoUrl && !repoLocalPath) {
            const repoName = extractRepoName(repoUrl);
            targetPath = getCloneDir(repoName);

            jobManager.updateJob(job.id, {
              status: 'cloning',
              repoName,
              progress: { phase: 'cloning', percent: 0, message: `Cloning ${repoUrl}...` },
            });

            await cloneOrPull(repoUrl, targetPath, (progress) => {
              jobManager.updateJob(job.id, {
                progress: { phase: progress.phase, percent: 5, message: progress.message },
              });
            });
          }

          if (!targetPath) {
            throw new Error('No target path resolved');
          }

          // Acquire shared repo lock (keyed on storagePath to match embed handler)
          const analyzeLockKey = getStoragePath(targetPath);
          const lockErr = acquireRepoLock(analyzeLockKey);
          if (lockErr) {
            jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
            return;
          }

          jobManager.updateJob(job.id, {
            repoPath: targetPath,
            status: 'analyzing',
            progress: { phase: 'analyzing', percent: 10, message: '解析中' },
          });

          console.log(
            `[product-analyze] workflow=cli-direct cwd=${targetPath} command=gitnexus analyze --force --skip-agents-md${
              embeddings ? ' --embeddings' : ''
            }`,
          );
          await runAnalyzeInWorker(
            targetPath,
            {
              force: true,
              embeddings,
              skipAgentsMd: true,
            },
            {
              onProgress: (phase, percent, rawMessage) => {
                lastAnalyzePercent = percent;
                const progressPhase =
                  percent >= 98
                    ? 'done'
                    : percent >= 85
                      ? 'loading'
                      : percent >= 20
                        ? 'parsing'
                        : 'analyzing';
                const progressMessage =
                  progressPhase === 'done'
                    ? '解析完成'
                    : progressPhase === 'loading'
                      ? '构建服务'
                      : '解析中';
                const phaseLogSignature = `${phase}:${rawMessage}`;
                if (phaseLogSignature !== lastAnalyzePhaseLog) {
                  lastAnalyzePhaseLog = phaseLogSignature;
                  console.log(
                    `[product-analyze] job=${job.id} step="${rawMessage}" percent=${percent}`,
                  );
                }
                jobManager.updateJob(job.id, {
                  status: 'analyzing',
                  progress: {
                    phase: progressPhase,
                    percent,
                    message: progressMessage,
                  },
                });
              },
              onLog: (...args: any[]) => {
                const text = args
                  .map((arg) => (typeof arg === 'string' ? arg : String(arg)))
                  .join(' ')
                  .trim();
                if (/Worker pool parsing switched to sequential fallback:/i.test(text)) {
                  console.log(`[product-analyze] job=${job.id} fallback=sequential detail="${text}"`);
                  jobManager.updateJob(job.id, {
                    status: 'analyzing',
                    progress: {
                      phase: 'parsing',
                      percent: lastAnalyzePercent,
                      message: '解析中（串行降级）',
                    },
                  });
                  return;
                }
                console.log('[product-analyze][cli]', ...args);
              },
            },
          );

          console.log(`[product-analyze] job=${job.id} CLI workflow completed successfully`);
          await backend.init().catch((e: any) => {
            console.warn(`[product-analyze] backend.init() failed (non-fatal): ${e?.message}`);
          });
          releaseRepoLock(analyzeLockKey);
          jobManager.updateJob(job.id, {
            status: 'complete',
            repoName: path.basename(targetPath),
            progress: { phase: 'done', percent: 100, message: '解析完成' },
          });
        } catch (err: any) {
          if (targetPath) releaseRepoLock(getStoragePath(targetPath));
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: err.message || 'Analysis failed',
          });
        }
      })();

      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err: any) {
      if (err.message?.includes('already in progress')) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || 'Failed to start analysis' });
      }
    }
  });

  // GET /api/analyze/:jobId — poll job status
  app.get('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoUrl: job.repoUrl,
      repoPath: job.repoPath,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/analyze/:jobId/progress — SSE stream (shared helper)
  mountSSEProgress(app, '/api/analyze/:jobId/progress', jobManager);

  // DELETE /api/analyze/:jobId — cancel a running analysis job
  app.delete('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    jobManager.cancelJob(req.params.jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // ── Embedding endpoints ────────────────────────────────────────────

  const embedJobManager = new JobManager();

  // POST /api/embed — trigger server-side embedding generation
  app.post('/api/embed', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Check shared repo lock — prevent concurrent analyze + embed on same repo
      const repoLockPath = entry.storagePath;
      const lockErr = acquireRepoLock(repoLockPath);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      const job = embedJobManager.createJob({ repoPath: entry.storagePath });
      embedJobManager.updateJob(job.id, {
        repoName: entry.name,
        status: 'analyzing' as any,
        progress: { phase: 'analyzing', percent: 0, message: 'Starting embedding generation...' },
      });

      // 30-minute timeout for embedding jobs (same as analyze jobs)
      const EMBED_TIMEOUT_MS = 30 * 60 * 1000;
      const embedTimeout = setTimeout(() => {
        const current = embedJobManager.getJob(job.id);
        if (current && current.status !== 'complete' && current.status !== 'failed') {
          releaseRepoLock(repoLockPath);
          embedJobManager.updateJob(job.id, {
            status: 'failed',
            error: 'Embedding timed out (30 minute limit)',
          });
        }
      }, EMBED_TIMEOUT_MS);

      // Run embedding pipeline asynchronously
      (async () => {
        try {
          const lbugPath = path.join(entry.storagePath, 'lbug');
          await withLbugDb(lbugPath, async () => {
            const { runEmbeddingPipeline } =
              await import('../core/embeddings/embedding-pipeline.js');
            await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, (p) => {
              embedJobManager.updateJob(job.id, {
                progress: {
                  phase:
                    p.phase === 'ready' ? 'complete' : p.phase === 'error' ? 'failed' : p.phase,
                  percent: p.percent,
                  message:
                    p.phase === 'loading-model'
                      ? 'Loading embedding model...'
                      : p.phase === 'embedding'
                        ? `Embedding nodes (${p.percent}%)...`
                        : p.phase === 'indexing'
                          ? 'Creating vector index...'
                          : p.phase === 'ready'
                            ? 'Embeddings complete'
                            : `${p.phase} (${p.percent}%)`,
                },
              });
            });
          });

          clearTimeout(embedTimeout);
          releaseRepoLock(repoLockPath);
          // Don't overwrite 'failed' if the job was cancelled while the pipeline was running
          const current = embedJobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            embedJobManager.updateJob(job.id, { status: 'complete' });
          }
        } catch (err: any) {
          clearTimeout(embedTimeout);
          releaseRepoLock(repoLockPath);
          const current = embedJobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            embedJobManager.updateJob(job.id, {
              status: 'failed',
              error: err.message || 'Embedding generation failed',
            });
          }
        }
      })();

      res.status(202).json({ jobId: job.id, status: 'analyzing' });
    } catch (err: any) {
      if (err.message?.includes('already in progress')) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || 'Failed to start embedding generation' });
      }
    }
  });

  // GET /api/embed/:jobId — poll embedding job status
  app.get('/api/embed/:jobId', (req, res) => {
    const job = embedJobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/embed/:jobId/progress — SSE stream (shared helper)
  mountSSEProgress(app, '/api/embed/:jobId/progress', embedJobManager);

  // DELETE /api/embed/:jobId — cancel embedding job
  app.delete('/api/embed/:jobId', (req, res) => {
    const job = embedJobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    embedJobManager.cancelJob(req.params.jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Wrap listen in a promise so errors (EADDRINUSE, EACCES, etc.) propagate
  // to the caller instead of crashing with an unhandled 'error' event.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const displayHost = host === '::' || host === '0.0.0.0' ? 'localhost' : host;
      console.log(`GitNexus server running on http://${displayHost}:${port}`);
      resolve();
    });
    server.on('error', (err) => reject(err));

    // Graceful shutdown — close Express + LadybugDB cleanly
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      jobManager.dispose();
      embedJobManager.dispose();
      await cleanupMcp();
      await closeLbug();
      await backend.disconnect();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
