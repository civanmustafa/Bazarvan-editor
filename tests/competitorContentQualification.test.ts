import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCompetitorKeywordTargeting,
  qualifyCompetitorCandidates,
} from '../server/competitorContentQualification.ts';
import {
  analyzeAndSelectCompetitors,
  type CompetitorContentQualification,
} from '../server/competitorSelectionEngine.ts';
import {
  ProgrammaticCompetitorExtractionError,
  type ProgrammaticCompetitorContent,
} from '../server/programmaticCompetitorExtractor.ts';
import type { CompetitorSearchResult } from '../server/firecrawlCompetitorService.ts';

const filler = 'يشرح الدليل خطوات عملية واضحة تساعد الفرق على التخطيط والتنفيذ والقياس والتحسين المستمر وفق احتياجات العمل والجمهور المستهدف. ';

const content = (options: {
  title?: string;
  h1?: string[];
  h2?: string[];
  h3?: string[];
  text: string;
}): ProgrammaticCompetitorContent => ({
  url: 'https://example.com/guide',
  canonicalUrl: 'https://example.com/guide',
  fetchedUrl: 'https://example.com/guide',
  domain: 'example.com',
  title: options.title || 'دليل عملي',
  description: '',
  headings: { h1: options.h1 || [], h2: options.h2 || [], h3: options.h3 || [] },
  paragraphs: [],
  listItems: [],
  text: `${options.text} ${filler.repeat(5)}`,
  wordCount: 90,
  contentHash: 'fixture',
  qualityScore: 80,
  redirectCount: 0,
  responseContentType: 'text/html',
  provider: 'programmatic',
  cacheHit: false,
  fetchedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
});

const candidate = (
  position: number,
  domain: string,
  title: string,
  qualification: CompetitorContentQualification,
): CompetitorSearchResult & { contentQualification: CompetitorContentQualification } => ({
  url: `https://${domain}/guide`,
  canonicalUrl: `https://${domain}/guide`,
  domain,
  title,
  description: 'دليل عربي مفصل يشرح إدارة المشاريع واختيار الأدوات المناسبة للشركات والفرق.',
  position,
  contentQualification: qualification,
});

const qualification = (
  status: CompetitorContentQualification['status'],
  score = 0,
  matchedKeyword = '',
): CompetitorContentQualification => ({
  status,
  score,
  matchedKeyword,
  matchKind: status === 'qualified' ? 'primary' : 'none',
  locations: status === 'qualified' ? ['body'] : [],
  occurrences: status === 'qualified' ? 2 : 0,
  wordCount: 100,
  qualityScore: 80,
  cacheHit: false,
  errorCode: status === 'not_qualified' ? 'keyword_not_found_in_content' : '',
  version: 'test-v1',
});

test('Arabic primary keywords match after normalization and safe proclitic removal', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({ text: 'تبدأ المنهجية وبإدارة المشاريع بصورة منظمة ثم توزع المسؤوليات.' }),
    primaryKeyword: 'إدَارة المَشاريع',
  });
  assert.equal(result.status, 'qualified');
  assert.equal(result.matchKind, 'primary');
  assert.equal(result.matchedKeyword, 'إدَارة المَشاريع');
});

test('an approved alternative qualifies content without a primary-keyword occurrence', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({
      h2: ['اختيار برامج تنظيم فرق العمل'],
      text: 'تساعد برامج تنظيم فرق العمل المؤسسات على توزيع المهام ومتابعة الإنجاز.',
    }),
    primaryKeyword: 'إدارة المشاريع',
    alternativeKeywords: ['برامج تنظيم فرق العمل'],
  });
  assert.equal(result.status, 'qualified');
  assert.equal(result.matchKind, 'alternative');
  assert.equal(result.matchedKeyword, 'برامج تنظيم فرق العمل');
  assert.ok(result.locations.includes('headings'));
});

