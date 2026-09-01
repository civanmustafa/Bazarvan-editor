import {
  FirecrawlCompetitorError,
  getFirecrawlCredentialSummary,
} from './firecrawlCompetitorService';
import {
  COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
  COMPETITOR_RENDERED_EXTRACTION_TIMEOUT_MS,
  COMPETITOR_REPLACEMENT_RESERVE_LIMIT,
} from '../constants/competitors';
import { getCompetitorPreview } from './competitorPreviewCache';
import {
  getProgrammaticCompetitorContent,
  ProgrammaticCompetitorExtractionError,
  type ProgrammaticCompetitorContent,
} from './programmaticCompetitorExtractor';
import {
  BrowserlessCompetitorExtractionError,
  getBrowserlessCompetitorContent,
} from './browserlessCompetitorExtractor.ts';
import {
  COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE,
  COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT,
  COMPETITOR_KEYWORD_TARGETING_WARNING_CODE,
  COMPETITOR_KEYWORD_TARGETING_WARNING_TEXT,
} from '../utils/competitorContent';
import {
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import { isCompetitorLanguageCompatible } from './competitorSelectionEngine.ts';
import { analyzeCompetitorKeywordTargeting } from './competitorContentQualification.ts';
import { assertAutomaticCompetitorResearchAllowed } from './contentResearchAutomationGuard.ts';
import {
  CONTENT_WRITING_MIN_COMPETITOR_UNIQUE_TOKENS,
  CONTENT_WRITING_MIN_COMPETITOR_WORDS,
} from '../utils/contentWritingContext.ts';

/**
 * Architecture boundary:
 * - Firecrawl gets exactly one attempt per URL.
 * - A failed Firecrawl request falls back immediately to deterministic HTML extraction,
 *   then to one Browserless rendered-page attempt. No fallback invokes Gemini/OpenAI.
 * - Deterministic qualification is the hard selection gate. A final keyword recheck is only
 *   advisory, so an approved source with readable content never breaks the automatic pipeline.
 * - It must persist the full text in article_competitors.content_text, then synchronize that
 *   text into the article competitor attachment consumed by analysis and content writing.
 * - If every provider fails, a confirmed reserve result replaces the failed URL in the
 *   same slot. The shared failure marker is written only after reserves are exhausted.
 */
type CompetitorRow = {
  id: string;
  article_id: string;
  position: number;
  canonical_url: string;
  source_url: string;
  domain: string;
  title: string;
  description: string;
  content_text: string;
  word_count: number;
  extraction_provider: string;
  status: 'queued' | 'extracting' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
};

type CompetitorFailure = {
  position: number;
  code: string;
  message: string;
  retryable: boolean;
  attempt: number;
};

type ArticleTargetingContext = {
  language: 'ar' | 'en';
  articleTitle: string;
  primaryKeyword: string;
  alternativeKeywords: string[];
};

type FinalKeywordTargetingOutcome = {
  warningCode: string;
  warningMessage: string;
  contentTooShort: boolean;
};

const FIRECRAWL_MODEL = 'v2/scrape';
const PROGRAMMATIC_MODEL = 'deterministic-main-content';
const BROWSERLESS_MODEL = 'rendered-main-content';

const getFirecrawlKeySuffix = async (userId?: string | null): Promise<string> => {
  const summary = await getFirecrawlCredentialSummary(userId);
  return summary.keySuffix;
};

const readCompetitors = async (articleId: string): Promise<CompetitorRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .select('id,article_id,position,canonical_url,source_url,domain,title,description,content_text,word_count,status,extraction_provider,error_code,error_message')
    .eq('article_id', articleId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data || []) as CompetitorRow[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const textList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 12) : []
);

const readArticleTargetingContext = async (articleId: string): Promise<ArticleTargetingContext> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('article_language,title,keywords')
    .eq('id', articleId)
    .single();
  if (error) throw error;
  const keywords = isRecord(data?.keywords) ? data.keywords : {};
  return {
    language: data?.article_language === 'en' ? 'en' : 'ar',
    articleTitle: text(data?.title),
    primaryKeyword: text(keywords.primary),
    alternativeKeywords: textList(keywords.secondaries),
  };
};

