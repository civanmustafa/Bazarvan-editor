import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
  MAX_ARTICLE_COMPETITORS,
  normalizeCompetitorSlots,
} from '../constants/competitors.ts';
import {
  canonicalizeCompetitorUrl,
  classifyFirecrawlProviderError,
  FirecrawlCompetitorError,
  getUnsupportedCompetitorFileExtension,
  isUnsupportedCompetitorFileUrl,
  markdownToCompetitorText,
  type CompetitorSearchResult,
} from '../server/firecrawlCompetitorService.ts';
import {
  analyzeAndSelectCompetitors,
  extractCompetitorOwnDomains,
  normalizeCompetitorText,
  resolveCompetitorCountryCode,
} from '../server/competitorSelectionEngine.ts';

const readWorkspaceFile = async (relativePath: string): Promise<string> => (
  readFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')
);

const searchResult = (
  domain: string,
  title: string,
  description: string,
  position: number,
  path = 'guide',
): CompetitorSearchResult => ({
  url: `https://${domain}/${path}`,
  canonicalUrl: `https://${domain}/${path}`,
  domain,
  title,
  description,
  position,
});

test('competitor URLs are canonicalized without tracking parameters', () => {
  assert.equal(
    canonicalizeCompetitorUrl('https://Example.com/article/?utm_source=test&keep=yes#section'),
    'https://example.com/article?keep=yes',
  );
});

test('competitor URLs reject local and private destinations', () => {
  for (const value of [
    'http://localhost:8080/private',
    'http://127.0.0.1/private',
    'http://10.20.30.40/private',
    'http://192.168.1.10/private',
    'http://[::1]/private',
    'file:///etc/passwd',
  ]) {
    assert.throws(
      () => canonicalizeCompetitorUrl(value),
      (error: unknown) => error instanceof FirecrawlCompetitorError
        && error.code === 'unsafe_competitor_url',
      value,
    );
  }
});

test('competitor file URLs are excluded by one central URL policy', () => {
  for (const [value, extension] of [
    ['https://example.com/report.pdf', 'pdf'],
    ['https://example.com/report.DOCX?download=1', 'docx'],
    ['https://example.com/report%2Exlsx', 'xlsx'],
    ['https://example.com/slides.pptx/', 'pptx'],
    ['https://example.com/archive.zip', 'zip'],
    ['https://example.com/image.webp', 'webp'],
    ['https://example.com/video.mp4', 'mp4'],
  ] as const) {
    assert.equal(getUnsupportedCompetitorFileExtension(value), extension, value);
    assert.equal(isUnsupportedCompetitorFileUrl(value), true, value);
    assert.throws(
      () => canonicalizeCompetitorUrl(value),
      (error: unknown) => error instanceof FirecrawlCompetitorError
        && error.code === 'unsupported_competitor_file'
        && error.retryable === false,
      value,
    );
  }

  assert.equal(isUnsupportedCompetitorFileUrl('https://example.com/article.html'), false);
  assert.equal(
    canonicalizeCompetitorUrl('https://example.com/download?file=report.pdf'),
    'https://example.com/download?file=report.pdf',
  );
});

test('Firecrawl tunnel failures remain retryable independently of provider status', () => {
  assert.deepEqual(
    classifyFirecrawlProviderError(
      400,
      'ERR_TUNNEL_CONNECTION_FAILED: internal proxy error while establishing the tunnel.',
    ),
    { code: 'firecrawl_tunnel_error', retryable: true },
  );
  assert.deepEqual(
    classifyFirecrawlProviderError(429, 'Quota exceeded.'),
    { code: 'firecrawl_quota_exceeded', retryable: true },
  );
});

test('competitor markdown is normalized into analysis text', () => {
  const normalized = markdownToCompetitorText(`
# Main title

Read the [full guide](https://example.com/guide).

- First point
- Second point

\`\`\`js
const secret = true;
\`\`\`
  `);
  assert.match(normalized, /Main title/);
  assert.match(normalized, /Read the full guide/);
  assert.match(normalized, /First point/);
  assert.doesNotMatch(normalized, /const secret/);
});

