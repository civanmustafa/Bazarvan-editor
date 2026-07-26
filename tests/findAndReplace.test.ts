import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findReplaceMatches,
  normalizeFindReplaceQuery,
} from '../utils/findAndReplace.ts';

test('find and replace matches complete and partial Arabic text across formatting nodes', () => {
  const firstText = 'تقدم الشركة خدمات الر';
  const secondText = 'قمية متقدمة للعملاء';
  const blocks = [{
    segments: [
      { text: firstText, from: 10 },
      { text: secondText, from: 10 + firstText.length },
    ],
  }];

  assert.deepEqual(findReplaceMatches(blocks, 'الرقمية'), [{
    from: 10 + firstText.indexOf('الر'),
    to: 10 + firstText.length + 'قمية'.length,
  }]);
  assert.deepEqual(findReplaceMatches(blocks, 'خدمات الرقمية متقدمة'), [{
    from: 10 + firstText.indexOf('خدمات'),
    to: 10 + firstText.length + 'قمية متقدمة'.length,
  }]);
});

test('find and replace ignores Arabic marks, common letter variants, case, and repeated spaces', () => {
  assert.equal(normalizeFindReplaceQuery('  أَفْضَل   خدمة  '), 'افضل خدمه');
  assert.deepEqual(findReplaceMatches([{
    segments: [{ text: 'هذه افضل خدمة DIGITAL متاحة', from: 4 }],
  }], 'أفضل خدمة digital'), [{
    from: 4 + 'هذه '.length,
    to: 4 + 'هذه افضل خدمة DIGITAL'.length,
  }]);
});

test('find and replace keeps paragraphs and inline atoms as safe replacement boundaries', () => {
  assert.deepEqual(findReplaceMatches([
    { segments: [{ text: 'نهاية الفقرة', from: 1 }] },
    { segments: [{ text: 'بداية أخرى', from: 20 }] },
  ], 'الفقرة بداية'), []);

  assert.deepEqual(findReplaceMatches([{
    segments: [
      { text: 'قبل', from: 1 },
      { text: 'بعد', from: 10 },
    ],
  }], 'قبل بعد'), []);
});
