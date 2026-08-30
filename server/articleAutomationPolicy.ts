import {
  normalizeUserAutomationPreferences,
  USER_AUTOMATION_BOOLEAN_KEYS,
  type UserAutomationPreferences,
} from '../constants/userAutomation';
import { getExternalAnalysisSupabaseAdmin, type ExternalAnalysisJob } from './externalAnalysisQueue';
import { ExternalAnalysisTerminalError } from './externalAnalysisExecutor';

export type ArticleAutomationPolicy = UserAutomationPreferences & {
  scope: 'creator' | 'legacy';
  creatorUserId: string | null;
  policyVersion: number;
};

// Missing schema or malformed policy must never silently enable automatic spending.
export const parseArticleAutomationPolicy = (value: unknown): ArticleAutomationPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Article automation policy is unavailable. Apply the creator automation migration.');
  }
  const policy = value as Record<string, unknown>;
  if ((policy.scope !== 'creator' && policy.scope !== 'legacy')
    || !USER_AUTOMATION_BOOLEAN_KEYS.every(key => typeof policy[key] === 'boolean')
    || !Array.isArray(policy.externalAnalysisCommandIds)
    || policy.policyVersion !== (policy.scope === 'creator' ? 1 : 0)) {
    throw new Error('Article automation policy response is invalid.');
  }
  const normalized = normalizeUserAutomationPreferences(policy);
  const creatorUserId = typeof policy.creatorUserId === 'string' ? policy.creatorUserId : null;
  if (!normalized.enabled || (policy.scope === 'creator' && !creatorUserId)) {
    for (const key of USER_AUTOMATION_BOOLEAN_KEYS) normalized[key] = false;
  }
  return { ...normalized, scope: policy.scope, creatorUserId, policyVersion: policy.policyVersion as number };
};

export const readArticleAutomationPolicy = async (articleId: string): Promise<ArticleAutomationPolicy> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc('article_automation_policy', {
    p_article_id: articleId,
  });
  if (error) throw new Error(`Could not read article automation policy (${error.code || 'database_error'}).`);
  return parseArticleAutomationPolicy(data);
};

export const automaticJobAllowedByPolicy = (
  job: Pick<ExternalAnalysisJob, 'job_type' | 'command_id' | 'requested_by'>,
  policy: ArticleAutomationPolicy,
): boolean => {
  if (policy.scope === 'legacy') return true;
  if (!policy.enabled || !policy.creatorUserId || job.requested_by !== policy.creatorUserId) return false;
  switch (job.job_type) {
    case 'semantic_keywords_lsi':
      return policy.autoGenerateAlternativeKeywords || policy.autoGenerateLsiKeywords || policy.autoGenerateGoogleMetadata;
    case 'competitor_discovery': return policy.autoDiscoverCompetitors;
    case 'competitor_extraction': return policy.autoExtractCompetitorContent;
    case 'engineering_command':
      return policy.autoRunReadyEngineeringCommands && policy.externalAnalysisCommandIds.includes(job.command_id || '');
    case 'content_writing_preparation': return policy.contentWritingAutomationEnabled;
    default: return false;
  }
};

/** Preserve explicit manual promotions; all other automatic work uses the immutable creator. */
export const assertAutomaticArticlePolicy = async (job: ExternalAnalysisJob): Promise<void> => {
  if (job.origin !== 'auto') return;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs').select('origin,requested_by').eq('id', job.id).maybeSingle();
  if (error) throw error;
  if (data?.origin === 'manual') {
    job.origin = 'manual';
    job.requested_by = data.requested_by;
    return;
  }
  const policy = await readArticleAutomationPolicy(job.article_id);
  if (!automaticJobAllowedByPolicy(job, policy)) {
    throw new ExternalAnalysisTerminalError({
      code: 'creator_automation_disabled',
      message: 'This automatic operation is disabled by the original article creator or administrator.',
    });
  }
};
