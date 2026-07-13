import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ARTICLE_COMPETITORS, normalizeCompetitorSlots } from '../constants/competitors.ts';
import {
  canonicalizeCompetitorUrl,
  FirecrawlCompetitorError,
  markdownToCompetitorText,
} from '../server/firecrawlCompetitorService.ts';

test('competitor URLs are canonicalized without tracking parameters', () => {
  assert.equal(
    canonicalizeCompetitorUrl('https://Example.com/article/?utm_source=test&keep=yes#section'),
    'https://example.com/article?keep=yes',
  );
});

test('competitor URLs reject local and private destinations', () => {
  for (const value of [
    'http://localhost:8080/private',
    'http://127.0.0.1/private',
    'http://10.20.30.40/private',
    'http://192.168.1.10/private',
    'http://[::1]/private',
    'file:///etc/passwd',
  ]) {
    assert.throws(
      () => canonicalizeCompetitorUrl(value),
      (error: unknown) => error instanceof FirecrawlCompetitorError
        && error.code === 'unsafe_competitor_url',
      value,
    );
  }
});

test('competitor markdown is normalized into analysis text', () => {
  const normalized = markdownToCompetitorText(`
# Main title

Read the [full guide](https://example.com/guide).

- First point
- Second point

\`\`\`js
const secret = true;
\`\`\`
  `);
  assert.match(normalized, /Main title/);
  assert.match(normalized, /Read the full guide/);
  assert.match(normalized, /First point/);
  assert.doesNotMatch(normalized, /const secret/);
});

test('all competitor paths share five stable slots', () => {
  assert.equal(MAX_ARTICLE_COMPETITORS, 5);
  assert.deepEqual(normalizeCompetitorSlots(['one', 'two']), ['one', 'two', '', '', '']);
});
