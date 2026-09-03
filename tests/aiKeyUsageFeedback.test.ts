import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAiModelKeyReports,
  collectAiKeyUsageEntries,
  formatAiKeySuffix,
  notifyAiKeyUsageFeedback,
} from '../utils/aiKeyUsageFeedback.ts';
import {
  beginAiExecutionActivity,
  clearAiExecutionActivities,
  finishAiExecutionActivity,
  getAiExecutionActivities,
  getAiExecutionActivitiesForArticle,
  getRunningAiExecutionActivities,
  getVisibleAiExecutionMessage,
  removeAiExecutionActivity,
  requestAiExecutionActivityCancel,
  resetAiExecutionActivitiesForTests,
  summarizeAiExecutionModelAttempts,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity.ts';

test('AI activity display hides duplicated live key details but keeps useful messages', () => {
  resetAiExecutionActivitiesForTests();
  const activity = beginAiExecutionActivity({
    id: 'display-deduplication',
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    keySuffix: 'KEYipE',
    currentKeyIndex: 1,
    keyCount: 13,
    surface: 'goal_context_generation',
    action: 'توليد سياق هدف الصفحة',
    message: 'تجربة المفتاح 1 من 13 (...ipE) للنموذج gemini-3.5-flash.',
  });

  assert.equal(
    getVisibleAiExecutionMessage(activity, 'توليد سياق هدف الصفحة', 'توليد سياق هدف الصفحة'),
    '',
  );
  assert.equal(
    getVisibleAiExecutionMessage(
      { ...activity, message: 'توليد سياق هدف الصفحة' },
      'توليد سياق هدف الصفحة',
      'توليد سياق هدف الصفحة',
    ),
    '',
  );
  assert.equal(
    getVisibleAiExecutionMessage(
      { ...activity, message: 'انتهت مهلة الاتصال وسيعاد المحاولة تلقائيًا.' },
      'توليد سياق هدف الصفحة',
      'توليد سياق هدف الصفحة',
    ),
    'انتهت مهلة الاتصال وسيعاد المحاولة تلقائيًا.',
  );
});

test('AI key feedback keeps failed rotations and the successful key suffix', () => {
  const entries = collectAiKeyUsageEntries({
    keySuffix: 'SUCCESS1',
    attempts: [
      { keySuffix: 'FAILED01', status: 429, reason: 'quota', model: 'gemini-test' },
      { keySuffix: 'FAILED02', status: 401, reason: 'auth', model: 'gemini-test' },
    ],
  }, 'success');

  assert.deepEqual(entries.map(entry => [entry.keySuffix, entry.outcome, entry.status]), [
    ['CCESS1', 'success', undefined],
    ['ILED01', 'failed', 429],
    ['ILED02', 'failed', 401],
  ]);
});

test('AI key feedback reads nested content-writing execution metadata', () => {
  const feedback = notifyAiKeyUsageFeedback({
    provider: 'Gemini Pro',
    status: 200,
    payload: {
      result: [{
        execution: {
          status: 200,
          keySuffix: '1234',
          providerMetadata: {
            attempts: [{ keySuffix: '9876', status: 503, reason: 'server' }],
          },
        },
      }],
    },
  });

  assert.ok(feedback);
  assert.deepEqual(feedback.entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['1234', 'success'],
    ['9876', 'failed'],
  ]);
  assert.equal(formatAiKeySuffix('...abcdefghi'), '••••defghi');
});

