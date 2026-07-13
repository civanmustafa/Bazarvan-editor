import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

export type ArticleAccessLevel = 'none' | 'read' | 'write' | 'admin';

export class ArticleAccessPolicyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ArticleAccessPolicyError';
    this.status = status;
  }
}

const isArticleAccessLevel = (value: unknown): value is ArticleAccessLevel => (
  value === 'none' || value === 'read' || value === 'write' || value === 'admin'
);

export const getArticleAccessLevelForUser = async (
  supabase: SupabaseAdmin,
  articleId: string,
  userId: string,
): Promise<ArticleAccessLevel> => {
  const { data, error } = await supabase.rpc('article_access_level_for_user', {
    target_article_id: articleId,
    target_user_id: userId,
  });

  if (error) {
    console.error('Could not evaluate the canonical article access policy:', {
      articleId,
      userId,
      code: error.code,
    });
    throw new ArticleAccessPolicyError('Article authorization service is unavailable.', 503);
  }

  return isArticleAccessLevel(data) ? data : 'none';
};

export const requireArticleWriteAccess = async (
  supabase: SupabaseAdmin,
  articleId: string,
  userId: string,
): Promise<'write' | 'admin'> => {
  const level = await getArticleAccessLevelForUser(supabase, articleId, userId);
  if (level !== 'write' && level !== 'admin') {
    throw new ArticleAccessPolicyError('You do not have permission to modify this article.', 403);
  }
  return level;
};
