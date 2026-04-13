import { useState } from 'react';
import { KeyRound, Loader2, LogIn, User } from '@/lib/lucide-icons';

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<void>;
  error: string | null;
}

export const LoginPage = ({ onLogin, error }: LoginPageProps) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      await onLogin(username.trim(), password);
    } catch {
      // Error is rendered by parent.
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[560px] items-center justify-center px-6">
      <div className="w-full rounded-[32px] border border-border-subtle bg-surface/95 p-8 shadow-[0_30px_80px_rgba(0,0,0,0.35)]">
        <div className="mb-6">
          <div className="text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
            Sign In
          </div>
          <h1 className="mt-2 text-3xl text-text-primary">登录后继续</h1>
        </div>

        <div className="space-y-4">
          <label className="block">
            <div className="mb-2 flex items-center gap-2 text-xs text-text-secondary">
              <User className="h-3.5 w-3.5" />
              用户名
            </div>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              className="w-full rounded-2xl border border-border-subtle bg-deep px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
            />
          </label>

          <label className="block">
            <div className="mb-2 flex items-center gap-2 text-xs text-text-secondary">
              <KeyRound className="h-3.5 w-3.5" />
              密码
            </div>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              className="w-full rounded-2xl border border-border-subtle bg-deep px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-[#79d7be]/50"
            />
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={() => void handleSubmit()}
          disabled={loading || !username.trim() || !password}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-[24px] bg-[linear-gradient(90deg,#f3b24c_0%,#79d7be_100%)] px-5 py-4 text-sm font-semibold text-[#101018] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          登录
        </button>

        <p className="mt-4 text-xs leading-6 text-text-secondary">
          首次启动服务后会自动创建管理员账号：`admin` / `admin123456`。
        </p>
      </div>
    </div>
  );
};
