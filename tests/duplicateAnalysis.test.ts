import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importDuplicateAnalysis = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/analysis/runDuplicateAnalysis.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('duplicate analysis excludes target terms and their repeated subphrases', async () => {
  const { runDuplicateAnalysis } = await importDuplicateAnalysis();
  const text = [
    'أجهزة كشف الذهب الأمريكية تناسب أعمال التنقيب الاحترافية.',
    'أجهزة كشف الذهب الأمريكية تناسب أعمال التنقيب الاحترافية.',
    'جهاز كشف المعادن يساعد الباحث على اتخاذ قرار مدروس.',
    'جهاز كشف المعادن يساعد الباحث على اتخاذ قرار مدروس.',
    'جهاز جولد ستار يقدم تقنيات استشعار متقدمة.',
    'جهاز جولد ستار يقدم تقنيات استشعار متقدمة.',
    'شركة البازرفان توفر دليل اختيار واضح.',
    'شركة البازرفان توفر دليل اختيار واضح.',
    'قرار الشراء يحتاج مقارنة عملية دقيقة قبل الطلب.',
    'قرار الشراء يحتاج مقارنة عملية دقيقة قبل الطلب.',
  ].join(' ');
  const result = runDuplicateAnalysis(text, {
    primary: 'أجهزة كشف الذهب الأمريكية',
    secondaries: ['جهاز كشف المعادن'],
    company: 'شركة البازرفان',
    lsi: ['تقنيات استشعار', 'جولد ستار'],
  }, text.split(/\s+/u).length, 'ar');

  const allPhrases = Object.values(result.duplicateAnalysis).flat() as { text: string }[];
  const normalizedPhrases = allPhrases.map(phrase => phrase.text.replace(/[.،]/gu, ''));

  assert.equal(normalizedPhrases.some(phrase => phrase.includes('أجهزة كشف')), false);
  assert.equal(normalizedPhrases.some(phrase => phrase.includes('جهاز كشف المعادن')), false);
  assert.equal(normalizedPhrases.some(phrase => phrase.includes('جولد ستار')), false);
  assert.equal(normalizedPhrases.some(phrase => phrase.includes('تقنيات استشعار')), false);
  assert.equal(normalizedPhrases.some(phrase => phrase.includes('شركة البازرفان')), false);
  assert.equal(normalizedPhrases.some(phrase => phrase.includes('قرار الشراء')), true);

  assert.equal(result.duplicateStats.keywordDuplicatesCount, 0);
  assert.ok(result.duplicateStats.commonDuplicatesCount > 0);
  assert.equal(
    result.duplicateStats.totalDuplicates,
    result.duplicateStats.commonDuplicatesCount,
  );
});
