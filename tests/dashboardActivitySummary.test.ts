import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

test('dashboard user filtering exposes the full matching result set and page size', async () => {
  const [dashboard, migration] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('supabase/migrations/20261012010000_complete_dashboard_user_filter.sql'),
  ]);

  assert.match(dashboard, /name === 'profileId' && value !== 'all'[\s\S]*setArticleStatusTab\('all'\)/);
  assert.match(dashboard, /const \[articlesPageSize, setArticlesPageSize\]/);
  assert.match(dashboard, /<option value="10">10<\/option>[\s\S]*<option value="25">25<\/option>[\s\S]*<option value="50">50<\/option>/);
  assert.match(dashboard, /في هذه الصفحة من أصل \{articlesTotalLabel\} نتيجة مطابقة/);
  assert.match(dashboard, /activeArticleFilterLabels/);
  assert.match(migration, /from public\.article_access as access_row/);
  assert.match(migration, /access_row\.article_id = article\.id/);
  assert.match(migration, /access_row\.user_id::text = v_filters->>''profileId''/);
});

test('dashboard user filter migration safely upgrades the existing RPC definition', async () => {
  const db = new PGlite();
  const migration = await readWorkspaceFile('supabase/migrations/20261012010000_complete_dashboard_user_filter.sql');

  await db.exec(`
    create table public.articles (id uuid primary key, assigned_to uuid);
    create table public.article_access (article_id uuid, user_id uuid);
    create or replace function public.list_dashboard_articles_page(
      p_page integer default 1,
      p_page_size integer default 10,
      p_search text default '',
      p_mode text default 'all',
      p_trash boolean default false,
      p_filters jsonb default '{}'::jsonb
    ) returns jsonb language plpgsql as $$
    declare
      v_filters jsonb := p_filters;
    begin
      perform 1
      from public.articles as article
      where (
        coalesce(v_filters->>'profileId', 'all') = 'all'
        or article.assigned_to::text = v_filters->>'profileId'
      );
      return '{}'::jsonb;
    end;
    $$;
  `);
  await db.exec(migration);

  const result = await db.query<{ definition: string }>(`
    select pg_get_functiondef(
      'public.list_dashboard_articles_page(integer,integer,text,text,boolean,jsonb)'::regprocedure::oid
    ) as definition
  `);
  assert.match(result.rows[0]?.definition || '', /from public\.article_access as access_row/);
  await db.close();
});

test('dashboard search normalizes Arabic variants and Latin case within the active status tab', async () => {
  const [dashboard, baseMigration, searchMigration] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql'),
    readWorkspaceFile('supabase/migrations/20261015000000_normalize_dashboard_search.sql'),
  ]);
  const db = new PGlite();

  await db.exec(`
    create role authenticated;
    create role anon;
    create or replace function public.list_dashboard_articles_page(
      p_page integer default 1,
      p_page_size integer default 10,
      p_search text default '',
      p_mode text default 'all',
      p_trash boolean default false,
      p_filters jsonb default '{}'::jsonb
    ) returns jsonb language plpgsql as $$
    declare
      v_search text := lower(btrim(coalesce(p_search, '')));
    begin
      if v_search = '' or position(v_search in lower(concat_ws(' ', 'sample'))) > 0 then
        return jsonb_build_object('matched', true);
      end if;
      return jsonb_build_object('matched', false);
    end;
    $$;
  `);
  await db.exec(searchMigration);

  const result = await db.query<{
    arabic_forward: boolean;
    arabic_reverse: boolean;
    hamza_below: boolean;
    latin_case: boolean;
  }>(`
    select
      public.normalize_dashboard_search_text('أوروبية') = public.normalize_dashboard_search_text('اوروبية') as arabic_forward,
      public.normalize_dashboard_search_text('اوروبية') = public.normalize_dashboard_search_text('أوروبية') as arabic_reverse,
      public.normalize_dashboard_search_text('إنفعال') = public.normalize_dashboard_search_text('انفعال') as hamza_below,
      public.normalize_dashboard_search_text('EUROPE') = public.normalize_dashboard_search_text('europe') as latin_case
  `);

  assert.deepEqual(result.rows[0], {
    arabic_forward: true,
    arabic_reverse: true,
    hamza_below: true,
    latin_case: true,
  });
  assert.match(dashboard, /status: isTrashVisible \? 'all' : articleStatusTab/);
  assert.match(baseMigration, /coalesce\(v_filters->>'status', 'all'\) = 'all' or article\.status = v_filters->>'status'/);

  const definition = await db.query<{ definition: string }>(`
    select pg_get_functiondef(
      'public.list_dashboard_articles_page(integer,integer,text,text,boolean,jsonb)'::regprocedure::oid
    ) as definition
  `);
  assert.match(definition.rows[0]?.definition || '', /normalize_dashboard_search_text\(btrim\(p_search\)\)/);
  assert.match(definition.rows[0]?.definition || '', /normalize_dashboard_search_text\(concat_ws/);
  await db.close();
});

