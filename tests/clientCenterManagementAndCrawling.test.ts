import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  extractClientPageMetadataFromHtml,
} from '../server/clientPageCrawler.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSqlParentheses = (sql: string): void => {
  let depth = 0;
  for (const char of sql.replace(/--.*$/gm, '').replace(/'(?:''|[^'])*'/g, "''")) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    assert.ok(depth >= 0, 'SQL closes a parenthesis before it opens one.');
  }
  assert.equal(depth, 0, 'SQL has unbalanced parentheses.');
};

const importClientUtility = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/clientCenter.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('Client Center phase 2 UI manages scoped clients without excluded fields', async () => {
  const [component, utility, settings] = await Promise.all([
    readWorkspaceFile('components/ClientCenterSettings.tsx'),
    readWorkspaceFile('utils/clientCenter.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  for (const marker of [
    'مركز العملاء',
    'بيانات والدومين',
    'روابط الموقع',
    'الموظفون والصلاحيات',
    'إدخال الروابط يدويًا',
    'لا يستخدم مقالات المحرر أو الذكاء الاصطناعي',
  ]) {
    assert.match(component, new RegExp(marker));
  }
  for (const operation of [
    'createClientCenterClient',
    'saveClientCenterPrimaryDomain',
    'saveClientCenterAssignment',
    'addClientCenterPages',
    'refreshClientCenterPage',
  ]) {
    assert.match(component, new RegExp(operation));
  }
  assert.match(component, /label="الدومين"/);
  assert.doesNotMatch(component, /دومينات العميل/);
  assert.doesNotMatch(component, /domainPrimary|domainSubdomains|handleAddDomain/);
  assert.match(settings, /<ClientCenterSettings \/>/);
  assert.match(settings, /<ClientGoalSettings \/>/);
  assert.match(utility, /\.from\('clients'\)/);
  assert.match(utility, /\.from\('client_pages'\)/);
  assert.match(utility, /\.from\('client_page_crawl_jobs'\)/);
  assert.match(utility, /include_subdomains:\s*true/);
  assert.match(utility, /\.delete\(\)[\s\S]*\.neq\('id', target\.id\)/);

  for (const excludedLabel of [
    'أسلوب ونبرة الكتابة',
    'المصطلحات المعتمدة',
    'المصطلحات المحظورة',
    'ملاحظات المسؤول',
    'الشعار',
    'المنتجات والخدمات',
    'الجمهور المستهدف',
    'الأسواق والمناطق المستهدفة',
  ]) {
    assert.doesNotMatch(component, new RegExp(excludedLabel));
  }
});

test('manual client URLs are normalized and restricted to registered domains', async () => {
  const {
    isUrlAllowedForClientDomains,
    normalizeClientHostname,
    normalizeClientPrimaryDomain,
    normalizeClientPageUrl,
  } = await importClientUtility();
  assert.equal(normalizeClientHostname('https://WWW.Example.com/path'), 'www.example.com');
  assert.equal(normalizeClientPrimaryDomain('https://WWW.Example.com/path'), 'example.com');
  assert.throws(() => normalizeClientPrimaryDomain('example'));
  assert.equal(
    normalizeClientPageUrl('example.com/page#section'),
    'https://example.com/page',
  );
  assert.equal(normalizeClientPageUrl('javascript:alert(1)'), '');

  const domains = [{
    id: 'domain-1',
    clientId: 'client-1',
    hostname: 'example.com',
    isPrimary: true,
    includeSubdomains: false,
    isActive: true,
    createdAt: '',
    updatedAt: '',
  }];
  assert.equal(isUrlAllowedForClientDomains('https://example.com/page', domains), true);
  assert.equal(isUrlAllowedForClientDomains('https://blog.example.com/page', domains), false);
  assert.equal(isUrlAllowedForClientDomains('https://attacker.example/page', domains), false);
  assert.equal(
    isUrlAllowedForClientDomains('https://blog.example.com/page', [{
      ...domains[0],
      includeSubdomains: true,
    }]),
    true,
  );
});

test('deterministic crawler extracts page metadata without AI', () => {
  const html = `
    <!doctype html>
    <html lang="ar">
      <head>
        <title>دليل التحول الرقمي</title>
        <meta name="description" content="شرح عملي لخدمات التحول الرقمي">
        <meta name="robots" content="noindex,nofollow">
        <link href="/canonical-page" rel="canonical">
      </head>
      <body>
        <h1>خدمات التحول الرقمي</h1>
        <h2>فوائد التحول الرقمي</h2>
        <h3>رفع الكفاءة</h3>
        <p>خدمات التحول الرقمي تساعد الشركات. خدمات التحول الرقمي ترفع الكفاءة.</p>
        <script>خدمات وهمية خدمات وهمية خدمات وهمية</script>
      </body>
    </html>
  `;
  const result = extractClientPageMetadataFromHtml({
    html,
    finalUrl: 'https://example.com/original',
    httpStatus: 200,
    responseContentType: 'text/html; charset=utf-8',
    redirectCount: 1,
    crawlDurationMs: 125,
  });

  assert.equal(result.pageTitle, 'دليل التحول الرقمي');
  assert.equal(result.metaDescription, 'شرح عملي لخدمات التحول الرقمي');
  assert.equal(result.h1, 'خدمات التحول الرقمي');
  assert.deepEqual(result.h2, ['فوائد التحول الرقمي']);
  assert.deepEqual(result.h3, ['رفع الكفاءة']);
  assert.equal(result.canonicalUrl, 'https://example.com/canonical-page');
  assert.equal(result.pageLanguage, 'ar');
  assert.equal(result.robotsIndex, false);
  assert.equal(result.robotsFollow, false);
  assert.equal(result.redirectCount, 1);
  assert.equal(result.crawlDurationMs, 125);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(result.extractedTerms.includes('التحول'));
  assert.equal(result.extractedTerms.includes('وهميه'), false);
});

test('Client Center phase 3 migration restricts durable crawl RPCs to service role', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724020000_client_center_management_and_crawling.sql',
  );

  for (const column of [
    'word_count',
    'response_content_type',
    'redirect_count',
    'last_crawl_duration_ms',
    'crawl_generation',
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`));
  }
  for (const functionName of [
    'claim_next_client_page_crawl_job',
    'heartbeat_client_page_crawl_job',
    'complete_client_page_crawl_job',
    'fail_client_page_crawl_job',
    'recover_stale_client_page_crawl_jobs',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}[^;]+to service_role`));
    assert.match(migration, new RegExp(`revoke all on function public\\.${functionName}[^;]+from public, anon, authenticated`));
  }
  assert.match(migration, /for update of job skip locked/);
  assert.match(migration, /crawl_status = 'crawling'/);
  assert.match(migration, /extracted_terms/);
  assert.match(migration, /extracted_phrases/);
  assert.doesNotMatch(migration, /openai|gemini|search_console|editor_articles/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});

