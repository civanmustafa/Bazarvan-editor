import type { CompetitorSearchMode } from '../constants/competitors';
import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

export type CompetitorDiscoveryStatus =
  | 'queued'
  | 'extracting'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CompetitorDiscoveryRow = {
  id: string;
  articleId: string;
  position: number;
  queryType: CompetitorSearchMode;
  queryText: string;
  sourceUrl: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  description: string;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  contentText: string;
  wordCount: number;
  status: CompetitorDiscoveryStatus;
  extractionProvider: string;
  errorCode: string;
  errorMessage: string;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompetitorSearchResult = {
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  description: string;
  position: number;
  selectionRank: number;
  selectionScore: number;
  confidence: number;
  autoSelected: boolean;
  eligible: boolean;
  inferredIntent: 'informational' | 'commercial' | 'transactional' | 'navigational' | 'local' | 'support' | 'unknown';
  inferredPageType: 'article' | 'guide' | 'comparison' | 'service' | 'product' | 'category' | 'landing' | 'news' | 'forum' | 'video' | 'homepage' | 'unknown';
  reasonCodes: string[];
  warningCodes: string[];
  signals: {
    intentMatch: number;
    relevance: number;
    searchStrength: number;
    pageTypeMatch: number;
    languageMatch: number;
    metadataQuality: number;
    locationMatch: number;
  };
};

export type CompetitorSelectionSummary = {
  strategy: 'automatic_review';
  engineVersion: string;
  targetIntent: CompetitorSearchResult['inferredIntent'];
  targetPageType: CompetitorSearchResult['inferredPageType'];
  confidence: number;
  candidateCount: number;
  reviewedCount: number;
  filteredCount: number;
  autoSelectedCount: number;
  autoSelectedUrls: string[];
};

export type CompetitorSearchResponse = {
  results: CompetitorSearchResult[];
  selection: CompetitorSelectionSummary;
};

export type CompetitorPreview = {
  url: string;
  canonicalUrl: string;
  fetchedUrl: string;
  domain: string;
  title: string;
  description: string;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  text: string;
  wordCount: number;
  provider: string;
  cacheHit: boolean;
  persisted: boolean;
  fetchedAt: string;
  expiresAt: string;
};

export type CompetitorExtractionJob = {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  last_error?: string | null;
  last_error_code?: string | null;
  attempt_count?: number;
  retry_count?: number;
  next_attempt_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type CompetitorDiscoveryState = {
  providerConfigured: boolean;
  competitors: CompetitorDiscoveryRow[];
  activeJob: CompetitorExtractionJob | null;
  latestJob: CompetitorExtractionJob | null;
};

export class CompetitorDiscoveryRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(response: Response, payload: Record<string, unknown>) {
    super(typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `Competitor request failed with HTTP ${response.status}.`);
    this.name = 'CompetitorDiscoveryRequestError';
    this.status = response.status;
    this.code = typeof payload.code === 'string' ? payload.code : 'competitor_request_failed';
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toStringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(toText).filter(Boolean) : []
);

const toHeadings = (value: unknown): CompetitorDiscoveryRow['headings'] => {
  const headings = isRecord(value) ? value : {};
  return {
    h1: toStringList(headings.h1),
    h2: toStringList(headings.h2),
    h3: toStringList(headings.h3),
  };
};

const toCompetitorRow = (value: unknown): CompetitorDiscoveryRow | null => {
  if (!isRecord(value) || !toText(value.id)) return null;
  const status = toText(value.status) as CompetitorDiscoveryStatus;
  return {
    id: toText(value.id),
    articleId: toText(value.article_id),
    position: Math.max(1, Number(value.position) || 1),
    queryType: value.query_type === 'primary_keyword' ? 'primary_keyword' : 'title',
    queryText: toText(value.query_text),
    sourceUrl: toText(value.source_url),
    canonicalUrl: toText(value.canonical_url),
    domain: toText(value.domain),
    title: toText(value.title),
    description: toText(value.description),
    headings: toHeadings(value.headings),
    contentText: toText(value.content_text),
    wordCount: Math.max(0, Number(value.word_count) || 0),
    status: ['queued', 'extracting', 'retry_scheduled', 'completed', 'failed', 'cancelled'].includes(status)
      ? status
      : 'queued',
    extractionProvider: toText(value.extraction_provider),
    errorCode: toText(value.error_code),
    errorMessage: toText(value.error_message),
    fetchedAt: value.fetched_at ? String(value.fetched_at) : null,
    createdAt: String(value.created_at || ''),
    updatedAt: String(value.updated_at || ''),
  };
};

const toJob = (value: unknown): CompetitorExtractionJob | null => {
  if (!isRecord(value) || !toText(value.id)) return null;
  return {
    id: toText(value.id),
    status: toText(value.status),
    progress: isRecord(value.progress) ? value.progress : {},
    last_error: value.last_error ? String(value.last_error) : null,
    last_error_code: value.last_error_code ? String(value.last_error_code) : null,
    attempt_count: Number(value.attempt_count) || 0,
    retry_count: Number(value.retry_count) || 0,
    next_attempt_at: value.next_attempt_at ? String(value.next_attempt_at) : null,
    completed_at: value.completed_at ? String(value.completed_at) : null,
    created_at: value.created_at ? String(value.created_at) : '',
    updated_at: value.updated_at ? String(value.updated_at) : '',
  };
};

const toPreview = (value: unknown): CompetitorPreview | null => {
  if (!isRecord(value) || !toText(value.canonicalUrl) || !toText(value.text)) return null;
  return {
    url: toText(value.url) || toText(value.canonicalUrl),
    canonicalUrl: toText(value.canonicalUrl),
    fetchedUrl: toText(value.fetchedUrl) || toText(value.canonicalUrl),
    domain: toText(value.domain),
    title: toText(value.title),
    description: toText(value.description),
    headings: toHeadings(value.headings),
    text: toText(value.text),
    wordCount: Math.max(0, Number(value.wordCount) || 0),
    provider: toText(value.provider),
    cacheHit: value.cacheHit === true,
    persisted: false,
    fetchedAt: toText(value.fetchedAt),
    expiresAt: toText(value.expiresAt),
  };
};

const requestCompetitors = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
  const token = await getAuthenticatedApiToken();
  const response = await fetch('/api/competitors', {
    method: 'POST',
    headers: getAuthenticatedApiHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  const normalized = isRecord(payload) ? payload : {};
  if (!response.ok) throw new CompetitorDiscoveryRequestError(response, normalized);
  return normalized;
};

export const listArticleCompetitors = async (
  articleId: string,
  options: { includeContent?: boolean } = {},
): Promise<CompetitorDiscoveryState> => {
  const payload = await requestCompetitors({
    action: 'list',
    articleId,
    includeContent: options.includeContent !== false,
  });
  return {
    providerConfigured: payload.providerConfigured === true,
    competitors: Array.isArray(payload.competitors)
      ? payload.competitors.map(toCompetitorRow).filter((row): row is CompetitorDiscoveryRow => Boolean(row))
      : [],
    activeJob: toJob(payload.activeJob),
    latestJob: toJob(payload.latestJob),
  };
};

export const searchArticleCompetitors = async (options: {
  articleId: string;
  query: string;
  queryType: CompetitorSearchMode;
  language: 'ar' | 'en';
  articleTitle: string;
  primaryKeyword: string;
  pageType: string;
  searchIntent: string;
  audienceScope: string;
  targetCountry: string;
  companyName: string;
}): Promise<CompetitorSearchResponse> => {
  const payload = await requestCompetitors({ action: 'search', ...options });
  const results = Array.isArray(payload.results)
    ? payload.results.flatMap((value: unknown) => {
        if (!isRecord(value)) return [];
        const canonicalUrl = toText(value.canonicalUrl);
        if (!canonicalUrl) return [];
        const signals = isRecord(value.signals) ? value.signals : {};
        return [{
          url: toText(value.url) || canonicalUrl,
          canonicalUrl,
          domain: toText(value.domain),
          title: toText(value.title),
          description: toText(value.description),
          position: Math.max(1, Number(value.position) || 1),
          selectionRank: Math.max(1, Number(value.selectionRank) || 1),
          selectionScore: Math.max(0, Math.min(100, Number(value.selectionScore) || 0)),
          confidence: Math.max(0, Math.min(100, Number(value.confidence) || 0)),
          autoSelected: value.autoSelected === true,
          eligible: value.eligible === true,
          inferredIntent: toText(value.inferredIntent) as CompetitorSearchResult['inferredIntent'] || 'unknown',
          inferredPageType: toText(value.inferredPageType) as CompetitorSearchResult['inferredPageType'] || 'unknown',
          reasonCodes: toStringList(value.reasonCodes),
          warningCodes: toStringList(value.warningCodes),
          signals: {
            intentMatch: Math.max(0, Math.min(100, Number(signals.intentMatch) || 0)),
            relevance: Math.max(0, Math.min(100, Number(signals.relevance) || 0)),
            searchStrength: Math.max(0, Math.min(100, Number(signals.searchStrength) || 0)),
            pageTypeMatch: Math.max(0, Math.min(100, Number(signals.pageTypeMatch) || 0)),
            languageMatch: Math.max(0, Math.min(100, Number(signals.languageMatch) || 0)),
            metadataQuality: Math.max(0, Math.min(100, Number(signals.metadataQuality) || 0)),
            locationMatch: Math.max(0, Math.min(100, Number(signals.locationMatch) || 0)),
          },
        }];
      })
    : [];
  const selection = isRecord(payload.selection) ? payload.selection : {};
  return {
    results,
    selection: {
      strategy: 'automatic_review',
      engineVersion: toText(selection.engineVersion),
      targetIntent: (toText(selection.targetIntent) || 'unknown') as CompetitorSelectionSummary['targetIntent'],
      targetPageType: (toText(selection.targetPageType) || 'unknown') as CompetitorSelectionSummary['targetPageType'],
      confidence: Math.max(0, Math.min(100, Number(selection.confidence) || 0)),
      candidateCount: Math.max(0, Number(selection.candidateCount) || 0),
      reviewedCount: Math.max(0, Number(selection.reviewedCount) || results.length),
      filteredCount: Math.max(0, Number(selection.filteredCount) || 0),
      autoSelectedCount: Math.max(0, Number(selection.autoSelectedCount) || 0),
      autoSelectedUrls: toStringList(selection.autoSelectedUrls),
    },
  };
};

export const loadArticleCompetitorPreview = async (
  articleId: string,
  url: string,
): Promise<CompetitorPreview> => {
  const payload = await requestCompetitors({ action: 'preview', articleId, url });
  const preview = toPreview(payload.preview);
  if (!preview) throw new Error('Competitor preview response was invalid.');
  return preview;
};

export const enqueueArticleCompetitorExtraction = async (options: {
  articleId: string;
  query: string;
  queryType: CompetitorSearchMode;
  results: CompetitorSearchResult[];
}): Promise<void> => {
  await requestCompetitors({ action: 'extract', ...options });
};

export const cancelArticleCompetitorExtraction = async (articleId: string): Promise<void> => {
  await requestCompetitors({ action: 'cancel', articleId });
};

export const removeArticleCompetitor = async (articleId: string, competitorId: string): Promise<void> => {
  await requestCompetitors({ action: 'remove', articleId, competitorId });
};
