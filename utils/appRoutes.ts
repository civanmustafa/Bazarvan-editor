export type AppRoute =
  | { name: 'dashboard' }
  | { name: 'editor'; articleId: string | null }
  | { name: 'admin'; section: AdminRouteSection; id: string | null; date: string | null }
  | { name: 'settings'; section: string | null }
  | { name: 'notFound' };

export type AdminRouteSection =
  | 'overview'
  | 'articles'
  | 'articleDetail'
  | 'users'
  | 'userDetail'
  | 'trash'
  | 'n8n'
  | 'reports'
  | 'dailyReport'
  | 'sessions'
  | 'sessionDetail'
  | 'activity';

export const APP_NAVIGATION_EVENT = 'bazarvan:navigation';
const SETTINGS_ROUTE_SECTIONS = new Set(['system', 'ai', 'n8n', 'users', 'roles']);

const cleanPath = (path: string): string => {
  const normalized = path.split('?')[0].split('#')[0].replace(/\/{2,}/g, '/');
  if (!normalized || normalized === '/') return '/dashboard';
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const decodeSegment = (value?: string): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseAppRoute = (path = window.location.pathname): AppRoute => {
  const normalizedPath = cleanPath(path);
  const [, first, second, third, fourth] = normalizedPath.split('/');

  if (!first || first === 'dashboard') {
    return { name: 'dashboard' };
  }

  if (first === 'editor') {
    return { name: 'editor', articleId: decodeSegment(second) };
  }

  if (first === 'settings') {
    const section = decodeSegment(second);
    if (section && !SETTINGS_ROUTE_SECTIONS.has(section)) return { name: 'notFound' };
    return { name: 'settings', section };
  }

  if (first === 'admin') {
    if (!second) return { name: 'admin', section: 'overview', id: null, date: null };
    if (second === 'articles') {
      return third
        ? { name: 'admin', section: 'articleDetail', id: decodeSegment(third), date: null }
        : { name: 'admin', section: 'articles', id: null, date: null };
    }
    if (second === 'users') {
      return third
        ? { name: 'admin', section: 'userDetail', id: decodeSegment(third), date: null }
        : { name: 'admin', section: 'users', id: null, date: null };
    }
    if (second === 'trash') return { name: 'admin', section: 'trash', id: null, date: null };
    if (second === 'n8n') return { name: 'admin', section: 'n8n', id: null, date: null };
    if (second === 'activity') return { name: 'admin', section: 'activity', id: null, date: null };
    if (second === 'sessions') {
      return third
        ? { name: 'admin', section: 'sessionDetail', id: decodeSegment(third), date: null }
        : { name: 'admin', section: 'sessions', id: null, date: null };
    }
    if (second === 'reports') {
      return third === 'daily' && fourth
        ? { name: 'admin', section: 'dailyReport', id: null, date: decodeSegment(fourth) }
        : { name: 'admin', section: 'reports', id: null, date: null };
    }
  }

  return { name: 'notFound' };
};

export const getRouteView = (route: AppRoute): 'dashboard' | 'editor' | 'admin' | 'settings' | 'notFound' => {
  if (route.name === 'dashboard') return 'dashboard';
  if (route.name === 'editor') return 'editor';
  if (route.name === 'admin') return 'admin';
  if (route.name === 'settings') return 'settings';
  return 'notFound';
};

export const buildEditorArticlePath = (articleId?: string | null): string => (
  articleId ? `/editor/${encodeURIComponent(articleId)}` : '/editor'
);

export const buildAdminArticlePath = (articleId: string): string => (
  `/admin/articles/${encodeURIComponent(articleId)}`
);

export const buildAdminUserPath = (userId: string): string => (
  `/admin/users/${encodeURIComponent(userId)}`
);

export const buildDailyReportPath = (date: string): string => (
  `/admin/reports/daily/${encodeURIComponent(date)}`
);

export const buildAdminSessionPath = (sessionId: string): string => (
  `/admin/sessions/${encodeURIComponent(sessionId)}`
);

export const navigateToAppPath = (path: string, options: { replace?: boolean } = {}) => {
  const normalizedPath = cleanPath(path);
  const currentPath = cleanPath(window.location.pathname);
  if (normalizedPath === currentPath) return;

  if (options.replace) {
    window.history.replaceState({}, '', normalizedPath);
  } else {
    window.history.pushState({}, '', normalizedPath);
  }
  window.dispatchEvent(new CustomEvent(APP_NAVIGATION_EVENT, { detail: { path: normalizedPath } }));
};
