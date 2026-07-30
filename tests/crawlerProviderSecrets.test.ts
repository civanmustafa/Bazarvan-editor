import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __crawlerProviderSecretsTestUtils,
  normalizeCrawlerExternalProvider,
} from '../server/crawlerProviderSecrets.ts';
import {
  normalizeClientSiteCrawlProvider,
} from '../constants/crawlerProviders.ts';
import {
  __clientPageCrawlerProvidersTestUtils,
} from '../server/clientPageCrawlerProviders.ts';
import type { ClientPageCrawlResult } from '../server/clientPageCrawler.ts';

test('crawler provider keys are encrypted with provider-bound authenticated data', () => {
  const previousDedicatedKey = process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY;
  const previousAiKey = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
  delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
  try {
    const plaintext = 'fc-this-is-a-secret-crawler-key';
    const encrypted = __crawlerProviderSecretsTestUtils.encryptSecret(
      'firecrawl',
      plaintext,
    );
    assert.notEqual(encrypted.ciphertext, plaintext);
    assert.equal(
      __crawlerProviderSecretsTestUtils.decryptSecret({
        provider: 'firecrawl',
        ...encrypted,
        enabled: true,
        key_suffix: plaintext.slice(-4),
        updated_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      plaintext,
    );
    assert.throws(() => (
      __crawlerProviderSecretsTestUtils.decryptSecret({
        provider: 'browserless',
        ...encrypted,
        enabled: true,
        key_suffix: plaintext.slice(-4),
        updated_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    ), /could not be decrypted/i);
  } finally {
    if (previousDedicatedKey === undefined) {
      delete process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY = previousDedicatedKey;
    }
    if (previousAiKey === undefined) {
      delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.AI_SETTINGS_ENCRYPTION_KEY = previousAiKey;
    }
  }
});

test('crawler provider normalization rejects secret-provider typos and bounds crawl mode', () => {
  assert.equal(normalizeCrawlerExternalProvider('firecrawl'), 'firecrawl');
  assert.equal(normalizeCrawlerExternalProvider('browserless'), 'browserless');
  assert.throws(
    () => normalizeCrawlerExternalProvider('local'),
    /unsupported crawler provider/i,
  );
  assert.equal(normalizeClientSiteCrawlProvider('firecrawl'), 'firecrawl');
  assert.equal(normalizeClientSiteCrawlProvider('unexpected'), 'auto');
});

test('automatic mode falls back only for truly sparse local HTML', () => {
  const base: ClientPageCrawlResult = {
    finalUrl: 'https://example.com/',
    canonicalUrl: 'https://example.com/',
    httpStatus: 200,
    pageTitle: '',
    metaDescription: '',
    h1: '',
    h2: [],
    h3: [],
    slug: '/',
    pageLanguage: '',
    robotsIndex: true,
    robotsFollow: true,
    contentHash: 'a'.repeat(64),
    extractedTerms: [],
    extractedPhrases: [],
    wordCount: 0,
    responseContentType: 'text/html',
    redirectCount: 0,
    crawlDurationMs: 1,
    internalLinks: [],
  };
  assert.equal(
    __clientPageCrawlerProvidersTestUtils.localResultNeedsExternalFallback(base),
    true,
  );
  assert.equal(
    __clientPageCrawlerProvidersTestUtils.localResultNeedsExternalFallback({
      ...base,
      pageTitle: 'Example',
    }),
    true,
  );
  assert.equal(
    __clientPageCrawlerProvidersTestUtils.localResultNeedsExternalFallback({
      ...base,
      pageTitle: 'Example',
      wordCount: 80,
    }),
    false,
  );
  assert.equal(
    __clientPageCrawlerProvidersTestUtils.localResultNeedsExternalFallback({
      ...base,
      internalLinks: [{
        targetUrl: 'https://example.com/about',
        anchorText: 'About',
        relNofollow: false,
        relSponsored: false,
        relUgc: false,
        crawlable: true,
        occurrenceCount: 1,
      }],
    }),
    false,
  );
});
