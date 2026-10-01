import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStructuredArticleExport,
  DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS,
} from '../utils/articleStructuredExport.ts';

const document = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'هذه مقدمة ' },
        { type: 'text', text: 'واضحة', marks: [{ type: 'bold' }] },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'طريقة الاستخدام' }],
    },
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ابدأ هنا' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'أكمل هنا' }] }] },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'الأسئلة الشائعة' }],
    },
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'ما السؤال الأول؟' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'هذه الإجابة.' }],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'الخاتمة' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'هذه الخلاصة.' }],
    },
  ],
};

const input = {
  title: 'دليل الاختبار المنظم',
  metaDescription: 'الوصف المختار للمقالة.',
  language: 'ar' as const,
  keywords: {
    primary: 'الكلمة الأساسية',
    secondaries: ['الصيغة الأولى', 'الصيغة الثانية'],
    company: '',
    lsi: ['عبارة LSI'],
    googleTitles: ['دليل الاختبار المنظم', 'عنوان بديل'],
    googleDescriptions: [
      { text: 'الوصف المختار للمقالة.', callToAction: '' },
      { text: 'وصف بديل للمقالة.', callToAction: '' },
    ],
  },
  document,
};

test('structured Markdown separates SEO context from the article body', () => {
  const result = buildStructuredArticleExport(input, 'markdown');

  assert.equal(result.filename, 'دليل-الاختبار-المنظم.md');
  assert.equal(result.sectionCount, 4);
  assert.match(result.content, /schema: "bazarvan-article\/1"/);
  assert.match(result.content, /primary_keyword: "الكلمة الأساسية"/);
  assert.match(result.content, /alternative_phrases:\n  - "الصيغة الأولى"\n  - "الصيغة الثانية"/);
  assert.match(result.content, /lsi_keywords:\n  - "عبارة LSI"/);
  assert.match(result.content, /text: "دليل الاختبار المنظم"\n    selected: true/);
  assert.match(result.content, /text: "الوصف المختار للمقالة\."\n    selected: true/);
  assert.match(result.content, /<!-- ARTICLE_BODY_START -->\n\n# دليل الاختبار المنظم/);
  assert.match(result.content, /SECTION_START role="introduction" id="introduction"/);
  assert.match(result.content, /SECTION_START role="steps" id="section-2"/);
  assert.match(result.content, /SECTION_START role="faq" id="section-3"/);
  assert.match(result.content, /SECTION_START role="conclusion" id="section-4"/);
  assert.match(result.content, /هذه مقدمة \*\*واضحة\*\*\./);
  assert.match(result.content, /1\. ابدأ هنا\n2\. أكمل هنا/);
  assert.deepEqual(result.warnings, []);
});

test('structured UTF-8 text uses explicit context, heading, and section tags', () => {
  const result = buildStructuredArticleExport(input, 'text');

  assert.equal(result.filename, 'دليل-الاختبار-المنظم.txt');
  assert.match(result.content, /^\[ARTICLE_CONTEXT\]/);
  assert.match(result.content, /\[PRIMARY_KEYWORD\] الكلمة الأساسية/);
  assert.match(result.content, /\[ARTICLE_BODY_START\]/);
  assert.match(result.content, /\[SECTION type="faq" id="section-3"\]/);
  assert.match(result.content, /\[HEADING level="3"\]\nما السؤال الأول؟/);
  assert.match(result.content, /\[ARTICLE_BODY_END\]\n$/);
});

test('export options can omit SEO groups without removing the article structure', () => {
  const result = buildStructuredArticleExport({
    ...input,
    options: {
      ...DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS,
      includeAlternativePhrases: false,
      includeLsiKeywords: false,
      includeSeoTitles: false,
      includeMetaDescriptions: false,
      includeSectionMarkers: false,
    },
  });

  assert.doesNotMatch(result.content, /alternative_phrases|lsi_keywords|seo_titles|meta_descriptions/);
  assert.doesNotMatch(result.content, /SECTION_START|SECTION_END/);
  assert.match(result.content, /<!-- ARTICLE_BODY_START -->/);
  assert.match(result.content, /## الأسئلة الشائعة/);
});

test('export reports missing context and structural heading jumps', () => {
  const result = buildStructuredArticleExport({
    title: '',
    metaDescription: '',
    language: 'ar',
    keywords: { primary: '', secondaries: [], company: '', lsi: [] },
    document: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'عنوان بعيد' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'نص.' }] },
      ],
    },
  });

  assert.ok(result.warnings.includes('لا يوجد عنوان رئيسي للمقالة.'));
  assert.ok(result.warnings.includes('لا توجد كلمة مفتاحية أساسية.'));
  assert.ok(result.warnings.includes('لا يوجد وصف حالي أو أوصاف مقترحة.'));
  assert.ok(result.warnings.includes('لم يُتعرف تلقائيًا على قسم خاتمة.'));
  assert.ok(result.warnings.includes('يوجد انتقال غير متسلسل من H1 إلى H4.'));
});
