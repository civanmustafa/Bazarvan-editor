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
  assessCompetitorLanguage,
  extractCompetitorOwnDomains,
  isCompetitorOwnDomain,
  isCompetitorLanguageCompatible,
  normalizeCompetitorText,
  resolveCompetitorCountryCode,
} from '../server/competitorSelectionEngine.ts';
import {
  COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT,
  getUsableCompetitorText,
  isCompetitorExtractionFailureText,
  resolveCompetitorCanonicalSource,
  sanitizeCompetitorSlots,
} from '../utils/competitorContent.ts';

test('managed competitor rows are canonical while unmarked legacy metadata remains a manual fallback', () => {
  assert.equal(resolveCompetitorCanonicalSource({
    managedRowCount: 1,
    metadataManagedBy: '',
    metadataTextCount: 3,
  }), 'managed_rows');
  assert.equal(resolveCompetitorCanonicalSource({
    managedRowCount: 0,
    metadataManagedBy: '',
    metadataTextCount: 2,
  }), 'manual_metadata');
  assert.equal(resolveCompetitorCanonicalSource({
    managedRowCount: 0,
    metadataManagedBy: 'competitor_discovery',
    metadataTextCount: 2,
  }), 'none');
});

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
  assert.equal(isCompetitorOwnDomain('https://shop.example.com/page', ['example.com']), true);
  assert.equal(isCompetitorOwnDomain('example.com.evil.test', ['example.com']), false);
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
      companyName: 'اسم الشركة',
      ownDomains: ['mybrand.com'],
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

test('Arabic competitor selection fully excludes Latin pages while allowing natural brand names', () => {
  const latinAssessment = assessCompetitorLanguage(
    'ar',
    'Best Branding Companies in the UAE. Compare leading branding agencies, services, pricing, and portfolios.',
  );
  assert.equal(latinAssessment.compatible, false);
  assert.equal(latinAssessment.detectedLanguage, 'latin');
  assert.equal(isCompetitorLanguageCompatible(
    'ar',
    'تقدم شركة Brand Studio خدمات البراندنج وبناء الهوية البصرية في الإمارات للشركات الناشئة والمؤسسات.',
  ), true);

  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'شركة براندينج في الإمارات',
      articleTitle: 'أفضل شركة براندينج في الإمارات',
      primaryKeyword: 'شركة براندينج في الإمارات',
      language: 'ar',
      pageType: 'service',
      searchIntent: 'commercial',
    },
    candidates: [
      searchResult(
        'english-first.example',
        'Best Branding Companies in the UAE',
        'Compare leading branding agencies in Dubai, their services, pricing, strategy, and creative portfolios.',
        1,
        'best-branding-agencies',
      ),
      searchResult(
        'arabic-brand.example',
        'شركة Brand Studio للبراندنج في الإمارات',
        'خدمات عربية متكاملة لبناء العلامة التجارية والهوية البصرية والاستراتيجية الإبداعية للشركات في دبي وأبوظبي.',
        2,
        'خدمات-البراندنج',
      ),
      searchResult(
        'arabic-agency.example',
        'أفضل شركات البراندينج في الإمارات',
        'مقارنة عربية لخدمات شركات بناء العلامات التجارية وتصميم الهوية البصرية وإدارة تجربة العلامة في الإمارات.',
        3,
        'شركات-براندينج',
      ),
    ],
    maxResults: 10,
    maxSelected: 5,
  });

  assert.equal(selection.summary.languageFilteredCount, 1);
  assert.equal(selection.summary.filteredCount, 1);
  assert.equal(selection.results.some(result => result.domain === 'english-first.example'), false);
  assert.equal(selection.results.some(result => result.domain === 'arabic-brand.example'), true);
  assert.ok(selection.results.filter(result => result.autoSelected).every(result => (
    result.signals.languageMatch >= 50
  )));
});

test('manual and queued competitor discovery load the linked client domain exclusion', async () => {
  const [apiSource, executorSource, exclusionSource] = await Promise.all([
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/competitorDiscoveryExecutor.ts'),
    readWorkspaceFile('server/clientCompetitorExclusions.ts'),
  ]);

  assert.match(apiSource, /loadArticleClientOwnDomains\(supabase, articleId, companyName\)/);
  assert.match(apiSource, /client_domain_not_a_competitor/);
  assert.match(executorSource, /loadArticleClientOwnDomains/);
  assert.match(exclusionSource, /\.from\('article_client_contexts'\)/);
  assert.match(exclusionSource, /\.from\('clients'\)/);
  assert.match(exclusionSource, /\.from\('client_domains'\)/);
  assert.match(exclusionSource, /\.eq\('name', textValue\(companyName\)\)/);
  assert.match(exclusionSource, /\.eq\('is_active', true\)/);
});

