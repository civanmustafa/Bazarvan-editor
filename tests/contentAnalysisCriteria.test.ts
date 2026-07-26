import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTolerantViolationStatus,
  hasValidParagraphEndPunctuation,
} from '../utils/analysis/criteriaEvaluation.ts';

test('paragraph ending detection accepts visible periods with common trailing characters', () => {
  assert.equal(hasValidParagraphEndPunctuation('تنتهي الفقرة بنقطة.'), true);
  assert.equal(hasValidParagraphEndPunctuation('تنتهي الفقرة بنقطة.\u200F'), true);
  assert.equal(hasValidParagraphEndPunctuation('تنتهي الفقرة بنقطة.»'), true);
  assert.equal(hasValidParagraphEndPunctuation('تنتهي الفقرة بنقطة.)'), true);
  assert.equal(hasValidParagraphEndPunctuation('تنتهي الفقرة بنقطة۔'), true);
  assert.equal(hasValidParagraphEndPunctuation('فقرة بلا ترقيم'), false);
  assert.equal(hasValidParagraphEndPunctuation('لا تكفي الفاصلة،'), false);
});

test('tolerant criteria use amber for one or two violations and red after that', () => {
  assert.equal(getTolerantViolationStatus(0), 'pass');
  assert.equal(getTolerantViolationStatus(1), 'warn');
  assert.equal(getTolerantViolationStatus(2), 'warn');
  assert.equal(getTolerantViolationStatus(3), 'fail');
  assert.equal(getTolerantViolationStatus(20), 'fail');
});
