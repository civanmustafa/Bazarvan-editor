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
      candidate(1, 'first.example', 'أفضل دليل عام للشركات', qualification('not_qualified')),
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

test('automatic selection never backfills five slots with unqualified pages', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => candidate(
    index + 1,
    `site-${index + 1}.example`,
    `دليل إدارة المشاريع رقم ${index + 1}`,
    index < 2 ? qualification('qualified', 78 - index, 'إدارة المشاريع') : qualification('not_qualified'),
  ));
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
