import {
  ExternalAnalysisTerminalError,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJob,
} from './externalAnalysisQueue';
import { readContentResearchAutomationSettings } from './externalAnalysisSettings';

const ACTIVE_SEMANTIC_STATUSES = [
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasTerms = (value: unknown): boolean => (
  Array.isArray(value)
  && value.some(item => typeof item === 'string' && item.trim().length > 0)
);

const stopAutomaticCompetitorResearch = (code: string, message: string): never => {
  throw new ExternalAnalysisTerminalError({ code, message });
};

/**
 * Rechecks automatic competitor policy in the worker immediately before an
 * external search or scrape. Database coordination owns ordering; this guard
 * closes the small commit race between a settings update and a queued worker.
 */
export const assertAutomaticCompetitorResearchAllowed = async (
  job: Pick<ExternalAnalysisJob, 'article_id' | 'origin'>,
): Promise<void> => {
  if (job.origin !== 'auto') return;

  const settings = await readContentResearchAutomationSettings();
  if (!settings.autoDiscoverCompetitors) {
    stopAutomaticCompetitorResearch(
      'competitor_automation_disabled',
      'Automatic competitor discovery is disabled in system settings.',
    );
  }

  const supabase = getExternalAnalysisSupabaseAdmin();
  const [articleResult, semanticResult] = await Promise.all([
    supabase
      .from('articles')
      .select('keywords')
      .eq('id', job.article_id)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_jobs')
      .select('id')
      .eq('article_id', job.article_id)
      .eq('job_type', 'semantic_keywords_lsi')
      .in('status', ACTIVE_SEMANTIC_STATUSES)
      .is('cancel_requested_at', null)
      .limit(1),
  ]);
  if (articleResult.error) throw articleResult.error;
  if (semanticResult.error) throw semanticResult.error;

  const keywords = isRecord(articleResult.data?.keywords)
    ? articleResult.data.keywords
    : {};
  const alternativesReady = hasTerms(keywords.secondaries);
  const lsiReady = hasTerms(keywords.lsi);
  const semanticActive = (semanticResult.data || []).length > 0;
  if (
    semanticActive
    || (settings.autoGenerateAlternativeKeywords && !alternativesReady)
    || (settings.autoGenerateLsiKeywords && !lsiReady)
  ) {
    stopAutomaticCompetitorResearch(
      'content_research_automation_changed',
      'Automatic competitor work is waiting for every enabled keyword stage.',
    );
  }
};
