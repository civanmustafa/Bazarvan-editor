import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { fillEmptyCompetitorTextSlots, fillEmptyCompetitorUrlSlots } from '../utils/competitorTextSlots.ts';
import { COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT } from '../utils/competitorContent.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const articleId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const source = (name: string) => ({ url: `https://${name}.example/article`, canonicalUrl: `https://${name}.example/article`, domain: `${name}.example` });

test('manual extraction executes non-destructively in PostgreSQL', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.profiles (id uuid primary key);
      create table public.articles (id uuid primary key, owner_id uuid, metadata jsonb default '{}');
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid, requested_by uuid,
        job_type text, origin text, status text, idempotency_key text, batch_key text,
        sequence_number integer, readiness_signature text, input_snapshot jsonb, progress jsonb,
        next_attempt_at timestamptz
      );
      create function public.article_access_level_for_user(article uuid, requester uuid)
      returns text language sql as 'select case when owner_id = requester then ''write'' end from articles where id = article';
    `);
    const original = await read('supabase/migrations/20260714000000_competitor_discovery.sql');
    await db.exec(original.slice(original.indexOf('create table if not exists public.article_competitors'), original.indexOf('create index if not exists article_competitors_article_status_idx')));
    await db.exec(original.slice(original.indexOf('create or replace function public.merge_article_competitors_metadata'), original.indexOf('create or replace function public.enqueue_competitor_extraction_job')));
    await db.exec(await read('supabase/migrations/20260904000000_preserve_manual_competitor_extraction.sql'));
    await db.query('insert into profiles values ($1)', [userId]);
    const reset = async (metadata = {}) => {
      await db.exec('truncate ai_external_analysis_jobs, article_competitors, articles;');
      await db.query('insert into articles (id, owner_id, metadata) values ($1, $2, $3)', [articleId, userId, metadata]);
    };
    const save = async (position: number, name: string, text: string, status = 'completed') => {
      const url = source(name).url;
      await db.query(`insert into article_competitors
        (article_id, position, source_url, canonical_url, domain, content_text, word_count, status)
        values ($1, $2, $3, $3, $4, $5, $6, $7)`, [articleId, position, url, `${name}.example`, text, text ? 10 : 0, status]);
    };
    const rows = async () => (await db.query<any>('select * from article_competitors order by position')).rows;
    const enqueue = async (names: string[], requester = userId) => (await db.query<{ result: any }>(
      'select public.enqueue_manual_competitor_extraction_job($1, $2, $3, $4, $5) as result',
      [articleId, requester, 'title', 'عنوان المقالة', names.map(source)],
    )).rows[0].result;
    const expectFailure = async (names: string[], pattern: RegExp, requester = userId) => {
      const before = await rows();
      await assert.rejects(enqueue(names, requester), pattern);
      assert.deepEqual(await rows(), before);
    };

    await t.test('keeps the first extracted text and fills the second slot', async () => {
      await reset(); await save(1, 'first', 'النص الأصلي المحفوظ');
      const before = (await rows())[0];
      const result = await enqueue(['second']);
      const after = await rows();
      assert.deepEqual(after[0], before);
      assert.equal(after[1].position, 2);
      assert.equal(after[1].canonical_url, source('second').url);
      assert.equal(result.queuedCount, 1);
      assert.deepEqual(result.job.input_snapshot.competitorIds, [after[1].id]);
      assert.equal(result.job.input_snapshot.preserveExisting, true);
      const article = (await db.query<any>('select metadata from articles')).rows[0];
      assert.equal(article.metadata.attachments.competitors.texts[0], before.content_text);
    });
    await t.test('selecting an already saved source is a no-op, not a paid repeat', async () => {
      await reset(); await save(1, 'first', 'saved content');
      const before = await rows(); const result = await enqueue(['first']);
      assert.deepEqual(await rows(), before);
      assert.equal(result.queuedCount, 0); assert.equal(result.job, null);
      assert.equal(result.preservedCount, 1);
    });
    await t.test('fills a hole without renumbering later saved texts', async () => {
      await reset(); await save(1, 'first', 'first'); await save(3, 'third', 'third');
      const before = await rows(); await enqueue(['second']); const after = await rows();
      assert.deepEqual(after[0], before[0]); assert.deepEqual(after[2], before[1]);
      assert.equal(after[1].canonical_url, source('second').url);
    });
    await t.test('retries a selected failed URL in place before allocating new URLs', async () => {
      await reset(); await save(1, 'first', 'saved');
      await save(2, 'retry', COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT, 'failed');
      await enqueue(['new', 'retry']); const after = await rows();
      assert.equal(after[1].canonical_url, source('retry').url);
      assert.equal(after[1].status, 'queued'); assert.equal(after[1].content_text, '');
      assert.equal(after[2].canonical_url, source('new').url);
    });
    await t.test('overflow rolls back even allocations made earlier in the request', async () => {
      await reset(); for (let i = 1; i <= 4; i++) await save(i, `saved${i}`, `text ${i}`);
      await expectFailure(['new1', 'new2'], /competitor_slots_full/);
      assert.equal((await db.query('select * from ai_external_analysis_jobs')).rows.length, 0);
      await save(5, 'saved5', 'text 5');
      await expectFailure(['new1'], /competitor_slots_full/);
    });
    await t.test('duplicate selected URLs consume one slot and one extraction', async () => {
      await reset(); const result = await enqueue(['new', 'new']);
      assert.equal(result.queuedCount, 1); assert.equal((await rows()).length, 1);
    });
    await t.test('adopts legacy manual text, including text without a URL', async () => {
      await reset({ attachments: { competitors: { texts: ['legacy one', 'legacy two'], urls: [source('first').url, ''] } } });
      await enqueue(['new']); const after = await rows();
      assert.equal(after[0].content_text, 'legacy one'); assert.equal(after[1].content_text, 'legacy two');
      assert.equal(after[1].status, 'completed'); assert.equal(after[2].position, 3);
    });
    await t.test('does not resurrect deleted managed projection texts', async () => {
      await reset({ attachments: { competitors: { managedBy: 'competitor_discovery', texts: ['deleted'], urls: [source('old').url] } } });
      await enqueue(['new']); const after = await rows();
      assert.equal(after.length, 1); assert.equal(after[0].canonical_url, source('new').url);
    });
    await t.test('active jobs and unauthorized users cannot alter the selection', async () => {
      await reset(); await save(1, 'first', 'saved'); await enqueue(['second']);
      await expectFailure(['third'], /active competitor extraction/);
      await expectFailure(['third'], /write access/, '00000000-0000-4000-8000-000000000003');
    });
    await t.test('browser database roles cannot bypass the authenticated API', async () => {
      const result = await db.query<{ allowed: boolean }>(`select
        has_function_privilege('anon', 'public.enqueue_manual_competitor_extraction_job(uuid,uuid,text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.enqueue_manual_competitor_extraction_job(uuid,uuid,text,text,jsonb)', 'execute') as allowed`);
      assert.equal(result.rows[0].allowed, false);
    });
  } finally {
    await db.close();
  }
});

test('bulk text import uses only empty slots and leaves overflow recoverable', () => {
  assert.deepEqual(fillEmptyCompetitorTextSlots(['first', '', 'third', '', ''], ['new']), {
    texts: ['first', 'new', 'third', '', ''], inserted: [1], remaining: [],
  });
  assert.deepEqual(fillEmptyCompetitorTextSlots(['first', '', 'third'], ['first', 'new', 'overflow']), {
    texts: ['first', 'new', 'third'], inserted: [1], remaining: ['overflow'],
  });
  assert.deepEqual(fillEmptyCompetitorTextSlots(['saved', COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT, ''], ['new'], [1]), {
    texts: ['saved', COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT, 'new'], inserted: [2], remaining: [],
  });
});

test('manual API and worker use additive allocation and scoped extraction', async () => {
  const api = await read('api/competitors.ts');
  const worker = await read('server/competitorExtractionExecutor.ts');
  const sidebar = await read('components/RightSidebar.tsx');
  assert.match(api, /rpc\('enqueue_manual_competitor_extraction_job'/);
  assert.doesNotMatch(api, /rpc\('enqueue_competitor_extraction_job'/);
  assert.match(worker, /const rows = allRows\.filter\(isRequestedRow\)/);
  assert.match(worker, /inputSnapshot\.preserveExisting !== true \|\| requestedIds\.has\(row\.id\)/);
  assert.match(worker, /new Set\(allRows\.flatMap/);
  assert.match(sidebar, /fillEmptyCompetitorTextSlots\(competitorTexts, sections/);
  assert.doesNotMatch(sidebar, /sections\[index\] \|\| prev\[index\]/);
  assert.doesNotMatch(sidebar, /normalizedUrls\[index\] \|\| prev\[index\]/);
});

test('bulk link import preserves URL/text pairs and in-flight slots', () => {
  assert.deepEqual(fillEmptyCompetitorUrlSlots(['first', '', ''], ['saved', '', ''], ['second']), {
    urls: ['first', 'second', ''], inserted: [1], remaining: [],
  });
  assert.deepEqual(fillEmptyCompetitorUrlSlots(['', '', ''], ['text-only source', '', ''], ['new', 'overflow'], [1]), {
    urls: ['', '', 'new'], inserted: [2], remaining: ['overflow'],
  });
  assert.deepEqual(fillEmptyCompetitorUrlSlots(['first', 'second'], ['saved', ''], ['first', 'third']), {
    urls: ['first', 'second'], inserted: [], remaining: ['third'],
  });
});
