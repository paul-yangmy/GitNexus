/**
 * Project CRUD routes for the GitNexus Platform.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { query } from './db.js';
import { requireAuth } from './jwt-auth.js';
import type { JwtPayload } from './jwt-auth.js';

const router = Router();
router.use(requireAuth);

/** Check if user can access this project (owner, member, or admin). */
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

/** Check if user is owner or admin. */
function isOwnerOrAdmin(projectId: string, user: JwtPayload): boolean {
  if (user.role === 'admin') return true;
  const result = query('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.userId,
  ]);
  return result.rowCount > 0;
}

// POST /api/platform/projects
router.post('/', async (req, res) => {
  try {
    const { name, description, source_type, source_url, source_branch } = req.body;

    if (!name || !source_type) {
      res.status(400).json({ error: 'name and source_type are required' });
      return;
    }

    if (!['git', 'archive'].includes(source_type)) {
      res.status(400).json({ error: "source_type must be 'git' or 'archive'" });
      return;
    }

    const projectId = randomUUID();
    const result = query(
      `INSERT INTO projects (id, name, description, owner_id, source_type, source_url, source_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [projectId, name, description ?? null, req.user.userId, source_type, source_url ?? null, source_branch ?? null],
    );

    const project = result.rows[0];

    // Add owner as a project member
    const memberId = randomUUID();
    query(
      `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'owner')`,
      [memberId, project.id, req.user.userId],
    );

    res.status(201).json(project);
  } catch (err) {
    console.error('[platform-projects] create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/platform/projects
router.get('/', async (req, res) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      result = query('SELECT * FROM projects ORDER BY created_at DESC');
    } else {
      result = query(
        `SELECT DISTINCT p.* FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id
         WHERE p.owner_id = ? OR pm.user_id = ?
         ORDER BY p.created_at DESC`,
        [req.user.userId, req.user.userId],
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error('[platform-projects] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/platform/projects/:id
router.get('/:id', async (req, res) => {
  try {
    if (!canAccess(req.params.id, req.user)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const result = query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[platform-projects] get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/platform/projects/:id
router.put('/:id', async (req, res) => {
  try {
    if (!canAccess(req.params.id, req.user)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const { name, description } = req.body;
    const result = query(
      `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = datetime('now')
       WHERE id = ? RETURNING *`,
      [name ?? null, description ?? null, req.params.id],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[platform-projects] update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/platform/projects/:id
router.delete('/:id', async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req.params.id, req.user)) {
      res.status(403).json({ error: 'Only the project owner or an admin can delete a project' });
      return;
    }

    const result = query('DELETE FROM projects WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error('[platform-projects] delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/platform/projects/:id/jobs
router.get('/:id/jobs', async (req, res) => {
  try {
    if (!canAccess(req.params.id, req.user)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const result = query(
      'SELECT * FROM analyze_jobs WHERE project_id = ? ORDER BY created_at DESC',
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[platform-projects] jobs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
