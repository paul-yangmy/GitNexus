import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from '@/lib/lucide-icons';
import {
  connectToServer,
  fetchCurrentUser,
  fetchRepos,
  login,
  logout,
  probeBackend,
  setAuthToken,
  type AuthUser,
  type ConnectResult,
  type BackendRepo,
} from '../services/backend-client';
import { useBackend } from '../hooks/useBackend';
import { LoginPage } from './LoginPage';
import { ProductWorkbench } from './ProductWorkbench';

interface DropZoneProps {
  onServerConnect?: (result: ConnectResult, serverUrl?: string) => void | Promise<void>;
}

export const DropZone = ({ onServerConnect }: DropZoneProps) => {
  const [authError, setAuthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detectedRepos, setDetectedRepos] = useState<BackendRepo[]>([]);
  const [openingRepo, setOpeningRepo] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  const { isConnected, isProbing, startPolling, stopPolling, isPolling, backendUrl } = useBackend();

  useEffect(() => {
    const token = window.localStorage.getItem('product.auth.token');
    if (!token) return;
    setAuthToken(token);
    void fetchCurrentUser()
      .then((user) => setCurrentUser(user))
      .catch(() => {
        setAuthToken(null);
        window.localStorage.removeItem('product.auth.token');
      });
  }, []);

  const refreshRepos = useCallback(async () => {
    if (!(await probeBackend().catch(() => false))) {
      setDetectedRepos([]);
      return [];
    }
    const repos = await fetchRepos().catch(() => [] as BackendRepo[]);
    setDetectedRepos(repos);
    return repos;
  }, []);

  useEffect(() => {
    if (isConnected) {
      stopPolling();
      void refreshRepos();
      return;
    }
    if (!isPolling) {
      startPolling();
    }
  }, [isConnected, isPolling, refreshRepos, startPolling, stopPolling]);

  const handleRetryConnection = useCallback(async () => {
    setError(null);
    await refreshRepos();
  }, [refreshRepos]);

  const handleLogin = useCallback(async (username: string, password: string) => {
    try {
      const result = await login({ username, password });
      setAuthToken(result.token);
      window.localStorage.setItem('product.auth.token', result.token);
      setCurrentUser(result.user);
      setAuthError(null);
      await refreshRepos();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '登录失败。');
      throw err;
    }
  }, [refreshRepos]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {}
    setAuthToken(null);
    window.localStorage.removeItem('product.auth.token');
    setCurrentUser(null);
    setDetectedRepos([]);
  }, []);

  const connectToRepo = useCallback(
    async (repoName: string) => {
      const ok = await probeBackend().catch(() => false);
      if (!ok) {
        setError('详情工作台当前不可用，请先启动服务后再试。');
        return;
      }

      setOpeningRepo(repoName);
      setError(null);
      try {
        const result = await connectToServer(backendUrl, undefined, undefined, repoName);
        if (onServerConnect) {
          await onServerConnect(result, backendUrl);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '打开详情工作台失败。');
      } finally {
        setOpeningRepo(null);
      }
    },
    [backendUrl, onServerConnect],
  );

  const serviceStatusText = isConnected
    ? '服务已连接，可以上传、预览并进入详情工作台。'
    : isProbing
      ? '正在检测服务状态...'
      : '服务未连接，页面仍可使用，但需要连接服务后才能执行解析和详情查看。';

  if (!currentUser) {
    return <LoginPage onLogin={handleLogin} error={authError} />;
  }

  return (
    <div className="min-h-screen bg-void p-4 sm:p-6 lg:p-8">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute right-1/4 bottom-1/4 h-96 w-96 rounded-full bg-node-interface/10 blur-3xl" />
      </div>

      <div className="relative mx-auto w-full max-w-[1520px]">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {openingRepo && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-border-subtle bg-surface/95 px-4 py-3 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在打开 {openingRepo} 的详情工作台...
          </div>
        )}

        <ProductWorkbench
          repos={detectedRepos}
          serviceConnected={isConnected}
          serviceStatusText={serviceStatusText}
          onRetryConnection={handleRetryConnection}
          currentUser={currentUser}
          onLogout={handleLogout}
          onOpenRepo={connectToRepo}
        />
      </div>
    </div>
  );
};
