import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USER_GUIDE_ARTICLE_COUNT,
  USER_GUIDE_CATEGORIES,
} from '../constants/userGuide.ts';
import { parseAppRoute } from '../utils/appRoutes.ts';
import {
  normalizeUserGuideSearchText,
  searchUserGuide,
} from '../utils/userGuideSearch.ts';

test('user guide has unique searchable coverage across every major product area', () => {
  assert.ok(USER_GUIDE_CATEGORIES.length >= 10);
  assert.ok(USER_GUIDE_ARTICLE_COUNT >= 25);

  const categoryIds = USER_GUIDE_CATEGORIES.map(category => category.id);
  const articleIds = USER_GUIDE_CATEGORIES.flatMap(category => (
    category.articles.map(article => article.id)
  ));
  assert.equal(new Set(categoryIds).size, categoryIds.length);
  assert.equal(new Set(articleIds).size, articleIds.length);

  for (const category of USER_GUIDE_CATEGORIES) {
    assert.ok(category.title.trim());
    assert.ok(category.description.trim());
    assert.ok(category.articles.length >= 1);
    for (const article of category.articles) {
      assert.ok(article.title.trim());
      assert.ok(article.summary.trim());
      assert.ok(article.keywords.length >= 2);
      assert.ok(article.sections.length >= 1);
    }
  }
});

test('Arabic guide search tolerates letter variants and ranks the requested writing modes', () => {
  assert.equal(
    normalizeUserGuideSearchText('الكتابة العميقة'),
    normalizeUserGuideSearchText('الكتابه العَميقة'),
  );
  const writingModes = searchUserGuide('قراءتان مستقلتان والكتابة العميقة');
  assert.ok(writingModes.length > 0);
  assert.equal(writingModes[0].article.id, 'knowledge-and-candidate-modes');

  const qualityProblem = searchUserGuide('81 أحمر إصلاح الجودة');
  assert.ok(qualityProblem.some(result => result.article.id === 'quality-score-confusion'));

  const automation = searchUserGuide('n8n عدد الكلمات');
  assert.ok(automation.some(result => result.article.id === 'n8n-integration'));

  const automaticWriting = searchUserGuide('طابور الكتابة التلقائية فترة بين المقالات');
  assert.ok(automaticWriting.some(result => result.article.id === 'automatic-content-writing-queue'));
});

test('guide route is a first-class application page', () => {
  assert.deepEqual(parseAppRoute('/guide'), { name: 'guide' });
  assert.equal(parseAppRoute('/guide/unknown').name, 'notFound');
});
