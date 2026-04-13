import { useState, useEffect, useCallback } from 'react';
import {
  getToken,
  getMe,
  platformLogout,
  type PlatformUser,
  type AuthResponse,
} from '../../services/platform-client';
import { PlatformLayout } from './PlatformLayout';
import { PlatformLogin } from './PlatformLogin';
import { Dashboard } from './Dashboard';
import { CreateProject } from './CreateProject';
import { ProjectDetail } from './ProjectDetail';

// ── Hash router ────────────────────────────────────────────────────────────

interface Route {
  page: 'login' | 'dashboard' | 'project-new' | 'project-detail';
  id?: string;
}

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '/');

  if (path.startsWith('/project/new')) return { page: 'project-new' };

  const projectMatch = path.match(/^\/project\/([^/]+)/);
  if (projectMatch) return { page: 'project-detail', id: projectMatch[1] };

  if (path.startsWith('/login')) return { page: 'login' };

  return { page: 'dashboard' };
}

function useHashRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  return { route, navigate };
}

// ── PlatformApp ────────────────────────────────────────────────────────────

const PlatformApp = () => {
  const { route, navigate } = useHashRouter();
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Check existing token on mount
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setAuthChecked(true);
      return;
    }
    getMe()
      .then((u) => setUser(u))
      .catch(() => {
        platformLogout();
      })
      .finally(() => setAuthChecked(true));
  }, []);

  // Auth guard: redirect to login if not authenticated
  useEffect(() => {
    if (!authChecked) return;
    if (!user && route.page !== 'login') {
      navigate('#/login');
    }
  }, [authChecked, user, route.page, navigate]);

  const handleAuth = useCallback(
    (result: AuthResponse) => {
      setUser(result.user);
      navigate('#/dashboard');
    },
    [navigate],
  );

  const handleLogout = useCallback(() => {
    platformLogout();
    setUser(null);
    navigate('#/login');
  }, [navigate]);

  // Loading state while checking auth
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-void">
        <svg className="h-6 w-6 animate-spin text-text-muted" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      </div>
    );
  }

  // Login page (no layout wrapper)
  if (route.page === 'login' || !user) {
    return <PlatformLogin onAuth={handleAuth} />;
  }

  // Authenticated pages wrapped in layout
  return (
    <PlatformLayout user={user} onLogout={handleLogout} onNavigate={navigate}>
      {route.page === 'dashboard' && <Dashboard onNavigate={navigate} />}
      {route.page === 'project-new' && <CreateProject onNavigate={navigate} />}
      {route.page === 'project-detail' && route.id && (
        <ProjectDetail projectId={route.id} onNavigate={navigate} />
      )}
    </PlatformLayout>
  );
};

export default PlatformApp;
