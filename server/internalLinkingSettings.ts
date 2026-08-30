import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readArticleAutomationPolicy } from './articleAutomationPolicy';

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
  const accessResult = await admin.rpc('article_access_level_for_user', {
      target_article_id: input.articleId,
      target_user_id: input.userId,
    });
  if (accessResult.error) throw accessResult.error;
  const canApplyToArticle = accessResult.data === 'write' || accessResult.data === 'admin';
  if (!canApplyToArticle) return { canApplyToArticle: false, autoApplyStrongInternalLinkSuggestions: false };
  const policy = await readArticleAutomationPolicy(input.articleId);
  return {
    autoApplyStrongInternalLinkSuggestions: policy.autoApplyStrongInternalLinkSuggestions,
    canApplyToArticle,
  };
};
