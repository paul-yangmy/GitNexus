/**
 * In-process worker for repository analysis jobs.
 * Registered via analyzeQueue.process() during platform initialization.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { analyzeQueue, publishProgress } from './queue.js';
import { query } from './db.js';

export interface AnalyzeJobData {
  projectId: string;
  userId: string;
  repoPath: string;
  indexPath: string;
  analyzeJobId: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, '../../cli/index.js');

async function processAnalyzeJob(data: AnalyzeJobData): Promise<void> {
  const { projectId, analyzeJobId, repoPath, indexPath } = data;

  // Mark job as running
  query(
    `UPDATE analyze_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`,
    [analyzeJobId],
  );
  query(`UPDATE projects SET status = 'analyzing' WHERE id = ?`, [projectId]);
  publishProgress(analyzeJobId, { phase: 'starting', percent: 0, message: 'Analysis starting…' });

  try {
    await runAnalyzeCLI(repoPath, analyzeJobId);

    // Read stats from meta.json if available
    let stats = '{}';
    const metaPath = path.join(indexPath, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        stats = fs.readFileSync(metaPath, 'utf-8');
        JSON.parse(stats); // validate
      } catch {
        stats = '{}';
      }
    }

    // Mark success
    query(
      `UPDATE analyze_jobs SET status = 'completed', progress = 100, current_phase = 'done', completed_at = datetime('now') WHERE id = ?`,
      [analyzeJobId],
    );
    query(
      `UPDATE projects SET status = 'ready', last_indexed = datetime('now'), stats = ? WHERE id = ?`,
      [stats, projectId],
    );
    publishProgress(analyzeJobId, { phase: 'done', percent: 100, message: 'Analysis complete' });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    query(
      `UPDATE analyze_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`,
      [errorMessage, analyzeJobId],
    );
    query(`UPDATE projects SET status = 'error' WHERE id = ?`, [projectId]);
    publishProgress(analyzeJobId, { phase: 'failed', percent: 0, message: errorMessage });
    throw err;
  }
}

/**
 * Spawn the GitNexus CLI analyze command as a child process.
 * Parses stdout for progress milestones.
 */
function runAnalyzeCLI(repoPath: string, analyzeJobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'analyze', repoPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('Parsing')) {
        publishProgress(analyzeJobId, { phase: 'parsing', percent: 20, message: 'Parsing source files…' });
      } else if (text.includes('Resolving')) {
        publishProgress(analyzeJobId, { phase: 'resolving', percent: 50, message: 'Resolving relationships…' });
      } else if (text.includes('Writing')) {
        publishProgress(analyzeJobId, { phase: 'writing', percent: 80, message: 'Writing graph data…' });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`analyze CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/** Register the analyze job processor. Call once at platform startup. */
export function startAnalyzeWorker(): void {
  analyzeQueue.process(processAnalyzeJob);
  console.log('[analyze-worker] Worker registered, waiting for jobs…');
}