const requiresKeywordTargeting = (
  snapshot: Record<string, unknown>,
  row: CompetitorRow,
): boolean => {
  const selected = isRecord(snapshot.selectedQualifications) ? snapshot.selectedQualifications : {};
  const canonicalMetadata = selected[row.canonical_url];
  const sourceMetadata = selected[row.source_url];
  const metadata = isRecord(canonicalMetadata)
    ? canonicalMetadata
    : isRecord(sourceMetadata)
      ? sourceMetadata
      : {};
  return metadata.qualificationRequired === true;
};

/**
 * Deterministic qualification is the hard gate for choosing a competitor.
 * The final provider fetch is allowed to have a different main-content shape:
 * a missing phrase is advisory, whereas unusably short content remains a
 * genuine extraction failure that can use the programmatic fallback.
 */
const evaluateFinalKeywordTargeting = (options: {
  snapshot: Record<string, unknown>;
  row: CompetitorRow;
  articleTargeting: ArticleTargetingContext;
  content: Parameters<typeof analyzeCompetitorKeywordTargeting>[0]['content'];
}): FinalKeywordTargetingOutcome => {
  if (!requiresKeywordTargeting(options.snapshot, options.row)) {
    return { warningCode: '', warningMessage: '', contentTooShort: false };
  }
  const targeting = analyzeCompetitorKeywordTargeting({
    content: options.content,
    primaryKeyword: options.articleTargeting.primaryKeyword,
    alternativeKeywords: options.articleTargeting.alternativeKeywords,
    articleTitle: options.articleTargeting.articleTitle,
    searchResult: {
      title: options.row.title,
      description: options.row.description,
      url: options.row.source_url,
      canonicalUrl: options.row.canonical_url,
    },
  });
  if (targeting.status === 'unavailable') {
    return { warningCode: '', warningMessage: '', contentTooShort: true };
  }
  if (targeting.status === 'qualified') {
    return { warningCode: '', warningMessage: '', contentTooShort: false };
  }
  return {
    warningCode: COMPETITOR_KEYWORD_TARGETING_WARNING_CODE,
    warningMessage: COMPETITOR_KEYWORD_TARGETING_WARNING_TEXT,
    contentTooShort: false,
  };
};

const updateCompetitor = async (
  competitorId: string,
  values: Record<string, unknown>,
  allowedStatuses?: CompetitorRow['status'][],
): Promise<void> => {
  let query = getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .update(values)
    .eq('id', competitorId);
  if (allowedStatuses?.length) query = query.in('status', allowedStatuses);
  const { error } = await query;
  if (error) throw error;
};

const syncArticleCompetitors = async (articleId: string): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'sync_article_competitors_metadata',
    { p_article_id: articleId },
  );
  if (error) throw error;
};

type ReserveCompetitorSource = {
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  description: string;
  contentQualification: Record<string, unknown>;
};

type CompetitorReplacement = {
  position: number;
  previousUrl: string;
  replacementUrl: string;
  reasonCode: string;
};

class CompetitorContentUsabilityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'CompetitorContentUsabilityError';
    this.code = code;
    this.status = status;
  }
}

const competitorInformationTokens = (value: string): string[] => String(value || '')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .split(/\s+/u)
  .filter(token => token.length >= 3);

const competitorContentFingerprint = (value: string): string => (
  competitorInformationTokens(value).slice(0, 2_000).join(' ')
);

const assertUsableCompetitorContent = (options: {
  content: Pick<ProgrammaticCompetitorContent, 'text' | 'wordCount'>;
  articleLanguage: 'ar' | 'en';
  acceptedFingerprints: Set<string>;
}): string => {
  if (options.content.wordCount < CONTENT_WRITING_MIN_COMPETITOR_WORDS) {
    throw new CompetitorContentUsabilityError(
      'competitor_content_too_short',
      `Competitor content contains ${options.content.wordCount} words; at least ${CONTENT_WRITING_MIN_COMPETITOR_WORDS} are required.`,
    );
  }
  const informationTokens = competitorInformationTokens(options.content.text);
  if (new Set(informationTokens).size < CONTENT_WRITING_MIN_COMPETITOR_UNIQUE_TOKENS) {
    throw new CompetitorContentUsabilityError(
      'competitor_content_low_information_density',
      'The extracted competitor text does not contain enough distinct informational terms.',
    );
  }
  if (options.articleLanguage === 'ar' && !isCompetitorLanguageCompatible('ar', options.content.text)) {
    throw new CompetitorContentUsabilityError(
      'competitor_language_mismatch',
      'The extracted competitor page is Latin-language content and was excluded from the Arabic article.',
    );
  }
  const fingerprint = competitorContentFingerprint(options.content.text);
  if (fingerprint && options.acceptedFingerprints.has(fingerprint)) {
    throw new CompetitorContentUsabilityError(
      'competitor_duplicate_content',
      'The extracted text duplicates an already accepted competitor source.',
    );
  }
  return fingerprint;
};

