import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  extractProgrammaticCompetitorContentFromHtml,
  isPrivateCompetitorAddress,
  normalizeProgrammaticCompetitorUrl,
  ProgrammaticCompetitorExtractionError,
} from '../server/programmaticCompetitorExtractor.ts';
import {
  BrowserlessCompetitorExtractionError,
  classifyBrowserlessRestrictedPage,
  getBrowserlessCompetitorContent,
} from '../server/browserlessCompetitorExtractor.ts';
import { ProviderAccessError } from '../server/providerAccessControl.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('programmatic competitor URLs remove tracking data and reject private destinations', () => {
  assert.equal(
    normalizeProgrammaticCompetitorUrl('https://Example.com/article/?utm_source=test&keep=yes#part'),
    'https://example.com/article/?keep=yes',
  );
  for (const value of [
    'http://localhost:3000/private',
    'http://127.0.0.1/private',
    'http://10.20.30.40/private',
    'http://192.168.1.10/private',
    'http://[::1]/private',
    'file:///etc/passwd',
  ]) {
    assert.throws(
      () => normalizeProgrammaticCompetitorUrl(value),
      (error: unknown) => error instanceof ProgrammaticCompetitorExtractionError
        && error.code === 'unsafe_competitor_url',
      value,
    );
  }
  assert.equal(isPrivateCompetitorAddress('169.254.10.20'), true);
  assert.equal(isPrivateCompetitorAddress('203.0.113.10'), true);
  assert.equal(isPrivateCompetitorAddress('8.8.8.8'), false);
});

test('programmatic extraction keeps article order and removes navigation and page noise', () => {
  const extracted = extractProgrammaticCompetitorContentFromHtml({
    sourceUrl: 'https://example.com/source?utm_campaign=ignored',
    finalUrl: 'https://www.example.com/final',
    responseContentType: 'text/html; charset=utf-8',
    redirectCount: 1,
    html: `<!doctype html>
      <html lang="ar">
        <head>
          <title>دليل التحول الرقمي العملي</title>
          <meta name="description" content="وصف واضح للدليل العملي">
          <link rel="canonical" href="/digital-guide">
        </head>
        <body>
          <nav>الرئيسية الخدمات اتصل بنا</nav>
          <article>
            <h1>دليل التحول الرقمي</h1>
            <p>يشرح هذا الدليل خطوات التحول الرقمي للمؤسسات بطريقة عملية تبدأ بتحديد الأهداف وقياس الوضع الحالي ثم ترتيب الأولويات وتوزيع المسؤوليات بوضوح.</p>
            <h2>تقييم الوضع الحالي</h2>
            <p>يبدأ الفريق بجمع بيانات العمليات والأنظمة وتجربة العملاء، ثم يوثق المشكلات المتكررة ويقارن أثرها بالوقت والتكلفة والجودة والمخاطر التشغيلية.</p>
            <ul>
              <li>توثيق العمليات الأكثر تأثيرًا في تجربة العميل وفي كفاءة فرق العمل.</li>
              <li>اختيار مؤشرات قابلة للقياس ومراجعتها في مواعيد ثابتة مع أصحاب القرار.</li>
            </ul>
            <div class="related-posts"><p>مقالات ذات صلة لا تدخل في المحتوى الأساسي للمقالة.</p></div>
            <h3>خطة التنفيذ</h3>
            <p>تحول النتائج إلى خطة زمنية قصيرة المراحل، ويحدد لكل مرحلة مالك واضح وميزانية ومؤشر نجاح وآلية تصحيح عند ظهور انحراف.</p>
          </article>
          <footer>سياسة الخصوصية وجميع الحقوق محفوظة</footer>
        </body>
      </html>`,
  });

  assert.equal(extracted.url, 'https://example.com/source');
  assert.equal(extracted.fetchedUrl, 'https://www.example.com/final');
  assert.equal(extracted.canonicalUrl, 'https://www.example.com/digital-guide');
  assert.equal(extracted.title, 'دليل التحول الرقمي العملي');
  assert.deepEqual(extracted.headings, {
    h1: ['دليل التحول الرقمي'],
    h2: ['تقييم الوضع الحالي'],
    h3: ['خطة التنفيذ'],
  });
  assert.ok(extracted.wordCount >= 70);
  assert.ok(extracted.qualityScore >= 50);
  assert.ok(extracted.text.indexOf('دليل التحول الرقمي') < extracted.text.indexOf('تقييم الوضع الحالي'));
  assert.ok(extracted.text.indexOf('تقييم الوضع الحالي') < extracted.text.indexOf('خطة التنفيذ'));
  assert.doesNotMatch(extracted.text, /الرئيسية الخدمات|سياسة الخصوصية|مقالات ذات صلة/);
  assert.equal(extracted.provider, 'programmatic');
  assert.equal(extracted.cacheHit, false);
  assert.equal(extracted.redirectCount, 1);
});

