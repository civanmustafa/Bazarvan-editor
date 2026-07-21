import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string) => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('screen routes are lazy and editor providers are editor-only', async () => {
  const [app, appProviders, editorProviders, dashboard, editorApp] = await Promise.all([
    readWorkspaceFile('App.tsx'),
    readWorkspaceFile('contexts/Providers.tsx'),
    readWorkspaceFile('contexts/EditorProviders.tsx'),
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/EditorApp.tsx'),
  ]);

  for (const component of ['Dashboard', 'AdminApp', 'SettingsPage', 'EditorApp']) {
    assert.match(app, new RegExp(`lazy\\(\\(\\) => import\\('\\./components/${component}'\\)\\)`));
  }
  assert.doesNotMatch(appProviders, /EditorProvider|AIProvider|InteractionProvider|ModalProvider/);
  assert.match(editorProviders, /<EditorProvider>/);
  assert.match(editorProviders, /<AIProvider>/);
  assert.match(editorApp, /<EditorProviders>/);
  assert.doesNotMatch(dashboard, /contexts\/EditorContext/);
  assert.match(dashboard, /buildEditorArticlePath/);
});

test('content writing UI stays out of the initial editor sidebar chunk', async () => {
  const rightSidebar = await readWorkspaceFile('components/RightSidebar.tsx');

  assert.match(rightSidebar, /const ContentWritingPanel = React\.lazy\(\(\) => import\('\.\/ContentWritingPanel'\)\)/);
  assert.doesNotMatch(rightSidebar, /import ContentWritingPanel from/);
});

test('high-frequency editor contexts expose selectors and memoized provider values', async () => {
  const [editorContext, aiContext, interactionContext, userContext] = await Promise.all([
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('contexts/InteractionContext.tsx'),
    readWorkspaceFile('contexts/UserContext.tsx'),
  ]);

  assert.match(editorContext, /export const useEditorSelector/);
  assert.match(editorContext, /useMemo<EditorContextType>/);
  assert.match(aiContext, /export const useAISelector/);
  assert.match(aiContext, /useMemo<AIContextType>/);
  assert.match(interactionContext, /export const useInteractionSelector/);
  assert.match(interactionContext, /useMemo<InteractionContextType>/);
  assert.match(userContext, /useMemo<UserContextType>/);
});

test('dashboard RPC keeps AccessPolicy before pagination and has matching indexes', async () => {
  const [accessMigration, performanceMigration] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('supabase/migrations/20260713050000_phase_7_dashboard_performance.sql'),
  ]);
  const rpcStart = accessMigration.lastIndexOf('create or replace function public.list_dashboard_articles_page');
  const rpcSql = accessMigration.slice(rpcStart);
  const accessIndex = rpcSql.indexOf('public.can_read_article(article.id)');
  const limitIndex = rpcSql.indexOf('limit v_page_size');

  assert.ok(accessIndex >= 0, 'dashboard RPC must use canonical AccessPolicy');
  assert.ok(limitIndex > accessIndex, 'access and filters must run before LIMIT');
  assert.match(rpcSql, /coalesce\(p_page_size, 10\)/);
  assert.match(performanceMigration, /security definer/);
  assert.match(performanceMigration, /articles_dashboard_sort_idx/);
  assert.match(performanceMigration, /articles_dashboard_source_sort_idx/);
  assert.match(performanceMigration, /articles_dashboard_status_sort_idx/);
});

test('dashboard status tabs keep ten-row server pages and prefetch priority tabs sequentially', async () => {
  const dashboard = await readWorkspaceFile('components/Dashboard.tsx');

  assert.match(dashboard, /DASHBOARD_ARTICLES_PAGE_SIZE = 10/);
  assert.match(dashboard, /DASHBOARD_ARTICLE_STATUS_TABS\.map/);
  assert.match(dashboard, /status: isTrashVisible \? 'all' : articleStatusTab/);
  assert.match(dashboard, /for \(const status of DASHBOARD_PREFETCH_ARTICLE_STATUSES\)/);
  assert.match(dashboard, /await readCachedRemoteArticlesPage\(prefetchOptions\)/);
  assert.match(dashboard, /await listRemoteArticlesPage\(prefetchOptions\)/);
  assert.match(dashboard, /window\.history\.replaceState/);
  assert.doesNotMatch(dashboard, /<select name="status"/);
});
