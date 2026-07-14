import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ARTICLE_COMPETITORS, normalizeCompetitorSlots } from '../constants/competitors.ts';
import {
  canonicalizeCompetitorUrl,
  FirecrawlCompetitorError,
  markdownToCompetitorText,
  type CompetitorSearchResult,
} from '../server/firecrawlCompetitorService.ts';
import {
  analyzeAndSelectCompetitors,
  extractCompetitorOwnDomains,
  normalizeCompetitorText,
  resolveCompetitorCountryCode,
} from '../server/competitorSelectionEngine.ts';

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
