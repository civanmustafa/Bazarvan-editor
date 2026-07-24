import { getSupabaseClient } from './supabaseClient';
import {
  buildClientPageSemanticProfile,
  type ClientLinkDictionaryEntry,
  type ClientLinkDictionaryType,
  type ClientPageSemanticProfile,
} from './clientSemanticIndex';

export type ClientAssignmentAccess = 'viewer' | 'editor';
export type ClientPageSource = 'manual' | 'csv' | 'sitemap';
export type ClientPageStatus =
  | 'pending'
  | 'crawling'
  | 'ready'
  | 'needs_review'
  | 'redirected'
  | 'noindex'
  | 'deleted'
  | 'blocked'
  | 'failed';
export type ClientCrawlJobStatus =
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ClientCenterClient = {
  id: string;
  name: string;
  legalName: string;
  country: string;
  defaultLanguage: string;
  industry: string;
  companySummary: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientCenterDomain = {
  id: string;
  clientId: string;
  hostname: string;
  isPrimary: boolean;
  includeSubdomains: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientCenterAssignment = {
  id: string;
  clientId: string;
  userId: string;
  accessLevel: ClientAssignmentAccess;
  isActive: boolean;
  assignedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClientCenterPage = {
  id: string;
  clientId: string;
  source: ClientPageSource;
  inputUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  crawlStatus: ClientPageStatus;
  httpStatus: number | null;
  pageTitle: string;
  metaDescription: string;
  h1: string;
  h2: string[];
  h3: string[];
  slug: string;
  pageLanguage: string;
  robotsIndex: boolean | null;
  robotsFollow: boolean | null;
  contentHash: string;
  extractedTerms: string[];
  extractedPhrases: string[];
  wordCount: number;
  responseContentType: string;
  redirectCount: number;
  lastCrawlDurationMs: number | null;
  crawlGeneration: number;
  isEnabled: boolean;
  priority: number;
  lastCrawledAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientCenterCrawlJob = {
  id: string;
  clientId: string;
  pageId: string;
  requestedBy: string | null;
  requestReason: 'initial' | 'manual_refresh' | 'scheduled_refresh';
  status: ClientCrawlJobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientCenterDetails = {
  domains: ClientCenterDomain[];
  assignments: ClientCenterAssignment[];
  pages: ClientCenterPage[];
  jobs: ClientCenterCrawlJob[];
  dictionaries: ClientLinkDictionaryEntry[];
  semanticProfiles: ClientPageSemanticProfile[];
};

export type ClientCenterClientInput = {
  name: string;
  legalName?: string;
  country?: string;
  defaultLanguage?: string;
  industry?: string;
  companySummary?: string;
  isActive?: boolean;
};

const CLIENT_COLUMNS = [
  'id',
  'name',
  'legal_name',
  'country',
  'default_language',
  'industry',
  'company_summary',
  'is_active',
  'created_at',
  'updated_at',
].join(',');

const DOMAIN_COLUMNS = [
  'id',
  'client_id',
  'hostname',
  'is_primary',
  'include_subdomains',
  'is_active',
  'created_at',
  'updated_at',
].join(',');

const ASSIGNMENT_COLUMNS = [
  'id',
  'client_id',
  'user_id',
  'access_level',
  'is_active',
  'assigned_by',
  'created_at',
  'updated_at',
].join(',');

const PAGE_COLUMNS = [
  'id',
  'client_id',
  'source',
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
  'robots_follow',
  'content_hash',
  'extracted_terms',
  'extracted_phrases',
  'word_count',
  'response_content_type',
  'redirect_count',
  'last_crawl_duration_ms',
  'crawl_generation',
  'is_enabled',
  'priority',
  'last_crawled_at',
  'last_success_at',
  'last_error_code',
  'last_error_message',
  'created_at',
  'updated_at',
].join(',');

const JOB_COLUMNS = [
  'id',
  'client_id',
  'page_id',
  'requested_by',
  'request_reason',
  'status',
  'priority',
  'attempt_count',
  'max_attempts',
  'next_attempt_at',
  'started_at',
  'finished_at',
  'error_code',
  'error_message',
  'created_at',
  'updated_at',
].join(',');

const DICTIONARY_COLUMNS = [
  'id',
  'client_id',
  'dictionary_type',
  'label',
  'terms',
  'is_active',
  'created_at',
  'updated_at',
].join(',');

const SEMANTIC_PROFILE_COLUMNS = [
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
].join(',');

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const stringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
);

const mapClient = (row: any): ClientCenterClient => ({
  id: text(row.id),
  name: text(row.name),
  legalName: text(row.legal_name),
  country: text(row.country),
  defaultLanguage: text(row.default_language) || 'ar',
  industry: text(row.industry),
  companySummary: text(row.company_summary),
  isActive: row.is_active !== false,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapDomain = (row: any): ClientCenterDomain => ({
  id: text(row.id),
  clientId: text(row.client_id),
  hostname: text(row.hostname),
  isPrimary: row.is_primary === true,
  includeSubdomains: row.include_subdomains === true,
  isActive: row.is_active !== false,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapAssignment = (row: any): ClientCenterAssignment => ({
  id: text(row.id),
  clientId: text(row.client_id),
  userId: text(row.user_id),
  accessLevel: row.access_level === 'editor' ? 'editor' : 'viewer',
  isActive: row.is_active !== false,
  assignedBy: typeof row.assigned_by === 'string' ? row.assigned_by : null,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapPage = (row: any): ClientCenterPage => ({
  id: text(row.id),
  clientId: text(row.client_id),
  source: row.source === 'csv' || row.source === 'sitemap' ? row.source : 'manual',
  inputUrl: text(row.input_url),
  finalUrl: text(row.final_url),
  canonicalUrl: text(row.canonical_url),
  crawlStatus: text(row.crawl_status) as ClientPageStatus || 'pending',
  httpStatus: Number.isFinite(Number(row.http_status)) ? Number(row.http_status) : null,
  pageTitle: text(row.page_title),
  metaDescription: text(row.meta_description),
  h1: text(row.h1),
  h2: stringArray(row.h2),
  h3: stringArray(row.h3),
  slug: text(row.slug),
  pageLanguage: text(row.page_language),
  robotsIndex: typeof row.robots_index === 'boolean' ? row.robots_index : null,
  robotsFollow: typeof row.robots_follow === 'boolean' ? row.robots_follow : null,
  contentHash: text(row.content_hash),
  extractedTerms: stringArray(row.extracted_terms),
  extractedPhrases: stringArray(row.extracted_phrases),
  wordCount: Number(row.word_count) || 0,
  responseContentType: text(row.response_content_type),
  redirectCount: Number(row.redirect_count) || 0,
  lastCrawlDurationMs: Number.isFinite(Number(row.last_crawl_duration_ms))
    ? Number(row.last_crawl_duration_ms)
    : null,
  crawlGeneration: Number(row.crawl_generation) || 0,
  isEnabled: row.is_enabled !== false,
  priority: Number(row.priority) || 50,
  lastCrawledAt: typeof row.last_crawled_at === 'string' ? row.last_crawled_at : null,
  lastSuccessAt: typeof row.last_success_at === 'string' ? row.last_success_at : null,
  lastErrorCode: text(row.last_error_code),
  lastErrorMessage: text(row.last_error_message),
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapJob = (row: any): ClientCenterCrawlJob => ({
  id: text(row.id),
  clientId: text(row.client_id),
  pageId: text(row.page_id),
  requestedBy: typeof row.requested_by === 'string' ? row.requested_by : null,
  requestReason: row.request_reason === 'manual_refresh' || row.request_reason === 'scheduled_refresh'
    ? row.request_reason
    : 'initial',
  status: text(row.status) as ClientCrawlJobStatus || 'queued',
  priority: Number(row.priority) || 50,
  attemptCount: Number(row.attempt_count) || 0,
  maxAttempts: Number(row.max_attempts) || 3,
  nextAttemptAt: text(row.next_attempt_at),
  startedAt: typeof row.started_at === 'string' ? row.started_at : null,
  finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  errorCode: text(row.error_code),
  errorMessage: text(row.error_message),
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

export const mapClientLinkDictionary = (row: any): ClientLinkDictionaryEntry => ({
  id: text(row.id),
  clientId: text(row.client_id),
  dictionaryType: (
    row.dictionary_type === 'topic' || row.dictionary_type === 'excluded_term'
      ? row.dictionary_type
      : 'synonym'
  ),
  label: text(row.label),
  terms: stringArray(row.terms),
  isActive: row.is_active !== false,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapWeightedTerms = (value: unknown): ClientPageSemanticProfile['weightedTerms'] => (
  Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object').map((item: any) => ({
      term: text(item.term),
      weight: Number(item.weight) || 0,
      frequency: Math.max(1, Number(item.frequency) || 1),
      sources: stringArray(item.sources),
    })).filter(item => item.term)
    : []
);

const mapSemanticPhrases = (value: unknown): ClientPageSemanticProfile['phrases'] => (
  Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object').map((item: any) => ({
      phrase: text(item.phrase),
      weight: Number(item.weight) || 0,
      size: Number(item.size) || 0,
      sources: stringArray(item.sources),
    })).filter(item => item.phrase)
    : []
);

const mapSemanticStems = (value: unknown): ClientPageSemanticProfile['lightStems'] => (
  Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object').map((item: any) => ({
      stem: text(item.stem),
      terms: stringArray(item.terms),
      weight: Number(item.weight) || 0,
    })).filter(item => item.stem)
    : []
);

const mapDictionaryMatches = (value: unknown): ClientPageSemanticProfile['dictionaryMatches'] => (
  Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object').map((item: any) => ({
      dictionaryId: text(item.dictionaryId),
      type: (
        item.type === 'topic' || item.type === 'excluded_term'
          ? item.type
          : 'synonym'
      ),
      label: text(item.label),
      matchedTerms: stringArray(item.matchedTerms),
    })).filter(item => item.label)
    : []
);

const mapCompletenessDetails = (
  value: unknown,
): ClientPageSemanticProfile['completenessDetails'] => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    title: source.title === true,
    description: source.description === true,
    h1: source.h1 === true,
    h2: source.h2 === true,
    h3: source.h3 === true,
    slug: source.slug === true,
    language: source.language === true,
    canonical: source.canonical === true,
    extractedTerms: source.extractedTerms === true,
    extractedPhrases: source.extractedPhrases === true,
  };
};

export const mapClientSemanticProfile = (row: any): ClientPageSemanticProfile => ({
  pageId: text(row.page_id),
  clientId: text(row.client_id),
  profileVersion: Number(row.profile_version) || 1,
  sourceSignature: text(row.source_signature),
  dictionarySignature: text(row.dictionary_signature),
  pageLanguage: text(row.page_language),
  pathSegments: stringArray(row.path_segments),
  weightedTerms: mapWeightedTerms(row.weighted_terms),
  phrases: mapSemanticPhrases(row.phrases),
  lightStems: mapSemanticStems(row.light_stems),
  dictionaryMatches: mapDictionaryMatches(row.dictionary_matches),
  documentLength: Number(row.document_length) || 0,
  completenessScore: Number(row.completeness_score) || 0,
  completenessDetails: mapCompletenessDetails(row.completeness_details),
  indexedAt: text(row.indexed_at),
});

const throwIfError = (error: any): void => {
  if (error) throw new Error(error.message || 'تعذر تنفيذ طلب مركز العملاء.');
};

export const getCurrentClientCenterUserId = async (): Promise<string> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  throwIfError(error);
  return data.user?.id || '';
};

export const listClientCenterClients = async (): Promise<ClientCenterClient[]> => {
  const { data, error } = await getSupabaseClient()
    .from('clients')
    .select(CLIENT_COLUMNS)
    .order('is_active', { ascending: false })
    .order('name', { ascending: true });
  throwIfError(error);
  return (data || []).map(mapClient);
};

export const loadClientCenterDetails = async (clientId: string): Promise<ClientCenterDetails> => {
  const supabase = getSupabaseClient();
  const [
    domainsResult,
    assignmentsResult,
    pagesResult,
    jobsResult,
    dictionariesResult,
    semanticProfilesResult,
  ] = await Promise.all([
    supabase.from('client_domains').select(DOMAIN_COLUMNS).eq('client_id', clientId)
      .order('is_primary', { ascending: false }).order('hostname', { ascending: true }),
    supabase.from('client_assignments').select(ASSIGNMENT_COLUMNS).eq('client_id', clientId)
      .order('created_at', { ascending: true }),
    supabase.from('client_pages').select(PAGE_COLUMNS).eq('client_id', clientId)
      .order('updated_at', { ascending: false }).limit(500),
    supabase.from('client_page_crawl_jobs').select(JOB_COLUMNS).eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(500),
    supabase.from('client_link_dictionaries').select(DICTIONARY_COLUMNS).eq('client_id', clientId)
      .order('dictionary_type', { ascending: true }).order('label', { ascending: true }),
    supabase.from('client_page_semantic_profiles').select(SEMANTIC_PROFILE_COLUMNS)
      .eq('client_id', clientId).order('indexed_at', { ascending: false }).limit(500),
  ]);
  [
    domainsResult,
    assignmentsResult,
    pagesResult,
    jobsResult,
    dictionariesResult,
    semanticProfilesResult,
  ].forEach(result => throwIfError(result.error));
  return {
    domains: (domainsResult.data || []).map(mapDomain),
    assignments: (assignmentsResult.data || []).map(mapAssignment),
    pages: (pagesResult.data || []).map(mapPage),
    jobs: (jobsResult.data || []).map(mapJob),
    dictionaries: (dictionariesResult.data || []).map(mapClientLinkDictionary),
    semanticProfiles: (semanticProfilesResult.data || []).map(mapClientSemanticProfile),
  };
};

const toClientPayload = (input: ClientCenterClientInput) => ({
  name: input.name.trim(),
  legal_name: input.legalName?.trim() || null,
  country: input.country?.trim() || null,
  default_language: input.defaultLanguage?.trim().toLowerCase() || 'ar',
  industry: input.industry?.trim() || null,
  company_summary: input.companySummary?.trim() || null,
  is_active: input.isActive !== false,
});

export const createClientCenterClient = async (
  input: ClientCenterClientInput,
): Promise<ClientCenterClient> => {
  const { data, error } = await getSupabaseClient()
    .from('clients')
    .insert(toClientPayload(input))
    .select(CLIENT_COLUMNS)
    .single();
  throwIfError(error);
  return mapClient(data);
};

export const updateClientCenterClient = async (
  clientId: string,
  input: ClientCenterClientInput,
): Promise<ClientCenterClient> => {
  const { data, error } = await getSupabaseClient()
    .from('clients')
    .update(toClientPayload(input))
    .eq('id', clientId)
    .select(CLIENT_COLUMNS)
    .single();
  throwIfError(error);
  return mapClient(data);
};

export const normalizeClientHostname = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
      .hostname
      .replace(/\.$/, '');
  } catch {
    return trimmed.replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  }
};

