import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const importRepository = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../server/articleCompetitorRepository.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    plugins: [{
      name: `competitor-repository-${randomUUID()}`,
      setup(plugin) {
        plugin.onResolve({ filter: /externalAnalysisQueue$/ }, () => ({ path: 'queue', namespace: 'test' }));
        plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export const getExternalAnalysisSupabaseAdmin = () => { throw new Error("not used"); };',
          loader: 'js',
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('content writing accepts only article-scoped server competitor rows', async () => {
  const repository = await importRepository();
  assert.deepEqual(repository.resolveArticleCompetitorRepositorySnapshot({ rows: [] }), {
    source: 'none',
    hasManagedRows: false,
    competitors: [],
  });

  const articleId = 'article-a';
  const snapshot = repository.resolveArticleCompetitorRepositorySnapshot({
    rows: [
      {
        id: `${articleId}-1`, position: 1, source_url: 'https://one.example/a', canonical_url: null,
        title: 'One', content_text: 'usable competitor content', status: 'completed', source_origin: 'manual_text',
      },
      {
        id: `${articleId}-2`, position: 2, source_url: 'https://two.example/b', canonical_url: null,
        title: 'Two', content_text: 'must not leak', status: 'failed', source_origin: 'automatic_discovery',
      },
    ],
  });
  assert.equal(snapshot.source, 'managed_rows');
  assert.equal(snapshot.competitors.length, 1);
  assert.equal(snapshot.competitors[0].id, `${articleId}-1`);
});

test('browser saves and readiness cannot use competitor metadata as a fallback', async () => {
  const [storage, editor, saveApi, repository, migration, acceptanceMigration] = await Promise.all([
    readFile(new URL('../utils/competitorStorage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../contexts/EditorContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../api/articlesSave.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/articleCompetitorRepository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260921010000_article_competitor_repository_and_semantic_partial_recovery.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260924000000_remove_competitor_content_acceptance_gates.sql', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(storage, /localStorage|bazarvan-competitor-links|bazarvan-competitor-text-snippets/);
  assert.doesNotMatch(editor, /readStoredCompetitorInputs|writeStoredCompetitorInputs/);
  assert.match(saveApi, /Never accept a browser attachment copy/);
  assert.doesNotMatch(repository, /getContentWritingCompetitorsFromMetadata|manual_metadata/);
  assert.doesNotMatch(migration, /v_metadata_count|greatest\(coalesce\(v_metadata/);
  assert.match(migration, /v_usable_count < v_minimum_competitors/);
  assert.match(migration, /greatest\(2, least\(5, v_minimum_competitors\)\)/);
  assert.match(migration, /competitor\.article_id = v_article\.id/);
  assert.match(migration, /source_origin/);
  assert.doesNotMatch(acceptanceMigration, /competitor\.word_count\s*>\s*=|competitor\.word_count\s*>=/);
  assert.doesNotMatch(acceptanceMigration, /when competitor\.source_class = 'government'/);
  assert.match(acceptanceMigration, /drop constraint if exists article_competitors_article_id_canonical_url_key/);
  assert.match(acceptanceMigration, /source_class = 'commercial'/);
  assert.match(acceptanceMigration, /content_weight = 1\.000/);
});
