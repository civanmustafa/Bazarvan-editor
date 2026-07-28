import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  competitorPhraseIntelligenceToPromptJson,
  createCompetitorPhraseIntelligence,
  createCompetitorTextStats,
  createSharedCompetitorPhrases,
} from '../utils/competitorPhraseAnalysis.ts';

test('competitor repeated phrases are analyzed independently and sorted longest first', () => {
  const stats = createCompetitorTextStats([
    'alpha beta gamma delta epsilon alpha beta gamma delta epsilon',
  ]);

  assert.ok(stats.repeatedPhrases.length > 0);
  assert.equal(stats.repeatedPhrases[0].size, 5);
  const parent = stats.repeatedPhrases.find(
    item => item.text === 'alpha beta gamma delta epsilon',
  );
  assert.ok(parent);
  assert.equal(parent.size, 5);
  assert.equal(parent.count, 2);
  assert.ok(parent.containedPhrases?.some(
    item => item.text === 'alpha beta gamma delta' && item.size === 4,
  ));

  for (let index = 1; index < stats.repeatedPhrases.length; index += 1) {
    assert.ok(
      stats.repeatedPhrases[index - 1].size >= stats.repeatedPhrases[index].size,
      'phrase lengths must be in descending order',
    );
  }
});

test('fully contained shorter phrases collapse under the longest repeated phrase', () => {
  const stats = createCompetitorTextStats(
    ['افضل جهاز كشف الذهب الخام. افضل جهاز كشف الذهب الخام.'],
    {
      articleLanguage: 'ar',
      primaryKeyword: 'كشف الذهب',
    },
  );
  const parent = stats.repeatedPhrases.find(
    item => item.text === 'افضل جهاز كشف الذهب الخام',
  );

  assert.ok(parent);
  assert.equal(parent.size, 5);
  assert.ok(parent.containedPhrases?.some(
    item => item.text === 'افضل جهاز كشف الذهب' && item.size === 4,
  ));
  assert.ok(parent.containedPhrases?.some(
    item => item.text === 'جهاز كشف الذهب' && item.size === 3,
  ));
  assert.ok(parent.containedPhrases?.some(
    item => item.text === 'كشف الذهب الخام' && item.size === 3,
  ));
  assert.ok(stats.repeatedPhrases.every(
    item => item.text !== 'افضل جهاز كشف الذهب'
      && item.text !== 'جهاز كشف الذهب'
      && item.text !== 'كشف الذهب الخام',
  ));
});

test('a shorter phrase remains canonical when it also appears independently', () => {
  const stats = createCompetitorTextStats(
    [
      'افضل جهاز كشف الذهب الخام. افضل جهاز كشف الذهب الخام. '
      + 'كشف الذهب الخام. كشف الذهب الخام.',
    ],
    {
      articleLanguage: 'ar',
      primaryKeyword: 'كشف الذهب',
    },
  );

  assert.ok(stats.repeatedPhrases.some(
    item => item.text === 'افضل جهاز كشف الذهب الخام',
  ));
  assert.ok(stats.repeatedPhrases.some(
    item => item.text === 'كشف الذهب الخام' && item.count === 4,
  ));
});

test('phrase analysis never creates an n-gram across competitor text boundaries', () => {
  const stats = createCompetitorTextStats([
    'alpha beta',
    'gamma delta',
  ]);

  assert.deepEqual(stats.repeatedPhrases, []);
});

