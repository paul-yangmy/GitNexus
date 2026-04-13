import { useState, useEffect, type ReactNode } from 'react';
import type { PlatformUser } from '../../services/platform-client';

interface PlatformLayoutProps {
  user: PlatformUser;
  onLogout: () => void;
  onNavigate: (hash: string) => void;
  children: ReactNode;
}

export const PlatformLayout = ({ user, onLogout, onNavigate, children }: PlatformLayoutProps) => {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-void text-text-primary">
      {/* Top nav */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-6">
        <button
          onClick={() => onNavigate('#/dashboard')}
          className="flex items-center gap-2 text-sm font-semibold tracking-wide hover:opacity-80"
        >
          <span className="text-lg">⬡</span>
          <span>Code Analyzer</span>
        </button>

        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
              {(user.displayName || user.username)[0].toUpperCase()}
            </span>
            <span>{user.displayName || user.username}</span>
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
              <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border-subtle bg-elevated py-1 shadow-lg">
              <div className="border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
                {user.username}
              </div>
              <button
                onClick={onLogout}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-hover"
              >
                退出登录
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1">{children}</main>
    </div>
  );
};
