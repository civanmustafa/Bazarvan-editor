import {
  listClientCenterClients,
  mapClientLinkDictionary,
  mapClientSemanticProfile,
  type ClientCenterClient,
} from './clientCenter';
import {
  buildClientPageSemanticProfile,
  isClientSemanticProfileCurrent,
} from './clientSemanticIndex';
import { getSupabaseClient } from './supabaseClient';
import type { InternalLinkTargetPage, InternalLinkSuggestion } from './internalLinkingEngine';

export type ArticleClientContext = {
  articleId: string;
  clientId: string;
  selectedBy: string | null;
  updatedAt: string;
};

export type InternalLinkAction = {
  id: string;
  articleId: string;
  clientId: string;
  pageId: string;
  action: 'applied' | 'dismissed';
  anchorText: string;
  targetUrl: string;
  score: number;
  reasonDetails: Record<string, unknown>;
  articleSignature: string;
  createdAt: string;
};

const PAGE_COLUMNS = [
  'id',
  'client_id',
  'input_url',
  'final_url',
  'canonical_url',
  'crawl_status',
  'page_title',
  'meta_description',
  'h1',
  'h2',
  'h3',
  'slug',
  'page_language',
  'robots_index',
  'content_hash',
  'extracted_terms',
  'extracted_phrases',
  'is_enabled',
].join(',');

const ACTION_COLUMNS = [
  'id',
  'article_id',
  'client_id',
  'page_id',
  'action',
  'anchor_text',
  'target_url',
  'score',
  'reason_details',
  'article_signature',
  'created_at',
].join(',');

const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const asTextArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
);
const throwIfError = (error: any): void => {
  if (error) throw new Error(error.message || 'تعذر تحميل بيانات الربط الداخلي.');
};

const mapTargetPage = (row: any): InternalLinkTargetPage => ({
  id: asText(row.id),
  clientId: asText(row.client_id),
  inputUrl: asText(row.input_url),
  finalUrl: asText(row.final_url),
  canonicalUrl: asText(row.canonical_url),
  crawlStatus: asText(row.crawl_status),
  pageTitle: asText(row.page_title),
  metaDescription: asText(row.meta_description),
  h1: asText(row.h1),
  h2: asTextArray(row.h2),
  h3: asTextArray(row.h3),
  slug: asText(row.slug),
  pageLanguage: asText(row.page_language),
  robotsIndex: typeof row.robots_index === 'boolean' ? row.robots_index : null,
  contentHash: asText(row.content_hash),
  extractedTerms: asTextArray(row.extracted_terms),
  extractedPhrases: asTextArray(row.extracted_phrases),
  isEnabled: row.is_enabled !== false,
});

const mapAction = (row: any): InternalLinkAction => ({
  id: asText(row.id),
  articleId: asText(row.article_id),
  clientId: asText(row.client_id),
  pageId: asText(row.page_id),
  action: row.action === 'dismissed' ? 'dismissed' : 'applied',
  anchorText: asText(row.anchor_text),
  targetUrl: asText(row.target_url),
  score: Number(row.score) || 0,
  reasonDetails: row.reason_details && typeof row.reason_details === 'object'
    ? row.reason_details
    : {},
  articleSignature: asText(row.article_signature),
  createdAt: asText(row.created_at),
});

export const listInternalLinkingClients = async (): Promise<ClientCenterClient[]> => (
  (await listClientCenterClients()).filter(client => client.isActive)
);

export const loadArticleClientContext = async (
  articleId: string,
): Promise<ArticleClientContext | null> => {
  const { data, error } = await getSupabaseClient()
    .from('article_client_contexts')
    .select('article_id,client_id,selected_by,updated_at')
    .eq('article_id', articleId)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  return {
    articleId: asText(data.article_id),
    clientId: asText(data.client_id),
    selectedBy: typeof data.selected_by === 'string' ? data.selected_by : null,
    updatedAt: asText(data.updated_at),
  };
};

export const saveArticleClientContext = async (
  articleId: string,
  clientId: string,
): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('article_client_contexts')
    .upsert({
      article_id: articleId,
      client_id: clientId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'article_id' });
  throwIfError(error);
};

export const loadInternalLinkTargetPages = async (
  clientId: string,
): Promise<InternalLinkTargetPage[]> => {
  const supabase = getSupabaseClient();
  const [pagesResult, dictionariesResult, profilesResult] = await Promise.all([
    supabase
      .from('client_pages')
      .select(PAGE_COLUMNS)
      .eq('client_id', clientId)
      .eq('is_enabled', true)
      .eq('crawl_status', 'ready')
      .neq('robots_index', false)
      .order('priority', { ascending: false })
      .order('page_title', { ascending: true })
      .limit(2000),
    supabase
      .from('client_link_dictionaries')
      .select('id,client_id,dictionary_type,label,terms,is_active,created_at,updated_at')
      .eq('client_id', clientId)
      .eq('is_active', true),
    supabase
      .from('client_page_semantic_profiles')
      .select([
        'page_id',
        'client_id',
        'profile_version',
        'source_signature',
        'dictionary_signature',
        'page_language',
        'path_segments',
        'weighted_terms',
        'phrases',
        'light_stems',
        'dictionary_matches',
        'document_length',
        'completeness_score',
        'completeness_details',
        'indexed_at',
      ].join(','))
      .eq('client_id', clientId)
      .limit(2000),
  ]);
  [pagesResult, dictionariesResult, profilesResult].forEach(result => throwIfError(result.error));

  const dictionaries = (dictionariesResult.data || []).map(mapClientLinkDictionary);
  const storedProfiles = new Map(
    (profilesResult.data || [])
      .map(mapClientSemanticProfile)
      .map(profile => [profile.pageId, profile] as const),
  );
  return (pagesResult.data || []).map(mapTargetPage).map(page => {
    const storedProfile = storedProfiles.get(page.id);
    return {
      ...page,
      semanticProfile: isClientSemanticProfileCurrent(storedProfile, {
        ...page,
        clientId: page.clientId || clientId,
      }, dictionaries)
        ? storedProfile
        : buildClientPageSemanticProfile({
          ...page,
          clientId: page.clientId || clientId,
        }, dictionaries),
    };
  });
};

export const loadInternalLinkActions = async (
  articleId: string,
  clientId: string,
): Promise<InternalLinkAction[]> => {
  const { data, error } = await getSupabaseClient()
    .from('internal_link_actions')
    .select(ACTION_COLUMNS)
    .eq('article_id', articleId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(500);
  throwIfError(error);
  return (data || []).map(mapAction);
};

export const recordInternalLinkAction = async (input: {
  articleId: string;
  clientId: string;
  suggestion: InternalLinkSuggestion;
  action: 'applied' | 'dismissed';
  articleSignature: string;
}): Promise<InternalLinkAction> => {
  const { data, error } = await getSupabaseClient()
    .from('internal_link_actions')
    .insert({
      article_id: input.articleId,
      client_id: input.clientId,
      page_id: input.suggestion.pageId,
      action: input.action,
      anchor_text: input.suggestion.anchorText,
      target_url: input.suggestion.targetUrl,
      score: input.suggestion.score,
      reason_details: {
        confidence: input.suggestion.confidence,
        matchedTerms: input.suggestion.matchedTerms,
        reasons: input.suggestion.reasons,
        bm25Score: input.suggestion.bm25Score,
        completenessScore: input.suggestion.completenessScore,
        algorithmVersion: input.suggestion.algorithmVersion,
      },
      article_signature: input.articleSignature,
    })
    .select(ACTION_COLUMNS)
    .single();
  throwIfError(error);
  return mapAction(data);
};
