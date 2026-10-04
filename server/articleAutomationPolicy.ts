import {
  normalizeUserAutomationPreferences,
  USER_AUTOMATION_BOOLEAN_KEYS,
  type UserAutomationPreferences,
} from '../constants/userAutomation';
import { getExternalAnalysisSupabaseAdmin, type ExternalAnalysisJob } from './externalAnalysisQueue';
import { ExternalAnalysisTerminalError } from './externalAnalysisExecutor';
import {
  ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  isArticleWritingMode,
  type ArticleWritingMode,
} from '../constants/articleAutomationOverrides';

export type ArticleAutomationPolicy = UserAutomationPreferences & {
  scope: 'creator' | 'legacy';
  creatorUserId: string | null;
  policyVersion: number;
  articleOverrideVersion: number;
  articleWritingMode: ArticleWritingMode;
  disabledCapabilities: string[];
  excludedExternalCommandIds: string[];
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
  return {
    ...normalized,
    scope: policy.scope,
    creatorUserId,
    policyVersion: policy.policyVersion as number,
    articleOverrideVersion: Math.max(0, Number(policy.articleOverrideVersion) || 0),
    articleWritingMode: isArticleWritingMode(policy.articleWritingMode)
      ? policy.articleWritingMode
      : ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS.writingMode,
    disabledCapabilities: Array.isArray(policy.disabledCapabilities)
      ? policy.disabledCapabilities.filter((item): item is string => typeof item === 'string')
      : [],
    excludedExternalCommandIds: Array.isArray(policy.excludedExternalCommandIds)
      ? policy.excludedExternalCommandIds.filter((item): item is string => typeof item === 'string')
      : [],
  };
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
  if (policy.scope === 'legacy' && policy.articleOverrideVersion === 0) return true;
  if (!policy.enabled || (policy.scope === 'creator' && (!policy.creatorUserId || job.requested_by !== policy.creatorUserId))) return false;
  switch (job.job_type) {
    case 'duplicate_cleanup': return policy.enabled;
    case 'semantic_keywords_lsi':
      return policy.autoGenerateAlternativeKeywords || policy.autoGenerateLsiKeywords || policy.autoGenerateGoogleMetadata;
    case 'competitor_discovery': return policy.autoDiscoverCompetitors;
    case 'competitor_extraction': return policy.autoExtractCompetitorContent;
    case 'engineering_command':
      return policy.autoRunReadyEngineeringCommands && policy.externalAnalysisCommandIds.includes(job.command_id || '');
    case 'content_writing_preparation':
      return policy.contentWritingAutomationEnabled
        && (!policy.articleWritingMode || policy.articleWritingMode === 'strict');
    default: return false;
  }
};

export const automaticJobMayFinishCurrentRun = (
  job: Pick<ExternalAnalysisJob, 'origin' | 'input_snapshot'>,
): boolean => job.origin === 'auto'
  && job.input_snapshot?.automationOverrideDisposition === 'finish_current';

/** Preserve explicit manual promotions; all other automatic work uses the immutable creator. */
export const assertAutomaticArticlePolicy = async (job: ExternalAnalysisJob): Promise<void> => {
  if (job.origin !== 'auto') return;
  if (automaticJobMayFinishCurrentRun(job)) return;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs').select('origin,requested_by,input_snapshot').eq('id', job.id).maybeSingle();
  if (error) throw error;
  if (data?.origin === 'manual') {
    job.origin = 'manual';
    job.requested_by = data.requested_by;
    return;
  }
  if (data?.input_snapshot && typeof data.input_snapshot === 'object' && !Array.isArray(data.input_snapshot)) {
    job.input_snapshot = data.input_snapshot as Record<string, unknown>;
    if (automaticJobMayFinishCurrentRun(job)) return;
  }
  const policy = await readArticleAutomationPolicy(job.article_id);
  if (!automaticJobAllowedByPolicy(job, policy)) {
    throw new ExternalAnalysisTerminalError({
      code: 'creator_automation_disabled',
      message: 'This automatic operation is disabled by the original article creator or administrator.',
    });
  }
};
