/**
 * GitNexus Platform — main router and initialization.
 */

import type { Express } from 'express';
import { Router } from 'express';
import { initializeDatabase } from './db.js';
import { jwtMiddleware } from './jwt-auth.js';
import { seedAdminUser } from './user-store.js';
import authRoutes from './auth-routes.js';
import projectRoutes from './project-routes.js';
import queueRoutes from './queue-routes.js';
import { mountPlatformSSE } from './sse-progress.js';
import { startAnalyzeWorker } from './analyze-worker-process.js';
import { startWikiWorker } from './wiki-worker-process.js';

export function createPlatformRouter(): Router {
  const router = Router();

  router.use(jwtMiddleware);
  router.use('/auth', authRoutes);
  router.use('/projects', projectRoutes);
  router.use('/projects', queueRoutes);

  return router;
}

export function mountPlatformEndpoints(app: Express): void {
  app.use('/api/platform', createPlatformRouter());
  mountPlatformSSE(app);
}

export async function initializePlatform(): Promise<void> {
  initializeDatabase();       // synchronous — creates/migrates SQLite DB
  await seedAdminUser();
  startAnalyzeWorker();
  startWikiWorker();
  console.log('[platform] Initialization complete');
}

