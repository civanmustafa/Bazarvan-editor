import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = async (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('external analysis markdown and find/replace fields stay legible in dark mode', async () => {
  const [externalAnalysisSource, findReplaceSource] = await Promise.all([
    readSource('components/ExternalAnalysisResultsTab.tsx'),
    readSource('components/toolbar/FindAndReplace.tsx'),
  ]);

  assert.match(
    externalAnalysisSource,
    /ai-output text-xs leading-6 text-gray-800 dark:text-gray-100/,
  );
  assert.equal(
    (findReplaceSource.match(/dark:text-gray-100 dark:placeholder:text-gray-500/g) || []).length,
    2,
  );
});

test('competitor cards place the editable URL beside the numbered competitor label', async () => {
  const source = await readSource('components/RightSidebar.tsx');
  const competitorTab = source.slice(
    source.indexOf('<CompetitorDiscoveryPanel'),
    source.indexOf('competitorTextStats.totalWords'),
  );

  assert.doesNotMatch(competitorTab, /\{tRs\.competitors\}/);
  assert.doesNotMatch(competitorTab, /\{tRs\.competitorsHint\}/);
  assert.match(competitorTab, /htmlFor=\{`competitor-url-\$\{index\}`\}/);
  assert.match(competitorTab, /id=\{`competitor-url-\$\{index\}`\}/);
});
