/**
 * Wiki Job Manager
 *
 * Tracks background wiki generation jobs with:
 * - In-memory Map storage
 * - Progress event emission for SSE relay
 * - 1-hour TTL cleanup for completed/failed jobs
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export interface WikiJobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface WikiJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  repoName: string;
  repoPath: string;
  progress: WikiJobProgress;
  error?: string;
  /** Serialized ProductHistoryEntry returned when complete. */
  entry?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class WikiJobManager {
  private jobs = new Map<string, WikiJob>();
  private emitter = new EventEmitter();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.emitter.setMaxListeners(200);
  }

  createJob(params: { repoName: string; repoPath: string }): WikiJob {
    const job: WikiJob = {
      id: randomUUID(),
      status: 'queued',
      repoName: params.repoName,
      repoPath: params.repoPath,
      progress: { phase: 'queued', percent: 0, message: '等待开始...' },
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): WikiJob | undefined {
    return this.jobs.get(id);
  }

  updateJob(
    id: string,
    update: Partial<Pick<WikiJob, 'status' | 'progress' | 'error' | 'entry' | 'completedAt'>>,
  ) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, update);
    if (job.status === 'complete' || job.status === 'failed') {
      job.completedAt = job.completedAt ?? Date.now();
    }
    // Emit progress event — emit a synthetic progress that signals terminal states
    const progressPayload: WikiJobProgress =
      update.progress ??
      (job.status === 'failed'
        ? { phase: 'failed', percent: job.progress.percent, message: job.error ?? '生成失败' }
        : job.status === 'complete'
          ? { phase: 'complete', percent: 100, message: 'Wiki 生成完成' }
          : job.progress);
    this.emitter.emit(`progress:${id}`, progressPayload);
  }

  onProgress(id: string, callback: (progress: WikiJobProgress) => void): () => void {
    const event = `progress:${id}`;
    this.emitter.on(event, callback);
    return () => this.emitter.off(event, callback);
  }

  isTerminal(status: WikiJob['status']): boolean {
    return status === 'complete' || status === 'failed';
  }

  private cleanup() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (this.isTerminal(job.status) && job.completedAt && job.completedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }
}
