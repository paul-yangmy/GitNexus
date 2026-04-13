/**
 * Express routes for queue management — enqueue analyze/wiki jobs and query job status.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { query } from './db.js';
import { requireAuth } from './jwt-auth.js';
import { analyzeQueue, wikiQueue } from './queue.js';
import type { JwtPayload } from './jwt-auth.js';

const router = Router();
router.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────

function canAccess(projectId: string, user: JwtPayload): boolean {
  if (user.role === 'admin') return true;
  const result = query(
    `SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
     UNION
     SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`,
    [projectId, user.userId, projectId, user.userId],
  );
  return result.rowCount > 0;
}

function getProject(projectId: string) {
  const result = query(`SELECT * FROM projects WHERE id = ?`, [projectId]);
  return result.rows[0] ?? null;
}

// ── POST /api/platform/projects/:id/analyze ────────────────────────────

router.post('/:id/analyze', async (req, res) => {
  try {
    const projectId = req.params.id;
    const user = req.user!;

    if (!canAccess(projectId, user)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Deduplication: reject if an active job already exists
    const activeJob = query(
      `SELECT id FROM analyze_jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1`,
      [projectId],
    );
    if (activeJob.rowCount > 0) {
      res.status(409).json({
        error: 'An analyze job is already queued or running for this project',
        jobId: activeJob.rows[0].id,
      });
      return;
    }

    // Create DB row
    const analyzeJobId = randomUUID();
    query(
      `INSERT INTO analyze_jobs (id, project_id, user_id, status, progress, current_phase)
       VALUES (?, ?, ?, 'queued', 0, 'queued')`,
      [analyzeJobId, projectId, user.userId],
    );

    // Enqueue into in-process queue
    const internalJob = await analyzeQueue.add('analyze', {
      projectId,
      userId: user.userId,
      repoPath: project.repo_path,
      indexPath: project.index_path,
      analyzeJobId,
    });

    // Store internal job ID back
    query(`UPDATE analyze_jobs SET queue_job_id = ? WHERE id = ?`, [
      internalJob.id,
      analyzeJobId,
    ]);

    res.status(202).json({ jobId: analyzeJobId, queueJobId: internalJob.id });
  } catch (err) {
    console.error('[queue-routes] POST /analyze error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/platform/projects/:id/wiki ───────────────────────────────

router.post('/:id/wiki', async (req, res) => {
  try {
    const projectId = req.params.id;
    const user = req.user!;

    if (!canAccess(projectId, user)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Deduplication: reject if a wiki entry is already generating
    const activeWiki = query(
      `SELECT id FROM wiki_entries WHERE project_id = ? AND status = 'generating' LIMIT 1`,
      [projectId],
    );
    if (activeWiki.rowCount > 0) {
      res.status(409).json({
        error: 'A wiki generation is already in progress for this project',
        wikiEntryId: activeWiki.rows[0].id,
      });
      return;
    }

    // Create wiki_entries row
    const wikiEntryId = randomUUID();
    query(
      `INSERT INTO wiki_entries (id, project_id, user_id, file_path, status)
       VALUES (?, ?, ?, '', 'generating')`,
      [wikiEntryId, projectId, user.userId],
    );

    // Enqueue into in-process queue
    const internalJob = await wikiQueue.add('wiki', {
      projectId,
      userId: user.userId,
      repoPath: project.repo_path,
      wikiEntryId,
      repoName: project.name,
    });

    res.status(202).json({ wikiEntryId, queueJobId: internalJob.id });
  } catch (err) {
    console.error('[queue-routes] POST /wiki error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/platform/projects/:id/jobs ────────────────────────────────

router.get('/:id/jobs', async (req, res) => {
  try {
    const projectId = req.params.id;
    const user = req.user!;

    if (!canAccess(projectId, user)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = query(
      `SELECT id, queue_job_id, status, progress, current_phase, error_message, attempts,
              started_at, completed_at, created_at
       FROM analyze_jobs
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [projectId],
    );

    res.json({ jobs: result.rows });
  } catch (err) {
    console.error('[queue-routes] GET /jobs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/platform/projects/:id/jobs/:jobId ─────────────────────────

router.get('/:id/jobs/:jobId', async (req, res) => {
  try {
    const { id: projectId, jobId } = req.params;
    const user = req.user!;

    if (!canAccess(projectId, user)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = query(
      `SELECT id, queue_job_id, status, progress, current_phase, error_message, attempts,
              started_at, completed_at, created_at
       FROM analyze_jobs
       WHERE id = ? AND project_id = ?`,
      [jobId, projectId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ job: result.rows[0] });
  } catch (err) {
    console.error('[queue-routes] GET /jobs/:jobId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