test('JSON-LD articleBody provides a deterministic fallback for script-rendered article pages', () => {
  const articleBody = [
    'تشرح هذه المقالة كيفية بناء خطة محتوى قوية تبدأ بفهم نية البحث وتحديد الأسئلة التي يحتاج القارئ إلى إجابات عملية عنها.',
    'بعد ذلك تجمع الأدلة الموثوقة وتوزع الأفكار على أقسام متتابعة دون تكرار، مع الحفاظ على الصلة بين العنوان وكل فقرة.',
    'وفي المرحلة الأخيرة تراجع الدقة والوضوح والروابط والنتيجة المطلوبة للقارئ قبل اعتماد النسخة النهائية ونشرها.',
  ].join(' ');
  const extracted = extractProgrammaticCompetitorContentFromHtml({
    sourceUrl: 'https://example.org/rendered-article',
    html: `<html>
      <head><title>خطة محتوى قوية</title></head>
      <body>
        <main><h1>إنشاء خطة المحتوى</h1><div id="app">جار تحميل المحتوى...</div></main>
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          articleBody,
        })}</script>
      </body>
    </html>`,
  });

  assert.equal(extracted.headings.h1[0], 'إنشاء خطة المحتوى');
  assert.match(extracted.text, /تشرح هذه المقالة/);
  assert.match(extracted.text, /المرحلة الأخيرة/);
  assert.ok(extracted.wordCount >= 45);
});

const renderedArticleHtml = `<!doctype html>
  <html lang="ar">
    <head>
      <title>دليل أجهزة كشف الذهب الاحترافية</title>
      <meta name="description" content="مقارنة عملية بين أجهزة كشف الذهب الحديثة">
      <link rel="canonical" href="/gold-detectors-guide">
    </head>
    <body>
      <main>
        <article>
          <h1>اختيار جهاز كشف الذهب المناسب</h1>
          <p>يشرح هذا الدليل طريقة اختيار جهاز كشف الذهب المناسب حسب عمق البحث ونوع التربة والميزانية المتاحة، مع توضيح الفروق العملية بين التقنيات والملفات وخيارات الضبط.</p>
          <h2>مقارنة الخصائص الأساسية</h2>
          <p>تبدأ المقارنة بقياس استقرار الإشارة ودقة تمييز المعادن وسهولة المعايرة في البيئات المختلفة، ثم تراجع مدة البطارية ووزن الجهاز وخدمة الضمان والتدريب.</p>
          <p>ينبغي تجربة الإعدادات في تربة معروفة قبل الانتقال إلى الموقع المستهدف، وتوثيق النتائج حتى يستطيع المستخدم تحسين الحساسية وتقليل الإشارات الوهمية تدريجيًا.</p>
        </article>
      </main>
    </body>
  </html>`;