test('shared phrases include phrases used once by two or more named competitors', () => {
  const shared = createSharedCompetitorPhrases([
    {
      competitorNumber: 1,
      text: 'content strategy improves organic search today',
    },
    {
      competitorNumber: 2,
      text: 'a content strategy improves organic search today',
    },
    {
      competitorNumber: 4,
      text: 'content strategy improves organic search for brands',
    },
  ]);

  const phrase = shared.find(item => item.text === 'content strategy improves organic search');
  assert.ok(phrase);
  assert.equal(phrase.size, 5);
  assert.equal(phrase.totalCount, 3);
  assert.deepEqual(phrase.competitors, [
    { competitorNumber: 1, count: 1 },
    { competitorNumber: 2, count: 1 },
    { competitorNumber: 4, count: 1 },
  ]);
  assert.ok(phrase.containedPhrases?.some(
    item => item.text === 'content strategy improves organic' && item.size === 4,
  ));
  assert.ok(shared.every(item => item.competitors.length >= 2));

  for (let index = 1; index < shared.length; index += 1) {
    assert.ok(
      shared[index - 1].size >= shared[index].size,
      'shared phrase lengths must be in descending order',
    );
  }
});

test('shared phrase comparison normalizes Arabic letter variants', () => {
  const shared = createSharedCompetitorPhrases([
    { competitorNumber: 1, text: 'إدارة المحتوى بطريقة فعالة اليوم' },
    { competitorNumber: 2, text: 'ادارة المحتوى بطريقه فعاله دائما' },
  ]);

  assert.ok(shared.some(item => item.text === 'إدارة المحتوى بطريقة فعالة'));
});

test('Arabic phrases keep their original spelling and stop at punctuation', () => {
  const stats = createCompetitorTextStats([
    'للقراءة، الإلكترونية مفيدة لجميع القراء. للقراءة، الإلكترونية مفيدة لجميع القراء.',
  ]);

  assert.ok(
    stats.repeatedPhrases.some(
      item => item.text === 'الإلكترونية مفيدة لجميع القراء'
        && item.size === 4
        && item.count === 2,
    ),
  );
  assert.ok(stats.topWords.some(item => item.word === 'الإلكترونية'));
  assert.ok(
    stats.repeatedPhrases.every(
      item => item.text !== 'للقراءة الإلكترونية مفيدة',
    ),
  );
});

test('phrases do not cross a new line or paragraph boundary', () => {
  const stats = createCompetitorTextStats([
    'تحسين محركات\nالبحث مهم للجميع\nتحسين محركات\nالبحث مهم للجميع',
  ]);

  assert.ok(stats.repeatedPhrases.some(item => item.text === 'البحث مهم للجميع'));
  assert.ok(
    stats.repeatedPhrases.every(
      item => item.text !== 'تحسين محركات البحث',
    ),
  );
});

test('shared phrases also respect punctuation boundaries', () => {
  const shared = createSharedCompetitorPhrases([
    { competitorNumber: 1, text: 'للقراءة، الإلكترونية مفيدة للجميع.' },
    { competitorNumber: 2, text: 'للقراءة، الإلكترونية مفيدة للجميع.' },
  ]);

  assert.ok(shared.some(item => item.text === 'الإلكترونية مفيدة للجميع'));
  assert.ok(shared.every(item => item.text !== 'للقراءة الإلكترونية مفيدة'));
});

test('Arabic phrase analysis trims function words from phrase boundaries without double counting', () => {
  const stats = createCompetitorTextStats(
    ['في كشف الذهب الخام. في كشف الذهب الخام.'],
    {
      articleLanguage: 'ar',
      primaryKeyword: 'كشف الذهب',
    },
  );

  assert.deepEqual(
    stats.repeatedPhrases.find(item => item.text === 'كشف الذهب الخام'),
    {
      text: 'كشف الذهب الخام',
      size: 3,
      count: 2,
    },
  );
  assert.ok(stats.repeatedPhrases.every(item => !item.text.startsWith('في ')));
});

