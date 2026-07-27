import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createCompetitorTextStats,
  createSharedCompetitorPhrases,
} from '../utils/competitorPhraseAnalysis.ts';

test('competitor repeated phrases are analyzed independently and sorted longest first', () => {
  const stats = createCompetitorTextStats([
    'alpha beta gamma delta epsilon alpha beta gamma delta epsilon',
  ]);

  assert.ok(stats.repeatedPhrases.length > 0);
  assert.equal(stats.repeatedPhrases[0].size, 5);
  assert.deepEqual(
    stats.repeatedPhrases.find(item => item.text === 'alpha beta gamma delta epsilon'),
    {
      text: 'alpha beta gamma delta epsilon',
      size: 5,
      count: 2,
    },
  );

  for (let index = 1; index < stats.repeatedPhrases.length; index += 1) {
    assert.ok(
      stats.repeatedPhrases[index - 1].size >= stats.repeatedPhrases[index].size,
      'phrase lengths must be in descending order',
    );
  }
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
  assert.deepEqual(phrase, {
    text: 'content strategy improves organic search',
    size: 5,
    totalCount: 3,
    competitors: [
      { competitorNumber: 1, count: 1 },
      { competitorNumber: 2, count: 1 },
      { competitorNumber: 4, count: 1 },
    ],
  });
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

  assert.ok(shared.some(item => item.text === 'اداره المحتوي بطريقه فعاله'));
});

test('competitor phrase sections stay inside each card and the shared section stays last', async () => {
  const source = await readFile(
    new URL('../components/RightSidebar.tsx', import.meta.url),
    'utf8',
  );
  const cardsStart = source.indexOf('{competitorUrls.map((url, index) => {');
  const aggregateStatsStart = source.indexOf(
    "{t.locale === 'ar' ? 'إحصاءات نصوص المنافسين'",
    cardsStart,
  );
  const sharedSectionStart = source.indexOf(
    "'العبارات المشتركة المقترحة للمقالة'",
    aggregateStatsStart,
  );
  const cardSection = source.slice(cardsStart, aggregateStatsStart);

  assert.ok(cardsStart >= 0);
  assert.ok(aggregateStatsStart > cardsStart);
  assert.ok(sharedSectionStart > aggregateStatsStart);
  assert.match(cardSection, /const repeatedPhrases = competitorTextStatsBySlot\[index\]/);
  assert.match(cardSection, /repeatedPhrases\.map\(item =>/);
});
