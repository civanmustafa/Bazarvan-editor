import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  getTolerantViolationStatus,
  hasValidParagraphEndPunctuation,
} from '../utils/analysis/criteriaEvaluation.ts';

const importAnalysisUtils = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/analysis/analysisUtils.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

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

test('keyword matching accepts hyphenated Arabic and English technical terms', async () => {
  const { countOccurrences } = await importAnalysisUtils();
  assert.equal(countOccurrences('يدعم الجهاز تقنية Multi-IQ المتقدمة.', 'تقنية Multi-IQ', 'ar'), 1);
  assert.equal(countOccurrences('Multi-IQ and multi-iq are both present.', 'multi-iq', 'en'), 2);
  assert.doesNotThrow(() => countOccurrences('تقنية Multi-IQ', 'multi-iq', 'ar'));
});