test('content-writing audit groups safe key attempts and availability by model', () => {
  const reports = collectAiModelKeyReports({
    execution: {
      providerMetadata: {
        attempts: [
          { keySuffix: 'FAIL01', status: 503, reason: 'server', model: 'gemini-a' },
          { keySuffix: 'FAIL02', status: 429, reason: 'quota', model: 'gemini-b' },
        ],
        modelKeyReports: [
          {
            model: 'gemini-a',
            status: 'exhausted',
            configuredKeyCount: 13,
            attemptedKeyCount: 1,
            attemptCount: 1,
            availabilityCheckCount: 2,
            waitedMs: 60_000,
            keyAttempts: [
              { keySuffix: 'FAIL01', outcome: 'failed', status: 503, reason: 'server' },
            ],
            lastAvailability: {
              source: 'supabase',
              configuredCount: 13,
              excludedCount: 1,
              inactiveCount: 0,
              disabledCount: 2,
              leasedCount: 3,
              cooldownCount: 7,
              eligibleCount: 0,
              nextEligibleAt: '2026-08-12T12:00:00.000Z',
            },
          },
          {
            model: 'gemini-b',
            status: 'succeeded',
            configuredKeyCount: 13,
            attemptedKeyCount: 2,
            attemptCount: 2,
            availabilityCheckCount: 0,
            waitedMs: 0,
            successfulKeySuffix: 'GOOD03',
            keyAttempts: [
              { keySuffix: 'FAIL02', outcome: 'failed', status: 429, reason: 'quota' },
              { keySuffix: 'GOOD03', outcome: 'success', status: 200 },
            ],
            lastAvailability: null,
          },
        ],
      },
    },
  });

  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0].entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['FAIL01', 'failed'],
  ]);
  assert.equal(reports[0].lastAvailability?.leasedCount, 3);
  assert.equal(reports[0].waitedMs, 60_000);
  assert.deepEqual(reports[1].entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['FAIL02', 'failed'],
    ['GOOD03', 'success'],
  ]);
});

test('AI key feedback includes credential and provider fallback suffixes', () => {
  const entries = collectAiKeyUsageEntries({
    keySuffix: 'FREE04',
    status: 200,
    credentialFallbackChain: [
      { keySuffix: 'ADMIN1', status: 401, outcome: 'failed', model: 'openai-test' },
      { keySuffix: 'HOST02', status: 429, outcome: 'failed', model: 'openai-test' },
    ],
    providerFallbackChain: [
      { keySuffix: 'PRO003', status: 503, outcome: 'failed', model: 'gemini-paid-test' },
      { keySuffix: 'FREE04', status: 200, outcome: 'success', model: 'gemini-free-test' },
    ],
  });

  assert.deepEqual(
    entries.map(entry => [entry.keySuffix, entry.outcome, entry.status]),
    [
      ['FREE04', 'success', 200],
      ['ADMIN1', 'failed', 401],
      ['HOST02', 'failed', 429],
      ['PRO003', 'failed', 503],
    ],
  );
});

test('unified AI activity follows live key, model, and paid-to-free fallback state', () => {
  resetAiExecutionActivitiesForTests();
  const started = beginAiExecutionActivity({
    id: 'activity-test',
    provider: 'geminiPaid',
    requestedProvider: 'geminiPaid',
    model: 'gemini-paid-test',
    requestedModel: 'gemini-paid-test',
    surface: 'quick_provider',
  });
  assert.equal(started.state, 'running');
  assert.equal(started.credentialTier, 'paid');

  const rotating = updateAiExecutionActivity('activity-test', {
    progress: {
      stage: 'failed-key',
      provider: 'geminiPaid',
      model: 'gemini-paid-test',
      currentKeyIndex: 1,
      keyCount: 2,
      keySuffix: 'PAID01',
      status: 429,
      completed: false,
    },
    completed: false,
  });
  assert.equal(rotating.state, 'running');
  assert.equal(rotating.keySuffix, 'PAID01');
  assert.deepEqual(rotating.entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['PAID01', 'failed'],
  ]);

  const completed = finishAiExecutionActivity('activity-test', {
    provider: 'gemini',
    requestedProvider: 'geminiPaid',
    model: 'gemini-free-test',
    requestedModel: 'gemini-paid-test',
    httpStatus: 200,
    outcome: 'success',
    payload: {
      provider: 'gemini',
      model: 'gemini-free-test',
      keySuffix: 'FREE02',
      status: 200,
      providerFallbackChain: [
        { provider: 'geminiPaid', model: 'gemini-paid-test', keySuffix: 'PAID01', status: 429 },
        { provider: 'gemini', model: 'gemini-free-test', keySuffix: 'FREE02', status: 200 },
      ],
    },
  });

  assert.equal(completed.state, 'success');
  assert.equal(completed.credentialTier, 'free');
  assert.equal(completed.requestedProvider, 'geminiPaid');
  assert.equal(completed.provider, 'gemini');
  assert.equal(completed.model, 'gemini-free-test');
  assert.equal(completed.keySuffix, 'FREE02');
  assert.ok(completed.entries.some(entry => entry.keySuffix === 'PAID01' && entry.outcome === 'failed'));
  assert.ok(completed.entries.some(entry => entry.keySuffix === 'FREE02' && entry.outcome === 'success'));
  assert.equal(getAiExecutionActivities()[0].id, 'activity-test');
});

