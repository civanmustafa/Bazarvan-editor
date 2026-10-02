import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

test('temporary focus stalls recover inside the existing single master only', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261017000000_truthful_idle_lane_and_stall_recovery.sql',
  );

  assert.match(migration, /create or replace function public\.release_recoverable_automatic_focus_stalls/);
  assert.match(migration, /pause\.reason = 'focus_stalled'/);
  assert.match(migration, /unified_duplicate_cleanup_auto_ready/);
  assert.match(migration, /automatic_content_writing_requirement/);
  assert.match(migration, /article_automatic_policy_allows/);
  assert.match(migration, /auto_requeue_recoverable_automation_failures/);
  assert.match(migration, /article-automation-master-engine/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
  assert.match(migration, /select 14/);
});

test('the public inventory treats pauses and missing prerequisites truthfully', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261017000000_truthful_idle_lane_and_stall_recovery.sql',
  );
  const dashboardQueue = await readWorkspaceFile('utils/dashboardAutomationQueue.ts');
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');

  assert.match(migration, /rename to get_visible_automation_task_inventory_v13/);
  assert.match(migration, /'status', 'failed'/);
  assert.match(migration, /manual_review_focus_stalled/);
  assert.match(migration, /manual_review_terminal_failure/);
  assert.match(migration, /missing_company_name/);
  assert.match(migration, /missing_editor_text/);
  assert.match(migration, /missing_competitor_source/);
  assert.match(migration, /writing_requirement->>'required'/);
  assert.match(dashboardQueue, /const waitingCount = scheduledCount \+ readyCount;/);
  assert.doesNotMatch(dashboardQueue, /scheduledCount \+ readyCount \+ unscheduledCount/);
  assert.match(dashboardQueue, /\['ready', 'completed'\]\.includes\(computedStatus\)/);
  assert.match(panel, /غير مستوفٍ للشروط/);
});

test('current blockers are separated from historical errors and shown once at their root stage', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261018000000_current_blocker_and_historical_error.sql',
  );
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');
  const guard = await readWorkspaceFile('server/contentResearchAutomationGuard.ts');
  const worker = await readWorkspaceFile('server/externalAnalysisWorker.ts');

  assert.match(migration, /automatic_article_focus_pause_history/);
  assert.match(migration, /automatic_focus_pause_blocker_state/);
  assert.match(migration, /content_research_automation_changed/);
  assert.match(migration, /reclassified_as_prerequisite_wait/);
  assert.match(migration, /competitor_requirement_now_satisfied/);
  assert.match(migration, /release_reclassified_automatic_focus_pauses/);
  assert.match(migration, /defer_external_analysis_job_for_prerequisite/);
  assert.match(migration, /attempt_count = greatest\(0, job\.attempt_count - 1\)/);
  assert.match(migration, /resume_satisfied_automatic_prerequisite_jobs/);
  assert.match(migration, /article-automation-master-engine/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
  assert.match(migration, /blocked_by_upstream/);
  assert.match(migration, /historical_blocker_resolved/);
  assert.match(migration, /'currentBlocker'/);
  assert.match(migration, /'rootOperationKey'/);
  assert.match(migration, /select 15/);
  assert.match(taskNormalizer, /historicalResolvedAt/);
  assert.match(panel, /خطأ تاريخي تمت معالجته/);
  assert.match(panel, /هذه المرحلة لم تفشل/);
  assert.match(panel, /لا تُعد محاولة تنفيذ/);
  assert.match(guard, /ExternalAnalysisPrerequisiteError/);
  assert.match(worker, /deferExternalAnalysisJobForPrerequisite/);
});

test('unfinished task cards name exact requirements and the article holding lane priority', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261019000000_detailed_automation_prerequisites.sql',
  );
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');

  assert.match(migration, /rename to get_visible_automation_task_inventory_v15/);
  assert.match(migration, /'code', 'google_titles'/);
  assert.match(migration, /'code', 'google_descriptions'/);
  assert.match(migration, /'code', 'automatic_article_focus'/);
  assert.match(migration, /'blockedByArticleTitle'/);
  assert.match(migration, /select 16/);
  assert.match(panel, /المتطلبات أو النتائج الناقصة/);
  assert.match(panel, /سبب عدم البدء الآن/);
  assert.match(panel, /ستُعاد جدولة هذه المهمة تلقائيًا بعد تحرر المسار/);
  assert.match(taskNormalizer, /AutomationTaskRequirement/);
  assert.match(taskNormalizer, /blockedByArticleTitle/);
  assert.match(taskNormalizer, /blockedByState/);
});
