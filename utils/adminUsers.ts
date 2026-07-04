import { getSupabaseClient } from './supabaseClient';
import type { RemoteProfile } from './supabaseArticles';

export type CreateAdminUserInput = {
  email: string;
  password: string;
  fullName: string;
  role: 'admin' | 'user';
  isActive: boolean;
};

const getAccessToken = async (): Promise<string> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('Supabase session is required.');
  }
  return data.session.access_token;
};

export const createRemoteAdminUser = async (input: CreateAdminUserInput): Promise<RemoteProfile> => {
  const accessToken = await getAccessToken();
  const response = await fetch('/api/admin/users', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Create user failed (${response.status}).`);
  }

  const profile = payload.profile || {};
  return {
    id: String(profile.id || ''),
    email: typeof profile.email === 'string' ? profile.email : null,
    fullName: typeof profile.full_name === 'string' ? profile.full_name : null,
    role: profile.role === 'admin' ? 'admin' : 'user',
    isActive: profile.is_active !== false,
    createdAt: typeof profile.created_at === 'string' ? profile.created_at : new Date().toISOString(),
    lastSeenAt: typeof profile.last_seen_at === 'string' ? profile.last_seen_at : null,
  };
};
