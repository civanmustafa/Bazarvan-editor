import type { ClientPageCrawlResult } from './clientPageCrawler';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import {
  buildClientPageSemanticProfile,
  type ClientLinkDictionaryEntry,
  type ClientLinkDictionaryType,
  type ClientPageSemanticProfile,
} from '../utils/clientSemanticIndex';

const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const asTextArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
);

const mapDictionaryType = (value: unknown): ClientLinkDictionaryType => (
  value === 'topic' || value === 'excluded_term' ? value : 'synonym'
);

const mapDictionary = (row: any): ClientLinkDictionaryEntry => ({
  id: asText(row.id),
  clientId: asText(row.client_id),
  dictionaryType: mapDictionaryType(row.dictionary_type),
  label: asText(row.label),
  terms: asTextArray(row.terms),
  isActive: row.is_active !== false,
  createdAt: asText(row.created_at),
  updatedAt: asText(row.updated_at),
});

const semanticProfilePayload = (profile: ClientPageSemanticProfile) => ({
  page_id: profile.pageId,
  client_id: profile.clientId,
  profile_version: profile.profileVersion,
  source_signature: profile.sourceSignature,
  dictionary_signature: profile.dictionarySignature,
  page_language: profile.pageLanguage || null,
  path_segments: profile.pathSegments,
  weighted_terms: profile.weightedTerms,
  phrases: profile.phrases,
  light_stems: profile.lightStems,
  dictionary_matches: profile.dictionaryMatches,
  document_length: profile.documentLength,
  completeness_score: profile.completenessScore,
  completeness_details: profile.completenessDetails,
  indexed_at: profile.indexedAt,
});

export const loadActiveClientLinkDictionariesForIndex = async (
  clientId: string,
): Promise<ClientLinkDictionaryEntry[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('client_link_dictionaries')
    .select('id,client_id,dictionary_type,label,terms,is_active,created_at,updated_at')
    .eq('client_id', clientId)
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map(mapDictionary);
};

export const indexCompletedClientPage = async (input: {
  pageId: string;
  clientId: string;
  inputUrl: string;
  result: ClientPageCrawlResult;
}): Promise<ClientPageSemanticProfile> => {
  const dictionaries = await loadActiveClientLinkDictionariesForIndex(input.clientId);
  const profile = buildClientPageSemanticProfile({
    id: input.pageId,
    clientId: input.clientId,
    inputUrl: input.inputUrl,
    finalUrl: input.result.finalUrl,
    canonicalUrl: input.result.canonicalUrl,
    pageTitle: input.result.pageTitle,
    metaDescription: input.result.metaDescription,
    h1: input.result.h1,
    h2: input.result.h2,
    h3: input.result.h3,
    slug: input.result.slug,
    pageLanguage: input.result.pageLanguage,
    contentHash: input.result.contentHash,
    extractedTerms: input.result.extractedTerms,
    extractedPhrases: input.result.extractedPhrases,
  }, dictionaries);

  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from('client_page_semantic_profiles')
    .upsert(semanticProfilePayload(profile), { onConflict: 'page_id' });
  if (error) throw error;
  return profile;
};
