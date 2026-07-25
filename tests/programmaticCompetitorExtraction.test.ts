import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  extractProgrammaticCompetitorContentFromHtml,
  isPrivateCompetitorAddress,
  normalizeProgrammaticCompetitorUrl,
  ProgrammaticCompetitorExtractionError,
} from '../server/programmaticCompetitorExtractor.ts';

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
  assert.match(translations, /وضع النص الكامل في خانة «محتوى نصي عادي»/);
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
