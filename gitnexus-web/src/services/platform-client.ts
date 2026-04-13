/**
 * Typed HTTP client for the GitNexus Platform API.
 *
 * Handles JWT auth, project CRUD, analysis job management,
 * and SSE subscriptions for real-time progress.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export interface PlatformProject {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  sourceType: 'git' | 'archive';
  sourceUrl?: string;
  sourceBranch?: string;
  status: 'pending' | 'analyzing' | 'ready' | 'error';
  stats?: {
    files?: number;
    symbols?: number;
    relationships?: number;
    flows?: number;
    communities?: number;
  };
  mcpEndpoint?: string;
  createdAt: string;
  updatedAt: string;
  lastIndexed?: string;
  error?: string;
}

export interface PlatformJob {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  progress?: {
    phase: string;
    percent: number;
    message: string;
  };
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface AuthResponse {
  token: string;
  user: PlatformUser;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_KEY = 'gitnexus_platform_token';
const API_BASE = '/api/platform';

// ── Token helpers ──────────────────────────────────────────────────────────

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── Core fetch wrapper ─────────────────────────────────────────────────────

async function platformFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body.error) message = body.error;
      else if (body.message) message = body.message;
    } catch {
      // ignore parse error
    }
    throw new PlatformError(message, response.status);
  }

  return response.json() as Promise<T>;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export async function platformLogin(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const result = await platformFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(result.token);
  return result;
}

export async function platformRegister(
  username: string,
  password: string,
  displayName: string,
): Promise<AuthResponse> {
  const result = await platformFetch<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, displayName }),
  });
  setToken(result.token);
  return result;
}

export function platformLogout(): void {
  clearToken();
}

export async function getMe(): Promise<PlatformUser> {
  const result = await platformFetch<{ user: PlatformUser }>('/auth/me');
  return result.user;
}

// ── Projects ───────────────────────────────────────────────────────────────

export async function getProjects(): Promise<PlatformProject[]> {
  const result = await platformFetch<{ projects: PlatformProject[] }>('/projects');
  return result.projects;
}

export async function createProject(data: {
  name: string;
  description?: string;
  sourceType: string;
  sourceUrl?: string;
  sourceBranch?: string;
}): Promise<PlatformProject> {
  const result = await platformFetch<{ project: PlatformProject }>('/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return result.project;
}

export async function getProject(id: string): Promise<PlatformProject> {
  const result = await platformFetch<{ project: PlatformProject }>(`/projects/${encodeURIComponent(id)}`);
  return result.project;
}

export async function deleteProject(id: string): Promise<void> {
  await platformFetch<{ deleted: boolean }>(`/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function updateProject(
  id: string,
  data: { name?: string; description?: string },
): Promise<PlatformProject> {
  const result = await platformFetch<{ project: PlatformProject }>(
    `/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
  );
  return result.project;
}

// ── Analysis Jobs ──────────────────────────────────────────────────────────

export async function triggerAnalyze(projectId: string): Promise<PlatformJob> {
  const result = await platformFetch<{ job: PlatformJob }>(
    `/projects/${encodeURIComponent(projectId)}/analyze`,
    { method: 'POST' },
  );
  return result.job;
}

export async function getProjectJobs(projectId: string): Promise<PlatformJob[]> {
  const result = await platformFetch<{ jobs: PlatformJob[] }>(
    `/projects/${encodeURIComponent(projectId)}/jobs`,
  );
  return result.jobs;
}

// ── SSE Job Progress ───────────────────────────────────────────────────────

export interface JobProgressEvent {
  phase: string;
  percent: number;
  message: string;
}

export function subscribeJobProgress(
  projectId: string,
  jobId: string,
  onProgress: (data: JobProgressEvent) => void,
  onComplete: () => void,
  onError: (error: string) => void,
): () => void {
  const controller = new AbortController();
  const token = getToken();
  const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/progress`;

  (async () => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        onError(`Server returned ${response.status}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError('No response body');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = 'message';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const data = JSON.parse(raw);
              if (eventType === 'complete' || eventType === 'done') {
                onComplete();
                return;
              } else if (eventType === 'error') {
                onError(data.error || 'Analysis failed');
                return;
              } else {
                onProgress(data);
              }
            } catch {
              // skip malformed data
            }
            eventType = 'message';
          }
        }
      }

      // Stream ended without explicit complete event
      onComplete();
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      onError(err instanceof Error ? err.message : 'Connection lost');
    }
  })();

  return () => controller.abort();
}
