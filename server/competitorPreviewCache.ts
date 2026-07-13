import { createHash } from 'node:crypto';
import {
  canonicalizeCompetitorUrl,
  scrapeCompetitorWeb,
  type ScrapedCompetitorContent,
} from './firecrawlCompetitorService';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

type CompetitorCacheRow = {
  cache_key: string;
  canonical_url: string;
  source_url: string;
  fetched_url: string;
  domain: string;
  title: string;
  description: string;
  headings: unknown;
  content_text: string;
  word_count: number;
  extraction_provider: string;
  provider_key_suffix: string;
  fetched_at: string;
  expires_at: string;
};

export type CompetitorPreview = ScrapedCompetitorContent & {
  cacheHit: boolean;
  provider: string;
  providerKeySuffix: string;
  fetchedAt: string;
  expiresAt: string;
};

const CACHE_TABLE = 'competitor_page_cache';
const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let lastCachePruneAt = 0;
let cacheWarningShown = false;

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toStringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(toText).filter(Boolean).slice(0, 80) : []
);

const toHeadings = (value: unknown): ScrapedCompetitorContent['headings'] => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    h1: toStringList(source.h1),
    h2: toStringList(source.h2),
    h3: toStringList(source.h3),
  };
};

const getCacheHours = (): number => {
  const parsed = Number.parseInt(process.env.COMPETITOR_PREVIEW_CACHE_HOURS || '24', 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 168)) : 24;
};

const createCacheKey = (canonicalUrl: string): string => (
  createHash('sha256').update(canonicalUrl).digest('hex')
);

const getProviderKeySuffix = (): string => (
  String(process.env.FIRECRAWL_API_KEY || '').trim().slice(-6)
);

const isMissingCacheTable = (error: { code?: string; message?: string } | null): boolean => (
  Boolean(error) && (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /competitor_page_cache/i.test(error?.message || '')
  )
);

const warnCacheFailure = (operation: string, error: { code?: string } | null): void => {
  if (cacheWarningShown || isMissingCacheTable(error)) return;
  cacheWarningShown = true;
  console.warn(`[competitor-preview-cache] ${operation} failed; continuing without cache.`, {
    code: error?.code || 'unknown',
  });
};

const rowToPreview = (row: CompetitorCacheRow): CompetitorPreview => ({
  url: row.source_url,
  canonicalUrl: row.canonical_url,
  fetchedUrl: row.fetched_url,
  domain: row.domain,
  title: row.title,
  description: row.description,
  headings: toHeadings(row.headings),
  text: row.content_text,
  wordCount: Math.max(0, Number(row.word_count) || 0),
  cacheHit: true,
  provider: row.extraction_provider || 'firecrawl',
  providerKeySuffix: row.provider_key_suffix || '',
  fetchedAt: row.fetched_at,
  expiresAt: row.expires_at,
});

const readCachedPreview = async (canonicalUrl: string): Promise<CompetitorPreview | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(CACHE_TABLE)
    .select('cache_key,canonical_url,source_url,fetched_url,domain,title,description,headings,content_text,word_count,extraction_provider,provider_key_suffix,fetched_at,expires_at')
    .eq('cache_key', createCacheKey(canonicalUrl))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) {
    warnCacheFailure('read', error);
    return null;
  }
  return data ? rowToPreview(data as CompetitorCacheRow) : null;
};

const pruneStalePreviews = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastCachePruneAt < CACHE_PRUNE_INTERVAL_MS) return;
  lastCachePruneAt = now;
  const staleBefore = new Date(now - CACHE_STALE_RETENTION_MS).toISOString();
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(CACHE_TABLE)
    .delete()
    .lt('expires_at', staleBefore);
  if (error) warnCacheFailure('prune', error);
};

const savePreview = async (
  preview: ScrapedCompetitorContent,
  fetchedAt: string,
  expiresAt: string,
): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(CACHE_TABLE)
    .upsert({
      cache_key: createCacheKey(preview.canonicalUrl),
      canonical_url: preview.canonicalUrl,
      source_url: preview.url,
      fetched_url: preview.fetchedUrl,
      domain: preview.domain,
      title: preview.title,
      description: preview.description,
      headings: preview.headings,
      content_text: preview.text,
      word_count: preview.wordCount,
      extraction_provider: 'firecrawl',
      provider_key_suffix: getProviderKeySuffix(),
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    }, { onConflict: 'cache_key' });
  if (error) {
    warnCacheFailure('write', error);
    return;
  }
  void pruneStalePreviews();
};

export const getCompetitorPreview = async (options: {
  url: string;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}): Promise<CompetitorPreview> => {
  const canonicalUrl = canonicalizeCompetitorUrl(options.url);
  if (!options.forceRefresh) {
    const cached = await readCachedPreview(canonicalUrl);
    if (cached) return cached;
  }

  const scraped = await scrapeCompetitorWeb({
    url: canonicalUrl,
    signal: options.signal,
  });
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (getCacheHours() * 60 * 60 * 1000)).toISOString();
  await savePreview(scraped, fetchedAt, expiresAt);
  return {
    ...scraped,
    cacheHit: false,
    provider: 'firecrawl',
    providerKeySuffix: getProviderKeySuffix(),
    fetchedAt,
    expiresAt,
  };
};
