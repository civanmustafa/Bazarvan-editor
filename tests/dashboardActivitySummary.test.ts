import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

test('dashboard header actions share one size contract and data tools leave the header', async () => {
  const dashboard = await readWorkspaceFile('components/Dashboard.tsx');

  assert.match(dashboard, /dashboardHeaderButtonClass = "inline-flex h-11 min-w-\[148px\]/);
  assert.match(dashboard, /className=\{dashboardHeaderButtonClass\}[\s\S]*مركز المتابعة/);
  assert.match(dashboard, /className=\{dashboardHeaderPrimaryButtonClass\}/);
  assert.doesNotMatch(dashboard, /onClick=\{handleExportHtml\}/);
  assert.doesNotMatch(dashboard, /setIsConfirmModalOpen/);
});

test('queue and AI monitor are rendered before the single activity summary card', async () => {
  const dashboard = await readWorkspaceFile('components/Dashboard.tsx');
  const queueIndex = dashboard.lastIndexOf('<AutomaticContentWritingQueuePanel');
  const monitorIndex = dashboard.lastIndexOf('<DashboardAiExecutionMonitor');
  const summaryIndex = dashboard.lastIndexOf('<DashboardActivitySummary');

  assert.ok(queueIndex > 0);
  assert.ok(monitorIndex > queueIndex);
  assert.ok(summaryIndex > monitorIndex);
});

test('activity summary exposes global status and per-user article/time metrics', async () => {
  const [component, client, migration] = await Promise.all([
    readWorkspaceFile('components/DashboardActivitySummary.tsx'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
    readWorkspaceFile('supabase/migrations/20260829020000_dashboard_activity_summary.sql'),
  ]);

  assert.match(component, /data-dashboard-activity-summary="true"/);
  for (const status of ['content_preparation', 'draft', 'in_review', 'published', 'archived']) {
    assert.match(component, new RegExp(status));
  }
  assert.match(component, /summary\.users\.map/);
  assert.match(component, /user\.articleCount/);
  assert.match(component, /user\.totalTimeSeconds/);
  assert.match(client, /rpc\('get_dashboard_activity_summary'\)/);
  assert.match(migration, /public\.can_read_article\(article\.id\)/);
  assert.match(migration, /not public\.dashboard_article_is_trashed/);
  assert.match(migration, /'totalTimeSeconds'/);
  assert.match(migration, /'statusCounts'/);
  assert.match(migration, /'users'/);
});

test('HTML export and recoverable data clearing live in settings', async () => {
  const [settings, tools] = await Promise.all([
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('components/DashboardDataTools.tsx'),
  ]);

  assert.match(settings, /import DashboardDataTools/);
  assert.match(settings, /<DashboardDataTools \/>/);
  assert.match(tools, /data-dashboard-data-tools="true"/);
  assert.match(tools, /listRemoteArticles\(\)/);
  assert.match(tools, /moveRemoteArticleToTrash\(article\.id\)/);
  assert.match(tools, /article\.ownerId === currentUserId \|\| article\.createdBy === currentUserId/);
  assert.match(tools, /تصدير تقرير HTML/);
  assert.match(tools, /يمكن الاستعادة قبل انتهاء مدة الاحتفاظ/);
});