const normalizeReserveSource = (value: unknown): ReserveCompetitorSource | null => {
  if (!isRecord(value)) return null;
  const rawUrl = text(value.canonicalUrl) || text(value.url);
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const canonicalUrl = parsed.toString();
    return {
      url: text(value.url) || canonicalUrl,
      canonicalUrl,
      domain: (text(value.domain) || parsed.hostname).toLocaleLowerCase().replace(/^www\./, ''),
      title: text(value.title) || parsed.hostname,
      description: text(value.description),
      contentQualification: isRecord(value.contentQualification) ? value.contentQualification : {},
    };
  } catch {
    return null;
  }
};

const qualificationSnapshotForSource = (
  source: ReserveCompetitorSource,
): Record<string, unknown> => {
  const qualification = source.contentQualification;
  const status = text(qualification.status) || 'unavailable';
  const targetingStatus = text(qualification.targetingStatus);
  return {
    autoSelected: false,
    qualificationRequired: status === 'qualified' || targetingStatus === 'confirmed',
    status,
    targetingStatus,
    score: Math.max(0, Math.min(100, Number(qualification.score) || 0)),
    matchedKeyword: text(qualification.matchedKeyword),
    matchKind: text(qualification.matchKind),
    targetingEvidence: Array.isArray(qualification.evidence)
      ? qualification.evidence.slice(0, 40)
      : [],
  };
};

const readDiscoveryReserveValues = async (
  context: ExternalAnalysisExecutionContext,
  snapshot: Record<string, unknown>,
): Promise<unknown[]> => {
  const discoveryJobId = text(snapshot.discoveryJobId);
  const discoverySignature = text(snapshot.discoverySignature);
  let job: { result?: unknown } | null = null;
  if (discoveryJobId) {
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from('ai_external_analysis_jobs')
      .select('result')
      .eq('id', discoveryJobId)
      .eq('job_type', 'competitor_discovery')
      .maybeSingle();
    if (error) throw error;
    job = data;
  } else if (discoverySignature) {
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from('ai_external_analysis_jobs')
      .select('result')
      .eq('article_id', context.job.article_id)
      .eq('job_type', 'competitor_discovery')
      .eq('readiness_signature', discoverySignature)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    job = data;
  }
  const result = isRecord(job?.result) ? job.result : {};
  return Array.isArray(result.results) ? result.results : [];
};

