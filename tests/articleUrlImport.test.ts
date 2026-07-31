import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractArticleImportPreviewFromHtml } from '../server/articleImportService.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('URL article import preserves safe editorial formatting and skips images and page chrome', () => {
  const preview = extractArticleImportPreviewFromHtml({
    sourceUrl: 'https://example.com/news/story?utm_source=newsletter',
    finalUrl: 'https://www.example.com/news/story',
    html: `<!doctype html>
      <html lang="ar">
        <head>
          <title>خبر تقني مهم - الموقع</title>
          <meta property="og:title" content="خبر تقني مهم">
          <meta name="author" content="فريق التحرير">
          <link rel="canonical" href="/canonical-story">
        </head>
        <body>
          <nav><a href="/">الرئيسية</a><a href="/news">الأخبار</a></nav>
          <article class="article-shell">
            <h1>خبر تقني مهم</h1>
            <p>تشرح هذه الفقرة <strong onclick="alert(1)">تفاصيل الخبر المهمة</strong> وتعرض خلفيته للقارئ بصورة واضحة ومباشرة تساعده على فهم الموضوع.</p>
            <h2>أبرز التفاصيل</h2>
            <p>يتضمن الخبر <em>معلومات موثوقة</em> مع <a href="/source">رابط إلى المصدر</a> ومزيد من الشرح المنظم داخل المقالة.</p>
            <ul><li>النقطة الأولى مكتوبة بوضوح.</li><li>النقطة الثانية تحتوي على تفاصيل إضافية.</li></ul>
            <table class="source-table"><tbody><tr><th colspan="2">البيان</th></tr><tr><td>القيمة</td><td>النتيجة</td></tr></tbody></table>
            <figure><img src="/one.jpg" onerror="alert(1)"><figcaption>وصف الصورة المحذوفة.</figcaption></figure>
            <picture><source srcset="/two.webp"><img src="/two.jpg"></picture>
            <script>alert('unsafe')</script>
          </article>
          <aside class="related-posts"><p>مقالات ذات صلة لا تدخل في النص الأساسي.</p></aside>
        </body>
      </html>`,
  });

  assert.equal(preview.sourceUrl, 'https://example.com/news/story');
  assert.equal(preview.canonicalUrl, 'https://www.example.com/canonical-story');
  assert.equal(preview.title, 'خبر تقني مهم');
  assert.equal(preview.author, 'فريق التحرير');
  assert.equal(preview.language, 'ar');
  assert.equal(preview.skippedImageCount, 2);
  assert.equal(preview.counts.links, 1);
  assert.equal(preview.counts.lists, 1);
  assert.equal(preview.counts.tables, 1);
  assert.match(preview.contentHtml, /<strong>تفاصيل الخبر المهمة<\/strong>/);
  assert.match(preview.contentHtml, /<em>معلومات موثوقة<\/em>/);
  assert.match(preview.contentHtml, /href="https:\/\/www\.example\.com\/source"/);
  assert.match(preview.contentHtml, /<table><tbody><tr><th colspan="2">/);
  assert.doesNotMatch(preview.contentHtml, /<img|<script|onclick|onerror|class=|javascript:/i);
  assert.doesNotMatch(preview.contentHtml, /<h1>/i);
  assert.doesNotMatch(preview.plainText, /الرئيسية|مقالات ذات صلة|unsafe/);
  assert.equal(preview.extractionProvider, 'rich_html');
  assert.match(preview.contentHash, /^[a-f0-9]{64}$/);
});

test('URL article import integration exposes the route, inline 75/25 control, modal, editor command, and import source migration', async () => {
  const [routes, api, modal, toolbar, tips, documentActions, editorContext, migration] = await Promise.all([
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('api/articleImport.ts'),
    readWorkspaceFile('components/ArticleImportModal.tsx'),
    readWorkspaceFile('components/EditorToolbar.tsx'),
    readWorkspaceFile('components/TipsCarousel.tsx'),
    readWorkspaceFile('components/toolbar/DocumentActions.tsx'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('supabase/migrations/20260731030000_article_url_import_source.sql'),
  ]);

  assert.match(routes, /path:\s*'\/api\/articles\/import-preview'/);
  assert.match(api, /authenticateApiRequest/);
  assert.match(api, /consumeApiRateLimit\('articles:import-preview'/);
  assert.match(modal, /fetchArticleImportPreview/);
  assert.match(modal, /autoFetch/);
  assert.match(modal, /تم تجاهل.*صورة/);
  assert.match(modal, /dangerouslySetInnerHTML/);
  assert.match(toolbar, /grid-cols-\[minmax\(0,3fr\)_minmax\(0,1fr\)\]/);
  assert.match(toolbar, /article-import-inline-url/);
  assert.match(toolbar, /'سحب'/);
  assert.match(toolbar, /initialUrl=\{articleImportUrl\}/);
  assert.match(tips, /handleLanguageChange/);
  assert.match(tips, /isIdle \? t\.idle : t\.active/);
  assert.doesNotMatch(documentActions, /onImportArticle|FileInput/);
  assert.match(editorContext, /applyImportedArticleContent/);
  assert.match(editorContext, /insertContent\(preview\.contentHtml\)/);
  assert.match(editorContext, /setEditorContentSafely\(editor,\s*preview\.contentHtml/);
  assert.match(migration, /new\.source := 'import'/);
  assert.match(migration, /importOrigin/);
});
