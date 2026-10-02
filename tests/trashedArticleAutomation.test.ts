import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

test('globally trashed articles leave every automatic queue and release focus', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261016000000_release_trashed_article_automation.sql',
  );

  assert.match(migration, /create or replace function public\.article_is_globally_trashed/);
  assert.match(migration, /metadata #>> '\{trash,deletedAt\}'/);
  assert.match(migration, /public\.article_is_globally_trashed\(p_article_id\)/);
  assert.match(migration, /'reason', 'article_trashed'/);
  assert.match(migration, /release_trashed_article_automation_after_update/);
  assert.match(migration, /after update of metadata on public\.articles/);
  assert.match(migration, /update public\.content_writing_sessions/);
  assert.match(migration, /update public\.content_writing_automation_items/);
  assert.match(migration, /update public\.ai_external_analysis_jobs/);
  assert.match(migration, /delete from public\.automatic_article_focus_pauses/);
  assert.match(migration, /set article_id = null,[\s\S]*last_article_id = null,[\s\S]*last_release_reason = 'article_trashed'/);
  assert.match(migration, /perform public\.reconcile_automatic_article_focus\(\)/);
  assert.match(migration, /release_deleted_article_focus_before_delete/);
  assert.match(migration, /select 13/);
});

test('trashed drafts cannot be reacquired, listed, or automatically recovered', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261016000000_release_trashed_article_automation.sql',
  );

  assert.match(migration, /create or replace function public\.article_automatic_policy_allows/);
  assert.match(migration, /create or replace function public\.automatic_article_focus_allows/);
  assert.match(migration, /create or replace function public\.try_acquire_automatic_article_focus/);
  assert.match(migration, /create or replace function public\.list_content_writing_automation_candidates/);
  assert.match(migration, /article\.status in \('content_preparation', 'draft'\)[\s\S]*metadata #>> '\{trash,deletedAt\}'/);
  assert.match(migration, /get_visible_automation_task_inventory_raw/);
  assert.match(migration, /reconcile_automatic_article_focus/);
});

test('the automation API hides a stale trashed focus instead of rendering untitled', async () => {
  const api = await readWorkspaceFile('api/contentWritingAutomation.ts');
  const releaseRegistry = await readWorkspaceFile('constants/contentWritingRelease.ts');
  const readiness = await readWorkspaceFile('server/contentWritingReadiness.ts');

  assert.match(api, /const isArticleGloballyTrashed/);
  assert.match(api, /!targetArticle \|\| isArticleGloballyTrashed\(targetArticle\)/);
  assert.match(api, /articleId: null,[\s\S]*state: 'idle'/);
  assert.match(api, /lastReleaseReason: 'article_trashed'/);
  assert.match(api, /articles\(title,status,metadata\)/);
  assert.match(releaseRegistry, /20261016000000_release_trashed_article_automation\.sql/);
  assert.match(readiness, /version < 15/);
});