const loadReserveSources = async (options: {
  context: ExternalAnalysisExecutionContext;
  snapshot: Record<string, unknown>;
  rows: CompetitorRow[];
}): Promise<ReserveCompetitorSource[]> => {
  const snapshotValues = Array.isArray(options.snapshot.reserveSources)
    ? options.snapshot.reserveSources
    : [];
  const discoveryValues = await readDiscoveryReserveValues(options.context, options.snapshot);
  const selectedUrls = new Set(options.rows.flatMap(row => [row.canonical_url, row.source_url]).filter(Boolean));
  const selectedDomains = new Set(options.rows.map(row => row.domain).filter(Boolean));
  const seenUrls = new Set(selectedUrls);
  const seenDomains = new Set(selectedDomains);
  const reserves = [...snapshotValues, ...discoveryValues].flatMap(value => {
    if (isRecord(value) && value.eligible === false) return [];
    const qualification = isRecord(value) && isRecord(value.contentQualification)
      ? value.contentQualification
      : {};
    const confirmed = text(qualification.status) === 'qualified'
      || text(qualification.targetingStatus) === 'confirmed'
      || (isRecord(value) && value.eligible === true);
    if (!confirmed) return [];
    const source = normalizeReserveSource(value);
    if (!source || seenUrls.has(source.canonicalUrl) || seenDomains.has(source.domain)) return [];
    seenUrls.add(source.canonicalUrl);
    seenDomains.add(source.domain);
    return [source];
  }).slice(0, COMPETITOR_REPLACEMENT_RESERVE_LIMIT);

  if (reserves.length > 0) {
    const qualifications = isRecord(options.snapshot.selectedQualifications)
      ? { ...options.snapshot.selectedQualifications }
      : {};
    reserves.forEach(source => {
      if (!isRecord(qualifications[source.canonicalUrl])) {
        qualifications[source.canonicalUrl] = qualificationSnapshotForSource(source);
      }
    });
    options.snapshot.reserveSources = reserves;
    options.snapshot.selectedQualifications = qualifications;
    const { error } = await getExternalAnalysisSupabaseAdmin()
      .from('ai_external_analysis_jobs')
      .update({ input_snapshot: options.snapshot })
      .eq('id', options.context.job.id);
    if (error) throw error;
  }
  return reserves;
};

const promoteReserveSource = async (options: {
  context: ExternalAnalysisExecutionContext;
  row: CompetitorRow;
  reserves: ReserveCompetitorSource[];
  claimedUrls: Set<string>;
  claimedDomains: Set<string>;
  reasonCode: string;
  replacements: CompetitorReplacement[];
  successfulCount: number;
  failedCount: number;
  total: number;
}): Promise<boolean> => {
  options.claimedUrls.delete(options.row.canonical_url);
  options.claimedUrls.delete(options.row.source_url);
  options.claimedDomains.delete(options.row.domain);
  let replacement: ReserveCompetitorSource | undefined;
  while (options.reserves.length > 0 && !replacement) {
    const candidate = options.reserves.shift()!;
    if (options.claimedUrls.has(candidate.canonicalUrl) || options.claimedDomains.has(candidate.domain)) continue;
    replacement = candidate;
  }
  if (!replacement) {
    options.claimedUrls.add(options.row.canonical_url);
    if (options.row.domain) options.claimedDomains.add(options.row.domain);
    return false;
  }
  const previousUrl = options.row.canonical_url || options.row.source_url;
  options.claimedUrls.add(replacement.canonicalUrl);
  options.claimedDomains.add(replacement.domain);
  options.replacements.push({
    position: options.row.position,
    previousUrl,
    replacementUrl: replacement.canonicalUrl,
    reasonCode: options.reasonCode,
  });
  await options.context.reportProgress({
    progress: {
      stage: 'replacing_competitor',
      current: options.row.position,
      total: options.total,
      previousUrl,
      replacementUrl: replacement.canonicalUrl,
      reasonCode: options.reasonCode,
      successfulCount: options.successfulCount,
      failedCount: options.failedCount,
    },
    provider: 'programmatic',
    model: 'confirmed-reserve-selection',
  });
  await updateCompetitor(options.row.id, {
    source_url: replacement.url,
    canonical_url: replacement.canonicalUrl,
    domain: replacement.domain,
    title: replacement.title,
    description: replacement.description,
    headings: { h1: [], h2: [], h3: [] },
    content_text: '',
    word_count: 0,
    status: 'extracting',
    extraction_provider: 'confirmed_reserve_replacement',
    error_code: null,
    error_message: null,
    fetched_at: null,
  }, ['queued', 'extracting', 'retry_scheduled']);
  options.row.source_url = replacement.url;
  options.row.canonical_url = replacement.canonicalUrl;
  options.row.domain = replacement.domain;
  options.row.title = replacement.title;
  options.row.description = replacement.description;
  options.row.status = 'extracting';
  options.row.content_text = '';
  options.row.word_count = 0;
  return true;
};

type ExtractedCompetitorPayload = Pick<
  ProgrammaticCompetitorContent,
  'url' | 'canonicalUrl' | 'domain' | 'title' | 'description' | 'headings' | 'text' | 'wordCount' | 'cacheHit' | 'fetchedAt'
