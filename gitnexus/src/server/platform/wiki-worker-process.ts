/**
 * In-process worker for wiki generation jobs.
 * Registered via wikiQueue.process() during platform initialization.
 */

import { wikiQueue } from './queue.js';
import { query } from './db.js';
import { runProductBuildWorkflow } from '../../cli/product-build.js';

export interface WikiJobData {
  projectId: string;
  userId: string;
  repoPath: string;
  wikiEntryId: string;
  repoName?: string;
  mcpEndpoint?: string;
}

async function processWikiJob(data: WikiJobData): Promise<void> {
  const { projectId, wikiEntryId, repoPath, repoName, mcpEndpoint } = data;

  // Mark entry as generating
  query(`UPDATE wiki_entries SET status = 'generating' WHERE id = ?`, [wikiEntryId]);

  try {
    const artifacts = await runProductBuildWorkflow(repoPath, {
      repoName: repoName || undefined,
      mcpEndpoint: mcpEndpoint || undefined,
    });

    // Update wiki entry on success — artifacts.wikiBundlePath is the generated bundle
    const filePath = artifacts.wikiBundlePath || '';
    let fileSize: number | null = null;
    if (filePath) {
      try {
        const { default: fs } = await import('fs');
        const stat = fs.statSync(filePath);
        fileSize = stat.size;
      } catch {
        // stat failed — leave null
      }
    }

    query(
      `UPDATE wiki_entries SET status = 'ready', file_path = ?, file_size = ? WHERE id = ?`,
      [filePath, fileSize, wikiEntryId],
    );

    console.log(`[wiki-worker] Wiki entry ${wikiEntryId} for project ${projectId} is ready`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    query(`UPDATE wiki_entries SET status = 'failed' WHERE id = ?`, [wikiEntryId]);
    console.error(`[wiki-worker] Wiki entry ${wikiEntryId} failed:`, errorMessage);
    throw err;
  }
}

/** Register the wiki job processor. Call once at platform startup. */
export function startWikiWorker(): void {
  wikiQueue.process(processWikiJob);
  console.log('[wiki-worker] Worker registered, waiting for jobs…');
}