test('all competitor paths share five stable slots', () => {
  assert.equal(MAX_ARTICLE_COMPETITORS, 5);
  assert.deepEqual(normalizeCompetitorSlots(['one', 'two']), ['one', 'two', '', '', '']);
});

test('competitor selection normalizes Arabic context, countries, and owned domains', () => {
  assert.equal(normalizeCompetitorText('أفْضَل شَرِكة لإدارة المشاريع'), 'افضل شركه لاداره المشاريع');
  assert.equal(resolveCompetitorCountryCode('المملكة العربية السعودية'), 'SA');
  assert.equal(resolveCompetitorCountryCode('Türkiye'), 'TR');
  assert.deepEqual(
    extractCompetitorOwnDomains('https://www.Example.com/path', 'شركة بلا دومين'),
    ['example.com'],
  );
});

test('central competitor engine auto-selects strong commercial matches for user review', () => {
  const candidates = [
    searchResult('compare-one.com', 'أفضل برامج إدارة المشاريع: مقارنة شاملة', 'مقارنة أفضل برامج إدارة المشاريع مع المميزات والأسعار وتجارب المستخدمين.', 1, 'comparison'),
    searchResult('review-two.com', 'مراجعة أفضل أدوات إدارة المشاريع', 'تقييم ومقارنة أدوات إدارة المشاريع ومميزات وعيوب كل برنامج.', 2, 'reviews'),
    searchResult('guide-three.com', 'دليل اختيار برنامج إدارة المشاريع المناسب', 'دليل شراء واختيار ومقارنة برامج إدارة المشاريع للشركات.', 3, 'guide'),
    searchResult('top-four.com', 'أفضل 12 منصة لإدارة المشاريع', 'ترشيحات أفضل منصات إدارة المشاريع وبدائلها وأسعارها.', 4, 'best'),
    searchResult('software-five.com', 'مقارنة حلول إدارة المشاريع للشركات', 'أي برامج إدارة المشاريع أفضل للشركات؟ مقارنة عملية ومفصلة.', 5, 'compare'),
    searchResult('mybrand.com', 'أفضل برامج إدارة المشاريع من شركتنا', 'صفحة الشركة المطلوب استبعادها من المنافسين.', 6, 'article'),
    searchResult('utility.example', 'تسجيل الدخول', 'الدخول إلى حساب إدارة المشاريع.', 7, 'login'),
    searchResult('youtube.com', 'أفضل برامج إدارة المشاريع بالفيديو', 'شاهد مقارنة برامج إدارة المشاريع.', 8, 'watch'),
  ];

  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'أفضل برامج إدارة المشاريع',
      queryType: 'primary_keyword',
      articleTitle: 'أفضل برامج إدارة المشاريع للشركات',
      primaryKeyword: 'برامج إدارة المشاريع',
      language: 'ar',
      pageType: 'comparison',
      searchIntent: 'commercial',
      audienceScope: 'country',
      targetCountry: 'السعودية',
      companyName: 'https://mybrand.com',
    },
    candidates,
    maxResults: 15,
    maxSelected: 5,
  });

  assert.equal(selection.summary.strategy, 'automatic_review');
  assert.equal(selection.summary.targetIntent, 'commercial');
  assert.equal(selection.summary.targetPageType, 'comparison');
  assert.equal(selection.summary.autoSelectedCount, 5);
  assert.ok(selection.summary.confidence >= 70);
  assert.ok(selection.results[0].selectionScore >= selection.results[1].selectionScore);
  assert.ok(selection.results.some(result => result.domain === 'compare-one.com' && result.autoSelected));
  assert.ok(selection.results.every(result => result.domain !== 'mybrand.com'));
  assert.ok(selection.results.every(result => !result.canonicalUrl.endsWith('/login')));
  assert.ok(selection.results.filter(result => result.autoSelected).every(result => result.inferredPageType !== 'video'));
});