test('the article title is a first-class target term across page evidence', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({
      title: 'أغلى جهاز كشف الذهب في العالم: المواصفات والسعر',
      text: 'تتناول الصفحة مواصفات الجهاز وتجربة استخدامه بالتفصيل.',
    }),
    primaryKeyword: 'أسعار أجهزة التنقيب',
    articleTitle: 'أغلى جهاز كشف الذهب في العالم',
  });

  assert.equal(result.status, 'qualified');
  assert.equal(result.targetingStatus, 'confirmed');
  assert.equal(result.matchKind, 'article_title');
  assert.ok(result.evidence?.some(item => (
    item.termKind === 'article_title' && item.source === 'page_title'
  )));
});

test('targeting evidence remains independent from usable extracted content', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({ text: 'هذا نص تقني صالح للتحليل لكنه لا يكرر عبارة الاستهداف.' }),
    primaryKeyword: 'أغلى جهاز كشف الذهب',
    searchResult: {
      url: 'https://example.com/report',
      canonicalUrl: 'https://example.com/report',
      title: 'أغلى جهاز كشف الذهب في العالم',
      description: 'تقرير تقني مفصل.',
    },
  });

  assert.equal(result.targetingStatus, 'confirmed');
  assert.equal(result.contentAvailability, 'available');
  assert.equal(result.contentUsability, 'usable');
  assert.deepEqual(result.evidence?.map(item => item.source), ['serp_title']);
});

test('ordered-near matching requires the complete phrase in order', () => {
  const near = analyzeCompetitorKeywordTargeting({
    content: content({ text: 'يعرض التقرير أغلى جهاز متخصص في كشف الذهب مع تفاصيل السعر.' }),
    primaryKeyword: 'أغلى جهاز كشف الذهب',
  });
  const scattered = analyzeCompetitorKeywordTargeting({
    content: content({
      text: `يعرض التقرير أغلى جهاز ثم ${filler.repeat(3)} ويناقش كشف الذهب في قسم مستقل.`,
    }),
    primaryKeyword: 'أغلى جهاز كشف الذهب',
  });

  assert.equal(near.status, 'qualified');
  assert.equal(near.matchKind, 'ordered_primary');
  assert.equal(near.evidence?.some(item => item.matchType === 'ordered_near'), true);
  assert.equal(scattered.status, 'not_qualified');
});

test('a broad single word is not sufficient targeting evidence', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({
      title: 'دليل الذهب',
      h1: ['الذهب'],
      text: 'ذهب ذهب ذهب وتفاصيل عامة عن الأسواق والمنتجات.',
    }),
    primaryKeyword: 'ذهب',
  });

  assert.equal(result.status, 'not_qualified');
  assert.equal(result.targetingStatus, 'not_confirmed');
  assert.equal(result.errorCode, 'target_terms_not_specific');
  assert.deepEqual(result.evidence, []);
});

test('scattered topic words and unrelated semantic terms do not qualify a page', () => {
  const result = analyzeCompetitorKeywordTargeting({
    content: content({
      text: `تتناول الصفحة كلمة إدارة ثم ${filler.repeat(3)} وتذكر المشاريع في خاتمة بعيدة. كما تتحدث عن الإنتاجية والتعاون.`,
    }),
    primaryKeyword: 'إدارة المشاريع الرقمية',
    alternativeKeywords: ['منصات إدارة المشاريع'],
  });
  assert.equal(result.status, 'not_qualified');
  assert.equal(result.matchKind, 'none');
});

test('prominent heading matches score higher than body-only matches', () => {
  const heading = analyzeCompetitorKeywordTargeting({
    content: content({ h1: ['إدارة المشاريع'], text: 'تشرح الصفحة إدارة المشاريع للفرق.' }),
    primaryKeyword: 'إدارة المشاريع',
  });
  const body = analyzeCompetitorKeywordTargeting({
    content: content({ text: `${filler.repeat(2)} ثم تشرح إدارة المشاريع للفرق.` }),
    primaryKeyword: 'إدارة المشاريع',
  });
  assert.equal(heading.status, 'qualified');
  assert.equal(body.status, 'qualified');
  assert.ok(heading.score > body.score);
});

