import { useState, useEffect, useCallback } from 'react';
import {
  getProjects,
  type PlatformProject,
} from '../../services/platform-client';

interface DashboardProps {
  onNavigate: (hash: string) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-yellow-500/10', text: 'text-yellow-400', label: '等待中' },
  analyzing: { bg: 'bg-blue-500/10',   text: 'text-blue-400',   label: '分析中' },
  ready:     { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: '就绪' },
  error:     { bg: 'bg-red-500/10',     text: 'text-red-400',     label: '错误' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export const Dashboard = ({ onNavigate }: DashboardProps) => {
  const [projects, setProjects] = useState<PlatformProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const list = await getProjects();
      setProjects(list);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    const interval = setInterval(() => void loadProjects(), 30_000);
    return () => clearInterval(interval);
  }, [loadProjects]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">我的项目</h1>
        <button
          onClick={() => onNavigate('#/project/new')}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          + 新建项目
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-text-muted">
          <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          加载中…
        </div>
      )}

      {/* Empty state */}
      {!loading && projects.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-border-default py-20 text-center">
          <div className="mb-2 text-3xl">📦</div>
          <p className="text-text-secondary">还没有项目</p>
          <p className="mt-1 text-sm text-text-muted">点击上方"新建项目"开始分析代码</p>
        </div>
      )}

      {/* Project grid */}
      {!loading && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onNavigate(`#/project/${project.id}`)}
              className="group rounded-xl border border-border-subtle bg-surface p-5 text-left transition-all hover:border-border-default hover:bg-elevated"
            >
              <div className="mb-2 flex items-start justify-between">
                <h3 className="truncate text-sm font-semibold text-text-primary group-hover:text-accent">
                  {project.name}
                </h3>
                <StatusBadge status={project.status} />
              </div>

              {project.description && (
                <p className="mb-3 line-clamp-2 text-xs text-text-muted">
                  {project.description}
                </p>
              )}

              {project.stats && (
                <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                  {project.stats.symbols != null && (
                    <span>{project.stats.symbols.toLocaleString()} 符号</span>
                  )}
                  {project.stats.relationships != null && (
                    <span>{project.stats.relationships.toLocaleString()} 关系</span>
                  )}
                  {project.stats.flows != null && (
                    <span>{project.stats.flows} 流程</span>
                  )}
                </div>
              )}

              <div className="text-xs text-text-muted">
                {project.lastIndexed
                  ? `索引于 ${formatDate(project.lastIndexed)}`
                  : `创建于 ${formatDate(project.createdAt)}`}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
