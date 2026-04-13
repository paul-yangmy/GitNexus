import { useState } from 'react';
import {
  createProject,
  triggerAnalyze,
} from '../../services/platform-client';

interface CreateProjectProps {
  onNavigate: (hash: string) => void;
}

export const CreateProject = ({ onNavigate }: CreateProjectProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState<'git' | 'archive'>('git');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceBranch, setSourceBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canSubmit = name.trim() && (sourceType === 'archive' || sourceUrl.trim());

  const handleCreate = async () => {
    if (!canSubmit) return;
    setError(null);
    setCreating(true);
    try {
      const project = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        sourceType,
        sourceUrl: sourceUrl.trim() || undefined,
        sourceBranch: sourceBranch.trim() || 'main',
      });
      // Auto-trigger analysis
      try {
        await triggerAnalyze(project.id);
      } catch {
        // Non-blocking — project was still created
      }
      onNavigate(`#/project/${project.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建失败');
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <button
        onClick={() => onNavigate('#/dashboard')}
        className="mb-4 text-sm text-text-muted hover:text-text-secondary"
      >
        ← 返回项目列表
      </button>

      <h1 className="mb-6 text-xl font-semibold text-text-primary">新建项目</h1>

      <div className="space-y-5">
        {/* Project Name */}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">项目名称 *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
            placeholder="my-project"
          />
        </label>

        {/* Description */}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">描述</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
            placeholder="可选项目描述…"
          />
        </label>

        {/* Source type toggle */}
        <div>
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">代码来源</span>
          <div className="flex rounded-lg bg-deep p-1">
            <button
              onClick={() => setSourceType('git')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                sourceType === 'git'
                  ? 'bg-elevated text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Git URL
            </button>
            <button
              onClick={() => setSourceType('archive')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                sourceType === 'archive'
                  ? 'bg-elevated text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              ZIP 上传
            </button>
          </div>
        </div>

        {/* Git fields */}
        {sourceType === 'git' && (
          <>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">Git URL *</span>
              <input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
                placeholder="https://github.com/user/repo.git"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">分支</span>
              <input
                value={sourceBranch}
                onChange={(e) => setSourceBranch(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
                placeholder="main"
              />
            </label>
          </>
        )}

        {/* ZIP placeholder */}
        {sourceType === 'archive' && (
          <div className="rounded-xl border border-dashed border-border-default py-12 text-center">
            <p className="text-sm text-text-muted">ZIP 上传即将推出</p>
            <p className="mt-1 text-xs text-text-muted">目前请使用 Git URL 方式</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={() => void handleCreate()}
          disabled={!canSubmit || creating}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          创建并分析
        </button>
      </div>
    </div>
  );
};
