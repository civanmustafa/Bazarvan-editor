import {
  ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  normalizeArticleAutomationOverrideImpact,
  normalizeArticleAutomationOverrides,
  type ArticleAutomationOverrideImpact,
  type ArticleAutomationOverrides,
  type ArticleAutomationRunningBehavior,
} from '../constants/articleAutomationOverrides';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

const toIsoString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

export const readArticleAutomationOverrides = async (
  articleId: string,
): Promise<ArticleAutomationOverrides> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_automation_overrides')
    .select('disabled_capabilities,writing_mode,excluded_external_command_ids,reason,revision,updated_at,updated_by')
    .eq('article_id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS };
  return normalizeArticleAutomationOverrides({
    disabledCapabilities: data.disabled_capabilities,
    writingMode: data.writing_mode,
    excludedExternalCommandIds: data.excluded_external_command_ids,
    reason: data.reason,
    revision: data.revision,
    updatedAt: toIsoString(data.updated_at),
    updatedBy: typeof data.updated_by === 'string' ? data.updated_by : null,
  });
};

export const saveArticleAutomationOverrides = async (input: {
  articleId: string;
  userId: string;
  overrides: ArticleAutomationOverrides;
  runningBehavior: ArticleAutomationRunningBehavior;
}): Promise<{ overrides: ArticleAutomationOverrides; impact: ArticleAutomationOverrideImpact }> => {
  const normalized = normalizeArticleAutomationOverrides(input.overrides);
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'save_article_automation_overrides_v2',
    {
      p_article_id: input.articleId,
      p_updated_by: input.userId,
      p_disabled_capabilities: normalized.disabledCapabilities,
      p_writing_mode: normalized.writingMode,
      p_excluded_external_command_ids: normalized.excludedExternalCommandIds,
      p_reason: normalized.reason || null,
      p_running_behavior: input.runningBehavior,
    },
  );
  if (error) throw error;
  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  return {
    overrides: normalizeArticleAutomationOverrides(payload.overrides || payload),
    impact: normalizeArticleAutomationOverrideImpact(payload.impact),
  };
};