test('crawler worker enforces public HTML and registered-domain safeguards', async () => {
  const [crawler, worker, queue, buildScript, ecosystem, releaseScript] = await Promise.all([
    readWorkspaceFile('server/clientPageCrawler.ts'),
    readWorkspaceFile('server/clientPageCrawlWorker.ts'),
    readWorkspaceFile('server/clientPageCrawlQueue.ts'),
    readWorkspaceFile('scripts/build-server.mjs'),
    readWorkspaceFile('ecosystem.config.cjs'),
    readWorkspaceFile('scripts/checkClientCenterRelease.ts'),
  ]);

  assert.match(crawler, /lookup\(hostname, \{ all: true/);
  assert.match(crawler, /redirect: 'manual'/);
  assert.match(crawler, /client_page_domain_not_allowed/);
  assert.match(crawler, /client_page_too_large/);
  assert.match(crawler, /text\\\/html\|application\\\/xhtml/);
  assert.match(worker, /crawlClientPage/);
  assert.match(worker, /heartbeatClientPageCrawlJob/);
  assert.match(worker, /recoverStaleClientPageCrawlJobs/);
  assert.match(queue, /claim_next_client_page_crawl_job/);
  assert.match(buildScript, /client-page-crawl-worker\.mjs/);
  assert.match(ecosystem, /bazarvan-client-page-crawler/);
  assert.match(releaseScript, /client-page-crawl-worker\.mjs/);
});
