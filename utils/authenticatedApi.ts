import { getSupabaseClient } from './supabaseClient';

export const getAuthenticatedApiToken = async (): Promise<string> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token?.trim() || '';
  if (error || !accessToken) {
    throw new Error('Your session has expired. Sign in again before using AI tools.');
  }
  return accessToken;
};

export const getAuthenticatedApiHeaders = (
  accessToken: string,
  headers: HeadersInit = {},
): Headers => {
  const result = new Headers(headers);
  result.set('Authorization', `Bearer ${accessToken}`);
  return result;
};
