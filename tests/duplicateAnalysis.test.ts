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

test('duplicate analysis reports keyword stuffing instead of hiding protected phrases', async () => {
  const { runDuplicateAnalysis } = await importDuplicateAnalysis();
  const text = [
    'أجهزة كشف الذهب الأمريكية تناسب أعمال التنقيب الاحترافية.',
    'أجهزة كشف الذهب الأمريكية تناسب أعمال التنقيب الاحترافية.',
    'قرار الشراء يحتاج مقارنة عملية دقيقة قبل الطلب.',
    'قرار الشراء يحتاج مقارنة عملية دقيقة قبل الطلب.',
  ].join(' ');
  const result = runDuplicateAnalysis(text, {
    primary: 'أجهزة كشف الذهب الأمريكية',
    secondaries: [],
    company: '',
    lsi: [],
  }, text.split(/\s+/u).length, 'ar');

  const primaryPhrase = result.duplicateAnalysis[4].find((phrase: { text: string }) => (
    phrase.text === 'أجهزة كشف الذهب الأمريكية'
  ));
  assert.equal(primaryPhrase?.count, 2);
  assert.equal(primaryPhrase?.containsKeyword, true);
  assert.ok(result.duplicateStats.keywordDuplicatesCount > 0);
  assert.ok(result.duplicateStats.commonDuplicatesCount > 0);
  assert.equal(
    result.duplicateStats.totalDuplicates,
    result.duplicateStats.keywordDuplicatesCount + result.duplicateStats.commonDuplicatesCount,
  );
});