test('content qualification is a hard automatic-selection gate', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'إدارة المشاريع',
      primaryKeyword: 'إدارة المشاريع',
      alternativeKeywords: ['برامج تنظيم فرق العمل'],
      language: 'ar',
      pageType: 'guide',
      searchIntent: 'informational',
    },
    candidates: [
      {
        ...candidate(1, 'first.example', 'أفضل دليل عام للشركات', qualification('not_qualified')),
        description: 'شرح عام لتطوير فرق الشركات وتحسين إجراءات العمل.',
      },
      candidate(5, 'targeted.example', 'دليل إدارة المشاريع للفرق', qualification('qualified', 82, 'إدارة المشاريع')),
    ],
    maxResults: 10,
    maxSelected: 5,
  });
  assert.equal(selection.summary.contentQualificationAttempted, true);
  assert.equal(selection.summary.contentQualifiedCount, 1);
  assert.deepEqual(selection.results.filter(row => row.autoSelected).map(row => row.domain), ['targeted.example']);
  assert.equal(selection.results.find(row => row.domain === 'first.example')?.eligible, false);
});

test('an alternative keyword can satisfy metadata relevance for automatic selection', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'إدارة المشاريع',
      primaryKeyword: 'إدارة المشاريع',
      alternativeKeywords: ['برامج تنظيم فرق العمل'],
      language: 'ar',
      pageType: 'guide',
      searchIntent: 'informational',
    },
    candidates: [
      candidate(
        2,
        'alternative.example',
        'دليل برامج تنظيم فرق العمل للشركات',
        {
          ...qualification('qualified', 84, 'برامج تنظيم فرق العمل'),
          matchKind: 'alternative',
        },
      ),
    ],
    maxResults: 10,
    maxSelected: 5,
  });
  assert.equal(selection.results[0]?.contentQualification?.matchKind, 'alternative');
  assert.ok((selection.results[0]?.signals.relevance || 0) >= 68);
  assert.equal(selection.results[0]?.eligible, true);
  assert.equal(selection.results[0]?.autoSelected, true);
});

test('automatic selection never backfills five slots with pages that have no targeting evidence', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    ...candidate(
      index + 1,
      `site-${index + 1}.example`,
      index < 2 ? `دليل إدارة المشاريع رقم ${index + 1}` : `دليل أعمال عام رقم ${index + 1}`,
      index < 2 ? qualification('qualified', 78 - index, 'إدارة المشاريع') : qualification('not_qualified'),
    ),
    description: index < 2
      ? 'دليل عربي مفصل يشرح إدارة المشاريع واختيار الأدوات المناسبة للشركات والفرق.'
      : 'شرح عام لتطوير فرق الشركات وتحسين إجراءات العمل.',
  }));
  const selection = analyzeAndSelectCompetitors({
    context: { query: 'إدارة المشاريع', primaryKeyword: 'إدارة المشاريع', language: 'ar' },
    candidates,
    maxResults: 10,
    maxSelected: 5,
  });
  assert.equal(selection.summary.autoSelectedCount, 2);
  assert.ok(selection.results.filter(row => row.autoSelected).every(row => (
    row.contentQualification?.status === 'qualified'
  )));
});

test('automatic selection safely falls back to unavailable prechecks when no candidate qualifies', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'إدارة المشاريع',
      primaryKeyword: 'إدارة المشاريع',
      language: 'ar',
      pageType: 'guide',
      searchIntent: 'informational',
    },
    candidates: [
      candidate(1, 'blocked-one.example', 'دليل إدارة المشاريع للشركات', qualification('unavailable')),
      candidate(2, 'blocked-two.example', 'شرح إدارة المشاريع للفرق', qualification('unavailable')),
      {
        ...candidate(3, 'unrelated.example', 'دليل عام للشركات', qualification('not_qualified')),
        description: 'شرح عام لتطوير فرق الشركات وتحسين إجراءات العمل.',
      },
    ],
    maxResults: 10,
    maxSelected: 5,
  });

  const selected = selection.results.filter(row => row.autoSelected);
  assert.equal(selection.summary.contentQualifiedCount, 0);
  assert.ok(selected.length > 0);
  assert.ok(selected.every(row => row.contentQualification?.status === 'unavailable'));
  assert.ok(selected.every(row => row.eligible));
  assert.equal(selection.results.find(row => row.domain === 'unrelated.example')?.autoSelected, false);
});