test('durable AI activity keeps authoritative server timestamps across polling', () => {
  resetAiExecutionActivitiesForTests();
  const started = beginAiExecutionActivity({
    id: 'durable-timestamps',
    state: 'running',
    stage: 'queued',
    startedAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:05.000Z',
  });
  assert.equal(started.startedAt, '2026-09-02T08:00:00.000Z');
  assert.equal(started.updatedAt, '2026-09-02T08:00:05.000Z');

  const polled = updateAiExecutionActivity(started.id, {
    completed: false,
    stage: 'queued',
    startedAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:05.000Z',
  });
  assert.equal(polled.startedAt, '2026-09-02T08:00:00.000Z');
  assert.equal(polled.updatedAt, '2026-09-02T08:00:05.000Z');

  const completed = finishAiExecutionActivity(started.id, {
    outcome: 'success',
    updatedAt: '2026-09-02T08:04:00.000Z',
    completedAt: '2026-09-02T08:03:59.000Z',
  });
  assert.equal(completed.updatedAt, '2026-09-02T08:04:00.000Z');
  assert.equal(completed.completedAt, '2026-09-02T08:03:59.000Z');
});

test('expanded AI activity summarizes successful and failed attempts by model', () => {
  const models = summarizeAiExecutionModelAttempts({
    requestedModel: 'gemini-pro-test',
    model: 'gemini-flash-test',
    entries: [
      { keySuffix: 'PAID01', outcome: 'failed', status: 429, model: 'gemini-pro-test' },
      { keySuffix: 'PAID02', outcome: 'failed', status: 503, model: 'gemini-pro-test' },
      { keySuffix: 'FREE01', outcome: 'failed', status: 429, model: 'gemini-flash-test' },
      { keySuffix: 'FREE02', outcome: 'success', status: 200, model: 'gemini-flash-test' },
    ],
  });

  assert.deepEqual(models, [
    {
      model: 'gemini-pro-test',
      successCount: 0,
      failureCount: 2,
      isCurrent: false,
    },
    {
      model: 'gemini-flash-test',
      successCount: 1,
      failureCount: 1,
      isCurrent: true,
    },
  ]);
});

test('AI activity selectors isolate the open article while keeping every dashboard task', () => {
  resetAiExecutionActivitiesForTests();
  const firstArticle = beginAiExecutionActivity({
    id: 'article-one-task',
    articleId: 'article-one',
    articleTitle: 'المقالة الأولى',
    surface: 'content_writing',
  });
  const secondArticle = beginAiExecutionActivity({
    id: 'article-two-task',
    articleId: 'article-two',
    articleTitle: 'المقالة الثانية',
    surface: 'smart_analysis',
  });
  const draftArticle = beginAiExecutionActivity({
    id: 'draft-task',
    articleKey: 'مسودة محلية',
    surface: 'draft_title_generation',
  });
  finishAiExecutionActivity(firstArticle.id, { outcome: 'success' });

  const activities = getAiExecutionActivities();
  assert.deepEqual(
    getAiExecutionActivitiesForArticle(activities, 'article-two').map(activity => activity.id),
    [secondArticle.id],
  );
  assert.deepEqual(
    getAiExecutionActivitiesForArticle(activities, null, 'مسودة محلية').map(activity => activity.id),
    [draftArticle.id],
  );
  assert.deepEqual(
    getRunningAiExecutionActivities(activities).map(activity => activity.id).sort(),
    [draftArticle.id, secondArticle.id].sort(),
  );
});

