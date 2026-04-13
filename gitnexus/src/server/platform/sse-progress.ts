/**
 * SSE progress relay — streams real-time job progress to clients via Server-Sent Events.
 */

import type { Express, Request, Response } from 'express';
import { requireAuth } from './jwt-auth.js';
import { subscribeProgress, type ProgressData } from './queue.js';
import { query } from './db.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export function mountPlatformSSE(app: Express): void {
  app.get(
    '/api/platform/projects/:projectId/jobs/:jobId/progress',
    requireAuth,
    (req: Request, res: Response) => {
      const { projectId, jobId } = req.params;
      const userId = req.user!.userId;

      // Verify job belongs to this project and user has access
      const jobResult = query(
        `SELECT aj.id FROM analyze_jobs aj
         JOIN projects p ON p.id = aj.project_id
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE aj.id = ? AND aj.project_id = ?
           AND (p.owner_id = ? OR pm.user_id IS NOT NULL OR ? = 'admin')`,
        [userId, jobId, projectId, userId, req.user!.role],
      );

      if (jobResult.rowCount === 0) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      // Set up SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let eventId = 0;

      const sendEvent = (data: ProgressData): void => {
        eventId++;
        res.write(`id: ${eventId}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Subscribe to in-process progress channel
      const unsubscribe = subscribeProgress(jobId, (data) => {
        sendEvent(data);

        // Auto-close on terminal states
        if (data.phase === 'done' || data.phase === 'failed') {
          cleanup();
        }
      });

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, HEARTBEAT_INTERVAL_MS);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };

      // Clean up on client disconnect
      req.on('close', cleanup);
    },
  );
}
