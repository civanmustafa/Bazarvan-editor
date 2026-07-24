import {
  normalizePromptRegistrySettings,
  type PromptRegistrySettings,
} from '../constants/promptRegistry';
import { getSupabaseClient } from './supabaseClient';

export const PROMPT_REGISTRY_CHANGED_EVENT = 'bazarvan:prompt-registry-changed';

const getAccessToken = async (): Promise<string> => {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('Supabase session is required.');
  }
  return data.session.access_token;
};

export const loadPromptRegistry = async (): Promise<PromptRegistrySettings> => {
  const accessToken = await getAccessToken();
  const response = await fetch('/api/ai/prompt-registry', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string'
      ? payload.error
      : `Prompt registry request failed (${response.status}).`);
  }
  return normalizePromptRegistrySettings(payload.registry);
};

export const notifyPromptRegistryChanged = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROMPT_REGISTRY_CHANGED_EVENT));
};
