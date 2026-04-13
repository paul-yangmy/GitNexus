/**
 * In-process queue and progress pub/sub for the GitNexus Platform.
 *
 * No Redis or BullMQ required — uses Node.js EventEmitter and a simple
 * async job queue. Suitable for single-instance deployments (local dev
 * and Docker Compose on a single host).
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// ── Progress pub/sub ──────────────────────────────────────────────────

export interface ProgressData {
  phase: string;
  percent: number;
  message: string;
}

const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(500);

/** Publish a progress event for a given job. */
export function publishProgress(jobId: string, data: ProgressData): void {
  progressEmitter.emit(`progress:${jobId}`, data);
}

/**
 * Subscribe to progress events for a given job.
 * Returns an unsubscribe function.
 */
export function subscribeProgress(
  jobId: string,
  callback: (data: ProgressData) => void,
): () => void {
  const channel = `progress:${jobId}`;
  progressEmitter.on(channel, callback);
  return () => progressEmitter.off(channel, callback);
}

// ── In-process job queue ──────────────────────────────────────────────

type JobProcessor<T> = (data: T) => Promise<void>;

interface QueueItem<T> {
  id: string;
  data: T;
}

class InProcessQueue<T = Record<string, unknown>> {
  readonly name: string;
  private pending: QueueItem<T>[] = [];
  private processor: JobProcessor<T> | null = null;
  private running = 0;
  private readonly concurrency: number;

  constructor(name: string, concurrency = 1) {
    this.name = name;
    this.concurrency = concurrency;
  }

  /** Enqueue a job and return its ID. */
  async add(_eventName: string, data: T): Promise<{ id: string }> {
    const id = randomUUID();
    this.pending.push({ id, data });
    setImmediate(() => this.drain());
    return { id };
  }

  /** Register the processor function (call once at startup). */
  process(fn: JobProcessor<T>): void {
    this.processor = fn;
    // Drain in case jobs were enqueued before processor was registered
    setImmediate(() => this.drain());
  }

  private async drain(): Promise<void> {
    if (!this.processor || this.running >= this.concurrency) return;
    const item = this.pending.shift();
    if (!item) return;

    this.running++;
    try {
      await this.processor(item.data);
    } catch (err) {
      console.error(`[queue:${this.name}] Job ${item.id} failed:`, err);
    } finally {
      this.running--;
      setImmediate(() => this.drain());
    }
  }
}

/** Analyze queue — processes repository indexing jobs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const analyzeQueue = new InProcessQueue<any>('analyze', 1);

/** Wiki queue — processes wiki generation jobs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const wikiQueue = new InProcessQueue<any>('wiki', 2);

// No-op kept for compatibility if called from graceful-shutdown handlers
export function closeQueues(): void { /* in-process — nothing to close */ }
