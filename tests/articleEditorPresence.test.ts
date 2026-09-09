import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  groupArticleEditorPresence,
  normalizeArticleEditorPresence,
} from '../utils/articleEditorPresenceState.ts';

test('article presence normalizes rows, hides malformed values, and deduplicates users', () => {
  const presence = normalizeArticleEditorPresence([
    {
      articleId: 'article-a',
      userId: 'user-a',
      displayName: 'writer',
      enteredAt: '2026-09-09T10:00:00.000Z',
      lastSeenAt: '2026-09-09T10:00:05.000Z',
    },
    {
      articleId: 'article-a',
      userId: 'user-a',
      displayName: 'writer',
      enteredAt: '2026-09-09T10:00:00.000Z',
      lastSeenAt: '2026-09-09T10:00:25.000Z',
    },
    { articleId: '', userId: 'invalid', displayName: 'invalid' },
  ]);

  assert.equal(presence.length, 1);
  assert.equal(presence[0]?.displayName, 'writer');
  assert.equal(presence[0]?.lastSeenAt, '2026-09-09T10:00:25.000Z');
  assert.deepEqual(Object.keys(groupArticleEditorPresence(presence)), ['article-a']);
});

test('presence migration restricts raw rows and exposes guarded heartbeat RPCs', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260909000000_article_editor_presence.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /create table if not exists public\.article_editor_presence/);
  assert.match(migration, /alter table public\.article_editor_presence enable row level security/);
  assert.match(migration, /revoke all on table public\.article_editor_presence from public, anon, authenticated/);
  assert.match(migration, /public\.can_read_article\(p_article_id\)/);
  assert.match(migration, /last_seen_at < now\(\) - interval '90 seconds'/);
  assert.match(migration, /split_part\([\s\S]*profile\.email[\s\S]*'@'/);
  assert.match(migration, /grant execute on function public\.heartbeat_article_editor_presence\(uuid, uuid\)[\s\S]*to authenticated/);
});

test('dashboard occupancy and in-editor warning are both wired to live monitoring', async () => {
  const [dashboard, editorApp, banner, hook] = await Promise.all([
    readFile(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/EditorApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/ArticleEditorPresenceBanner.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../hooks/useArticleEditorPresence.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(dashboard, /داخلها:/);
  assert.match(dashboard, /لا أحد داخلها/);
  assert.match(dashboard, /المقالة مفتوحة الآن لدى/);
  assert.match(editorApp, /<ArticleEditorPresenceBanner\s*\/>/);
  assert.match(banner, /هذه المقالة مفتوحة الآن لدى/);
  assert.match(banner, /aria-live="assertive"/);
  assert.match(hook, /ARTICLE_EDITOR_PRESENCE_HEARTBEAT_MS/);
  assert.match(hook, /leaveArticleEditorPresence\(articleId, presenceId\)/);
});
