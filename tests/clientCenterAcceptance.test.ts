import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  CLIENT_CENTER_ACCEPTANCE_CASES,
  CLIENT_CENTER_ACCEPTANCE_VERSION,
} from '../constants/clientCenterAcceptance.ts';
import {
  extractClientPageMetadataFromHtml,
  sanitizeDiscoveredClientUrl,
} from '../server/clientPageCrawler.ts';
import {
  buildClientPageSemanticProfile,
  isGenericClientPageTitle,
} from '../utils/clientSemanticIndex.ts';
import {
  generateInternalLinkSuggestions,
  resolveInternalLinkTargetUrl,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

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

const readyPage = (
  overrides: Partial<InternalLinkTargetPage> = {},
): InternalLinkTargetPage => ({
  id: '11111111-1111-4111-8111-111111111111',
  clientId: 'client-1',
  inputUrl: 'https://example.com/digital-transformation',
  finalUrl: 'https://example.com/digital-transformation',
  canonicalUrl: 'https://example.com/digital-transformation',
  crawlStatus: 'ready',
  httpStatus: 200,
  pageTitle: 'خدمات التحول الرقمي للشركات',
  metaDescription: 'حلول عملية لتطوير الأعمال وتحسين العمليات وتجربة العملاء.',
  h1: 'التحول الرقمي للشركات',
  h2: ['فوائد التحول الرقمي', 'تحسين تجربة العملاء'],
  h3: ['رفع كفاءة العمليات'],
  slug: 'digital-transformation',
  pageLanguage: 'ar',
  robotsIndex: true,
  extractedTerms: ['التحول الرقمي', 'الشركات', 'تطوير الأعمال', 'كفاءة العمليات'],
  extractedPhrases: ['خدمات التحول الرقمي', 'تحسين تجربة العملاء'],
  isEnabled: true,
  allowedDomains: [{ hostname: 'example.com', includeSubdomains: false }],
  ...overrides,
});

const articleText = [
  'تساعد خدمات التحول الرقمي الشركات على تطوير الأعمال ورفع كفاءة العمليات.',
  'ويبدأ تحسين تجربة العملاء بفهم الرحلة الرقمية وتبسيط نقاط التواصل.',
].join('\n');

test('phase 10 acceptance registry contains the complete final checklist', () => {
  assert.equal(CLIENT_CENTER_ACCEPTANCE_VERSION, 10);
  assert.equal(CLIENT_CENTER_ACCEPTANCE_CASES.length, 13);
  assert.equal(
    new Set(CLIENT_CENTER_ACCEPTANCE_CASES.map(item => item.id)).size,
    CLIENT_CENTER_ACCEPTANCE_CASES.length,
  );
});

test('[scoped-client-permissions] verifies client and employee permissions at the database boundary', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724010000_client_center_foundation.sql',
  );
  assert.match(migration, /client_access_level_for_user/);
  assert.match(migration, /profile\.role = 'admin'/);
  assert.match(migration, /assignment\.is_active = true/);
  assert.match(migration, /can_read_client\(id\)/);
  assert.match(migration, /can_edit_client\(client_id\)/);
  assert.match(migration, /client_assignments_select_self_or_admin/);
  assert.match(migration, /clients_insert_admin/);
  assert.match(migration, /client_pages_insert_editor_or_admin/);
});

test('[registered-domain-only] blocks out-of-domain input, canonical, and resolved target URLs', async () => {
  const {
    isUrlAllowedForClientDomains,
    prepareClientPageUrlBatch,
  } = await importClientUtility();
  assert.equal(isUrlAllowedForClientDomains('https://example.com/page', domains), true);
  assert.equal(isUrlAllowedForClientDomains('https://evil.example/page', domains), false);
  const prepared = prepareClientPageUrlBatch({
    urls: ['https://evil.example/page'],
    domains,
  });
  assert.deepEqual(prepared.accepted, []);
  assert.deepEqual(prepared.rejected, ['https://evil.example/page']);

  assert.equal(sanitizeDiscoveredClientUrl(
    'https://evil.example/canonical',
    'https://example.com/original',
    [{ hostname: 'example.com', includeSubdomains: false }],
  ), 'https://example.com/original');
  assert.equal(resolveInternalLinkTargetUrl(readyPage({
    canonicalUrl: 'https://evil.example/canonical',
  })), 'https://example.com/digital-transformation');
});