export const createClientCenterDomain = async (input: {
  clientId: string;
  hostname: string;
  isPrimary: boolean;
  includeSubdomains: boolean;
}): Promise<ClientCenterDomain> => {
  const supabase = getSupabaseClient();
  if (input.isPrimary) {
    const { error: primaryError } = await supabase
      .from('client_domains')
      .update({ is_primary: false })
      .eq('client_id', input.clientId)
      .eq('is_primary', true);
    throwIfError(primaryError);
  }
  const { data, error } = await supabase
    .from('client_domains')
    .insert({
      client_id: input.clientId,
      hostname: normalizeClientHostname(input.hostname),
      is_primary: input.isPrimary,
      include_subdomains: input.includeSubdomains,
      is_active: true,
    })
    .select(DOMAIN_COLUMNS)
    .single();
  throwIfError(error);
  return mapDomain(data);
};

export const updateClientCenterDomain = async (
  domainId: string,
  clientId: string,
  patch: Partial<Pick<ClientCenterDomain, 'isPrimary' | 'includeSubdomains' | 'isActive'>>,
): Promise<void> => {
  const supabase = getSupabaseClient();
  if (patch.isPrimary) {
    const { error: primaryError } = await supabase
      .from('client_domains')
      .update({ is_primary: false })
      .eq('client_id', clientId)
      .eq('is_primary', true)
      .neq('id', domainId);
    throwIfError(primaryError);
  }
  const values: Record<string, boolean> = {};
  if (typeof patch.isPrimary === 'boolean') values.is_primary = patch.isPrimary;
  if (typeof patch.includeSubdomains === 'boolean') values.include_subdomains = patch.includeSubdomains;
  if (typeof patch.isActive === 'boolean') values.is_active = patch.isActive;
  const { error } = await supabase.from('client_domains').update(values).eq('id', domainId);
  throwIfError(error);
};

