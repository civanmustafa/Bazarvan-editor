import adminUsersHandler from '../api/adminUsers';
import articlesSaveHandler from '../api/articlesSave';
import assignedArticleAutomationHandler from '../api/assignedArticleAutomation';
import chatgptHandler from '../api/chatgpt';
import externalAnalysisHandler from '../api/externalAnalysis';
import geminiHandler, { geminiProgressHandler } from '../api/gemini';
import n8nArticlesHandler from '../api/n8nArticles';
import systemSettingsHandler from '../api/systemSettings';

export type ApiHandler = (req: any, res?: any) => Promise<Response | void>;
export type ApiRouteMethod = 'ALL' | 'POST';

export type ApiRouteDefinition = {
  id: string;
  method: ApiRouteMethod;
  path: string;
  handler: ApiHandler;
};

export const API_ROUTES: readonly ApiRouteDefinition[] = [
  { id: 'gemini-progress-cancel', method: 'POST', path: '/api/gemini/progress/:progressId/cancel', handler: geminiProgressHandler },
  { id: 'gemini-progress', method: 'ALL', path: '/api/gemini/progress/:progressId', handler: geminiProgressHandler },
  { id: 'gemini', method: 'ALL', path: '/api/gemini', handler: geminiHandler },
  { id: 'chatgpt', method: 'ALL', path: '/api/chatgpt', handler: chatgptHandler },
  { id: 'n8n-articles', method: 'ALL', path: '/api/n8n/articles', handler: n8nArticlesHandler },
  { id: 'articles-save', method: 'ALL', path: '/api/articles/save', handler: articlesSaveHandler },
  { id: 'external-analysis', method: 'ALL', path: '/api/external-analysis', handler: externalAnalysisHandler },
  { id: 'assigned-article-automation', method: 'ALL', path: '/api/articles/assigned-automation', handler: assignedArticleAutomationHandler },
  { id: 'system-settings', method: 'ALL', path: '/api/system/settings', handler: systemSettingsHandler },
  { id: 'admin-users', method: 'ALL', path: '/api/admin/users', handler: adminUsersHandler },
] as const;

const splitPath = (value: string): string[] => value.split('/').filter(Boolean);

const pathMatches = (routePath: string, pathname: string): boolean => {
  const routeSegments = splitPath(routePath);
  const requestSegments = splitPath(pathname);
  if (routeSegments.length !== requestSegments.length) return false;

  return routeSegments.every((segment, index) => (
    segment.startsWith(':') || segment === requestSegments[index]
  ));
};

export const findApiRoute = (pathname: string, method = 'GET'): ApiRouteDefinition | undefined => (
  API_ROUTES.find(route => (
    (route.method === 'ALL' || route.method === method.toUpperCase())
    && pathMatches(route.path, pathname)
  ))
);