test('AI activity store keeps every running task beyond the terminal history limit', () => {
  resetAiExecutionActivitiesForTests();
  for (let index = 0; index < 30; index += 1) {
    beginAiExecutionActivity({
      id: `parallel-dashboard-task-${index}`,
      articleId: `article-${index}`,
      surface: 'engineering_command',
    });
  }
  assert.equal(getRunningAiExecutionActivities(getAiExecutionActivities()).length, 30);
});

test('AI activity removal clears stale background tasks and their cancel handler', async () => {
  resetAiExecutionActivitiesForTests();
  beginAiExecutionActivity({
    id: 'stale-dashboard-task',
    articleId: 'article-stale',
    surface: 'automatic_content_writing',
    cancel: async () => undefined,
  });

  assert.equal(removeAiExecutionActivity('stale-dashboard-task'), true);
  assert.deepEqual(getAiExecutionActivities(), []);
  const ignoredLateUpdate = updateAiExecutionActivity('stale-dashboard-task', {
    stage: 'reconnecting',
    completed: false,
  });
  assert.equal(ignoredLateUpdate.id, 'stale-dashboard-task');
  assert.deepEqual(getAiExecutionActivities(), []);
  await assert.rejects(
    requestAiExecutionActivityCancel('stale-dashboard-task'),
    /ليست نشطة/,
  );
  assert.equal(removeAiExecutionActivity('stale-dashboard-task'), false);

  beginAiExecutionActivity({ id: 'old-session-one', surface: 'quick_provider' });
  beginAiExecutionActivity({ id: 'old-session-two', surface: 'content_writing' });
  assert.equal(clearAiExecutionActivities(), 2);
  assert.deepEqual(getAiExecutionActivities(), []);
  updateAiExecutionActivity('old-session-one', { completed: false, stage: 'reconnecting' });
  assert.deepEqual(getAiExecutionActivities(), []);

  beginAiExecutionActivity({ id: 'old-session-one', surface: 'quick_provider' });
  assert.deepEqual(getAiExecutionActivities().map(activity => activity.id), ['old-session-one']);
});

test('unified AI activity identifies its article and stops the original operation', async () => {
  resetAiExecutionActivitiesForTests();
  let cancellationCount = 0;
  const started = beginAiExecutionActivity({
    id: 'identified-activity',
    articleId: 'article-123',
    articleTitle: 'دليل التحول الرقمي',
    articleKey: 'digital-transformation',
    commandId: 'commands-bundle',
    surface: 'engineering_command',
    action: 'حزمة الأوامر الهندسية',
    cancel: async () => {
      cancellationCount += 1;
    },
  });

  assert.equal(started.articleTitle, 'دليل التحول الرقمي');
  assert.equal(started.articleId, 'article-123');
  assert.equal(started.cancellable, true);

  const updated = updateAiExecutionActivity(started.id, {
    stage: 'running',
    completed: false,
  });
  assert.equal(updated.articleTitle, 'دليل التحول الرقمي');
  assert.equal(updated.cancellable, true);

  const cancelled = await requestAiExecutionActivityCancel(started.id);
  assert.equal(cancellationCount, 1);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.httpStatus, 499);
  assert.equal(cancelled.cancellable, false);

  const lateProgress = updateAiExecutionActivity(started.id, {
    stage: 'running',
    completed: false,
    message: 'late update',
  });
  assert.equal(lateProgress.state, 'cancelled');
  assert.equal(lateProgress.stage, 'cancelled');
});
