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

const readCurrentEngineeringJobOrigin = async (
  jobId: string,
): Promise<ExternalAnalysisJob['origin'] | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs')
    .select('origin')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;

  const origin = data?.origin;
  return origin === 'manual' || origin === 'auto' ? origin : null;
};

/**
 * Rechecks the ready-command switch at execution time. The database trigger is
 * the primary coordinator; this closes the small race where a worker claimed
 * an automatic task immediately before the administrator disabled it.
 */
export const assertAutomaticReadyEngineeringCommandsAllowed = async (
  job: Pick<ExternalAnalysisJob, 'id' | 'origin'>,
): Promise<void> => {
  if (job.origin !== 'auto') return;

  const currentOrigin = await readCurrentEngineeringJobOrigin(job.id);
  if (currentOrigin === 'manual') {
    job.origin = 'manual';
    return;
  }

  const settings = await readContentResearchAutomationSettings();
  if (settings.autoRunReadyEngineeringCommands) return;

  const latestOrigin = await readCurrentEngineeringJobOrigin(job.id);
  if (latestOrigin === 'manual') {
    job.origin = 'manual';
    return;
  }

  throw new ExternalAnalysisTerminalError({
    code: 'ready_engineering_commands_automation_disabled',
    message: 'Automatic ready engineering commands are disabled in system settings.',
  });
};

/**
 * Rechecks automatic competitor policy in the worker immediately before an
 * external search or scrape. Database coordination owns ordering; this guard
 * closes the small commit race between a settings update and a queued worker.
 */
export const assertAutomaticCompetitorResearchAllowed = async (
  job: Pick<ExternalAnalysisJob, 'article_id' | 'job_type' | 'origin'>,
): Promise<void> => {
  if (job.origin !== 'auto') return;

  const settings = await readContentResearchAutomationSettings();
  if (!settings.autoDiscoverCompetitors) {
    stopAutomaticCompetitorResearch(
      'competitor_automation_disabled',
      'Automatic competitor discovery is disabled in system settings.',
    );
  }
  if (job.job_type === 'competitor_extraction' && !settings.autoExtractCompetitorContent) {
    stopAutomaticCompetitorResearch(
      'competitor_content_extraction_automation_disabled',
      'Automatic competitor content extraction is disabled in system settings.',
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
