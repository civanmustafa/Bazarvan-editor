import {
  FirecrawlCompetitorError,
  getFirecrawlCredentialSummary,
} from './firecrawlCompetitorService';
import { COMPETITOR_EXTRACTION_MAX_ATTEMPTS } from '../constants/competitors';
import { getCompetitorPreview } from './competitorPreviewCache';
import {
  getProgrammaticCompetitorContent,
  ProgrammaticCompetitorExtractionError,
} from './programmaticCompetitorExtractor';
import {
  COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE,
  COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT,
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

/**
 * Architecture boundary:
 * - Firecrawl gets exactly one attempt per URL.
 * - A failed Firecrawl request falls back immediately to the deterministic programmatic
 *   extractor. This fallback never invokes Gemini/OpenAI and never schedules Firecrawl again.
 * - It must persist the full text in article_competitors.content_text, then synchronize that
 *   text into the article competitor attachment consumed by analysis and content writing.
 * - If both methods fail, the canonical editor field receives the shared failure marker.
 *   Failed rows stay excluded from persisted analysis attachments until the user replaces
 *   that marker with manual text, which the authenticated API promotes to a completed row.
 */
type CompetitorRow = {
  id: string;
  article_id: string;
  position: number;
  canonical_url: string;
  source_url: string;
  title: string;
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

const FIRECRAWL_MODEL = 'v2/scrape';
const PROGRAMMATIC_MODEL = 'deterministic-main-content';

const getFirecrawlKeySuffix = async (): Promise<string> => {
  const summary = await getFirecrawlCredentialSummary();
  return summary.keySuffix;
};

const readCompetitors = async (articleId: string): Promise<CompetitorRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .select('id,article_id,position,canonical_url,source_url,title,status,error_code,error_message')
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

const readArticleTargetingContext = async (articleId: string): Promise<{
  language: 'ar' | 'en';
  primaryKeyword: string;
  alternativeKeywords: string[];
}> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('article_language,keywords')
    .eq('id', articleId)
    .single();
  if (error) throw error;
  const keywords = isRecord(data?.keywords) ? data.keywords : {};
  return {
    language: data?.article_language === 'en' ? 'en' : 'ar',
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

const executeCompetitorExtraction = async (
  context: ExternalAnalysisExecutionContext,
) => {
  await assertAutomaticCompetitorResearchAllowed(context.job);
  const [rows, articleTargeting] = await Promise.all([
    readCompetitors(context.job.article_id),
    readArticleTargetingContext(context.job.article_id),
  ]);
  const articleLanguage = articleTargeting.language;
  const inputSnapshot = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
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

  const attempts: ExternalAnalysisJson[] = [];
  const failures: CompetitorFailure[] = [];
  const currentAttempt = Math.max(1, Number(context.job.attempt_count) || 1);
  let successfulCount = rows.filter(row => row.status === 'completed').length;

  for (const row of rows) {
    if (context.signal.aborted) throw context.signal.reason ?? new Error('Competitor extraction was cancelled.');
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') continue;
    await assertAutomaticCompetitorResearchAllowed(context.job);

    await context.reportProgress({
      progress: {
        stage: 'extracting_competitor',
        current: row.position,
        total: rows.length,
        competitorId: row.id,
        title: row.title,
        url: row.canonical_url,
        successfulCount,
        failedCount: failures.length,
      },
      provider: 'firecrawl',
      model: FIRECRAWL_MODEL,
      keyAttempts: attempts,
    });
    await updateCompetitor(row.id, {
      status: 'extracting',
      extraction_provider: 'firecrawl',
      error_code: null,
      error_message: null,
    }, ['queued', 'retry_scheduled', 'extracting']);

    try {
      const content = await getCompetitorPreview({
        url: row.canonical_url || row.source_url,
        signal: context.signal,
        userId: context.job.requested_by,
      });
      if (requiresKeywordTargeting(inputSnapshot, row)) {
        const targeting = analyzeCompetitorKeywordTargeting({
          content: {
            ...content,
            qualityScore: 100,
            cacheHit: content.cacheHit,
          },
          primaryKeyword: articleTargeting.primaryKeyword,
          alternativeKeywords: articleTargeting.alternativeKeywords,
        });
        if (targeting.status !== 'qualified') {
          throw new FirecrawlCompetitorError({
            message: 'The final Firecrawl content did not contain the primary keyword or an approved alternative.',
            status: 422,
            code: 'competitor_keyword_not_targeted',
            retryable: false,
          });
        }
      }
      if (articleLanguage === 'ar' && !isCompetitorLanguageCompatible('ar', content.text)) {
        const message = 'The extracted competitor page is Latin-language content and was excluded from the Arabic article.';
        attempts.push({
          requestIndex: row.position,
          outcome: 'failed',
          model: FIRECRAWL_MODEL,
          keySuffix: content.providerKeySuffix,
          status: 422,
          reason: 'competitor_language_mismatch',
          cacheHit: content.cacheHit,
          attempt: currentAttempt,
        });
        failures.push({
          position: row.position,
          code: 'competitor_language_mismatch',
          message,
          retryable: false,
          attempt: currentAttempt,
        });
        await updateCompetitor(row.id, {
          content_text: '',
          word_count: 0,
          status: 'failed',
          extraction_provider: content.cacheHit ? 'firecrawl_cache' : 'firecrawl',
          error_code: 'competitor_language_mismatch',
          error_message: message,
          fetched_at: new Date().toISOString(),
        }, ['queued', 'extracting', 'retry_scheduled']);
      } else {
        attempts.push({
          requestIndex: row.position,
          outcome: 'success',
          model: FIRECRAWL_MODEL,
          keySuffix: content.providerKeySuffix,
          status: 200,
          reason: content.cacheHit ? 'preview_cache_hit' : '',
          cacheHit: content.cacheHit,
          attempt: context.job.attempt_count,
        });
        await updateCompetitor(row.id, {
          source_url: content.url,
          canonical_url: content.canonicalUrl,
          domain: content.domain,
          title: content.title,
          description: content.description,
          headings: content.headings,
          content_text: content.text,
          word_count: content.wordCount,
          status: 'completed',
          extraction_provider: content.cacheHit ? 'firecrawl_cache' : 'firecrawl',
          error_code: null,
          error_message: null,
          fetched_at: new Date().toISOString(),
        }, ['queued', 'extracting', 'retry_scheduled']);
        successfulCount += 1;
      }
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      const firecrawlError = error instanceof FirecrawlCompetitorError
        ? error
        : new FirecrawlCompetitorError({
            message: error instanceof Error ? error.message : 'Unknown competitor extraction error.',
            status: 502,
            code: 'competitor_extraction_failed',
            retryable: false,
          });
      attempts.push({
        requestIndex: row.position,
        outcome: 'failed',
        model: FIRECRAWL_MODEL,
        keySuffix: firecrawlError.keySuffix || await getFirecrawlKeySuffix(),
        status: firecrawlError.status,
        reason: firecrawlError.code,
        attempt: currentAttempt,
      });

      await updateCompetitor(row.id, {
        status: 'extracting',
        extraction_provider: 'programmatic_after_firecrawl',
        error_code: firecrawlError.code,
        error_message: firecrawlError.message.slice(0, 2_000),
      }, ['queued', 'extracting', 'retry_scheduled']);
      await context.reportProgress({
        progress: {
          stage: 'programmatic_fallback',
          current: row.position,
          total: rows.length,
          competitorId: row.id,
          title: row.title,
          url: row.canonical_url,
          firecrawlErrorCode: firecrawlError.code,
          successfulCount,
          failedCount: failures.length,
        },
        provider: 'programmatic',
        model: PROGRAMMATIC_MODEL,
        keyAttempts: attempts,
      });

      try {
        const content = await getProgrammaticCompetitorContent({
          url: row.canonical_url || row.source_url,
          signal: context.signal,
        });
        if (requiresKeywordTargeting(inputSnapshot, row)) {
          const targeting = analyzeCompetitorKeywordTargeting({
            content,
            primaryKeyword: articleTargeting.primaryKeyword,
            alternativeKeywords: articleTargeting.alternativeKeywords,
          });
          if (targeting.status !== 'qualified') {
            throw new ProgrammaticCompetitorExtractionError({
              message: 'The final page content did not contain the primary keyword or an approved alternative.',
              status: 422,
              code: 'competitor_keyword_not_targeted',
              retryable: false,
            });
          }
        }
        if (articleLanguage === 'ar' && !isCompetitorLanguageCompatible('ar', content.text)) {
          const message = 'The extracted competitor page is Latin-language content and was excluded from the Arabic article.';
          attempts.push({
            requestIndex: row.position,
            outcome: 'failed',
            model: PROGRAMMATIC_MODEL,
            keySuffix: '',
            status: 422,
            reason: 'competitor_language_mismatch',
            cacheHit: content.cacheHit,
            attempt: currentAttempt,
          });
          failures.push({
            position: row.position,
            code: 'competitor_language_mismatch',
            message,
            retryable: false,
            attempt: currentAttempt,
          });
          await updateCompetitor(row.id, {
            content_text: '',
            word_count: 0,
            status: 'failed',
            extraction_provider: content.cacheHit
              ? 'programmatic_after_firecrawl_cache'
              : 'programmatic_after_firecrawl',
            error_code: 'competitor_language_mismatch',
            error_message: message,
            fetched_at: new Date().toISOString(),
          }, ['extracting']);
        } else {
          attempts.push({
            requestIndex: row.position,
            outcome: 'success',
            model: PROGRAMMATIC_MODEL,
            keySuffix: '',
            status: 200,
            reason: content.cacheHit ? 'programmatic_cache_hit' : 'firecrawl_failed_programmatic_succeeded',
            cacheHit: content.cacheHit,
            attempt: currentAttempt,
          });
          await updateCompetitor(row.id, {
            source_url: content.url,
            canonical_url: content.canonicalUrl,
            domain: content.domain,
            title: content.title,
            description: content.description,
            headings: content.headings,
            content_text: content.text,
            word_count: content.wordCount,
            status: 'completed',
            extraction_provider: content.cacheHit
              ? 'programmatic_after_firecrawl_cache'
              : 'programmatic_after_firecrawl',
            error_code: null,
            error_message: null,
            fetched_at: new Date().toISOString(),
          }, ['extracting']);
          successfulCount += 1;
        }
      } catch (programmaticError) {
        if (context.signal.aborted) throw context.signal.reason ?? programmaticError;
        const normalizedProgrammaticError = programmaticError instanceof ProgrammaticCompetitorExtractionError
          ? programmaticError
          : new ProgrammaticCompetitorExtractionError({
              message: programmaticError instanceof Error
                ? programmaticError.message
                : 'Unknown programmatic competitor extraction error.',
              status: 502,
              code: 'programmatic_extraction_failed',
              retryable: false,
            });
        const keywordTargetingFailed = firecrawlError.code === 'competitor_keyword_not_targeted'
          && normalizedProgrammaticError.code === 'competitor_keyword_not_targeted';
        const failureCode = keywordTargetingFailed
          ? 'competitor_keyword_not_targeted'
          : COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE;
        const failureMessage = keywordTargetingFailed
          ? 'The competitor page no longer targets the primary keyword or an approved alternative in its final content.'
          : [
              `Firecrawl failed (${firecrawlError.code}): ${firecrawlError.message}`,
              `Programmatic extraction failed (${normalizedProgrammaticError.code}): ${normalizedProgrammaticError.message}`,
            ].join(' ');
        failures.push({
          position: row.position,
          code: failureCode,
          message: failureMessage,
          retryable: false,
          attempt: currentAttempt,
        });
        attempts.push({
          requestIndex: row.position,
          outcome: 'failed',
          model: PROGRAMMATIC_MODEL,
          keySuffix: '',
          status: normalizedProgrammaticError.status,
          reason: normalizedProgrammaticError.code,
          attempt: currentAttempt,
        });
        await updateCompetitor(row.id, {
          content_text: COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT,
          word_count: 0,
          status: 'failed',
          extraction_provider: 'firecrawl_programmatic_failed',
          error_code: failureCode,
          error_message: failureMessage.slice(0, 2_000),
          fetched_at: new Date().toISOString(),
        }, ['extracting']);
      }
    }

    await context.reportProgress({
      progress: {
        stage: 'competitor_processed',
        current: row.position,
        total: rows.length,
        successfulCount,
        failedCount: failures.length,
      },
      provider: 'firecrawl',
      model: FIRECRAWL_MODEL,
      keyAttempts: attempts,
    });
  }

  // Completed Firecrawl/programmatic sources are synchronized. Terminal failure markers
  // remain only on failed rows and are intentionally omitted by the database merge function.
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
      competitors: finalRows.map(row => ({
        id: row.id,
        position: row.position,
        title: row.title,
        url: row.canonical_url,
        status: row.status,
      })),
    },
    progress: {
      stage: persistedFailures.length > 0 ? 'completed_with_failures' : 'completed',
      current: rows.length,
      total: rows.length,
      successfulCount,
      failedCount: persistedFailures.length,
      maxAttempts: COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
    },
  };
};

registerExternalAnalysisJobExecutor('competitor_extraction', executeCompetitorExtraction);
