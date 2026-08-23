import adminUsersHandler from '../api/adminUsers';
import adminAiProviderSecretsHandler from '../api/adminAiProviderSecrets';
import adminCrawlerProviderSecretsHandler from '../api/adminCrawlerProviderSecrets';
import adminCrawlerProviderUsageHandler from '../api/adminCrawlerProviderUsage';
import aiCapabilitiesHandler from '../api/aiCapabilities';
import articleImportHandler from '../api/articleImport';
import articlesSaveHandler from '../api/articlesSave';
import assignedArticleAutomationHandler from '../api/assignedArticleAutomation';
import chatgptHandler from '../api/chatgpt';
import clientSiteCrawlerHandler from '../api/clientSiteCrawler';
import contentWritingHandler from '../api/contentWriting';
import contentWritingAutomationHandler from '../api/contentWritingAutomation';
import contentWritingExternalResultHandler from '../api/contentWritingExternalResult';
import competitorsHandler from '../api/competitors';
import externalAnalysisHandler from '../api/externalAnalysis';
import geminiHandler, { geminiProgressHandler } from '../api/gemini';
import n8nArticlesHandler from '../api/n8nArticles';
import promptRegistryHandler from '../api/promptRegistry';
import systemSettingsHandler from '../api/systemSettings';
import userAiProviderSecretsHandler from '../api/userAiProviderSecrets';

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
  { id: 'client-site-crawl', method: 'ALL', path: '/api/client-site-crawl', handler: clientSiteCrawlerHandler },
  { id: 'content-writing', method: 'ALL', path: '/api/content-writing', handler: contentWritingHandler },
  { id: 'content-writing-automation', method: 'ALL', path: '/api/content-writing/automation', handler: contentWritingAutomationHandler },
  { id: 'content-writing-external-result', method: 'ALL', path: '/api/content-writing/external-result', handler: contentWritingExternalResultHandler },
  { id: 'ai-capabilities', method: 'ALL', path: '/api/ai/capabilities', handler: aiCapabilitiesHandler },
  { id: 'prompt-registry', method: 'ALL', path: '/api/ai/prompt-registry', handler: promptRegistryHandler },
  { id: 'competitors', method: 'ALL', path: '/api/competitors', handler: competitorsHandler },
  { id: 'article-import', method: 'ALL', path: '/api/articles/import-preview', handler: articleImportHandler },
  { id: 'n8n-articles', method: 'ALL', path: '/api/n8n/articles', handler: n8nArticlesHandler },
  { id: 'articles-save', method: 'ALL', path: '/api/articles/save', handler: articlesSaveHandler },
  { id: 'external-analysis', method: 'ALL', path: '/api/external-analysis', handler: externalAnalysisHandler },
  { id: 'assigned-article-automation', method: 'ALL', path: '/api/articles/assigned-automation', handler: assignedArticleAutomationHandler },
  { id: 'system-settings', method: 'ALL', path: '/api/system/settings', handler: systemSettingsHandler },
  { id: 'user-ai-provider-secrets', method: 'ALL', path: '/api/user/ai-provider-secrets', handler: userAiProviderSecretsHandler },
  { id: 'admin-ai-provider-secrets', method: 'ALL', path: '/api/admin/ai-provider-secrets', handler: adminAiProviderSecretsHandler },
  { id: 'admin-crawler-provider-secrets', method: 'ALL', path: '/api/admin/crawler-provider-secrets', handler: adminCrawlerProviderSecretsHandler },
  { id: 'admin-crawler-provider-usage', method: 'ALL', path: '/api/admin/crawler-provider-usage', handler: adminCrawlerProviderUsageHandler },
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
