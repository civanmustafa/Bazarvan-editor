import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

export type InternalLinkAutomationSettings = {
  autoApplyStrongInternalLinkSuggestions: boolean;
  canApplyToArticle: boolean;
};

let supabaseAdmin: SupabaseAdmin | null = null;

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  if (supabaseAdmin) return supabaseAdmin;
  const supabaseUrl = normalizeProjectUrl(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
  );
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Internal-link runtime settings service is not configured.');
  }
  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
};

export const readInternalLinkAutomationSettings = async (input: {
  articleId: string;
  userId: string;
}): Promise<InternalLinkAutomationSettings> => {
  const admin = getSupabaseAdmin();
  const [{ data, error }, accessResult] = await Promise.all([
    admin
    .from('app_settings')
    .select('value')
    .eq('key', 'system')
    .eq('is_secret', false)
    .maybeSingle(),
    admin.rpc('article_access_level_for_user', {
      target_article_id: input.articleId,
      target_user_id: input.userId,
    }),
  ]);
  if (error && error.code !== '42P01') throw error;
  if (accessResult.error) throw accessResult.error;

  const normalized = normalizeSystemSettingsMap({
    system: data?.value && typeof data.value === 'object' ? data.value : {},
  });
  return {
    autoApplyStrongInternalLinkSuggestions:
      normalized.system.autoApplyStrongInternalLinkSuggestions !== false,
    canApplyToArticle: accessResult.data === 'write' || accessResult.data === 'admin',
  };
};
