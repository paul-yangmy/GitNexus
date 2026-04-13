import { useState } from 'react';
import {
  platformLogin,
  platformRegister,
  type AuthResponse,
} from '../../services/platform-client';

interface PlatformLoginProps {
  onAuth: (result: AuthResponse) => void;
}

export const PlatformLogin = ({ onAuth }: PlatformLoginProps) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!username.trim() || !password) return;
    setError(null);
    setLoading(true);
    try {
      const result =
        mode === 'login'
          ? await platformLogin(username.trim(), password)
          : await platformRegister(username.trim(), password, displayName.trim() || username.trim());
      onAuth(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleSubmit();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-void px-6">
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface p-8 shadow-[0_30px_80px_rgba(0,0,0,0.35)]">
        {/* Header */}
        <div className="mb-2 flex items-center gap-2 text-lg font-semibold text-text-primary">
          <span className="text-xl">⬡</span>
          代码分析平台
        </div>
        <p className="mb-6 text-sm text-text-muted">
          {mode === 'login' ? '登录以继续' : '创建新账号'}
        </p>

        {/* Tab toggle */}
        <div className="mb-6 flex rounded-lg bg-deep p-1">
          <button
            onClick={() => { setMode('login'); setError(null); }}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
              mode === 'login'
                ? 'bg-elevated text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            登录
          </button>
          <button
            onClick={() => { setMode('register'); setError(null); }}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
              mode === 'register'
                ? 'bg-elevated text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            注册
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs text-text-secondary">用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
              placeholder="your-username"
            />
          </label>

          {mode === 'register' && (
            <label className="block">
              <span className="mb-1.5 block text-xs text-text-secondary">显示名称</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={onKeyDown}
                className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
                placeholder="Your Name"
              />
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-xs text-text-secondary">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full rounded-lg border border-border-subtle bg-deep px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent/50"
              placeholder="••••••••"
            />
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={() => void handleSubmit()}
          disabled={loading || !username.trim() || !password}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          {mode === 'login' ? '登录' : '注册'}
        </button>
      </div>
    </div>
  );
};