test('SERP evidence confirms targeting independently when page extraction is unavailable', async () => {
  const candidates: CompetitorSearchResult[] = [
    {
      url: 'https://title.example/report',
      canonicalUrl: 'https://title.example/report',
      domain: 'title.example',
      title: 'أغلى جهاز كشف الذهب في العالم',
      description: 'تقرير تقني مفصل.',
      position: 1,
    },
    {
      url: 'https://description.example/report',
      canonicalUrl: 'https://description.example/report',
      domain: 'description.example',
      title: 'تقرير تقني جديد',
      description: 'تعرف إلى أغلى جهاز كشف الذهب في العالم ومواصفاته.',
      position: 2,
    },
    {
      url: 'https://url.example/%D8%A3%D8%BA%D9%84%D9%89-%D8%AC%D9%87%D8%A7%D8%B2-%D9%83%D8%B4%D9%81-%D8%A7%D9%84%D8%B0%D9%87%D8%A8',
      canonicalUrl: 'https://url.example/%D8%A3%D8%BA%D9%84%D9%89-%D8%AC%D9%87%D8%A7%D8%B2-%D9%83%D8%B4%D9%81-%D8%A7%D9%84%D8%B0%D9%87%D8%A8',
      domain: 'url.example',
      title: 'تقرير تقني جديد',
      description: 'مواصفات وتجارب عملية.',
      position: 3,
    },
  ];
  const results = await qualifyCompetitorCandidates({
    candidates,
    primaryKeyword: 'أغلى جهاز كشف الذهب',
    extractor: async () => {
      throw new ProgrammaticCompetitorExtractionError({
        code: 'programmatic_extraction_http_403',
        message: 'Blocked.',
        status: 403,
      });
    },
  });

  assert.ok(results.every(item => item.contentQualification?.status === 'unavailable'));
  assert.ok(results.every(item => item.contentQualification?.targetingStatus === 'confirmed'));
  assert.deepEqual(results.map(item => item.contentQualification?.evidence?.[0]?.source), [
    'serp_title',
    'serp_description',
    'url',
  ]);
  assert.ok(results.every(item => item.contentQualification?.contentAvailability === 'unavailable'));
  assert.ok(results.every(item => item.contentQualification?.contentUsability === 'not_assessed'));
});

test('confirmed metadata targeting is eligible despite unavailable content', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'أغلى جهاز كشف الذهب',
      primaryKeyword: 'أغلى جهاز كشف الذهب',
      language: 'ar',
      pageType: 'article',
      searchIntent: 'informational',
    },
    candidates: [{
      ...candidate(
        1,
        'blocked-target.example',
        'أغلى جهاز كشف الذهب في العالم',
        qualification('unavailable'),
      ),
      description: 'تقرير عربي تقني مفصل عن المواصفات والأسعار والاستخدامات العملية.',
    }],
    maxResults: 10,
    maxSelected: 5,
  });

  const result = selection.results[0];
  assert.equal(result?.contentQualification?.status, 'unavailable');
  assert.equal(result?.contentQualification?.targetingStatus, 'confirmed');
  assert.equal(result?.eligible, true);
  assert.equal(result?.autoSelected, true);
  assert.ok(result?.reasonCodes.includes('targeting-evidence-confirmed'));
  assert.ok(result?.reasonCodes.includes('keyword-in-serp-title'));
  assert.equal(selection.summary.targetingConfirmedCount, 1);
  assert.equal(selection.summary.contentUsableCount, 0);
});

