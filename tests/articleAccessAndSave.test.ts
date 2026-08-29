import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSqlParentheses = (sql: string): void => {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (!quote && character === '-' && next === '-') {
      index = sql.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (quote) {
      if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    assert.ok(depth >= 0, `Unexpected closing parenthesis at character ${index}.`);
  }
  assert.equal(quote, null, 'SQL contains an unterminated quoted value.');
  assert.equal(depth, 0, 'SQL contains mismatched parentheses.');
};

test('article access is owned by one canonical Supabase policy', async () => {
  const [migration, assignedAutomation, externalAnalysis] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('api/assignedArticleAutomation.ts'),
    readWorkspaceFile('api/externalAnalysis.ts'),
  ]);

  assert.match(migration, /function public\.article_access_level_for_user\s*\(/);
  assert.match(migration, /using \(public\.can_read_article\(id\)\)/);
  assert.match(migration, /with check \(public\.can_write_article\(id\)\)/);
  assert.match(migration, /and public\.can_read_article\(article\.id\)/);
  assert.match(assignedAutomation, /requireArticleWriteAccess\(/);
  assert.match(externalAnalysis, /requireArticleWriteAccess\(/);
  assert.doesNotMatch(assignedAutomation, /article\.owner_id ===|article\.assigned_to ===/);
  assert.doesNotMatch(externalAnalysis, /article\.owner_id ===|article\.assigned_to ===/);
});

test('article save transaction is atomic and idempotent', async () => {
  const [migration, articleApi, articleClient] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('api/articlesSave.ts'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
  ]);

  assert.match(migration, /function public\.save_article_snapshot\s*\(/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /insert into public\.article_versions/);
  assert.match(migration, /insert into public\.article_save_requests/);
  assert.match(articleApi, /rpc\('save_article_snapshot_with_content_policy'/);
  assert.doesNotMatch(articleApi, /\.from\('article_competitors'\)/);
  assert.match(articleClient, /saveRemoteArticleSnapshotViaServer\(snapshot, options\)/);

  const publicSaveStart = articleClient.indexOf('export const saveRemoteArticleSnapshot = async');
  const publicSaveEnd = articleClient.indexOf('export const renameRemoteArticle', publicSaveStart);
  const publicSaveImplementation = articleClient.slice(publicSaveStart, publicSaveEnd);
  assert.doesNotMatch(publicSaveImplementation, /\.from\('articles'\)/);
  assert.doesNotMatch(publicSaveImplementation, /recordArticleVersion/);
});

test('database preserves accidental empty saves and permits only an explicit transactional clear', async () => {
  const [protectionMigration, clearMigration, articleApi, articleClient, editorContext] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260805000000_protect_saved_article_content.sql'),
    readWorkspaceFile('supabase/migrations/20260820010000_allow_intentional_article_content_clear.sql'),
    readWorkspaceFile('api/articlesSave.ts'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
  ]);

  assert.match(protectionMigration, /before update of content_json, content_html, plain_text on public\.articles/);
  assert.match(clearMigration, /current_setting\('app\.allow_empty_article_body', true\)/);
  assert.match(clearMigration, /function public\.save_article_snapshot_with_content_policy\s*\(/);
  assert.match(clearMigration, /perform set_config\('app\.allow_empty_article_body', 'on', true\)/);
  assert.match(clearMigration, /return public\.save_article_snapshot\s*\(/);
  assert.match(clearMigration, /new\.content_json := old\.content_json/);
  assert.match(clearMigration, /new\.content_html := old\.content_html/);
  assert.match(clearMigration, /new\.plain_text := old\.plain_text/);
  assert.match(articleApi, /p_allow_empty_body: clearContent/);
  assert.match(articleClient, /clearContent: options\.clearContent === true/);
  assert.match(editorContext, /editorChangedAfterLoad: hasEditorChangedAfterArticleLoadRef\.current/);
});

test('article time tracking uses an authenticated atomic increment', async () => {
  const [migration, articleClient] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260820020000_atomic_article_time_tracking.sql'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
  ]);

  assert.match(migration, /function public\.record_article_time\s*\(/);
  assert.match(migration, /article_access_level_for_user\(p_article_id, v_user_id\) not in \('write', 'admin'\)/);
  assert.match(migration, /time_spent_seconds = coalesce\(article\.time_spent_seconds, 0\) \+ p_seconds/);
  assert.match(migration, /grant execute on function public\.record_article_time\(uuid, integer\) to authenticated, service_role/);
  assert.match(articleClient, /rpc\('record_article_time'/);
  assert.doesNotMatch(articleClient, /time_spent_seconds =|\.update\(\{ time_spent_seconds/);
});

test('dashboard lifecycle mutations require the deployed canonical RPCs without client-side compatibility writes', async () => {
  const articleClient = await readWorkspaceFile('utils/supabaseArticles.ts');

  assert.match(articleClient, /rpc\('update_article_dashboard_status'/);
  assert.match(articleClient, /rpc\('move_article_to_dashboard_trash'/);
  assert.match(articleClient, /rpc\('restore_article_from_dashboard_trash'/);
  assert.match(articleClient, /rpc\('purge_expired_dashboard_trash'/);
  assert.doesNotMatch(articleClient, /error\?\.code !== 'PGRST202'/);
  assert.doesNotMatch(articleClient, /error\?\.code === 'PGRST202'/);
});

test('dashboard, access/save, and performance migrations have balanced SQL delimiters', async () => {
  const migrations = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260711010000_dashboard_filtered_pagination.sql'),
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('supabase/migrations/20260713050000_phase_7_dashboard_performance.sql'),
    readWorkspaceFile('supabase/migrations/20260714000000_competitor_discovery.sql'),
    readWorkspaceFile('supabase/migrations/20260714010000_competitor_preview_cache.sql'),
    readWorkspaceFile('supabase/migrations/20260714020000_external_analysis_exactly_once.sql'),
    readWorkspaceFile('supabase/migrations/20260714030000_automatic_competitor_discovery.sql'),
    readWorkspaceFile('supabase/migrations/20260820010000_allow_intentional_article_content_clear.sql'),
    readWorkspaceFile('supabase/migrations/20260820020000_atomic_article_time_tracking.sql'),
    readWorkspaceFile('supabase/migrations/20260827030000_content_research_automation_settings.sql'),
    readWorkspaceFile('supabase/migrations/20260828010000_concurrent_editing_and_meta_description.sql'),
  ]);

  migrations.forEach((migration) => {
    assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL contains an unmatched $$ delimiter.');
    assertBalancedSqlParentheses(migration);
  });
});

test('competitor discovery is durable, RLS protected, and uses the canonical article policy', async () => {
  const [migration, cacheMigration, api, worker, cacheService, previewModal, registry] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260714000000_competitor_discovery.sql'),
    readWorkspaceFile('supabase/migrations/20260714010000_competitor_preview_cache.sql'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('server/competitorPreviewCache.ts'),
    readWorkspaceFile('components/CompetitorPreviewModal.tsx'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
  ]);

  assert.match(migration, /create table if not exists public\.article_competitors/);
  assert.match(migration, /using \(public\.can_read_article\(article_id\)\)/);
  assert.match(migration, /article_access_level_for_user\(p_article_id, p_requested_by\)/);
  assert.match(migration, /enqueue_competitor_extraction_job/);
  assert.match(migration, /function public\.merge_article_competitors_metadata/);
  assert.match(migration, /trigger preserve_article_competitors_metadata/);
  assert.match(migration, /job_type = 'competitor_extraction'/);
  assert.match(cacheMigration, /create table if not exists public\.competitor_page_cache/);
  assert.match(cacheMigration, /enable row level security/);
  assert.match(cacheMigration, /revoke all on public\.competitor_page_cache from public, anon, authenticated/);
  assert.match(cacheMigration, /grant all on public\.competitor_page_cache to service_role/);
  assert.match(api, /requireArticleWriteAccess\(/);
  assert.match(api, /authenticateApiRequest\(req\)/);
  assert.match(api, /action === 'preview'/);
  assert.match(api, /consumeApiRateLimit\('competitors-preview'/);
  assert.match(api, /getCompetitorPreview\(/);
  assert.match(worker, /registerExternalAnalysisJobExecutor\('competitor_extraction'/);
  assert.match(worker, /getCompetitorPreview\(/);
  assert.doesNotMatch(worker, /scrapeCompetitorWeb\(/);
  assert.match(cacheService, /createHash\('sha256'\)/);
  assert.match(cacheService, /COMPETITOR_PREVIEW_CACHE_HOURS/);
  assert.match(previewModal, /createPortal\(/);
  assert.match(previewModal, /aria-modal="true"/);
  assert.match(previewModal, /event\.key === 'Escape'/);
  assert.match(registry, /path: '\/api\/competitors'/);
});

test('article save API authenticates before invoking the save transaction', async () => {
  const articleApi = await readWorkspaceFile('api/articlesSave.ts');
  const authenticateAt = articleApi.indexOf('await authenticateApiRequest(req)');
  const rpcAt = articleApi.indexOf("rpc('save_article_snapshot_with_content_policy'");

  assert.ok(authenticateAt > 0);
  assert.ok(rpcAt > authenticateAt);
  assert.match(articleApi, /assertAllowedOrigin\(req\)/);
  assert.match(articleApi, /consumeApiRateLimit\(/);
});