> & { providerKeySuffix?: string };

type ProviderFailureDetails = {
  code: string;
  message: string;
  status: number;
  keySuffix: string;
};

const providerFailureDetails = async (
  error: unknown,
  provider: 'firecrawl' | 'programmatic' | 'browserless',
  userId?: string | null,
): Promise<ProviderFailureDetails> => {
  if (error instanceof CompetitorContentUsabilityError) {
    return { code: error.code, message: error.message, status: error.status, keySuffix: '' };
  }
  if (error instanceof FirecrawlCompetitorError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      keySuffix: error.keySuffix || '',
    };
  }
  if (error instanceof ProgrammaticCompetitorExtractionError) {
    return { code: error.code, message: error.message, status: error.status, keySuffix: '' };
  }
  if (error instanceof BrowserlessCompetitorExtractionError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      keySuffix: error.keySuffix,
    };
  }
  return {
    code: `${provider}_competitor_extraction_failed`,
    message: error instanceof Error ? error.message : `Unknown ${provider} competitor extraction error.`,
    status: 502,
    keySuffix: provider === 'firecrawl' ? await getFirecrawlKeySuffix(userId).catch(() => '') : '',
  };
};

const persistCompletedCompetitor = async (options: {
  row: CompetitorRow;
  content: ExtractedCompetitorPayload;
  extractionProvider: string;
  keywordTargeting: FinalKeywordTargetingOutcome;
}): Promise<void> => {
  await updateCompetitor(options.row.id, {
    source_url: options.content.url,
    canonical_url: options.content.canonicalUrl,
    domain: options.content.domain,
    title: options.content.title,
    description: options.content.description,
    headings: options.content.headings,
    content_text: options.content.text,
    word_count: options.content.wordCount,
    status: 'completed',
    extraction_provider: options.extractionProvider,
    error_code: options.keywordTargeting.warningCode || null,
    error_message: options.keywordTargeting.warningMessage || null,
    fetched_at: options.content.fetchedAt || new Date().toISOString(),
  }, ['queued', 'extracting', 'retry_scheduled']);
  options.row.source_url = options.content.url;
  options.row.canonical_url = options.content.canonicalUrl;
  options.row.domain = options.content.domain;
  options.row.title = options.content.title;
  options.row.description = options.content.description;
  options.row.content_text = options.content.text;
  options.row.word_count = options.content.wordCount;
  options.row.extraction_provider = options.extractionProvider;
  options.row.status = 'completed';
};