export const deleteClientCenterDomain = async (domainId: string): Promise<void> => {
  const { error } = await getSupabaseClient().from('client_domains').delete().eq('id', domainId);
  throwIfError(error);
};

export const saveClientCenterAssignment = async (input: {
  clientId: string;
  userId: string;
  accessLevel: ClientAssignmentAccess;
}): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('client_assignments')
    .upsert({
      client_id: input.clientId,
      user_id: input.userId,
      access_level: input.accessLevel,
      is_active: true,
    }, { onConflict: 'client_id,user_id' });
  throwIfError(error);
};

export const deleteClientCenterAssignment = async (assignmentId: string): Promise<void> => {
  const { error } = await getSupabaseClient().from('client_assignments').delete().eq('id', assignmentId);
  throwIfError(error);
};

export const normalizeClientPageUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    url.hash = '';
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const isUrlAllowedForClientDomains = (
  value: string,
  domains: ClientCenterDomain[],
): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return domains.some(domain => (
      domain.isActive
      && (
        hostname === domain.hostname
        || (domain.includeSubdomains && hostname.endsWith(`.${domain.hostname}`))
      )
    ));
  } catch {
    return false;
  }
};

const createIdempotencyKey = (pageId: string, reason: string): string => {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${reason}:${pageId}:${randomPart}`.slice(0, 200);
};

const enqueuePageIds = async (
  clientId: string,
  pageIds: string[],
  reason: 'initial' | 'manual_refresh',
): Promise<number> => {
  if (pageIds.length === 0) return 0;
  const supabase = getSupabaseClient();
  const { data: activeJobs, error: activeError } = await supabase
    .from('client_page_crawl_jobs')
    .select('page_id')
    .in('page_id', pageIds)
    .in('status', ['queued', 'running', 'retry_scheduled']);
  throwIfError(activeError);
  const activePageIds = new Set((activeJobs || []).map(row => text(row.page_id)));
  const rows = pageIds
    .filter(pageId => !activePageIds.has(pageId))
    .map(pageId => ({
      client_id: clientId,
      page_id: pageId,
      request_reason: reason,
      status: 'queued',
      priority: reason === 'manual_refresh' ? 70 : 50,
      idempotency_key: createIdempotencyKey(pageId, reason),
    }));
  if (rows.length === 0) return 0;
  const { error } = await supabase.from('client_page_crawl_jobs').insert(rows);
  throwIfError(error);
  return rows.length;
};

export const addClientCenterPages = async (input: {
  clientId: string;
  urls: string[];
  domains: ClientCenterDomain[];
}): Promise<{ accepted: number; queued: number; rejected: string[] }> => {
  const normalized = Array.from(new Set(input.urls.map(normalizeClientPageUrl).filter(Boolean))).slice(0, 100);
  const rejected = normalized.filter(url => !isUrlAllowedForClientDomains(url, input.domains));
  const accepted = normalized.filter(url => isUrlAllowedForClientDomains(url, input.domains));
  if (accepted.length === 0) return { accepted: 0, queued: 0, rejected };

  const supabase = getSupabaseClient();
  const { error: upsertError } = await supabase
    .from('client_pages')
    .upsert(accepted.map(inputUrl => ({
      client_id: input.clientId,
      source: 'manual',
      input_url: inputUrl,
      is_enabled: true,
    })), {
      onConflict: 'client_id,input_url',
      ignoreDuplicates: true,
    });
  throwIfError(upsertError);

  const { data: pages, error: pagesError } = await supabase
    .from('client_pages')
    .select('id,input_url')
    .eq('client_id', input.clientId)
    .in('input_url', accepted);
  throwIfError(pagesError);
  const pageIds = (pages || []).map(row => text(row.id)).filter(Boolean);
  const queued = await enqueuePageIds(input.clientId, pageIds, 'initial');
  return { accepted: pageIds.length, queued, rejected };
};

export const refreshClientCenterPage = async (
  clientId: string,
  pageId: string,
): Promise<boolean> => (
  (await enqueuePageIds(clientId, [pageId], 'manual_refresh')) > 0
);

export const setClientCenterPageEnabled = async (
  pageId: string,
  enabled: boolean,
): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('client_pages')
    .update({ is_enabled: enabled })
    .eq('id', pageId);
  throwIfError(error);
};

export const deleteClientCenterPage = async (pageId: string): Promise<void> => {
  const { error } = await getSupabaseClient().from('client_pages').delete().eq('id', pageId);
  throwIfError(error);
};

export const saveClientLinkDictionary = async (input: {
  id?: string;
  clientId: string;
  dictionaryType: ClientLinkDictionaryType;
  label: string;
  terms: string[];
  isActive?: boolean;
}): Promise<ClientLinkDictionaryEntry> => {
  const values = {
    client_id: input.clientId,
    dictionary_type: input.dictionaryType,
    label: input.label.trim(),
    terms: Array.from(new Set(input.terms.map(value => value.trim()).filter(Boolean))).slice(0, 100),
    is_active: input.isActive !== false,
  };
  const query = input.id
    ? getSupabaseClient().from('client_link_dictionaries').update(values).eq('id', input.id)
    : getSupabaseClient().from('client_link_dictionaries').insert(values);
  const { data, error } = await query.select(DICTIONARY_COLUMNS).single();
  throwIfError(error);
  return mapClientLinkDictionary(data);
};

export const setClientLinkDictionaryEnabled = async (
  dictionaryId: string,
  enabled: boolean,
): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('client_link_dictionaries')
    .update({ is_active: enabled })
    .eq('id', dictionaryId);
  throwIfError(error);
};

export const deleteClientLinkDictionary = async (dictionaryId: string): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('client_link_dictionaries')
    .delete()
    .eq('id', dictionaryId);
  throwIfError(error);
};

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

export const saveClientSemanticProfiles = async (
  profiles: ClientPageSemanticProfile[],
): Promise<void> => {
  const supabase = getSupabaseClient();
  for (let start = 0; start < profiles.length; start += 100) {
    const batch = profiles.slice(start, start + 100).map(semanticProfilePayload);
    if (batch.length === 0) continue;
    const { error } = await supabase
      .from('client_page_semantic_profiles')
      .upsert(batch, { onConflict: 'page_id' });
    throwIfError(error);
  }
};

export const rebuildClientSemanticProfiles = async (input: {
  pages: ClientCenterPage[];
  dictionaries: ClientLinkDictionaryEntry[];
}): Promise<ClientPageSemanticProfile[]> => {
  const indexedAt = new Date().toISOString();
  const profiles = input.pages
    .filter(page => page.crawlStatus === 'ready' && page.isEnabled && page.robotsIndex !== false)
    .map(page => buildClientPageSemanticProfile(page, input.dictionaries, indexedAt));
  await saveClientSemanticProfiles(profiles);
  return profiles;
};
