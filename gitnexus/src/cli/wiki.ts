/**
 * Wiki Command
 *
 * Generates repository documentation from the knowledge graph.
 * Usage: gitnexus wiki [path] [options]
 */

import path from 'path';
import readline from 'readline';
import { execSync, execFileSync } from 'child_process';
import cliProgress from 'cli-progress';
import { getGitRoot, isGitRepo } from '../storage/git.js';
import {
  getStoragePaths,
  loadMeta,
  loadCLIConfig,
  saveCLIConfig,
} from '../storage/repo-manager.js';
import { WikiGenerator, type WikiOptions } from '../core/wiki/generator.js';
import { resolveLLMConfig, type LLMProvider } from '../core/wiki/llm-client.js';
import { closeWikiDb } from '../core/wiki/graph-queries.js';

export interface WikiCommandOptions {
  force?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiVersion?: string;
  reasoningModel?: boolean;
  concurrency?: string;
  gist?: boolean;
  provider?: LLMProvider;
  verbose?: boolean;
  review?: boolean;
}

/**
 * Prompt the user for input via stdin.
 */
function prompt(question: string, hide = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hide && process.stdin.isTTY) {
      // Mask input for API keys
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      const onData = (char: string) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          rl.close();
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

export const wikiCommand = async (inputPath?: string, options?: WikiCommandOptions) => {
  // Set verbose mode globally for cursor-client to pick up
  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  console.log('\n  GitNexus Wiki Generator\n');

  // ── Resolve repo path ───────────────────────────────────────────────
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    // If not in a git repo, fall back to cwd — meta check below will validate
    repoPath = gitRoot ?? process.cwd();
  }

  // ── Check for existing index ────────────────────────────────────────
  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    console.log('  Error: No GitNexus index found.');
    console.log('  Run `gitnexus analyze` first to index this repository.\n');
    process.exitCode = 1;
    return;
  }

  // ── Resolve LLM config (with interactive fallback) ─────────────────
  // Save any CLI overrides immediately
  if (
    options?.apiKey ||
    options?.model ||
    options?.baseUrl ||
    options?.provider ||
    options?.apiVersion ||
    options?.reasoningModel !== undefined
  ) {
    const existing = await loadCLIConfig();
    const updates: Partial<typeof existing> = {};
    if (options.apiKey) updates.apiKey = options.apiKey;
    if (options.baseUrl) updates.baseUrl = options.baseUrl;
    if (options.provider) updates.provider = options.provider;
    if (options.apiVersion) updates.apiVersion = options.apiVersion;
    if (options.reasoningModel !== undefined) updates.isReasoningModel = options.reasoningModel;
    // Save model to appropriate field based on provider
    if (options.model) {
      if (options.provider === 'cursor') {
        updates.cursorModel = options.model;
      } else {
        updates.model = options.model;
      }
    }
    await saveCLIConfig({ ...existing, ...updates });
    console.log('  Config saved to ~/.gitnexus/config.json\n');
  }

  const llmConfig = await resolveLLMConfig({
    model: options?.model,
    baseUrl: options?.baseUrl,
    apiKey: options?.apiKey,
    provider: options?.provider,
    apiVersion: options?.apiVersion,
    isReasoningModel: options?.reasoningModel,
  });

  console.log(`  Using model: ${llmConfig.model} (${llmConfig.baseUrl})\n`);

  // ── Setup progress bar with elapsed timer ──────────────────────────
  const bar = new cliProgress.SingleBar(
    {
      format: '  {bar} {percentage}% | {phase}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      barGlue: '',
      autopadding: true,
      clearOnComplete: false,
      stopOnComplete: false,
    },
    cliProgress.Presets.shades_grey,
  );

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeWikiDb()
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route console output through bar.log() to prevent progress bar corruption
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: any[]) => {
    process.stdout.write('\x1b[2K\r');
    origLog(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  const t0 = Date.now();
  let lastPhase = 'Initializing...';
  let phaseStart = t0;

  const updateBar = (value: number, phaseLabel: string) => {
    if (phaseLabel !== lastPhase) {
      lastPhase = phaseLabel;
      phaseStart = Date.now();
    }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  // Tick elapsed time every second while stuck on the same phase
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhase} (${elapsed}s)` });
    }
  }, 1000);

  // ── Run generator ───────────────────────────────────────────────────
  const wikiOptions: WikiOptions = {
    force: options?.force,
    concurrency: options?.concurrency ? parseInt(options.concurrency, 10) : undefined,
    reviewOnly: options?.review,
  };

  const generator = new WikiGenerator(
    repoPath,
    storagePath,
    lbugPath,
    llmConfig,
    wikiOptions,
    (_phase, percent, detail) => {
      updateBar(percent, detail || _phase);
    },
  );

  try {
    const result = await generator.run();

    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    bar.stop();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const wikiDir = path.join(storagePath, 'wiki');
    const viewerPath = path.join(wikiDir, 'index.html');
    const treeFile = path.join(wikiDir, 'module_tree.json');

    // Review mode: show module tree and ask for confirmation
    if (options?.review && result.moduleTree) {
      console.log(`\n  Module structure ready for review (${elapsed}s)\n`);
      console.log('  Modules to generate:\n');

      const printTree = (nodes: typeof result.moduleTree, indent = 0) => {
        for (const node of nodes) {
          const prefix = '  '.repeat(indent + 2);
          const fileCount = node.files?.length || 0;
          const childCount = node.children?.length || 0;
          const suffix =
            fileCount > 0
              ? ` (${fileCount} files)`
              : childCount > 0
                ? ` (${childCount} children)`
                : '';
          console.log(`${prefix}- ${node.name}${suffix}`);
          if (node.children && node.children.length > 0) {
            printTree(node.children, indent + 1);
          }
        }
      };
      printTree(result.moduleTree);

      console.log(`\n  Tree saved to: ${treeFile}`);
      console.log('  You can edit this file to remove/rename modules.\n');

      // Ask for confirmation (auto-continue in non-interactive environments)
      if (!process.stdin.isTTY) {
        console.log('  Non-interactive mode — auto-continuing with generation.\n');
      }
      const answer = process.stdin.isTTY
        ? await prompt('  Continue with generation? (Y/n/edit): ')
        : 'y';
      const choice = answer.trim().toLowerCase();

      if (choice === 'n' || choice === 'no') {
        console.log('\n  Generation cancelled. Run `gitnexus wiki` later to generate.\n');
        return;
      }

      if (choice === 'edit' || choice === 'e') {
        // Open editor for the user
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        console.log(`\n  Opening ${treeFile} in ${editor}...`);
        console.log('  Save and close the editor when done.\n');

        try {
          execFileSync(editor, [treeFile], { stdio: 'inherit' });
        } catch {
          console.log(`  Could not open editor. Please edit manually:\n  ${treeFile}\n`);
          console.log('  Then run `gitnexus wiki` to continue.\n');
          return;
        }
      }

      // Continue with generation using the (possibly edited) tree
      console.log('\n  Continuing with wiki generation...\n');
      bar.start(100, 30, { phase: 'Generating pages...' });

      // Re-enable console override and SIGINT handler for the continuation
      console.log = barLog;
      console.warn = barLog;
      console.error = barLog;
      process.on('SIGINT', sigintHandler);

      // Re-run generator without reviewOnly flag
      const continueOptions: WikiOptions = {
        ...wikiOptions,
        reviewOnly: false,
      };

      const continueGenerator = new WikiGenerator(
        repoPath,
        storagePath,
        lbugPath,
        llmConfig,
        continueOptions,
        (_phase, percent, detail) => {
          updateBar(percent, detail || _phase);
        },
      );

      const continueResult = await continueGenerator.run();

      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.update(100, { phase: 'Done' });
      bar.stop();

      const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n  Wiki generated successfully (${totalElapsed}s)\n`);
      console.log(`  Mode: ${continueResult.mode}`);
      console.log(`  Pages: ${continueResult.pagesGenerated}`);
      console.log(`  Output: ${wikiDir}`);
      console.log(`  Viewer: ${viewerPath}`);

      if (continueResult.failedModules && continueResult.failedModules.length > 0) {
        console.log(`\n  Failed modules (${continueResult.failedModules.length}):`);
        for (const mod of continueResult.failedModules) {
          console.log(`    - ${mod}`);
        }
      }

      console.log('');
      await maybePublishGist(viewerPath, options?.gist);
      return;
    }

    bar.update(100, { phase: 'Done' });
    bar.stop();

    if (result.mode === 'up-to-date' && !options?.force) {
      console.log('\n  Wiki is already up to date.');
      console.log(`  Viewer: ${viewerPath}\n`);
      await maybePublishGist(viewerPath, options?.gist);
      return;
    }

    console.log(`\n  Wiki generated successfully (${elapsed}s)\n`);
    console.log(`  Mode: ${result.mode}`);
    console.log(`  Pages: ${result.pagesGenerated}`);
    console.log(`  Output: ${wikiDir}`);
    console.log(`  Viewer: ${viewerPath}`);

    if (result.failedModules && result.failedModules.length > 0) {
      console.log(`\n  Failed modules (${result.failedModules.length}):`);
      for (const mod of result.failedModules) {
        console.log(`    - ${mod}`);
      }
      console.log('  Re-run to retry failed modules (pages will be regenerated).');
    }

    console.log('');

    await maybePublishGist(viewerPath, options?.gist);
  } catch (err: any) {
    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    bar.stop();

    if (err.message?.includes('No source files')) {
      console.log(`\n  ${err.message}\n`);
    } else if (err.message?.includes('content filter')) {
      // Content filter block — actionable message
      console.log(`\n  Content Filter: ${err.message}\n`);
      console.log(
        '  To resolve: rephrase your prompt or adjust the content filter policy for your deployment.\n',
      );
    } else if (err.message?.includes('API key') || err.message?.includes('API error')) {
      console.log(`\n  LLM Error: ${err.message}\n`);

      // Offer to reconfigure on auth-related failures
      const isAuthError =
        err.message?.includes('401') ||
        err.message?.includes('403') ||
        err.message?.includes('502') ||
        err.message?.includes('authenticate') ||
        err.message?.includes('Unauthorized');
      if (isAuthError && process.stdin.isTTY) {
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question('  Reconfigure LLM settings? (Y/n): ', (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });
        if (!answer || answer === 'y' || answer === 'yes') {
          // Clear saved config so next run triggers interactive setup
          await saveCLIConfig({});
          console.log('  Config cleared. Run `gitnexus wiki` again to reconfigure.\n');
        }
      }
    } else {
      console.log(`\n  Error: ${err.message}\n`);
      if (process.env.GITNEXUS_VERBOSE) {
        console.error(err);
      }
    }
    process.exitCode = 1;
  }
};