test('Arabic article with an Arabic primary keyword removes Latin phrases from every competitor analysis', () => {
  const context = {
    articleLanguage: 'ar' as const,
    primaryKeyword: 'كشف الذهب',
  };
  const sources = [
    {
      competitorNumber: 1,
      text: 'في كشف الذهب الخام. best raw gold detector guide.',
    },
    {
      competitorNumber: 2,
      text: 'كشف الذهب الخام مهم. best raw gold detector guide.',
    },
  ];
  const stats = createCompetitorTextStats(
    sources.map(source => `${source.text} ${source.text}`),
    context,
  );
  const shared = createSharedCompetitorPhrases(sources, context);
  const intelligence = createCompetitorPhraseIntelligence({
    sources,
    articleLanguage: 'ar',
    keywords: {
      primary: 'كشف الذهب',
      secondaries: [],
      lsi: ['gold detector'],
    },
  });

  assert.ok(stats.repeatedPhrases.some(item => item.text === 'كشف الذهب الخام'));
  assert.ok(stats.repeatedPhrases.every(item => !/[A-Za-z]/u.test(item.text)));
  assert.ok(stats.topWords.every(item => !/[A-Za-z]/u.test(item.word)));
  assert.ok(shared.some(item => item.text === 'كشف الذهب الخام'));
  assert.ok(shared.every(item => !/[A-Za-z]/u.test(item.text)));
  assert.ok(intelligence.items.some(item => item.text === 'كشف الذهب الخام'));
  assert.ok(intelligence.items.every(item => !/[A-Za-z]/u.test(item.text)));
  assert.ok(intelligence.keywordTerms.every(item => !/[A-Za-z]/u.test(item)));
});

test('Latin phrase filtering requires both an Arabic article and an Arabic primary keyword', () => {
  const stats = createCompetitorTextStats(
    ['best raw gold detector. best raw gold detector.'],
    {
      articleLanguage: 'ar',
      primaryKeyword: 'gold detector',
    },
  );

  assert.ok(stats.repeatedPhrases.some(item => item.text === 'best raw gold detector'));
});

test('phrase intelligence combines every competitor with keyword relevance and preserves low-priority signals', () => {
  const result = createCompetitorPhraseIntelligence({
    sources: [
      {
        competitorNumber: 1,
        text: 'content strategy improves organic search. content strategy improves organic search.',
      },
      {
        competitorNumber: 2,
        text: 'content strategy improves organic search and search intent.',
      },
      {
        competitorNumber: 3,
        text: 'random brand slogan random brand slogan',
      },
      {
        competitorNumber: 4,
        text: 'content strategy improves organic search for growing companies.',
      },
    ],
    keywords: {
      primary: 'content strategy',
      secondaries: ['organic search'],
      lsi: ['search intent'],
    },
  });

  const mustCover = result.mustCover.find(
    item => item.text === 'content strategy improves organic search',
  );
  assert.ok(mustCover);
  assert.equal(mustCover.competitorCount, 3);
  assert.deepEqual(mustCover.competitors.map(item => item.competitorNumber), [1, 2, 4]);
  assert.deepEqual(
    new Set(mustCover.matchedKeywordTerms),
    new Set(['content', 'strategy', 'organic', 'search']),
  );
  assert.ok(result.lowPriority.some(item => item.text === 'random brand slogan'));

  const promptPayload = JSON.parse(competitorPhraseIntelligenceToPromptJson(result));
  assert.equal(promptPayload.enabled, true);
  assert.equal(promptPayload.analyzedCompetitorCount, 4);
  assert.ok(promptPayload.mustCover.some(
    (item: { text: string }) => item.text === 'content strategy improves organic search',
  ));
  assert.ok(promptPayload.lowPriority.some(
    (item: { text: string }) => item.text === 'random brand slogan',
  ));
});