test('competitor Firecrawl operations resolve only user-owned or assigned vault credentials', async () => {
  const [service, apiSource, settings, panel] = await Promise.all([
    readWorkspaceFile('server/firecrawlCompetitorService.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('components/AdminProviderAccessSettings.tsx'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.match(service, /resolveCrawlerProviderCredential\('firecrawl', userId\)/);
  assert.match(service, /reserveProviderRequest\(\{/);
  assert.match(service, /export const isFirecrawlConfigured = async/);
  assert.match(apiSource, /providerConfigured: await isFirecrawlConfigured\(principal\.userId\)/);
  assert.match(apiSource, /!\(await isFirecrawlConfigured\(principal\.userId\)\)/);
  assert.match(settings, /Firecrawl/);
  assert.match(settings, /Browserless/);
  assert.match(settings, /حفظ دون تعيين/);
  assert.doesNotMatch(settings, /FIRECRAWL_API_KEY|BROWSERLESS_API_KEY|Hostinger/);
  assert.match(panel, /مركز المزودات/);
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

test('automatic competitor discovery is durable, ordered after enabled semantic stages, and uses content qualification', async () => {
  const [migration, qualificationMigration, automationMigration, executor, discoveryService, qualifier, worker, ecosystem, panel, card, modal, reports] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260714030000_automatic_competitor_discovery.sql'),
    readWorkspaceFile('supabase/migrations/20260827020000_competitor_content_qualification.sql'),
    readWorkspaceFile('supabase/migrations/20260827030000_content_research_automation_settings.sql'),
    readWorkspaceFile('server/competitorDiscoveryExecutor.ts'),
    readWorkspaceFile('server/competitorDiscoveryService.ts'),
    readWorkspaceFile('server/competitorContentQualification.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('ecosystem.config.cjs'),
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
  assert.match(executor, /discoverAndSelectCompetitors\(/);
  assert.match(executor, /readArticleAlternativeKeywords/);
  assert.match(discoveryService, /searchCompetitorWeb\(/);
  assert.match(discoveryService, /qualifyCompetitorCandidates\(/);
  assert.match(discoveryService, /analyzeAndSelectCompetitors\(/);
  assert.match(qualifier, /getProgrammaticCompetitorContent/);
  assert.doesNotMatch(qualifier, /getCompetitorPreview|scrapeCompetitorWeb/);
  assert.match(qualificationMigration, /alternativeKeywords/);
  assert.match(qualificationMigration, /hydrate_competitor_discovery_keywords/);
  assert.match(automationMigration, /autoGenerateAlternativeKeywords/);
  assert.match(automationMigration, /autoGenerateLsiKeywords/);
  assert.match(automationMigration, /autoDiscoverCompetitors/);
  assert.match(automationMigration, /enqueue_external_semantic_analysis_job_controlled/);
  assert.match(automationMigration, /enqueue_competitor_discovery_job_controlled/);
  assert.match(automationMigration, /semantic_job\.status in \(/);
  assert.match(automationMigration, /v_auto_secondaries[\s\S]*v_auto_lsi[\s\S]*v_auto_competitors/);
  assert.match(automationMigration, /trigger enqueue_semantic_followup_after_completion/);
  assert.match(automationMigration, /trigger reconcile_content_research_automation_from_settings/);
  assert.equal((automationMigration.match(/\$\$/g) || []).length % 2, 0);
  assert.match(executor, /registerExternalAnalysisJobExecutor\('competitor_discovery'/);
  assert.match(worker, /import '\.\/competitorDiscoveryExecutor'/);
  assert.match(worker, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES/);
  assert.match(worker, /supportedJobTypes: workerJobTypes/);
  assert.match(worker, /reason=\$\{retry\.code\}/);
  assert.match(worker, /retry\.message\.replace\(\/\\s\+\/g/);
  assert.match(ecosystem, /name: 'bazarvan-competitor-worker'/);
  assert.match(ecosystem, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES: 'competitor_discovery,competitor_extraction'/);
  assert.match(ecosystem, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES: 'semantic_keywords_lsi,content_brief_generation,meta_description_generation,engineering_command'/);
  assert.match(panel, /getPersistedCompetitorDiscovery/);
  assert.doesNotMatch(panel, /ensureArticleCompetitorDiscovery/);
  assert.match(card, /بحث المنافسين/);
  assert.match(card, /COMPETITOR_REQUIREMENT_FIELDS/);
  assert.equal((card.match(/ensureArticleCompetitorDiscovery/g) || []).length, 2);
  const manualCompetitorHandler = card.slice(
    card.indexOf('const handleCompetitors'),
    card.indexOf('const handleSemantic'),
  );
  assert.match(manualCompetitorHandler, /ensureArticleCompetitorDiscovery\(articleId\)/);
  assert.match(modal, /createPortal\(/);
  assert.match(modal, /CompetitorDiscoveryPanel/);
  assert.match(reports, /job\.job_type === 'competitor_discovery'/);
  assert.match(reports, /اكتشاف وترتيب المنافسين/);
});

test('competitor discovery stop control requests durable cancellation and keeps extraction cancellation separate', async () => {
  const [apiHandler, browserClient, panel, controlsMigration, executor] = await Promise.all([
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('utils/competitorDiscovery.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
    readWorkspaceFile('supabase/migrations/20260711000000_external_analysis_job_controls.sql'),
    readWorkspaceFile('server/competitorDiscoveryExecutor.ts'),
  ]);

  assert.match(apiHandler, /const cancelCompetitorJob = async/);
  assert.match(apiHandler, /\.eq\('job_type', jobType\)/);
  assert.match(apiHandler, /request_external_analysis_job_cancel/);
  assert.match(apiHandler, /action === 'cancel_discovery'/);
  assert.match(apiHandler, /'competitor_discovery'/);
  assert.match(apiHandler, /jobType === 'competitor_extraction'/);
  assert.match(browserClient, /cancelArticleCompetitorDiscovery/);
  assert.match(browserClient, /action: 'cancel_discovery'/);
  assert.match(panel, /handleCancelDiscovery/);
  assert.match(panel, /discoveryCancelRequested/);
  assert.match(panel, /discoveryQueueStalled/);
  assert.match(panel, /COMPETITOR_DISCOVERY_QUEUE_STALL_MS/);
  assert.match(panel, /بانتظار عامل بحث المنافسين/);
  assert.match(panel, /عامل المنافسين لم يستلمها خلال 90 ثانية/);
  assert.match(panel, /إيقاف البحث عن المنافسين/);
  assert.match(panel, /جاري إيقاف البحث عن المنافسين بأمان/);
  assert.match(controlsMigration, /status = case when job\.status = 'running' then 'running' else 'cancelled' end/);
  assert.match(controlsMigration, /cancel_requested_at = coalesce\(job\.cancel_requested_at, now\(\)\)/);
  assert.match(executor, /signal: context\.signal/);
});

test('competitor extraction tries Firecrawl once and falls back programmatically without AI', async () => {
  const [executor, panel] = await Promise.all([
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.equal(COMPETITOR_EXTRACTION_MAX_ATTEMPTS, 1);
  assert.match(executor, /getCompetitorPreview/);
  assert.match(executor, /getProgrammaticCompetitorContent/);
  assert.match(executor, /stage: 'programmatic_fallback'/);
  assert.match(executor, /COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT/);
  assert.match(executor, /status: 'failed'/);
  assert.doesNotMatch(executor, /throw new ExternalAnalysisRetryError/);
  assert.doesNotMatch(executor, /shouldRetry|retryExhausted/);
  assert.match(panel, /progressStage === 'programmatic_fallback'/);
  assert.match(panel, /hasNewCompletedSource/);
  assert.match(panel, /hydratedCompetitorsRef/);
});

test('bulk competitor import uses Firecrawl then programmatic fallback and never Gemini', async () => {
  const [executor, panel, sidebar] = await Promise.all([
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
  ]);

  assert.match(executor, /provider: 'firecrawl'/);
  assert.match(executor, /model: FIRECRAWL_MODEL/);
  assert.match(executor, /getCompetitorPreview/);
  assert.match(executor, /provider: 'programmatic'/);
  assert.match(executor, /model: PROGRAMMATIC_MODEL/);
  assert.match(executor, /programmatic_after_firecrawl/);
  assert.match(executor, /isCompetitorLanguageCompatible\('ar', content\.text\)/);
  assert.match(executor, /competitor_language_mismatch/);
  assert.match(executor, /\.select\('article_language,keywords'\)/);
  assert.match(executor, /analyzeCompetitorKeywordTargeting/);
  assert.match(executor, /COMPETITOR_KEYWORD_TARGETING_WARNING_CODE/);
  assert.match(executor, /evaluateFinalKeywordTargeting/);
  assert.doesNotMatch(executor, /The final Firecrawl content did not contain the primary keyword/);
  assert.doesNotMatch(executor, /runGeminiAnalysisEngine|executeOpenAiRequest|geminiPaid/);
  assert.match(panel, /سحب \$\{selectedResults\.length\} موقع/);
  assert.match(panel, /البحث وسحب المنافسين/);
  assert.match(panel, /بانتظار عامل السحب 0\//);
  assert.match(panel, /لم يبدأ عامل السحب 0\//);
  assert.match(panel, /COMPETITOR_EXTRACTION_QUEUE_STALL_MS/);
  assert.doesNotMatch(panel, /current \|\| 1/);
  assert.match(sidebar, /row\.extractionProvider\.startsWith\('firecrawl'\)/);
  assert.match(sidebar, /extraction\.source === 'firecrawl'/);
  assert.match(sidebar, /source: 'firecrawl'/);
  assert.match(sidebar, /isFirecrawlLoading/);
  assert.match(sidebar, /const firecrawlPendingHint = isArabicLocale/);
  assert.match(sidebar, /لم تبدأ خدمة السحب بعد/);
  assert.doesNotMatch(sidebar, /لم يبدأ استخراج Gemini|Gemini extraction has not started/);
});

test('dual extraction failure is excluded until the canonical marker is manually replaced', async () => {
  assert.equal(isCompetitorExtractionFailureText(COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT), true);
  assert.equal(getUsableCompetitorText(COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT), '');
  assert.equal(getUsableCompetitorText('Manual competitor article text.'), 'Manual competitor article text.');
  assert.deepEqual(
    sanitizeCompetitorSlots(
      ['First competitor', COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT, 'Manual replacement'],
      ['https://one.example', 'https://failed.example', 'https://manual.example'],
    ),
    {
      texts: ['First competitor', '', 'Manual replacement'],
      urls: ['https://one.example', '', 'https://manual.example'],
    },
  );

  const [api, executor, sidebar, engineeringExecutor, writingContext] = await Promise.all([
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('server/externalEngineeringAnalysisExecutor.ts'),
    readWorkspaceFile('utils/contentWritingContext.ts'),
  ]);
  assert.match(executor, /firecrawl_programmatic_failed/);
  assert.match(api, /action === 'save_manual_text'/);
  assert.match(api, /sync_article_competitors_metadata/);
  assert.match(sidebar, /saveArticleCompetitorManualText/);
  assert.match(sidebar, /isCompetitorExtractionFailureText\(event\.currentTarget\.value\)/);
  assert.match(engineeringExecutor, /sanitizeCompetitorSlots/);
  assert.match(writingContext, /getUsableCompetitorText/);
});

test('competitor sidebar keeps one unlabeled canonical text box and no Firecrawl or AI result card', async () => {
  const [sidebar, translations, writingContext, engineeringExecutor] = await Promise.all([
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/translations.ts'),
    readWorkspaceFile('utils/contentWritingContext.ts'),
    readWorkspaceFile('server/externalEngineeringAnalysisExecutor.ts'),
  ]);

  assert.doesNotMatch(sidebar, /competitorPlainTextField/);
  assert.doesNotMatch(sidebar, /canonicalAnalysisSource/);
  assert.doesNotMatch(sidebar, /competitorPlainTextUsageHint/);
  assert.match(sidebar, /extraction\.source === 'text'/);
  assert.match(sidebar, /extraction\.source === 'firecrawl'/);
  assert.match(sidebar, /extraction\.source === 'url'/);
  assert.doesNotMatch(sidebar, /firecrawlExtractionPreview/);
  assert.match(sidebar, /programmaticExtractionPreview/);
  assert.doesNotMatch(sidebar, /aiExtractionPreview/);
  assert.match(sidebar, /extractionPreviewUsageHint/);
  assert.doesNotMatch(sidebar, /tRs\.extractedContent/);
  assert.doesNotMatch(translations, /competitorPlainTextField:/);
  assert.doesNotMatch(translations, /canonicalAnalysisSource:/);
  assert.doesNotMatch(translations, /competitorPlainTextUsageHint:/);
  assert.doesNotMatch(translations, /aiExtractionPreview:/);
  assert.match(translations, /هذه بطاقة معاينة للمصدر والبنية فقط وليست مدخلًا ثانيًا/);
  assert.doesNotMatch(translations, /extractedContent:\s*'المحتوى المستخرج'/);
  assert.doesNotMatch(translations, /firecrawlExtractionPreview/);
  assert.match(writingContext, /attachments\.competitors\.texts is the single canonical competitor input/);
  assert.match(engineeringExecutor, /same persisted canonical competitor texts as content writing/);
  assert.doesNotMatch(sidebar, /fullExtractedText/);
  assert.doesNotMatch(translations, /fullExtractedText/);
});

test('search results and saved article sources open their safe original URL in a new tab', async () => {
  const panel = await readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx');

  assert.match(panel, /const resolveExternalSourceUrl/);
  assert.match(panel, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  assert.match(panel, /const searchSourceUrl = resolveExternalSourceUrl\(result\.canonicalUrl, result\.url\)/);
  assert.match(panel, /const savedSourceUrl = resolveExternalSourceUrl\(row\.canonicalUrl, row\.sourceUrl\)/);
  assert.ok((panel.match(/target="_blank"/g) || []).length >= 2);
  assert.ok((panel.match(/rel="noopener noreferrer"/g) || []).length >= 2);
  assert.ok((panel.match(/<ExternalLink size=\{14\} \/>/g) || []).length >= 2);
});
