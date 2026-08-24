import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlToTipTapJson, preserveExistingArticleLinks } from '../utils/editorHtmlContent.ts';
import { normalizeStoredEditorContent } from '../utils/editorStoredContent.ts';
import { parseMarkdownToHtml } from '../utils/editorUtils.ts';

const collectNodes = (value: unknown, type: string): Record<string, any>[] => {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, any>;
  const children = Array.isArray(node.content) ? node.content : [];
  return [
    ...(node.type === type ? [node] : []),
    ...children.flatMap(child => collectNodes(child, type)),
  ];
};

test('preserves unique safe article links without flattening rich generated HTML', () => {
  const sourceHtml = [
    '<p>راجع <a href="/gold-detectors">أجهزة كشف الذهب</a> قبل الشراء.</p>',
    '<p>واقرأ <a href="https://example.com/guide">دليل المقارنة</a>.</p>',
    '<p><a href="javascript:alert(1)">رابط غير آمن</a></p>',
  ].join('');
  const targetHtml = [
    '<h2>اختيار الجهاز المناسب</h2>',
    '<p>يساعد دليل المقارنة في توضيح الفروق بين أجهزة كشف الذهب الحديثة.</p>',
    '<ul><li>حدد الميزانية</li><li>قارن الترددات</li></ul>',
    '<table><thead><tr><th>الجهاز</th><th>الاستخدام</th></tr></thead>',
    '<tbody><tr><td>احترافي</td><td>الذهب الخام</td></tr></tbody></table>',
  ].join('');

  const result = preserveExistingArticleLinks({ sourceHtml, targetHtml });

  assert.equal(result.preservedCount, 2);
  assert.deepEqual(result.missingSafeLinks, [{
    href: 'javascript:alert(1)',
    anchor: 'رابط غير آمن',
    reason: 'unsafe_href',
  }]);
  assert.match(result.html, /href="\/gold-detectors"/);
  assert.match(result.html, /href="https:\/\/example\.com\/guide"/);
  assert.match(result.html, /<ul>/);
  assert.match(result.html, /<table>/);
});

test('reports an ambiguous anchor instead of guessing where to put an existing link', () => {
  const result = preserveExistingArticleLinks({
    sourceHtml: '<p><a href="/guide">الدليل الكامل</a></p>',
    targetHtml: '<p>الدليل الكامل مفيد، وهذا الدليل الكامل محدث.</p>',
  });

  assert.equal(result.preservedCount, 0);
  assert.deepEqual(result.missingSafeLinks, [{
    href: '/guide',
    anchor: 'الدليل الكامل',
    reason: 'anchor_ambiguous',
  }]);
  assert.doesNotMatch(result.html, /<a\b/);
});

test('converts headings, lists, tables, formatting, and links to canonical TipTap JSON', () => {
  const content = htmlToTipTapJson([
    '<h2 dir="rtl">عنوان <strong>مهم</strong></h2>',
    '<p>اقرأ <a href="/guide"><em>الدليل</em></a><br>اليوم</p>',
    '<ol start="3"><li>الخطوة الأولى</li><li><p>الخطوة الثانية</p><ul><li>تفصيل</li></ul></li></ol>',
    '<table><thead><tr><th colspan="2">المعيار</th></tr></thead>',
    '<tbody><tr><td>المدى</td><td>العمق</td></tr></tbody></table>',
  ].join(''), 'ar');

  assert.equal(content.type, 'doc');
  assert.deepEqual(normalizeStoredEditorContent(content), content);
  assert.equal(collectNodes(content, 'heading').length, 1);
  assert.equal(collectNodes(content, 'orderedList').length, 1);
  assert.equal(collectNodes(content, 'bulletList').length, 1);
  assert.equal(collectNodes(content, 'table').length, 1);
  assert.equal(collectNodes(content, 'tableRow').length, 2);
  assert.equal(collectNodes(content, 'tableHeader')[0]?.attrs?.colspan, 2);
  assert.equal(collectNodes(content, 'hardBreak').length, 1);

  const linkedText = collectNodes(content, 'text').find(node => node.text === 'الدليل');
  assert.ok(linkedText?.marks?.some((mark: any) => mark.type === 'link' && mark.attrs.href === '/guide'));
  assert.ok(linkedText?.marks?.some((mark: any) => mark.type === 'italic'));
});

test('keeps a 2000+ word article structured during HTML-to-JSON conversion', () => {
  const sections = Array.from({ length: 21 }, (_, sectionIndex) => {
    const words = Array.from({ length: 100 }, (_, wordIndex) => `كلمة${sectionIndex}_${wordIndex}`).join(' ');
    return `<h2>القسم ${sectionIndex + 1}</h2><p>${words}</p>`;
  }).join('');
  const json = htmlToTipTapJson(`${sections}<ul><li>خلاصة أولى</li><li>خلاصة ثانية</li></ul>`, 'ar');

  assert.equal(collectNodes(json, 'heading').length, 21);
  assert.equal(collectNodes(json, 'paragraph').length, 23);
  assert.equal(collectNodes(json, 'bulletList').length, 1);
  assert.ok(collectNodes(json, 'text').map(node => node.text || '').join(' ').split(/\s+/).length > 2_000);
});

test('renders safe Markdown links and degrades unsafe destinations to plain text', () => {
  const html = parseMarkdownToHtml(
    'اقرأ [**الدليل**](/guide) ثم [المصدر](https://example.com)، ولا تفتح [الخطر](javascript:alert(1)).',
  );

  assert.match(html, /<a href="\/guide"[^>]*><strong>الدليل<\/strong><\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /الخطر/);
});
