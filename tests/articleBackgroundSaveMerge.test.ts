import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ArticleStorageSnapshot } from '../utils/editorContentStore.ts';
import {
  backgroundSaveNeedsGeneratedFieldGuard,
  mergeServerGeneratedFieldsForBackgroundSave,
} from '../utils/articleBackgroundSaveMerge.ts';

const snapshot = (options: {
  secondaries?: string[];
  lsi?: string[];
  generatedBrief?: string;
} = {}): ArticleStorageSnapshot => ({
  kind: 'articleSnapshot',
  version: 1,
  username: 'writer',
  title: 'Article',
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  contentHtml: '<p></p>',
  plainText: '',
  keywords: {
    primary: 'gold detector',
    company: 'Bazarvan',
    secondaries: options.secondaries || [],
    lsi: options.lsi || [],
  },
  goalContext: {
    pageType: '',
    objective: '',
    audienceScope: '',
    targetCountry: '',
    targetAudience: '',
    audienceKnowledgeLevel: '',
    audienceNeeds: '',
    readerOutcome: '',
    desiredAction: '',
    marketingStage: '',
    uniqueAngle: '',
    evidenceRequirements: '',
    freshnessRequirements: '',
    brandVoice: '',
    topicSensitivity: '',
    searchIntent: '',
    generatedBrief: options.generatedBrief || '',
  },
  articleLanguage: 'en',
  savedAt: '2026-08-24T12:00:00.000Z',
});

test('stale autosave preserves semantic terms and brief written by a worker', () => {
  const merged = mergeServerGeneratedFieldsForBackgroundSave({
    snapshot: snapshot(),
    reason: 'auto',
    persistedKeywords: {
      secondaries: ['American gold detectors'],
      lsi: ['ground balance'],
    },
    persistedGoalContext: { generatedBrief: 'Server generated brief' },
  });

  assert.deepEqual(merged.keywords.secondaries, ['American gold detectors']);
  assert.deepEqual(merged.keywords.lsi, ['ground balance']);
  assert.equal(merged.goalContext.generatedBrief, 'Server generated brief');
});

test('manual saves can intentionally clear generated fields', () => {
  const original = snapshot();
  const merged = mergeServerGeneratedFieldsForBackgroundSave({
    snapshot: original,
    reason: 'manual',
    persistedKeywords: { secondaries: ['persisted'], lsi: ['persisted'] },
    persistedGoalContext: { generatedBrief: 'persisted' },
  });

  assert.equal(merged, original);
  assert.equal(backgroundSaveNeedsGeneratedFieldGuard(original, 'manual'), false);
  assert.equal(backgroundSaveNeedsGeneratedFieldGuard(original, 'lifecycle'), true);
});

test('article save API applies the stale-autosave guard before the atomic RPC', async () => {
  const [source, migration, editor, client] = await Promise.all([
    readFile(new URL('../api/articlesSave.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260824010000_full_article_pipeline_safety.sql', import.meta.url), 'utf8'),
    readFile(new URL('../contexts/EditorContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../utils/supabaseArticles.ts', import.meta.url), 'utf8'),
  ]);
  const guardAt = source.indexOf('backgroundSaveNeedsGeneratedFieldGuard(snapshot, saveReason)');
  const saveAt = source.indexOf("rpc('save_article_snapshot_with_content_policy'");
  assert.ok(guardAt > 0 && saveAt > guardAt);
  assert.match(source, /select\('keywords,goal_context'\)/);
  assert.match(source, /p_expected_last_saved_at: expectedLastSavedAt/);
  assert.match(source, /data\.staleBackgroundSave === true/);
  assert.match(source, /newer reviewed article revision exists/);
  assert.match(client, /expectedLastSavedAt: options\.expectedLastSavedAt \|\| null/);
  assert.match(editor, /loadedArticleExpectedLastSavedAtRef/);
  assert.match(editor, /expectedLastSavedAt: activeArticleId/);
  assert.match(editor, /authoritativeRemoteSavedAt: remoteSnapshot\.savedAt/);
  assert.doesNotMatch(editor, /loadedArticleExpectedLastSavedAtRef\.current = snapshot\?\.savedAt/);
  assert.match(source, /RFC3339_TIMESTAMP_PATTERN\.test\(timestamp\)/);
  assert.match(migration, /p_expected_last_saved_at timestamptz default null/);
  assert.match(migration, /v_article\.last_saved_at is distinct from p_expected_last_saved_at/);
  assert.match(migration, /p_expected_last_saved_at is null/);
  assert.match(migration, /'staleBackgroundSave', true/);
  const staleFenceAt = migration.indexOf("'staleBackgroundSave', true");
  const delegatedSaveAt = migration.indexOf('return public.save_article_snapshot(', staleFenceAt);
  assert.ok(staleFenceAt > 0 && delegatedSaveAt > staleFenceAt);
});
