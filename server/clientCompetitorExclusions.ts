import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCompetitorOwnDomains } from './competitorSelectionEngine.ts';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const loadArticleClientOwnDomains = async (
  supabase: SupabaseAdmin,
  articleId: string,
  companyName = '',
): Promise<string[]> => {
  const normalizedArticleId = textValue(articleId);
  if (!normalizedArticleId) return [];

  const { data: context, error: contextError } = await supabase
    .from('article_client_contexts')
    .select('client_id,current_page_url')
    .eq('article_id', normalizedArticleId)
    .maybeSingle();
  if (contextError) throw contextError;

  const linkedClientId = textValue(context?.client_id);
  const currentPageUrl = textValue(context?.current_page_url);
  let clientIds = linkedClientId ? [linkedClientId] : [];
  if (clientIds.length === 0 && textValue(companyName)) {
    const { data: matchedClients, error: clientsError } = await supabase
      .from('clients')
      .select('id')
      .eq('name', textValue(companyName))
      .eq('is_active', true);
    if (clientsError) throw clientsError;
    clientIds = (matchedClients || [])
      .map(client => textValue(client?.id))
      .filter(Boolean);
  }
  if (clientIds.length === 0) return extractCompetitorOwnDomains(currentPageUrl);

  const { data: domains, error: domainsError } = await supabase
    .from('client_domains')
    .select('hostname')
    .in('client_id', clientIds)
    .eq('is_active', true);
  if (domainsError) throw domainsError;

  return extractCompetitorOwnDomains(
    currentPageUrl,
    ...(domains || []).map(domain => domain?.hostname),
  );
};
