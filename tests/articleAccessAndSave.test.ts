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
  assert.match(articleApi, /rpc\('save_article_snapshot'/);
  assert.doesNotMatch(articleApi, /\.from\('article_competitors'\)/);
  assert.match(articleClient, /saveRemoteArticleSnapshotViaServer\(snapshot, options\)/);

  const publicSaveStart = articleClient.indexOf('export const saveRemoteArticleSnapshot = async');
  const publicSaveEnd = articleClient.indexOf('export const renameRemoteArticle', publicSaveStart);
  const publicSaveImplementation = articleClient.slice(publicSaveStart, publicSaveEnd);
  assert.doesNotMatch(publicSaveImplementation, /\.from\('articles'\)/);
  assert.doesNotMatch(publicSaveImplementation, /recordArticleVersion/);
});

test('dashboard, access/save, and performance migrations have balanced SQL delimiters', async () => {
  const migrations = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260711010000_dashboard_filtered_pagination.sql'),
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('supabase/migrations/20260713050000_phase_7_dashboard_performance.sql'),
    readWorkspaceFile('supabase/migrations/20260714000000_competitor_discovery.sql'),
    readWorkspaceFile('supabase/migrations/20260714010000_competitor_preview_cache.sql'),
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
  const rpcAt = articleApi.indexOf("rpc('save_article_snapshot'");

  assert.ok(authenticateAt > 0);
  assert.ok(rpcAt > authenticateAt);
  assert.match(articleApi, /assertAllowedOrigin\(req\)/);
  assert.match(articleApi, /consumeApiRateLimit\(/);
});