const extractCompetitorCandidate = async (options: {
  context: ExternalAnalysisExecutionContext;
  row: CompetitorRow;
  snapshot: Record<string, unknown>;
  articleTargeting: ArticleTargetingContext;
  acceptedFingerprints: Set<string>;
  claimedUrls: Set<string>;
  claimedDomains: Set<string>;
  attempts: ExternalAnalysisJson[];
  currentAttempt: number;
  successfulCount: number;
  failedCount: number;
  total: number;
}): Promise<{ fingerprint: string } | { failure: ProviderFailureDetails; message: string }> => {
  const failures: Array<{ provider: string; details: ProviderFailureDetails }> = [];
  const recordFailure = async (
    provider: 'firecrawl' | 'programmatic' | 'browserless',
    model: string,
    error: unknown,
  ): Promise<ProviderFailureDetails> => {
    const details = await providerFailureDetails(
      error,
      provider,
      options.context.job.requested_by,
    );
    failures.push({ provider, details });
    options.attempts.push({
      requestIndex: options.row.position,
      outcome: 'failed',
      model,
      keySuffix: details.keySuffix,
      status: details.status,
      reason: details.code,
      attempt: options.currentAttempt,
      url: options.row.canonical_url,
    });
    return details;
  };
  const validateAndPersist = async (
    content: ExtractedCompetitorPayload,
    extractionProvider: string,
  ): Promise<string> => {
    const previousUrls = new Set([options.row.canonical_url, options.row.source_url].filter(Boolean));
    const previousDomain = options.row.domain;
    const nextUrls = [content.canonicalUrl, content.url].filter(Boolean);
    const nextDomain = content.domain.toLocaleLowerCase().replace(/^www\./, '');
    if (nextUrls.some(url => options.claimedUrls.has(url) && !previousUrls.has(url))) {
      throw new CompetitorContentUsabilityError(
        'competitor_duplicate_canonical_url',
        'The extracted page redirects to a competitor URL that is already used by another slot.',
      );
    }
    if (
      nextDomain
      && nextDomain !== options.row.domain
      && options.claimedDomains.has(nextDomain)
    ) {
      throw new CompetitorContentUsabilityError(
        'competitor_duplicate_domain',
        'The extracted page redirects to a competitor domain that is already used by another slot.',
      );
    }
    const fingerprint = assertUsableCompetitorContent({
      content,
      articleLanguage: options.articleTargeting.language,
      acceptedFingerprints: options.acceptedFingerprints,
    });
    const keywordTargeting = evaluateFinalKeywordTargeting({
      snapshot: options.snapshot,
      row: options.row,
      articleTargeting: options.articleTargeting,
      content: {
        ...content,
        qualityScore: 'qualityScore' in content ? Number(content.qualityScore) || 100 : 100,
        cacheHit: content.cacheHit,
      },
    });
    if (keywordTargeting.contentTooShort) {
      throw new CompetitorContentUsabilityError(
        'competitor_content_too_short',
        'The final extracted content is too short to preserve the approved competitor source.',
      );
    }
    await persistCompletedCompetitor({
      row: options.row,
      content,
      extractionProvider,
      keywordTargeting,
    });
    previousUrls.forEach(url => options.claimedUrls.delete(url));
    if (previousDomain && previousDomain !== nextDomain) {
      options.claimedDomains.delete(previousDomain);
    }
    nextUrls.forEach(url => options.claimedUrls.add(url));
    if (nextDomain) options.claimedDomains.add(nextDomain);
    return fingerprint;
  };

  await options.context.reportProgress({
    progress: {
      stage: 'extracting_competitor',
      current: options.row.position,
      total: options.total,
      competitorId: options.row.id,
      title: options.row.title,
      url: options.row.canonical_url,
      successfulCount: options.successfulCount,
      failedCount: options.failedCount,
    },
    provider: 'firecrawl',
    model: FIRECRAWL_MODEL,
    keyAttempts: options.attempts,
  });
  await updateCompetitor(options.row.id, {
    status: 'extracting',
    extraction_provider: 'firecrawl',
    error_code: null,
    error_message: null,
  }, ['queued', 'retry_scheduled', 'extracting']);
  try {
    const content = await getCompetitorPreview({
      url: options.row.canonical_url || options.row.source_url,
      signal: options.context.signal,
      userId: options.context.job.requested_by,
    });
    const fingerprint = await validateAndPersist(
      content,
      content.cacheHit ? 'firecrawl_cache' : 'firecrawl',
    );
    options.attempts.push({
      requestIndex: options.row.position,
      outcome: 'success',
      model: FIRECRAWL_MODEL,
      keySuffix: content.providerKeySuffix,
      status: 200,
      reason: content.cacheHit ? 'preview_cache_hit' : '',
      cacheHit: content.cacheHit,
      attempt: options.currentAttempt,
      url: options.row.canonical_url,
    });
    return { fingerprint };
  } catch (error) {
    if (options.context.signal.aborted) throw options.context.signal.reason ?? error;
    await recordFailure('firecrawl', FIRECRAWL_MODEL, error);
  }

  await updateCompetitor(options.row.id, {
    status: 'extracting',
    extraction_provider: 'programmatic_after_firecrawl',
    error_code: failures.at(-1)?.details.code || null,
    error_message: failures.at(-1)?.details.message.slice(0, 2_000) || null,
  }, ['extracting']);
  await options.context.reportProgress({
    progress: {
      stage: 'programmatic_fallback',
      current: options.row.position,
      total: options.total,
      competitorId: options.row.id,
      title: options.row.title,
      url: options.row.canonical_url,
      firecrawlErrorCode: failures[0]?.details.code,
      successfulCount: options.successfulCount,
      failedCount: options.failedCount,
    },
    provider: 'programmatic',
    model: PROGRAMMATIC_MODEL,
    keyAttempts: options.attempts,
  });
  try {
    const content = await getProgrammaticCompetitorContent({
      url: options.row.canonical_url || options.row.source_url,
      signal: options.context.signal,
    });
    const extractionProvider = content.cacheHit
      ? 'programmatic_after_firecrawl_cache'
      : 'programmatic_after_firecrawl';
    const fingerprint = await validateAndPersist(content, extractionProvider);
    options.attempts.push({
      requestIndex: options.row.position,
      outcome: 'success',
      model: PROGRAMMATIC_MODEL,
      keySuffix: '',
      status: 200,
      reason: content.cacheHit ? 'programmatic_cache_hit' : 'firecrawl_failed_programmatic_succeeded',
      cacheHit: content.cacheHit,
      attempt: options.currentAttempt,
      url: options.row.canonical_url,
    });
    return { fingerprint };
  } catch (error) {
    if (options.context.signal.aborted) throw options.context.signal.reason ?? error;
    await recordFailure('programmatic', PROGRAMMATIC_MODEL, error);
  }

  await updateCompetitor(options.row.id, {
    status: 'extracting',
    extraction_provider: 'browserless_after_firecrawl_programmatic',
    error_code: failures.at(-1)?.details.code || null,
    error_message: failures.at(-1)?.details.message.slice(0, 2_000) || null,
  }, ['extracting']);
  await options.context.reportProgress({
    progress: {
      stage: 'rendered_browser_fallback',
      current: options.row.position,
      total: options.total,
      competitorId: options.row.id,
      title: options.row.title,
      url: options.row.canonical_url,
      successfulCount: options.successfulCount,
      failedCount: options.failedCount,
    },
    provider: 'browserless',
    model: BROWSERLESS_MODEL,
    keyAttempts: options.attempts,
  });
  try {
    const content = await getBrowserlessCompetitorContent({
      url: options.row.canonical_url || options.row.source_url,
      signal: options.context.signal,
      userId: options.context.job.requested_by,
      timeoutMs: COMPETITOR_RENDERED_EXTRACTION_TIMEOUT_MS,
    });
    const fingerprint = await validateAndPersist(
      content,
      'browserless_after_firecrawl_programmatic',
    );
    options.attempts.push({
      requestIndex: options.row.position,
      outcome: 'success',
      model: BROWSERLESS_MODEL,
      keySuffix: '',
      status: 200,
      reason: 'firecrawl_programmatic_failed_browserless_succeeded',
      cacheHit: false,
      attempt: options.currentAttempt,
      url: options.row.canonical_url,
    });
    return { fingerprint };
  } catch (error) {
    if (options.context.signal.aborted) throw options.context.signal.reason ?? error;
    const finalFailure = await recordFailure('browserless', BROWSERLESS_MODEL, error);
    return {
      failure: finalFailure,
      message: failures.map(item => (
        `${item.provider} failed (${item.details.code}): ${item.details.message}`
      )).join(' '),
    };
  }
};

