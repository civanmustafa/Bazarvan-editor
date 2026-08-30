import { getSupabaseClient } from './supabaseClient';

export const INTERNAL_LINK_AUTOMATION_SETTINGS_CHANGED_EVENT =
  'bazarvan:internal-link-automation-settings-changed';

export type InternalLinkAutomationSettings = {
  autoApplyStrongInternalLinkSuggestions: boolean;
  canApplyToArticle: boolean;
};

const getAccessToken = async (): Promise<string> => {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('Supabase session is required.');
  }
  return data.session.access_token;
};

export const loadInternalLinkAutomationSettings = async (
  articleId: string,
): Promise<InternalLinkAutomationSettings> => {
  if (!articleId.trim()) throw new Error('Article id is required for internal-link automation.');
  const accessToken = await getAccessToken();
  const response = await fetch(`/api/internal-linking/settings?articleId=${encodeURIComponent(articleId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string'
      ? payload.error
      : `Internal-link settings request failed (${response.status}).`);
  }
  if (
    typeof payload.settings?.autoApplyStrongInternalLinkSuggestions !== 'boolean'
    || typeof payload.settings?.canApplyToArticle !== 'boolean'
  ) {
    throw new Error('Internal-link automation settings response is invalid.');
  }
  return {
    autoApplyStrongInternalLinkSuggestions:
      payload.settings.autoApplyStrongInternalLinkSuggestions,
    canApplyToArticle: payload.settings.canApplyToArticle,
  };
};

export const notifyInternalLinkAutomationSettingsChanged = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(INTERNAL_LINK_AUTOMATION_SETTINGS_CHANGED_EVENT));
};