test('expanded intent lexicon recognizes Arabic support and transactional searches', () => {
  const support = analyzeAndSelectCompetitors({
    context: {
      query: 'حل مشكلة تسجيل الدخول لا يعمل وإصلاح رمز الخطأ',
      language: 'ar',
    },
    candidates: [
      searchResult('support-one.com', 'حل مشكلة تسجيل الدخول لا يعمل', 'خطوات إصلاح رمز الخطأ واستعادة الحساب وإعدادات كلمة المرور.', 1, 'troubleshooting'),
      searchResult('support-two.com', 'إصلاح أخطاء الدخول إلى البرنامج', 'مساعدة ودعم لحل المشاكل الشائعة واسترجاع الحساب.', 2, 'help'),
    ],
    maxResults: 10,
    maxSelected: 5,
  });
  assert.equal(support.summary.targetIntent, 'support');

  const transactional = analyzeAndSelectCompetitors({
    context: {
      query: 'حجز موعد استشارة وطلب عرض سعر',
      language: 'ar',
      pageType: 'service',
    },
    candidates: [
      searchResult('booking-one.com', 'احجز موعد استشارة واطلب عرض سعر', 'حجز خدمة واستشارة وطلب عرض سعر والبدء الآن.', 1, 'services'),
    ],
    maxResults: 10,
    maxSelected: 5,
  });
  assert.equal(transactional.summary.targetIntent, 'transactional');
});

test('automatic competitor discovery is durable, idempotent, and uses the central engine', async () => {
  const [migration, executor, worker, panel, card, modal, reports] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260714030000_automatic_competitor_discovery.sql'),
    readWorkspaceFile('server/competitorDiscoveryExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
    readWorkspaceFile('components/ExternalAnalysisCardControls.tsx'),
    readWorkspaceFile('components/CompetitorDiscoveryModal.tsx'),
    readWorkspaceFile('components/ExternalAnalysisReportsTable.tsx'),
  ]);

  assert.match(migration, /evaluate_competitor_discovery_readiness/);
  assert.match(migration, /article_title_or_primary_keyword/);
  assert.match(migration, /enqueue_competitor_discovery_job/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /ai_external_analysis_jobs_competitor_discovery_once_idx/);
  assert.match(migration, /trigger enqueue_competitor_discovery_from_state/);
  assert.match(migration, /trigger assign_competitor_discovery_signature/);
  assert.match(migration, /job\.job_type in \('competitor_discovery', 'competitor_extraction'\)/);
  assert.match(executor, /searchCompetitorWeb\(/);
  assert.match(executor, /analyzeAndSelectCompetitors\(/);
  assert.match(executor, /registerExternalAnalysisJobExecutor\('competitor_discovery'/);
  assert.match(worker, /import '\.\/competitorDiscoveryExecutor'/);
  assert.match(panel, /getPersistedCompetitorDiscovery/);
  assert.match(panel, /ensureArticleCompetitorDiscovery/);
  assert.match(card, /بحث المنافسين/);
  assert.match(card, /COMPETITOR_REQUIREMENT_FIELDS/);
  assert.match(modal, /createPortal\(/);
  assert.match(modal, /CompetitorDiscoveryPanel/);
  assert.match(reports, /job\.job_type === 'competitor_discovery'/);
  assert.match(reports, /اكتشاف وترتيب المنافسين/);
});

test('competitor extraction preserves partial success and bounds transient retries', async () => {
  const [executor, panel] = await Promise.all([
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.equal(COMPETITOR_EXTRACTION_MAX_ATTEMPTS, 3);
  assert.match(executor, /retryExhausted/);
  assert.match(executor, /status: shouldRetry \? 'retry_scheduled' : 'failed'/);
  assert.match(executor, /\$\{normalized\.code\}_retry_exhausted/);
  assert.ok(
    executor.indexOf('await syncArticleCompetitors(context.job.article_id)')
      < executor.indexOf('throw new ExternalAnalysisRetryError'),
  );
  assert.match(panel, /hasNewCompletedSource/);
  assert.match(panel, /hydratedCompetitorsRef/);
});

test('competitor sidebar keeps one plain-text content surface', async () => {
  const [sidebar, translations] = await Promise.all([
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/translations.ts'),
  ]);

  assert.match(sidebar, /competitorPlainTextField/);
  assert.doesNotMatch(sidebar, /fullExtractedText/);
  assert.doesNotMatch(translations, /fullExtractedText/);
});
