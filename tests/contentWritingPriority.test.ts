import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getContentWritingQueueMessage } from '../utils/contentWritingQueueMessage.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const userId = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const articleId = '00000000-0000-4000-8000-000000000003';

test('PostgreSQL manual writing priority and live queue diagnostics', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table profiles (id uuid primary key);
      create table articles (id uuid primary key, owner_id uuid);
      create function public.article_access_level_for_user(article uuid, requester uuid)
      returns text language sql as 'select case when owner_id = requester then ''write'' end from articles where id = article';
    `);
    const base = await read('supabase/migrations/20260722000000_content_writing_sessions.sql');
    await db.exec(base.slice(base.indexOf('create table if not exists public.content_writing_sessions'), base.indexOf('create table if not exists public.content_writing_messages')));
    await db.exec(await read('supabase/migrations/20260905000000_manual_content_writing_priority.sql'));
    await db.query('insert into profiles values ($1)', [userId]);
    await db.query('insert into articles values ($1, $2)', [articleId, userId]);
    let sequence = 0;
    const reset = () => db.exec('truncate content_writing_sessions');
    const enqueue = async (origin: string | null, ageSeconds: number, extra: Record<string, unknown> = {}) => {
      const result = await db.query<any>(`insert into content_writing_sessions (
        article_id, created_by, provider, model, idempotency_key, max_input_tokens, input_hash,
        context_snapshot, progress, next_attempt_at, created_at, status, lease_expires_at, locked_by, cancel_requested_at
      ) values ($1,$2,'gemini','test',$3,1000,$4,$5,$6,now()-make_interval(secs=>$7),now()-make_interval(secs=>$7),
        $8,case when $9::integer is null then null else now()+make_interval(secs=>$9) end,$10,
        case when $11::boolean then now() else null end) returning *`, [
        articleId, userId, `manual-priority-${++sequence}`, 'a'.repeat(64),
        origin ? { triggerSource: origin } : {}, extra.progress || {}, ageSeconds,
        extra.status || 'queued', extra.leaseSeconds ?? null, extra.worker || null, extra.cancel === true,
      ]);
      return result.rows[0];
    };
    const claim = async () => (await db.query<any>("select * from claim_next_content_writing_session('test-worker',900)")).rows[0];
    const state = async (id: string, requester = userId) => (await db.query<any>(
      'select * from get_content_writing_queue_state($1,$2)', [[id], requester],
    )).rows[0]?.queue_state;

    await t.test('manual overtakes an older automatic request without modifying that request', async () => {
      await reset(); const automatic = await enqueue('automatic_ready', 200); const manual = await enqueue('manual', 10);
      assert.equal((await state(manual.id)).priority, 'manual');
      assert.equal((await state(manual.id)).reason, 'awaiting_worker');
      assert.equal((await state(automatic.id)).reason, 'earlier_requests');
      assert.equal((await claim()).id, manual.id);
      const unchanged = (await db.query<any>('select * from content_writing_sessions where id=$1', [automatic.id])).rows[0];
      assert.deepEqual(unchanged, automatic);
    });
    await t.test('healthy running session, result, lease and worker stay untouched', async () => {
      await reset(); const running = await enqueue('automatic_ready', 500, { status: 'running', leaseSeconds: 900, worker: 'original-worker' });
      await db.query("update content_writing_sessions set result_text='saved partial article' where id=$1", [running.id]);
      const before = (await db.query<any>('select * from content_writing_sessions where id=$1', [running.id])).rows[0];
      const manual = await enqueue('manual', 1);
      assert.equal((await state(manual.id)).reason, 'worker_busy');
      assert.equal((await claim()).id, manual.id); // Represents a free worker slot, not preemption.
      assert.deepEqual((await db.query<any>('select * from content_writing_sessions where id=$1', [running.id])).rows[0], before);
      assert.equal(await claim(), undefined); // Neither healthy lease is claimable again.
    });
    await t.test('future manual retry respects its cooldown while eligible automatic work can proceed', async () => {
      await reset(); const retry = await enqueue('manual', -900, { status: 'retry_scheduled' });
      const automatic = await enqueue('automatic_ready', 20);
      const diagnostic = await state(retry.id);
      assert.equal(diagnostic.reason, 'retry_delay');
      assert.ok(Date.parse(diagnostic.nextAttemptAt) > Date.now());
      assert.equal((await claim()).id, automatic.id); assert.equal(await claim(), undefined);
      await db.query("update content_writing_sessions set next_attempt_at=now()-interval '1 second' where id=$1", [retry.id]);
      assert.equal((await claim()).id, retry.id);
    });
    await t.test('FIFO within priority and queued cancellation remain intact', async () => {
      await reset(); const automatic = await enqueue('automatic_ready', 600);
      const first = await enqueue('manual', 120); const second = await enqueue('manual', 60);
      await enqueue('manual', 300, { cancel: true });
      assert.equal((await state(second.id)).reason, 'earlier_requests');
      assert.equal((await claim()).id, first.id); assert.equal((await claim()).id, second.id);
      assert.equal((await claim()).id, automatic.id); assert.equal(await claim(), undefined);
    });
    await t.test('expired leases remain recoverable, with saved output untouched', async () => {
      await reset(); const stale = await enqueue('manual', 100, { status: 'running', leaseSeconds: -1, worker: 'dead-worker', progress: { step: 4 } });
      const resumed = await claim(); assert.equal(resumed.id, stale.id);
      assert.equal(resumed.locked_by, 'test-worker'); assert.equal(resumed.attempt_count, 1);
      assert.equal(resumed.progress.step, 4);
    });
    await t.test('legacy manual sessions and explicit resumes are prioritized; pipelines are not mislabeled', async () => {
      await reset(); await enqueue('full_pipeline', 900); await enqueue('automatic_ready', 600);
      const resumed = await enqueue('automatic_ready', 100, { progress: { resumed: true } });
      const legacy = await enqueue(null, 50);
      assert.equal((await claim()).id, resumed.id); assert.equal((await claim()).id, legacy.id);
    });
    await t.test('diagnostics expose no other article data and require article access', async () => {
      await reset(); const session = await enqueue('manual', 1);
      assert.deepEqual(Object.keys(await state(session.id)).sort(), ['nextAttemptAt', 'observedAt', 'priority', 'reason']);
      assert.equal(await state(session.id, stranger), undefined);
      await assert.rejects(db.query('select * from get_content_writing_queue_state($1,$2)', [Array(51).fill(session.id), userId]), /at most 50/);
      const permissions = await db.query<{ allowed: boolean }>(`select exists (
        select 1 from unnest(array['anon','authenticated']) role_name,
          unnest(array['public.claim_next_content_writing_session(text,integer)','public.get_content_writing_queue_state(uuid[],uuid)']) signature
        where has_function_privilege(role_name,signature,'execute')
      ) as allowed`);
      assert.equal(permissions.rows[0].allowed, false);
    });
  } finally { await db.close(); }
});

test('queue explanation is localized, honest on diagnostic outages, and does not hide cooldowns', () => {
  const session = (reason: string) => ({ status: 'queued', progress: { queue: { reason, priority: 'manual', nextAttemptAt: '2026-09-02T12:00:00Z' } } });
  assert.match(getContentWritingQueueMessage(session('worker_busy')), /قيد التنفيذ.*أولوية.*دون قطع/);
  assert.match(getContentWritingQueueMessage(session('earlier_requests'), false), /ahead.*priority/);
  assert.match(getContentWritingQueueMessage(session('retry_delay')), /موعد إعادة المحاولة.*لا تتجاوز مهلة التهدئة/);
  assert.match(getContentWritingQueueMessage(session('awaiting_worker'), true, Date.parse('2026-09-02T12:03:00Z')), /يلزم فحص/);
  assert.doesNotMatch(getContentWritingQueueMessage(session('awaiting_worker'), true, Date.parse('2026-09-02T12:00:30Z')), /يلزم فحص/);
  assert.match(getContentWritingQueueMessage({ status: 'queued', progress: {} }), /لا حاجة لإرساله مجددًا/);
  assert.equal(getContentWritingQueueMessage({ status: 'running', progress: {} }), '');
  assert.equal(getContentWritingQueueMessage({ status: 'failed', progress: {} }), '');
});

test('all queue read paths and both UI surfaces use live diagnostics', async () => {
  const api = await read('api/contentWriting.ts');
  for (const action of ['start', 'getPreparation', 'get', 'resume']) {
    const block = api.split(`if (action === '${action}')`)[1]?.split('\n  if (action ===')[0] || '';
    assert.match(block, /await presentContentWritingSession\(/);
  }
  assert.match(api, /await presentContentWritingSessions\(sessions, principal.userId\)/);
  assert.match(await read('components/ContentWritingPanel.tsx'), /getContentWritingQueueMessage\(selectedSession, isArabic\)/);
  assert.match(await read('utils/contentWritingActivityMonitor.ts'), /getContentWritingQueueMessage\(session, options.isArabic/);
  assert.match(await read('server/contentWritingQueueState.ts'), /p_requested_by: requestedBy/);
});
