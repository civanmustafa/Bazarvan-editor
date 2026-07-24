import { getSupabaseClient } from './supabaseClient';

export type ArticleClientContext = {
  articleId: string;
  clientId: string;
  currentPageUrl: string;
  selectedBy: string | null;
  updatedAt: string;
};

const asText = (value: unknown): string => typeof value === 'string' ? value : '';

const throwIfError = (error: any): void => {
  if (error) throw new Error(error.message || 'تعذر حفظ عميل المقالة.');
};

export const loadArticleClientContext = async (
  articleId: string,
): Promise<ArticleClientContext | null> => {
  const { data, error } = await getSupabaseClient()
    .from('article_client_contexts')
    .select('article_id,client_id,current_page_url,selected_by,updated_at')
    .eq('article_id', articleId)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  return {
    articleId: asText(data.article_id),
    clientId: asText(data.client_id),
    currentPageUrl: asText(data.current_page_url),
    selectedBy: typeof data.selected_by === 'string' ? data.selected_by : null,
    updatedAt: asText(data.updated_at),
  };
};

export const saveArticleClientContext = async (
  articleId: string,
  clientId: string,
  currentPageUrl = '',
): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('article_client_contexts')
    .upsert({
      article_id: articleId,
      client_id: clientId,
      current_page_url: currentPageUrl.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'article_id' });
  throwIfError(error);
};

export const saveArticleClientSelection = async (
  articleId: string,
  clientId: string,
): Promise<void> => {
  const normalizedArticleId = articleId.trim();
  const normalizedClientId = clientId.trim();
  if (!normalizedArticleId || !normalizedClientId) return;

  const existingContext = await loadArticleClientContext(normalizedArticleId);
  if (existingContext?.clientId === normalizedClientId) return;
  await saveArticleClientContext(normalizedArticleId, normalizedClientId, '');
};

export const saveArticleCurrentPageUrl = async (
  articleId: string,
  clientId: string,
  currentPageUrl: string,
): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('article_client_contexts')
    .upsert({
      article_id: articleId,
      client_id: clientId,
      current_page_url: currentPageUrl.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'article_id' });
  throwIfError(error);
};