test('dashboard header actions share one size contract and data tools leave the header', async () => {
  const dashboard = await readWorkspaceFile('components/Dashboard.tsx');

  assert.match(dashboard, /dashboardHeaderButtonClass = "inline-flex h-11 min-w-\[148px\]/);
  assert.match(dashboard, /className=\{dashboardHeaderButtonClass\}[\s\S]*مركز المتابعة/);
  assert.match(dashboard, /className=\{dashboardHeaderPrimaryButtonClass\}/);
  assert.doesNotMatch(dashboard, /onClick=\{handleExportHtml\}/);
  assert.doesNotMatch(dashboard, /setIsConfirmModalOpen/);
});

test('the unified AI and automation card is rendered before the single activity summary card', async () => {
  const [dashboard, queue] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx'),
  ]);
  const queueIndex = dashboard.lastIndexOf('<AutomaticContentWritingQueuePanel');
  const summaryIndex = dashboard.lastIndexOf('<DashboardActivitySummary');

  assert.ok(queueIndex > 0);
  assert.ok(summaryIndex > queueIndex);
  assert.doesNotMatch(dashboard, /DashboardAiExecutionMonitor/);
  assert.match(queue, /<DashboardAiExecutionMonitor\s+embedded\s+isArabic=\{isArabic\}\s*\/>/);
  assert.match(dashboard, /externalAnalysisSummaries=\{externalAnalysisSummaries\}/);
  assert.match(dashboard, /articleTitles=\{dashboardArticleTitles\}/);
  assert.match(dashboard, /articleSnapshots=\{dashboardAutomationArticleSnapshots\}/);
});

test('the automation queue keeps every user-controlled operation visible in one box', async () => {
  const [component, queue, inventoryMigration, API] = await Promise.all([
    readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx'),
    readWorkspaceFile('utils/dashboardAutomationQueue.ts'),
    readWorkspaceFile('supabase/migrations/20261004000000_draft_only_automation_stage_inventory.sql'),
    readWorkspaceFile('api/contentWritingAutomation.ts'),
  ]);

  assert.match(component, /data-ai-automation-status="true"/);
  assert.match(component, /data-automation-status-stale=/);
  assert.match(component, /data-automation-refresh-warning="true"/);
  assert.match(component, /البيانات الظاهرة هي آخر حالة ناجحة/);
  assert.match(component, /ستتم إعادة المحاولة تلقائيًا خلال 30 ثانية/);
  assert.doesNotMatch(component, /<span>\{getContentWritingAutomationErrorMessage\(error, isArabic\)\}<\/span>/);
  assert.match(component, /data-automation-operations-queue="true"/);
  assert.match(component, /حالة الذكاء الاصطناعي وطابور العمليات/);
  assert.match(component, /المهام الحية للذكاء الاصطناعي|DashboardAiExecutionMonitor/);
  assert.match(component, /حالة جميع مراحل الأتمتة/);
  assert.match(component, /operations\.map\(renderOperation\)/);
  assert.match(component, /createPortal\(/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /event\.key === 'Escape'/);
  assert.match(component, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(component, /attention: countDashboardAutomationIssues\(operations\)/);
  assert.match(component, /getOperationErrorMessage\(operation, isArabic\)/);
  assert.match(component, /إدارة الأتمتة/);
  assert.match(component, /loadContentWritingAutomationStatus\(undefined, \{ draftOnly: true \}\)/);
  assert.match(component, /loadAutomaticRecoverySchedule\(\)/);
  assert.match(API, /action === 'recovery_status'/);
  assert.match(queue, /status === 'draft'/);
  assert.match(API, /body\.draftOnly === true/);
  assert.match(inventoryMigration, /where evidence\.article_status = 'draft'/);
  assert.match(inventoryMigration, /'articleStatus', filtered\.article_status/);
  for (const operation of [
    'alternative_keywords',
    'lsi_keywords',
    'google_metadata',
    'competitor_discovery',
    'competitor_extraction',
    'external_analysis',
    'content_writing',
    'internal_linking',
  ]) {
    assert.match(queue, new RegExp(`'${operation}'`));
  }
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

test('dashboard and monitoring center use the same activity summary engine', async () => {
  const [dashboard, admin, client] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/AdminApp.tsx'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
  ]);

  assert.match(dashboard, /loadDashboardActivitySummary\(\)/);
  assert.match(admin, /loadDashboardActivitySummary\(\)/);
  assert.match(admin, /activitySummaryByUserId\.get\(profile\.id\)/);
  assert.match(admin, /summary\?\.articleCount/);
  assert.match(admin, /summary\?\.totalTimeSeconds/);
  assert.match(admin, /summary\?\.lastSeenAt/);
  assert.doesNotMatch(admin, /<UserRow[^>]+articles=/);
  assert.doesNotMatch(admin, /profileArticles\.reduce\(\(sum, article\) => sum \+ article\.timeSpentSeconds/);
  assert.equal((client.match(/rpc\('get_dashboard_activity_summary'\)/g) || []).length, 1);
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