const browserlessFunctionResponse = (options: {
  html?: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  navigationError?: string;
  observedUrls?: string[];
  navigationUrls?: string[];
  remoteAddresses?: string[];
  blockedUrls?: string[];
} = {}): Response => {
  const finalUrl = options.finalUrl || 'https://example.com/original';
  return new Response(JSON.stringify({
    data: {
      html: options.html ?? renderedArticleHtml,
      finalUrl,
      status: options.status ?? 200,
      contentType: options.contentType || 'text/html; charset=utf-8',
      navigationError: options.navigationError || '',
      observedUrls: options.observedUrls || [finalUrl],
      navigationUrls: options.navigationUrls || [finalUrl],
      remoteAddresses: options.remoteAddresses || ['93.184.216.34'],
      blockedUrls: options.blockedUrls || [],
    },
    type: 'application/json',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const browserlessTestUserId = '11111111-1111-4111-8111-111111111111';

test('Browserless fallback reserves the authorized provider quota and returns the programmatic content shape', async () => {
  const calls: string[] = [];
  let providerRequest: Record<string, unknown> | null = null;
  let browserlessRequest: { endpoint: string; body: Record<string, unknown> } | null = null;
  const content = await getBrowserlessCompetitorContent({
    url: 'https://example.com/original?utm_source=ignored',
    userId: browserlessTestUserId,
    dependencies: {
      validateTargetUrl: async value => {
        calls.push('validate');
        return normalizeProgrammaticCompetitorUrl(value);
      },
      resolveCredential: async (provider, userId) => {
        calls.push('credential');
        assert.equal(provider, 'browserless');
        assert.equal(userId, browserlessTestUserId);
        return { apiKey: 'browserless-secret-key', keySuffix: '-key', source: 'admin' };
      },
      reserveRequest: async options => {
        calls.push('quota');
        providerRequest = options;
        return {
          allowed: true,
          duplicate: false,
          dailyUsed: 1,
          monthlyUsed: 1,
          dailyLimit: 20,
          monthlyLimit: 500,
          schemaAvailable: true,
        };
      },
      fetchImpl: async (input, init) => {
        calls.push('fetch');
        browserlessRequest = {
          endpoint: String(input),
          body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        };
        return browserlessFunctionResponse();
      },
    },
  });

  assert.deepEqual(calls, ['validate', 'credential', 'quota', 'fetch', 'validate']);
  assert.deepEqual(providerRequest, {
    userId: browserlessTestUserId,
    provider: 'browserless',
    operation: 'competitor_rendered_scrape',
  });
  assert.match(browserlessRequest?.endpoint || '', /\/function\?token=browserless-secret-key$/);
  assert.match(String(browserlessRequest?.body.code || ''), /setRequestInterception\(true\)/);
  assert.match(String(browserlessRequest?.body.code || ''), /remoteAddress\(\)/);
  assert.equal(
    (browserlessRequest?.body.context as Record<string, unknown>)?.url,
    'https://example.com/original',
  );
  assert.equal('bestAttempt' in (browserlessRequest?.body || {}), false);
  assert.equal('solveCaptcha' in (browserlessRequest?.body || {}), false);
  assert.equal(content.url, 'https://example.com/original');
  assert.equal(content.canonicalUrl, 'https://example.com/gold-detectors-guide');
  assert.equal(content.provider, 'programmatic');
  assert.equal(content.cacheHit, false);
  assert.match(content.responseContentType, /renderer=browserless/);
  assert.ok(content.wordCount >= 65);
  assert.match(content.text, /استقرار الإشارة/);
});

test('Browserless fallback validates redirect URLs and persists the real final URL', async () => {
  const validatedUrls: string[] = [];
  const content = await getBrowserlessCompetitorContent({
    url: 'https://example.com/original',
    userId: browserlessTestUserId,
    dependencies: {
      validateTargetUrl: async value => {
        validatedUrls.push(value);
        return normalizeProgrammaticCompetitorUrl(value);
      },
      resolveCredential: async () => ({
        apiKey: 'browserless-secret-key',
        keySuffix: '-key',
        source: 'admin',
      }),
      reserveRequest: async () => ({
        allowed: true,
        duplicate: false,
        dailyUsed: 1,
        monthlyUsed: 1,
        dailyLimit: 20,
        monthlyLimit: 500,
        schemaAvailable: true,
      }),
      fetchImpl: async () => browserlessFunctionResponse({
        finalUrl: 'https://www.example.com/final',
        observedUrls: ['https://example.com/original', 'https://www.example.com/final'],
        navigationUrls: ['https://example.com/original', 'https://www.example.com/final'],
      }),
    },
  });

  assert.deepEqual(validatedUrls, [
    'https://example.com/original',
    'https://example.com/original',
    'https://www.example.com/final',
  ]);
  assert.equal(content.fetchedUrl, 'https://www.example.com/final');
  assert.equal(content.canonicalUrl, 'https://www.example.com/gold-detectors-guide');
  assert.equal(content.redirectCount, 1);
});

test('Browserless fallback rejects blocked requests, private final URLs, and private remote addresses', async () => {
  const credential = async () => ({
    apiKey: 'browserless-secret-key',
    keySuffix: '-key',
    source: 'admin' as const,
  });
  const reserve = async () => ({
    allowed: true,
    duplicate: false,
    dailyUsed: 1,
    monthlyUsed: 1,
    dailyLimit: 20,
    monthlyLimit: 500,
    schemaAvailable: true,
  });
  const scenarios = [
    browserlessFunctionResponse({
      blockedUrls: ['http://169.254.169.254/latest/meta-data'],
    }),
    browserlessFunctionResponse({
      finalUrl: 'http://127.0.0.1/admin',
      observedUrls: ['http://127.0.0.1/admin'],
      navigationUrls: ['http://127.0.0.1/admin'],
    }),
    browserlessFunctionResponse({
      remoteAddresses: ['10.20.30.40'],
    }),
    browserlessFunctionResponse({
      remoteAddresses: ['::ffff:7f00:1'],
    }),
  ];

  for (const response of scenarios) {
    await assert.rejects(
      getBrowserlessCompetitorContent({
        url: 'https://example.com/original',
        userId: browserlessTestUserId,
        dependencies: {
          validateTargetUrl: async value => normalizeProgrammaticCompetitorUrl(value),
          resolveCredential: credential,
          reserveRequest: reserve,
          fetchImpl: async () => response,
        },
      }),
      (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
        && error.code === 'unsafe_competitor_address'
        && error.retryable === false,
    );
  }

  await assert.rejects(
    getBrowserlessCompetitorContent({
      url: 'https://example.com/original',
      userId: browserlessTestUserId,
      dependencies: {
        validateTargetUrl: async value => normalizeProgrammaticCompetitorUrl(value),
        resolveCredential: credential,
        reserveRequest: reserve,
        fetchImpl: async () => browserlessFunctionResponse({ remoteAddresses: [] }),
      },
    }),
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'browserless_remote_address_missing'
      && error.status === 502
      && error.retryable === true,
  );
});

test('Browserless deadline cancellation covers preflight work and streamed response bodies', async () => {
  const preflightController = new AbortController();
  const preflight = getBrowserlessCompetitorContent({
    url: 'https://example.com/article',
    userId: browserlessTestUserId,
    signal: preflightController.signal,
    dependencies: {
      validateTargetUrl: async () => new Promise<string>(() => {}),
    },
  });
  preflightController.abort(new Error('cancelled by test'));
  await assert.rejects(
    preflight,
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'competitor_extraction_cancelled'
      && error.status === 499
      && error.retryable === false,
  );

  const bodyController = new AbortController();
  const streamed = getBrowserlessCompetitorContent({
    url: 'https://example.com/article',
    userId: browserlessTestUserId,
    signal: bodyController.signal,
    dependencies: {
      validateTargetUrl: async value => value,
      resolveCredential: async () => ({
        apiKey: 'browserless-secret-key',
        keySuffix: '-key',
        source: 'admin',
      }),
      reserveRequest: async () => ({
        allowed: true,
        duplicate: false,
        dailyUsed: 1,
        monthlyUsed: 1,
        dailyLimit: 20,
        monthlyLimit: 500,
        schemaAvailable: true,
      }),
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => {
          bodyController.abort(new Error('cancelled while reading'));
          return new Promise<void>(() => {});
        },
      }), { status: 200 }),
    },
  });
  await assert.rejects(
    streamed,
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'competitor_extraction_cancelled'
      && error.status === 499,
  );
});

test('Browserless errors redact raw and encoded tokens and preserve transient access failures', async () => {
  const apiKey = 'browserless-secret+/=?';
  await assert.rejects(
    getBrowserlessCompetitorContent({
      url: 'https://example.com/article',
      userId: browserlessTestUserId,
      dependencies: {
        validateTargetUrl: async value => value,
        resolveCredential: async () => ({ apiKey, keySuffix: '=/=?', source: 'admin' }),
        reserveRequest: async () => ({
          allowed: true,
          duplicate: false,
          dailyUsed: 1,
          monthlyUsed: 1,
          dailyLimit: 20,
          monthlyLimit: 500,
          schemaAvailable: true,
        }),
        fetchImpl: async input => {
          throw new Error(`Could not fetch ${String(input)} with ${apiKey}`);
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserlessCompetitorExtractionError);
      assert.doesNotMatch(error.message, new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(error.message, new RegExp(encodeURIComponent(apiKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /token=\[redacted\]/);
      return true;
    },
  );

  await assert.rejects(
    getBrowserlessCompetitorContent({
      url: 'https://example.com/article',
      userId: browserlessTestUserId,
      dependencies: {
        validateTargetUrl: async value => value,
        resolveCredential: async () => ({ apiKey, keySuffix: '=/=?', source: 'admin' }),
        reserveRequest: async () => {
          throw new ProviderAccessError(
            'Provider policy storage is temporarily unavailable.',
            503,
            'PROVIDER_ACCESS_STORAGE_UNAVAILABLE',
          );
        },
      },
    }),
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'provider_access_storage_unavailable'
      && error.status === 503
      && error.retryable === true,
  );
});

test('Browserless fallback refuses CAPTCHA and authentication walls without attempting a bypass', async () => {
  const credential = async () => ({
    apiKey: 'browserless-secret-key',
    keySuffix: '-key',
    source: 'assigned_all' as const,
  });
  const reserve = async () => ({
    allowed: true,
    duplicate: false,
    dailyUsed: 1,
    monthlyUsed: 1,
    dailyLimit: 10,
    monthlyLimit: 100,
    schemaAvailable: true,
  });
  const scenarios = [
    {
      expected: 'browserless_captcha_required',
      html: '<html><head><title>Just a moment...</title></head><body><form id="challenge-form"><div class="cf-turnstile">Verify you are human</div></form></body></html>',
      url: 'https://example.com/article',
    },
    {
      expected: 'browserless_authentication_required',
      html: '<html><head><title>تسجيل الدخول</title></head><body><main><form action="/login"><input type="password"></form></main></body></html>',
      url: 'https://example.com/login',
    },
  ];

  for (const scenario of scenarios) {
    await assert.rejects(
      getBrowserlessCompetitorContent({
        url: scenario.url,
        userId: browserlessTestUserId,
        dependencies: {
          validateTargetUrl: async value => value,
          resolveCredential: credential,
          reserveRequest: reserve,
          fetchImpl: async () => browserlessFunctionResponse({
            html: scenario.html,
            finalUrl: scenario.url,
            observedUrls: [scenario.url],
            navigationUrls: [scenario.url],
          }),
        },
      }),
      (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
        && error.code === scenario.expected
        && error.retryable === false,
    );
  }
});

test('Browserless restriction detection does not reject an editorial page with an optional login modal', () => {
  assert.equal(classifyBrowserlessRestrictedPage({
    url: 'https://example.com/article',
    html: `${renderedArticleHtml}<form class="login-modal"><input type="password"></form>`,
  }), null);
});

test('Browserless fallback stops before the network request when access quota is denied', async () => {
  let fetched = false;
  await assert.rejects(
    getBrowserlessCompetitorContent({
      url: 'https://example.com/article',
      userId: browserlessTestUserId,
      dependencies: {
        validateTargetUrl: async value => value,
        resolveCredential: async () => ({
          apiKey: 'browserless-secret-key',
          keySuffix: '-key',
          source: 'user',
        }),
        reserveRequest: async () => {
          throw new ProviderAccessError(
            'The provider request quota has been reached for this user.',
            429,
            'PROVIDER_REQUEST_QUOTA_EXCEEDED',
          );
        },
        fetchImpl: async () => {
          fetched = true;
          return new Response(renderedArticleHtml);
        },
      },
    }),
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'provider_request_quota_exceeded'
      && error.status === 429
      && error.retryable === false,
  );
  assert.equal(fetched, false);
});

test('Browserless fallback requires an authenticated user before credential or quota access', async () => {
  let touchedProvider = false;
  await assert.rejects(
    getBrowserlessCompetitorContent({
      url: 'https://example.com/article',
      dependencies: {
        validateTargetUrl: async value => {
          touchedProvider = true;
          return value;
        },
        resolveCredential: async () => {
          touchedProvider = true;
          return null;
        },
        reserveRequest: async () => {
          touchedProvider = true;
          throw new Error('quota must not be touched');
        },
      },
    }),
    (error: unknown) => error instanceof BrowserlessCompetitorExtractionError
      && error.code === 'browserless_user_identity_required'
      && error.status === 403
      && error.retryable === false,
  );
  assert.equal(touchedProvider, false);
});

test('competitor UI exposes separate AI and programmatic extraction with automatic AI fallback', async () => {
  const [sidebar, translations, promptRegistry, browserClient, apiHandler, extractor] = await Promise.all([
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/translations.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('utils/competitorDiscovery.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/programmaticCompetitorExtractor.ts'),
  ]);

  assert.match(sidebar, /handleExtractCompetitorUrl/);
  assert.match(sidebar, /handleExtractCompetitorProgrammatically/);
  assert.match(sidebar, /handleCancelProgrammaticExtraction/);
  assert.match(sidebar, /await runCompetitorExtraction\([\s\S]*fallbackNotice/);
  assert.match(sidebar, /controller\.signal\.aborted/);
  assert.match(sidebar, /programmaticExtractionCancelled/);
  assert.match(sidebar, /setCompetitorPlainTextFromExtraction\(index, content\)/);
  assert.match(sidebar, /textIndex === index \? extractedText : text/);
  assert.match(sidebar, /const text = plainText \|\| extractedText/);
  assert.match(translations, /وضع النص الكامل في خانة «النص المعتمد للتحليل والكتابة»/);
  assert.match(promptRegistry, /نسخة واحدة من خانة المحتوى النصي العادي لكل منافس/);
  assert.doesNotMatch(sidebar, /competitorGeminiProgress/);
  assert.match(browserClient, /action:\s*'programmatic_extract'/);
  assert.match(browserClient, /signal:\s*options\.signal/);
  assert.match(apiHandler, /getProgrammaticCompetitorContent/);
  assert.match(apiHandler, /competitors-programmatic-extract/);
  assert.match(extractor, /redirect:\s*'manual'/);
  assert.match(extractor, /validateResolvedPublicUrl\(new URL\(location/);
  assert.match(extractor, /maximumBytes/);
  assert.doesNotMatch(extractor, /Gemini|OpenAI|runGeminiAnalysisEngine|chatgpt/i);
});
