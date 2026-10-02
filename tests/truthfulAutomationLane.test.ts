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
