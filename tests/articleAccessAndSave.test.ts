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
  assert.match(articleClient, /saveRemoteArticleSnapshotViaServer\(snapshot, options\)/);

  const publicSaveStart = articleClient.indexOf('export const saveRemoteArticleSnapshot = async');
  const publicSaveEnd = articleClient.indexOf('export const renameRemoteArticle', publicSaveStart);
  const publicSaveImplementation = articleClient.slice(publicSaveStart, publicSaveEnd);
  assert.doesNotMatch(publicSaveImplementation, /\.from\('articles'\)/);
  assert.doesNotMatch(publicSaveImplementation, /recordArticleVersion/);
});

test('dashboard and phase 2/3 migrations have balanced SQL delimiters', async () => {
  const migrations = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260711010000_dashboard_filtered_pagination.sql'),
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
  ]);

  migrations.forEach((migration) => {
    assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL contains an unmatched $$ delimiter.');
    assertBalancedSqlParentheses(migration);
  });
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