test('[duplicate-url-cleanup] normalizes and removes duplicate URL variants before insertion', async () => {
  const { prepareClientPageUrlBatch } = await importClientUtility();
  const prepared = prepareClientPageUrlBatch({
    urls: [
      'HTTPS://EXAMPLE.COM/services/',
      'https://example.com/services#details',
      'https://example.com//services/?utm_source=test',
      'https://example.com/services?b=2&a=1',
      'https://example.com/services?a=1&b=2',
    ],
    domains,
  });
  assert.deepEqual(prepared.rejected, []);
  assert.deepEqual(prepared.accepted, [
    'https://example.com/services',
    'https://example.com/services?a=1&b=2',
  ]);
});

test('[redirect-and-canonical] keeps allowed redirects and Canonical while rejecting foreign Canonical', () => {
  const allowed = [
    { hostname: 'example.com', includeSubdomains: false },
    { hostname: 'example.net', includeSubdomains: false },
  ];
  assert.equal(sanitizeDiscoveredClientUrl(
    'https://example.net/canonical#section',
    'https://example.com/original',
    allowed,
  ), 'https://example.net/canonical');
  assert.equal(sanitizeDiscoveredClientUrl(
    'https://outside.example/canonical',
    'https://example.net/final',
    allowed,
  ), 'https://example.net/final');
});

test('[noindex-and-404] excludes noindex and 404 pages from internal-link suggestions', () => {
  const noindex = readyPage({
    id: '22222222-2222-4222-8222-222222222222',
    robotsIndex: false,
  });
  const missing = readyPage({
    id: '33333333-3333-4333-8333-333333333333',
    httpStatus: 404,
  });
  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'دليل التحول الرقمي',
    articleText,
    articleLanguage: 'ar',
    pages: [noindex, missing],
  }), []);
});

test('[arabic-and-english-extraction] extracts Arabic and English pages deterministically', () => {
  const arabic = extractClientPageMetadataFromHtml({
    html: '<html lang="ar"><head><title>التحول الرقمي</title></head><body><h1>التحول الرقمي</h1><p>تطوير الأعمال تطوير الأعمال وتحسين العمليات تحسين العمليات.</p></body></html>',
    finalUrl: 'https://example.com/ar',
    httpStatus: 200,
    responseContentType: 'text/html; charset=utf-8',
  });
  const english = extractClientPageMetadataFromHtml({
    html: '<html><head><title>Digital transformation</title></head><body><h1>Digital transformation services</h1><p>Business automation improves operations. Business automation improves operations.</p></body></html>',
    finalUrl: 'https://example.com/en',
    httpStatus: 200,
    responseContentType: 'text/html; charset=utf-8',
  });
  assert.equal(arabic.pageLanguage, 'ar');
  assert.equal(english.pageLanguage, 'en');
  assert.ok(arabic.extractedTerms.includes('تطوير'));
  assert.ok(english.extractedTerms.includes('business'));
  assert.ok(english.extractedPhrases.includes('business automation'));
});

test('[missing-description] can rank a useful page when its meta description is empty', () => {
  const suggestions = generateInternalLinkSuggestions({
    articleTitle: 'دليل التحول الرقمي',
    articleText,
    articleLanguage: 'ar',
    pages: [readyPage({ metaDescription: '' })],
  });
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].reasons.some(reason => reason.includes('عنوان')));
});

test('[generic-page-title] ignores a generic page title and falls back to meaningful headings', () => {
  const page = readyPage({
    pageTitle: 'الرئيسية',
    metaDescription: '',
  });
  page.semanticProfile = buildClientPageSemanticProfile({
    ...page,
    clientId: page.clientId || 'client-1',
  }, []);
  const suggestions = generateInternalLinkSuggestions({
    articleTitle: 'دليل التحول الرقمي',
    articleText,
    articleLanguage: 'ar',
    pages: [page],
  });
  assert.equal(isGenericClientPageTitle(page.pageTitle), true);
  assert.equal(page.semanticProfile.completenessDetails.title, false);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].targetTitle, page.h1);
  assert.equal(suggestions[0].reasons.includes('تطابق مع عنوان الصفحة'), false);
  assert.ok(suggestions[0].reasons.includes('تطابق مع عناوين الصفحة'));
});