test('content writing receives canonical phrases without fully contained shorter requirements', () => {
  const result = createCompetitorPhraseIntelligence({
    sources: [
      { competitorNumber: 1, text: 'افضل جهاز كشف الذهب الخام.' },
      { competitorNumber: 2, text: 'افضل جهاز كشف الذهب الخام.' },
    ],
    articleLanguage: 'ar',
    keywords: {
      primary: 'كشف الذهب',
      secondaries: ['جهاز كشف الذهب'],
      lsi: [],
    },
  });
  const parent = result.mustCover.find(
    item => item.text === 'افضل جهاز كشف الذهب الخام',
  );
  const promptPayload = JSON.parse(competitorPhraseIntelligenceToPromptJson(result));
  const sentTexts = [
    ...promptPayload.mustCover,
    ...promptPayload.supporting,
    ...promptPayload.review,
    ...promptPayload.lowPriority,
  ].map((item: { text: string }) => item.text);

  assert.ok(parent);
  assert.ok(parent.containedPhrases?.some(
    item => item.text === 'جهاز كشف الذهب',
  ));
  assert.deepEqual(sentTexts, ['افضل جهاز كشف الذهب الخام']);
  assert.ok(promptPayload.rule.includes('already been collapsed'));
});

test('administrator can disable phrase intelligence without losing analyzed competitor count', () => {
  const result = createCompetitorPhraseIntelligence({
    enabled: false,
    sources: [
      { competitorNumber: 1, text: 'content strategy improves organic search' },
      { competitorNumber: 2, text: 'content strategy improves organic search' },
    ],
    keywords: {
      primary: 'content strategy',
      secondaries: [],
      lsi: [],
    },
  });

  assert.equal(result.enabled, false);
  assert.equal(result.analyzedCompetitorCount, 2);
  assert.deepEqual(result.items, []);
});

test('competitor phrase sections stay inside each card and the shared section stays last', async () => {
  const [source, intelligencePanel, contentWritingEngine] = await Promise.all([
    readFile(new URL('../components/RightSidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/CompetitorPhraseIntelligencePanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../server/contentWritingEngine.ts', import.meta.url), 'utf8'),
  ]);
  const cardsStart = source.indexOf('{competitorUrls.map((url, index) => {');
  const aggregateStatsStart = source.indexOf(
    "{t.locale === 'ar' ? 'إحصاءات نصوص المنافسين'",
    cardsStart,
  );
  const sharedSectionStart = source.indexOf(
    "'العبارات المشتركة المقترحة للمقالة'",
    aggregateStatsStart,
  );
  const intelligenceSectionStart = source.indexOf(
    '<CompetitorPhraseIntelligencePanel',
    aggregateStatsStart,
  );
  const cardSection = source.slice(cardsStart, aggregateStatsStart);

  assert.ok(cardsStart >= 0);
  assert.ok(aggregateStatsStart > cardsStart);
  assert.ok(intelligenceSectionStart > aggregateStatsStart);
  assert.ok(sharedSectionStart > intelligenceSectionStart);
  assert.match(cardSection, /const competitorStats = competitorTextStatsBySlot\[index\]/);
  assert.match(cardSection, /repeatedPhrases\.map\(item =>/);
  assert.match(cardSection, /العبارات المكررة من 3 إلى 5 كلمات/);
  assert.match(cardSection, /competitorWordCount\.toLocaleString/);
  assert.match(cardSection, /item\.containedPhrases/);
  assert.match(source, /React\.lazy\(\(\) => import\('\.\/CompetitorPhraseIntelligencePanel'\)\)/);
  assert.match(
    source,
    /aiProviderCapabilities\.contentWriting\.competitorPhraseIntelligenceEnabled/,
  );
  assert.match(intelligencePanel, /createCompetitorPhraseIntelligence/);
  assert.match(intelligencePanel, /تحليل أهمية العبارات/);
  assert.match(intelligencePanel, /#d4af37/);
  assert.doesNotMatch(intelligencePanel, /violet|sky-/);
  assert.match(source, /articleLanguage=\{articleLanguage\}/);
  assert.match(intelligencePanel, /item\.containedPhrases/);
  assert.match(contentWritingEngine, /wordCount: countContentWritingTargetWords\(competitor\.content\)/);
  assert.match(contentWritingEngine, /manualRange: normalizedGoalContext\.targetWordRange/);
  assert.match(contentWritingEngine, /competitors: bundle\.competitors/);
});
