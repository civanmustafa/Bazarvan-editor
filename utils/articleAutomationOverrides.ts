import {
  normalizeArticleAutomationOverrides,
  type ArticleAutomationOverrides,
} from '../constants/articleAutomationOverrides';
import { getSupabaseClient } from './supabaseClient';

type ArticleAutomationOverridesResponse = {
  overrides: ArticleAutomationOverrides;
  effectivePolicy: Record<string, unknown>;
};

const request = async (
  articleId: string,
  overrides?: ArticleAutomationOverrides,
): Promise<ArticleAutomationOverridesResponse> => {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error || !data.session?.access_token) throw error || new Error('يجب تسجيل الدخول.');
  const response = await fetch(
    overrides
      ? '/api/articles/automation-overrides'
      : `/api/articles/automation-overrides?articleId=${encodeURIComponent(articleId)}`,
    {
      method: overrides ? 'PUT' : 'GET',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        ...(overrides ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
      body: overrides ? (() => {
        const normalized = normalizeArticleAutomationOverrides(overrides);
        return JSON.stringify({
          articleId,
          disabledCapabilities: normalized.disabledCapabilities,
          writingMode: normalized.writingMode,
          excludedExternalCommandIds: normalized.excludedExternalCommandIds,
          reason: normalized.reason,
        });
      })() : undefined,
    },
  );
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string'
      ? payload.error
      : `تعذر حفظ استثناءات الأتمتة (${response.status}).`);
  }
  return {
    overrides: normalizeArticleAutomationOverrides(payload?.overrides),
    effectivePolicy: payload?.effectivePolicy && typeof payload.effectivePolicy === 'object'
      ? payload.effectivePolicy as Record<string, unknown>
      : {},
  };
};

export const loadArticleAutomationOverrides = (articleId: string) => request(articleId);
export const updateArticleAutomationOverrides = (
  articleId: string,
  overrides: ArticleAutomationOverrides,
) => request(articleId, overrides);