const executeCompetitorExtraction = async (
  context: ExternalAnalysisExecutionContext,
) => {
  await assertAutomaticCompetitorResearchAllowed(context.job);
  const [rows, articleTargeting] = await Promise.all([
    readCompetitors(context.job.article_id),
    readArticleTargetingContext(context.job.article_id),
  ]);
  const inputSnapshot = isRecord(context.job.input_snapshot)
    ? { ...context.job.input_snapshot }
    : {};
  if (rows.length === 0) {
    return {
      result: {
        status: 'completed',
        successfulCount: 0,
        failedCount: 0,
        competitors: [] as ExternalAnalysisJson[],
      },
      progress: { stage: 'completed', current: 0, total: 0 },
    };
  }

  const reserves = await loadReserveSources({ context, snapshot: inputSnapshot, rows });
  const attempts: ExternalAnalysisJson[] = [];
  const failures: CompetitorFailure[] = [];
  const replacements: CompetitorReplacement[] = [];
  const currentAttempt = Math.max(1, Number(context.job.attempt_count) || 1);
  const acceptedFingerprints = new Set(rows
    .filter(row => row.status === 'completed' && Boolean(row.content_text))
    .map(row => competitorContentFingerprint(row.content_text))
    .filter(Boolean));
  const claimedUrls = new Set(rows.flatMap(row => [row.canonical_url, row.source_url]).filter(Boolean));
  const claimedDomains = new Set(rows.map(row => row.domain).filter(Boolean));
  let successfulCount = rows.filter(row => row.status === 'completed').length;

  for (const row of rows) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error('Competitor extraction was cancelled.');
    }
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') continue;
    await assertAutomaticCompetitorResearchAllowed(context.job);
    let processed = false;
    while (!processed) {
      const extraction = await extractCompetitorCandidate({
        context,
        row,
        snapshot: inputSnapshot,
        articleTargeting,
        acceptedFingerprints,
        claimedUrls,
        claimedDomains,
        attempts,
        currentAttempt,
        successfulCount,
        failedCount: failures.length,
        total: rows.length,
      });
      if ('fingerprint' in extraction) {
        if (extraction.fingerprint) acceptedFingerprints.add(extraction.fingerprint);
        successfulCount += 1;
        processed = true;
      } else {
        const replacementAvailable = await promoteReserveSource({
          context,
          row,
          reserves,
          claimedUrls,
          claimedDomains,
          reasonCode: extraction.failure.code,
          replacements,
          successfulCount,
          failedCount: failures.length,
          total: rows.length,
        });
        if (replacementAvailable) continue;
        const failureMessage = extraction.message.slice(0, 2_000);
        failures.push({
          position: row.position,
          code: COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE,
          message: failureMessage,
          retryable: false,
          attempt: currentAttempt,
        });
        await updateCompetitor(row.id, {
          content_text: COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT,
          word_count: 0,
          status: 'failed',
          extraction_provider: 'firecrawl_programmatic_failed_browserless_failed',
          error_code: COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE,
          error_message: failureMessage,
          fetched_at: new Date().toISOString(),
        }, ['extracting', 'queued', 'retry_scheduled']);
        row.status = 'failed';
        row.error_code = COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE;
        row.error_message = failureMessage;
        processed = true;
      }
    }

    await context.reportProgress({
      progress: {
        stage: 'competitor_processed',
        current: row.position,
        total: rows.length,
        successfulCount,
        failedCount: failures.length,
        replacementCount: replacements.length,
      },
      provider: row.extraction_provider.startsWith('browserless')
        ? 'browserless'
        : row.extraction_provider.startsWith('programmatic')
          ? 'programmatic'
          : 'firecrawl',
      model: row.extraction_provider.startsWith('browserless')
        ? BROWSERLESS_MODEL
        : row.extraction_provider.startsWith('programmatic')
          ? PROGRAMMATIC_MODEL
          : FIRECRAWL_MODEL,
      keyAttempts: attempts,
    });
  }

  await syncArticleCompetitors(context.job.article_id);
  const finalRows = await readCompetitors(context.job.article_id);
  successfulCount = finalRows.filter(row => row.status === 'completed').length;
  const persistedFailures: CompetitorFailure[] = finalRows
    .filter(row => row.status === 'failed')
    .map(row => ({
      position: row.position,
      code: row.error_code || 'competitor_extraction_failed',
      message: row.error_message || 'Competitor extraction failed.',
      retryable: false,
      attempt: currentAttempt,
    }));
  return {
    result: {
      status: persistedFailures.length > 0 ? 'partial' : 'completed',
      successfulCount,
      failedCount: persistedFailures.length,
      failures: persistedFailures,
      replacements,
      extractionAttempts: attempts,
      competitors: finalRows.map(row => ({
        id: row.id,
        position: row.position,
        title: row.title,
        url: row.canonical_url,
        status: row.status,
        wordCount: row.word_count,
        contentStatus: row.status === 'completed' ? 'usable' : 'failed',
        extractionProvider: row.extraction_provider,
      })),
    },
    progress: {
      stage: persistedFailures.length > 0 ? 'completed_with_failures' : 'completed',
      current: rows.length,
      total: rows.length,
      successfulCount,
      failedCount: persistedFailures.length,
      replacementCount: replacements.length,
      maxAttempts: COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
    },
  };
};

registerExternalAnalysisJobExecutor('competitor_extraction', executeCompetitorExtraction);