test('matching SERP metadata confirms targeting even when the preliminary page check missed it', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'أغلى جهاز كشف الذهب',
      primaryKeyword: 'أغلى جهاز كشف الذهب',
      language: 'ar',
    },
    candidates: [{
      ...candidate(
        1,
        'irrelevant.example',
        'أغلى جهاز كشف الذهب في العالم',
        qualification('not_qualified'),
      ),
      description: 'شرح عربي واضح ومفصل عن أجهزة الكشف والأسواق العالمية.',
    }],
    maxResults: 10,
    maxSelected: 5,
  });

  const result = selection.results[0];
  assert.equal(result?.eligible, true);
  assert.equal(result?.autoSelected, true);
  assert.equal(result?.contentQualification?.targetingStatus, 'confirmed');
  assert.ok(result?.reasonCodes.includes('keyword-in-serp-title'));
  assert.ok(result?.reasonCodes.includes('targeting-evidence-confirmed'));
  assert.ok(result?.warningCodes.includes('keyword-not-found-in-content'));
});

test('the article title can confirm targeting from the Google description', () => {
  const selection = analyzeAndSelectCompetitors({
    context: {
      query: 'أجهزة التنقيب الحديثة',
      primaryKeyword: 'أجهزة التنقيب الحديثة',
      articleTitle: 'أغلى جهاز كشف الذهب في العالم',
      language: 'ar',
      pageType: 'article',
      searchIntent: 'informational',
    },
    candidates: [{
      ...candidate(1, 'article-title.example', 'مراجعة تقنية مفصلة', qualification('unavailable')),
      description: 'نشرح أغلى جهاز كشف الذهب في العالم ونقارن أهم مواصفاته.',
    }],
    maxResults: 10,
    maxSelected: 5,
  });

  const result = selection.results[0];
  assert.equal(result?.contentQualification?.targetingStatus, 'confirmed');
  assert.ok(result?.reasonCodes.includes('article-title-targeting'));
  assert.ok(result?.reasonCodes.includes('keyword-in-serp-description'));
  assert.equal(result?.autoSelected, true);
});

test('one programmatic extraction failure does not fail or qualify the batch', async () => {
  const candidates: CompetitorSearchResult[] = [
    { url: 'https://good.example/guide', canonicalUrl: 'https://good.example/guide', domain: 'good.example', title: 'دليل', description: 'دليل عربي', position: 1 },
    { url: 'https://blocked.example/guide', canonicalUrl: 'https://blocked.example/guide', domain: 'blocked.example', title: 'دليل', description: 'دليل عربي', position: 2 },
  ];
  const results = await qualifyCompetitorCandidates({
    candidates,
    primaryKeyword: 'إدارة المشاريع',
    extractor: async options => {
      if (options.url.includes('blocked')) {
        throw new ProgrammaticCompetitorExtractionError({ code: 'programmatic_extraction_http_403', message: 'Blocked.', status: 403 });
      }
      return content({ text: 'يقدم هذا الدليل شرحًا عمليًا عن إدارة المشاريع.' });
    },
  });
  assert.equal(results[0].contentQualification?.status, 'qualified');
  assert.equal(results[1].contentQualification?.status, 'unavailable');
  assert.equal(results[1].contentQualification?.errorCode, 'programmatic_extraction_http_403');
});

test('programmatic prequalification is capped at twelve candidates', async () => {
  let calls = 0;
  const candidates: CompetitorSearchResult[] = Array.from({ length: 15 }, (_, index) => ({
    url: `https://site-${index}.example/guide`,
    canonicalUrl: `https://site-${index}.example/guide`,
    domain: `site-${index}.example`,
    title: 'دليل إدارة المشاريع',
    description: 'شرح عربي لإدارة المشاريع.',
    position: index + 1,
  }));
  const results = await qualifyCompetitorCandidates({
    candidates,
    primaryKeyword: 'إدارة المشاريع',
    extractor: async () => {
      calls += 1;
      return content({ text: 'شرح مفصل عن إدارة المشاريع.' });
    },
  });
  assert.equal(results.length, 12);
  assert.equal(calls, 12);
});
