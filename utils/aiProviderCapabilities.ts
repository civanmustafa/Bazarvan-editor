import {
  normalizeAiProviderCapabilities,
  type AiProviderCapabilities,
} from '../constants/aiProviderCapabilities';
import { getSupabaseClient } from './supabaseClient';

export const AI_PROVIDER_CAPABILITIES_CHANGED_EVENT = 'bazarvan:ai-provider-capabilities-changed';

const getAccessToken = async (): Promise<string> => {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('Supabase session is required.');
  }
  return data.session.access_token;
};

export const loadAiProviderCapabilities = async (): Promise<AiProviderCapabilities> => {
  const accessToken = await getAccessToken();
  const response = await fetch('/api/ai/capabilities', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string'
      ? payload.error
      : `AI capabilities request failed (${response.status}).`);
  }
  return normalizeAiProviderCapabilities(payload.capabilities);
};

export const notifyAiProviderCapabilitiesChanged = (): void => {
  window.dispatchEvent(new Event(AI_PROVIDER_CAPABILITIES_CHANGED_EVENT));
};