test('[anchor-text-accuracy] keeps every Anchor Text exact, bounded, and inside one paragraph', () => {
  const suggestion = generateInternalLinkSuggestions({
    articleTitle: 'دليل التحول الرقمي',
    articleText,
    articleLanguage: 'ar',
    pages: [readyPage()],
  })[0];
  assert.ok(suggestion);
  const paragraph = articleText.split('\n')[suggestion.paragraphNumber - 1];
  const wordCount = suggestion.anchorText.match(/[A-Za-z0-9\u0600-\u06FF]+/g)?.length || 0;
  assert.ok(paragraph.includes(suggestion.anchorText));
  assert.ok(wordCount >= 2 && wordCount <= 5);
  assert.ok(suggestion.alternativeAnchors.every(anchor => paragraph.includes(anchor)));
});

test('[website-inventory-only] keeps editor articles outside the core inventory engine', async () => {
  const [crawler, semanticIndex, linkEngine, targetLoader] = await Promise.all([
    readWorkspaceFile('server/clientPageCrawler.ts'),
    readWorkspaceFile('utils/clientSemanticIndex.ts'),
    readWorkspaceFile('utils/internalLinkingEngine.ts'),
    readWorkspaceFile('utils/internalLinking.ts'),
  ]);
  const core = `${crawler}\n${semanticIndex}\n${linkEngine}\n${targetLoader}`;
  assert.doesNotMatch(core, /from ['"].*EditorContext|supabaseArticles|editor_articles/i);
  assert.match(targetLoader, /\.from\('client_pages'\)/);
  assert.match(targetLoader, /\.from\('client_domains'\)/);
});

test('[core-without-api-key] keeps the core inventory and ranking engine independent from AI keys', async () => {
  const [crawler, semanticIndex, linkEngine] = await Promise.all([
    readWorkspaceFile('server/clientPageCrawler.ts'),
    readWorkspaceFile('utils/clientSemanticIndex.ts'),
    readWorkspaceFile('utils/internalLinkingEngine.ts'),
  ]);
  assert.doesNotMatch(`${crawler}\n${semanticIndex}\n${linkEngine}`, /openai|gemini|api[_-]?key/i);
});

test('[manual-fields-survive-recrawl] preserves manually controlled page fields after recrawl', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724020000_client_center_management_and_crawling.sql',
  );
  const completionUpdate = migration.match(
    /update public\.client_pages\s+set([\s\S]*?)where id = v_job\.page_id\s+and client_id = v_job\.client_id;/,
  )?.[1] || '';
  assert.ok(completionUpdate);
  for (const protectedField of [
    'input_url',
    'source',
    'is_enabled',
    'priority',
    'created_by',
    'updated_by',
  ]) {
    assert.doesNotMatch(completionUpdate, new RegExp(`\\b${protectedField}\\s*=`));
  }
  assert.match(completionUpdate, /crawl_generation = crawl_generation \+ 1/);
});

test('[crawl-resume-after-failure] reschedules retryable and stale crawl jobs after failure', async () => {
  const [migration, worker] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260724020000_client_center_management_and_crawling.sql'),
    readWorkspaceFile('server/clientPageCrawlWorker.ts'),
  ]);
  assert.match(migration, /v_retry := coalesce\(p_retryable, true\) and v_job\.attempt_count < v_job\.max_attempts/);
  assert.match(migration, /when v_retry then 'retry_scheduled'/);
  assert.match(migration, /where status = 'running'\s+and lease_expires_at is not null\s+and lease_expires_at < now\(\)/);
  assert.match(worker, /recoverStaleClientPageCrawlJobs/);
  assert.match(worker, /retryBaseSeconds \* Math\.max\(1, 2 \*\*/);
});
