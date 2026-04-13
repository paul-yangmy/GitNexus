import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getProject,
  getProjectJobs,
  triggerAnalyze,
  deleteProject,
  updateProject,
  subscribeJobProgress,
  type PlatformProject,
  type PlatformJob,
  type JobProgressEvent,
} from '../../services/platform-client';

interface ProjectDetailProps {
  projectId: string;
  onNavigate: (hash: string) => void;
}

// ── Sub-components ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-yellow-500/10', text: 'text-yellow-400', label: '等待中' },
  analyzing: { bg: 'bg-blue-500/10',   text: 'text-blue-400',   label: '分析中' },
  ready:     { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: '就绪' },
  error:     { bg: 'bg-red-500/10',     text: 'text-red-400',     label: '错误' },
};

const JOB_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  queued:   { bg: 'bg-yellow-500/10', text: 'text-yellow-400', label: '排队中' },
  running:  { bg: 'bg-blue-500/10',   text: 'text-blue-400',   label: '运行中' },
  complete: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: '完成' },
  failed:   { bg: 'bg-red-500/10',     text: 'text-red-400',     label: '失败' },
};

function StatusBadge({ status, map }: { status: string; map: Record<string, { bg: string; text: string; label: string }> }) {
  const s = map[status] ?? { bg: 'bg-gray-500/10', text: 'text-gray-400', label: status };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function ProgressBar({ percent, message }: { percent: number; message: string }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
        <span>{message}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-deep">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const TABS = ['概览', '分析', 'MCP', '设置'] as const;
type Tab = (typeof TABS)[number];

// ── Main component ─────────────────────────────────────────────────────────

export const ProjectDetail = ({ projectId, onNavigate }: ProjectDetailProps) => {
  const [project, setProject] = useState<PlatformProject | null>(null);
  const [jobs, setJobs] = useState<PlatformJob[]>([]);
  const [tab, setTab] = useState<Tab>('概览');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // SSE progress state
  const [liveProgress, setLiveProgress] = useState<JobProgressEvent | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  // Settings state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [p, j] = await Promise.all([getProject(projectId), getProjectJobs(projectId)]);
      setProject(p);
      setJobs(j);
      setEditName(p.name);
      setEditDesc(p.description ?? '');
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // SSE: subscribe to running jobs
  useEffect(() => {
    const runningJob = jobs.find((j) => j.status === 'running' || j.status === 'queued');
    if (!runningJob) {
      setLiveProgress(null);
      return;
    }

    sseCleanupRef.current?.();
    const cleanup = subscribeJobProgress(
      projectId,
      runningJob.id,
      (data) => setLiveProgress(data),
      () => {
        setLiveProgress(null);
        void loadData();
      },
      () => {
        setLiveProgress(null);
        void loadData();
      },
    );
    sseCleanupRef.current = cleanup;
    return () => cleanup();
  }, [jobs, projectId, loadData]);

  const handleReanalyze = async () => {
    try {
      await triggerAnalyze(projectId);
      await loadData();
      setTab('分析');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '触发分析失败');
    }
  };

  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const updated = await updateProject(projectId, {
        name: editName.trim(),
        description: editDesc.trim() || undefined,
      });
      setProject(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteProject(projectId);
      onNavigate('#/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '删除失败');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        加载中…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error || '项目不存在'}
        </div>
        <button onClick={() => onNavigate('#/dashboard')} className="mt-4 text-sm text-text-muted hover:text-text-secondary">
          ← 返回
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Back */}
      <button onClick={() => onNavigate('#/dashboard')} className="mb-4 text-sm text-text-muted hover:text-text-secondary">
        ← 返回项目列表
      </button>

      {/* Title row */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{project.name}</h1>
          {project.description && <p className="mt-1 text-sm text-text-muted">{project.description}</p>}
        </div>
        <StatusBadge status={project.status} map={STATUS_STYLES} />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === '概览' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="符号" value={project.stats?.symbols} />
            <StatCard label="关系" value={project.stats?.relationships} />
            <StatCard label="流程" value={project.stats?.flows} />
            <StatCard label="社区" value={project.stats?.communities} />
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface p-4 text-sm">
            <InfoRow label="来源类型" value={project.sourceType === 'git' ? 'Git' : '归档'} />
            {project.sourceUrl && <InfoRow label="URL" value={project.sourceUrl} />}
            {project.sourceBranch && <InfoRow label="分支" value={project.sourceBranch} />}
            <InfoRow label="创建" value={formatDate(project.createdAt)} />
            <InfoRow label="最后索引" value={formatDate(project.lastIndexed)} />
          </div>
        </div>
      )}

      {/* ── Analysis Tab ── */}
      {tab === '分析' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => void handleReanalyze()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
            >
              重新分析
            </button>
          </div>

          {liveProgress && (
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
              <div className="text-sm font-medium text-blue-400">分析进行中</div>
              <ProgressBar percent={liveProgress.percent} message={liveProgress.message} />
            </div>
          )}

          {jobs.length === 0 && !liveProgress && (
            <p className="py-8 text-center text-sm text-text-muted">暂无分析任务</p>
          )}

          {jobs.map((job) => (
            <div key={job.id} className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-text-muted">{job.id.slice(0, 8)}</span>
                <StatusBadge status={job.status} map={JOB_STATUS_STYLES} />
              </div>
              {job.progress && (
                <ProgressBar percent={job.progress.percent} message={job.progress.message} />
              )}
              {job.error && (
                <p className="mt-2 text-xs text-red-400">{job.error}</p>
              )}
              <p className="mt-2 text-xs text-text-muted">{formatDate(job.createdAt)}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── MCP Tab ── */}
      {tab === 'MCP' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border-subtle bg-surface p-4">
            <h3 className="mb-2 text-sm font-medium text-text-primary">MCP 端点</h3>
            <p className="mb-3 text-xs text-text-muted">
              使用以下 URL 连接到此项目的 MCP 服务端点。
            </p>
            <CopyField value={project.mcpEndpoint || `${window.location.origin}/api/platform/mcp/${project.id}`} />
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface p-4">
            <h3 className="mb-2 text-sm font-medium text-text-primary">API Key</h3>
            <p className="text-xs text-text-muted">API Key 管理将在后续版本中推出。</p>
          </div>
        </div>
      )}

      {/* ── Settings Tab ── */}
      {tab === '设置' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border-subtle bg-surface p-4">
            <h3 className="mb-4 text-sm font-medium text-text-primary">项目信息</h3>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-text-secondary">名称</span>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-text-secondary">描述</span>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border-subtle bg-deep px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
                />
              </label>
              <button
                onClick={() => void handleSave()}
                disabled={saving || !editName.trim()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>

          {/* Danger zone */}
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
            <h3 className="mb-2 text-sm font-medium text-red-400">危险操作</h3>
            <p className="mb-3 text-xs text-text-muted">删除项目后无法恢复。</p>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                删除项目
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? '删除中…' : '确认删除'}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg px-4 py-2 text-sm text-text-muted hover:text-text-secondary"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 text-center">
      <div className="text-2xl font-semibold text-text-primary">
        {value != null ? value.toLocaleString() : '—'}
      </div>
      <div className="mt-1 text-xs text-text-muted">{label}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border-subtle py-2 last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{value}</span>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select text
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-deep px-3 py-2">
      <code className="flex-1 truncate text-xs text-text-secondary">{value}</code>
      <button
        onClick={() => void handleCopy()}
        className="shrink-0 rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
