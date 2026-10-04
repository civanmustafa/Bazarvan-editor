import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL(
  '../supabase/migrations/20261027000000_released_focus_review_truth.sql',
  import.meta.url,
);

test('released focus exposes review requirements without claiming the lane', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.focus_payload_source(payload jsonb not null);
      insert into public.focus_payload_source(payload) values ('{
        "articleId": null,
        "articleTitle": "",
        "state": "needs_attention",
        "currentStage": "duplicate_cleanup",
        "lastArticleId": "10000000-0000-4000-8000-000000000001",
        "lastArticleTitle": "Review article",
        "lastError": "No automatic prerequisite task could be scheduled.",
        "releasedAt": "2026-10-04T00:33:59Z",
        "canResume": true
      }');

      create function public.get_automatic_article_focus()
      returns jsonb language sql stable as $$
        select payload from public.focus_payload_source limit 1
      $$;

      create function public.article_automation_work_readiness(uuid)
      returns jsonb language sql stable as $$
        select '{
          "state": "waiting_prerequisites",
          "missingPrerequisites": ["company_name", "competitor_content_or_url"],
          "nextRequiredStage": "competitor_extraction",
          "stageScheduled": false
        }'::jsonb
      $$;

      create function public.content_writing_automation_schema_version()
      returns integer language sql immutable as $$ select 21 $$;
    `);

    await db.exec(await readFile(migrationUrl, 'utf8'));

    const released = (await db.query<{ value: Record<string, unknown> }>(
      'select public.get_automatic_article_focus() value',
    )).rows[0].value;
    assert.equal(released.laneAvailable, true);
    assert.equal(released.articleId, null);
    assert.equal(released.currentStage, null);
    assert.equal(released.reviewArticleId, '10000000-0000-4000-8000-000000000001');
    assert.deepEqual(released.reviewMissingPrerequisites, [
      'company_name',
      'competitor_content_or_url',
    ]);
    assert.equal(released.reviewNextRequiredStage, 'competitor_discovery');
    assert.equal(released.reviewStageScheduled, false);

    await db.query(`update public.focus_payload_source set payload = '{
      "articleId": "20000000-0000-4000-8000-000000000002",
      "articleTitle": "Active article",
      "state": "active",
      "currentStage": "duplicate_cleanup",
      "lastArticleId": null
    }'::jsonb`);
    const active = (await db.query<{ value: Record<string, unknown> }>(
      'select public.get_automatic_article_focus() value',
    )).rows[0].value;
    assert.equal(active.laneAvailable, false);
    assert.equal(active.currentStage, 'duplicate_cleanup');
    assert.equal(active.reviewArticleId, null);
    assert.deepEqual(active.reviewMissingPrerequisites, []);
    assert.equal((await db.query<{ version: number }>(
      'select public.content_writing_automation_schema_version() version',
    )).rows[0].version, 22);
  } finally {
    await db.close();
  }
});