// ─── Gist Publishing ───────────────────────────────────────────────────

function hasGhCLI(): boolean {
  try {
    execSync('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function publishGist(htmlPath: string): { url: string; rawUrl: string } | null {
  try {
    const output = execFileSync(
      'gh',
      ['gist', 'create', htmlPath, '--desc', 'Repository Wiki — generated by GitNexus', '--public'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    // gh gist create prints the gist URL as the last line
    const lines = output.split('\n');
    const gistUrl = lines.find((l) => l.includes('gist.github.com')) || lines[lines.length - 1];

    if (!gistUrl || !gistUrl.includes('gist.github.com')) return null;

    // Build a raw viewer URL via gist.githack.com
    // gist URL format: https://gist.github.com/{user}/{id}
    const match = gistUrl.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/);
    let rawUrl = gistUrl;
    if (match) {
      rawUrl = `https://gistcdn.githack.com/${match[1]}/${match[2]}/raw/index.html`;
    }

    return { url: gistUrl.trim(), rawUrl };
  } catch {
    return null;
  }
}

async function maybePublishGist(htmlPath: string, gistFlag?: boolean): Promise<void> {
  if (gistFlag === false) return;

  // Check that the HTML file exists
  try {
    const fs = await import('fs/promises');
    await fs.access(htmlPath);
  } catch {
    return;
  }

  if (!hasGhCLI()) {
    if (gistFlag) {
      console.log('  GitHub CLI (gh) is not installed. Cannot publish gist.');
      console.log('  Install it: https://cli.github.com\n');
    }
    return;
  }

  let shouldPublish = !!gistFlag;

  if (!shouldPublish && process.stdin.isTTY) {
    const answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('  Publish wiki as a GitHub Gist for easy viewing? (Y/n): ', (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
    shouldPublish = !answer || answer === 'y' || answer === 'yes';
  }

  if (!shouldPublish) return;

  console.log('\n  Publishing to GitHub Gist...');
  const result = publishGist(htmlPath);

  if (result) {
    console.log(`  Gist:   ${result.url}`);
    console.log(`  Viewer: ${result.rawUrl}\n`);
  } else {
    console.log('  Failed to publish gist. Make sure `gh auth login` is configured.\n');
  }
}
