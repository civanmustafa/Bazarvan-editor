import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractArticleImportPreviewFromHtml } from '../server/articleImportService.ts';
import {
  createEditorContentFromPlainText,
  getSafeEditorContent,
  normalizeStoredEditorContent,
} from '../utils/editorStoredContent.ts';

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

test('a long imported TipTap document keeps formatting and link attributes when restored', () => {
  const linkAttributes: Record<string, string | null> = {
    href: 'https://www.example.com/internal-page',
    target: '_self',
    rel: 'noopener',
    class: null,
    title: 'صفحة داخلية',
  };
  const longParagraphs = Array.from({ length: 23 }, (_, paragraphIndex) => ({
    type: 'paragraph',
    attrs: { textAlign: paragraphIndex % 2 === 0 ? 'right' : null },
    content: [{
      type: 'text',
      text: Array.from(
        { length: 100 },
        (_, wordIndex) => `كلمة-${paragraphIndex + 1}-${wordIndex + 1}`,
      ).join(' '),
    }],
  }));
  const storedDocument: any = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2, textAlign: 'right' },
        content: [{ type: 'text', text: 'عنوان القسم' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'قبل الرابط ' },
          { type: 'text', text: 'رابط داخلي', marks: [{ type: 'link', attrs: linkAttributes }] },
          { type: 'text', text: ' بعد الرابط' },
        ],
      },
      {
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'عنصر قائمة منسق' }],
          }],
        }],
      },
      {
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'العنوان' }] }],
            },
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'القيمة' }] }],
            },
          ],
        }],
      },
      ...longParagraphs,
    ],
  };
  const wordCount = longParagraphs.reduce(
    (total, paragraph) => total + paragraph.content[0].text.split(/\s+/).length,
    0,
  );

  assert.ok(wordCount > 2_000);
  assert.deepEqual(normalizeStoredEditorContent(storedDocument), storedDocument);

  const restored = getSafeEditorContent(storedDocument, { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.notEqual(typeof restored, 'string');
  assert.deepEqual(restored, storedDocument);
  assert.deepEqual(restored.content[1].content[1].marks[0].attrs, linkAttributes);
});

test('invalid stored JSON prefers meaningful HTML before plain-text recovery', () => {
  const invalidStoredDocument = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{
          type: 'text',
          text: 'عنوان من JSON غير صالح',
          marks: [{ type: 'unsupportedLegacyMark' }],
        }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'نص مجرد لا ينبغي اختياره' }] },
    ],
  };
  const fallbackHtml = '<h2>عنوان HTML المحفوظ</h2><p>فقرة منسقة <a href="https://www.example.com/internal">برابط داخلي</a>.</p>';

  assert.equal(normalizeStoredEditorContent(invalidStoredDocument), null);
  assert.equal(getSafeEditorContent(invalidStoredDocument, fallbackHtml), fallbackHtml);
});

test('plain-text recovery from invalid stored JSON creates separate TipTap paragraphs', () => {
  const invalidStoredDocument = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{
          type: 'text',
          text: 'العنوان المستعاد',
          marks: [{ type: 'unsupportedLegacyMark' }],
        }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'الفقرة الأولى' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'الفقرة الثانية' }] },
    ],
  };

  const restored = getSafeEditorContent(
    invalidStoredDocument,
    { type: 'doc', content: [{ type: 'paragraph' }] },
  );

  assert.notEqual(typeof restored, 'string');
  assert.deepEqual(restored, {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'العنوان المستعاد' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'الفقرة الأولى' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'الفقرة الثانية' }] },
    ],
  });
});

test('direct multiline plain text becomes a TipTap document with separate paragraphs', () => {
  assert.deepEqual(
    createEditorContentFromPlainText('السطر الأول\n\nالسطر الثاني\r\nالسطر الثالث'),
    {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'السطر الأول' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'السطر الثاني' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'السطر الثالث' }] },
      ],
    },
  );
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
  assert.match(editorContext, /const snapshotContentHtml = snapshot\?\.contentHtml/);
  assert.match(editorContext, /createEditorContentFromPlainText\(snapshotPlainText\)/);
  assert.match(editorContext, /const storedContentFallback = isUsableEditorContent\(snapshotContentHtml\)/);
  assert.match(editorContext, /setEditorContentSafely\([\s\S]*?storedContentFallback,/);
  assert.match(migration, /new\.source := 'import'/);
  assert.match(migration, /importOrigin/);
});
