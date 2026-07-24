import {
  listClientCenterClients,
  mapClientLinkDictionary,
  mapClientSemanticProfile,
  mapInternalLinkQualityPolicy,
  type ClientCenterClient,
} from './clientCenter';
import {
  buildClientPageSemanticProfile,
  isClientSemanticProfileCurrent,
} from './clientSemanticIndex';
import { getSupabaseClient } from './supabaseClient';
import type { InternalLinkTargetPage, InternalLinkSuggestion } from './internalLinkingEngine';
import {
  DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
  type InternalLinkQualityPolicyValues,
} from './internalLinkQualityPolicy';

export {
  loadArticleClientContext,
  saveArticleClientContext,
  saveArticleClientSelection,
  saveArticleCurrentPageUrl,
  type ArticleClientContext,
} from './articleClientContext';

export type InternalLinkActionType = 'applied' | 'dismissed' | 'blocked' | 'reported';

export type InternalLinkAction = {
  id: string;
  articleId: string;
  clientId: string;
  pageId: string;
  action: InternalLinkActionType;
  anchorText: string;
  targetUrl: string;
  score: number;
  reasonDetails: Record<string, unknown>;
  articleSignature: string;
  createdAt: string;
};

export type EffectiveInternalLinkQualityPolicy = {
  values: InternalLinkQualityPolicyValues;
  source: 'client' | 'global' | 'default';
  policyVersion: number;
};

const PAGE_COLUMNS = [
  'id',
  'client_id',
  'input_url',
  'final_url',
  'canonical_url',
  'crawl_status',
  'http_status',
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

const QUALITY_POLICY_COLUMNS = [
  'id',
  'scope',
  'client_id',
  'minimum_score',
  'max_links_per_1000_words',
  'absolute_maximum_links',
  'maximum_links_per_target',
  'minimum_matched_terms',
  'forbidden_anchors',
  'policy_version',
  'created_at',
  'updated_at',
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
  httpStatus: row.http_status !== null && row.http_status !== undefined
    && Number.isFinite(Number(row.http_status))
    ? Number(row.http_status)
    : null,
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
  action: (
    row.action === 'dismissed'
    || row.action === 'blocked'
    || row.action === 'reported'
  ) ? row.action : 'applied',
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

export const loadInternalLinkQualityPolicy = async (
  clientId: string,
): Promise<EffectiveInternalLinkQualityPolicy> => {
  const { data, error } = await getSupabaseClient()
    .from('internal_link_quality_policies')
    .select(QUALITY_POLICY_COLUMNS)
    .or(`scope.eq.global,client_id.eq.${clientId}`);
  throwIfError(error);
  const policies = (data || []).map(mapInternalLinkQualityPolicy);
  const clientPolicy = policies.find(policy => (
    policy.scope === 'client' && policy.clientId === clientId
  ));
  const globalPolicy = policies.find(policy => policy.scope === 'global');
  const selected = clientPolicy || globalPolicy;
  if (!selected) {
    return {
      values: {
        ...DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
        forbiddenAnchors: [...DEFAULT_INTERNAL_LINK_QUALITY_POLICY.forbiddenAnchors],
      },
      source: 'default',
      policyVersion: 1,
    };
  }
  return {
    values: {
      minimumScore: selected.minimumScore,
      maxLinksPer1000Words: selected.maxLinksPer1000Words,
      absoluteMaximumLinks: selected.absoluteMaximumLinks,
      maximumLinksPerTarget: selected.maximumLinksPerTarget,
      minimumMatchedTerms: selected.minimumMatchedTerms,
      forbiddenAnchors: selected.forbiddenAnchors,
    },
    source: selected.scope,
    policyVersion: selected.policyVersion,
  };
};

export const loadInternalLinkTargetPages = async (
  clientId: string,
): Promise<InternalLinkTargetPage[]> => {
  const supabase = getSupabaseClient();
  const [pagesResult, dictionariesResult, profilesResult, domainsResult] = await Promise.all([
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
    supabase
      .from('client_domains')
      .select('hostname,include_subdomains')
      .eq('client_id', clientId)
      .eq('is_active', true),
  ]);
  [pagesResult, dictionariesResult, profilesResult, domainsResult]
    .forEach(result => throwIfError(result.error));

  const dictionaries = (dictionariesResult.data || []).map(mapClientLinkDictionary);
  const allowedDomains = (domainsResult.data || []).flatMap(row => {
    const hostname = asText(row.hostname).toLocaleLowerCase().replace(/\.$/, '');
    return hostname
      ? [{
        hostname,
        includeSubdomains: row.include_subdomains === true,
      }]
      : [];
  });
  const storedProfiles = new Map(
    (profilesResult.data || [])
      .map(mapClientSemanticProfile)
      .map(profile => [profile.pageId, profile] as const),
  );
  return (pagesResult.data || []).map(mapTargetPage).map(page => {
    const storedProfile = storedProfiles.get(page.id);
    return {
      ...page,
      allowedDomains,
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
  action: InternalLinkActionType;
  articleSignature: string;
  feedbackNote?: string;
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
        paragraphNumber: input.suggestion.paragraphNumber,
        feedbackNote: input.feedbackNote?.trim().slice(0, 1000) || null,
      },
      article_signature: input.articleSignature,
    })
    .select(ACTION_COLUMNS)
    .single();
  throwIfError(error);
  return mapAction(data);
};

export const recordInternalLinkSuggestionRun = async (input: {
  articleId: string;
  clientId: string;
  articleSignature: string;
  inventorySignature: string;
  currentPageUrl?: string;
  pageCount: number;
  suggestions: InternalLinkSuggestion[];
  qualityPolicy?: EffectiveInternalLinkQualityPolicy;
  suggestionBudget?: number;
}): Promise<void> => {
  const paragraphNumbers = new Set(input.suggestions.map(item => item.paragraphNumber));
  const { error } = await getSupabaseClient()
    .from('client_link_suggestion_runs')
    .insert({
      article_id: input.articleId,
      client_id: input.clientId,
      article_signature: input.articleSignature,
      inventory_signature: input.inventorySignature,
      current_page_url: input.currentPageUrl?.trim() || null,
      page_count: Math.max(0, Math.min(1_000_000, input.pageCount)),
      suggestion_count: Math.max(0, Math.min(10_000, input.suggestions.length)),
      top_score: input.suggestions[0]?.score ?? null,
      algorithm_version: input.suggestions[0]?.algorithmVersion || 'bm25-quality-v3',
      result_summary: {
        paragraphCount: paragraphNumbers.size,
        strongCount: input.suggestions.filter(item => item.confidence === 'strong').length,
        goodCount: input.suggestions.filter(item => item.confidence === 'good').length,
        reviewCount: input.suggestions.filter(item => item.confidence === 'review').length,
        suggestionBudget: Math.max(0, input.suggestionBudget || 0),
        policySource: input.qualityPolicy?.source || 'default',
        policyVersion: input.qualityPolicy?.policyVersion || 1,
        minimumScore: input.qualityPolicy?.values.minimumScore
          ?? DEFAULT_INTERNAL_LINK_QUALITY_POLICY.minimumScore,
      },
    });
  if (error && error.code !== '23505') throwIfError(error);
};
