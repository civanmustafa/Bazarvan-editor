export const CLIENT_CENTER_FOUNDATION_MIGRATION = '20260724010000_client_center_foundation.sql';
export const CLIENT_CENTER_CRAWLING_MIGRATION = '20260724020000_client_center_management_and_crawling.sql';
export const CLIENT_CENTER_INTERNAL_LINKING_MIGRATION = '20260724030000_internal_linking_engine.sql';
export const CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION = '20260724040000_client_semantic_index.sql';
export const CLIENT_CENTER_EDITOR_SUGGESTIONS_MIGRATION = '20260724050000_editor_internal_link_suggestions.sql';
export const CLIENT_CENTER_QUALITY_POLICY_MIGRATION = '20260724060000_internal_link_quality_policies.sql';
export const CLIENT_CENTER_DRAFT_CREATION_MIGRATION = '20260725010000_client_draft_creation.sql';
export const CLIENT_CENTER_CRAWL_SOURCE_MIGRATION = '20260728050000_client_page_crawl_source.sql';
export const CLIENT_CENTER_SITE_CRAWLER_MIGRATION = '20260728060000_local_client_site_crawler.sql';
export const CLIENT_CENTER_AI_LINK_PROFILES_MIGRATION = '20260730040000_client_page_ai_link_profiles.sql';
export const CLIENT_CENTER_CRAWL_PGCRYPTO_FIX_MIGRATION = '20260731010000_client_site_crawl_pgcrypto_fix.sql';
export const CLIENT_CENTER_ECONOMIC_CRAWLER_MIGRATION = '20260731020000_economic_external_client_crawler.sql';
export const CLIENT_CENTER_REQUIRED_MIGRATION = CLIENT_CENTER_ECONOMIC_CRAWLER_MIGRATION;

export const CLIENT_CENTER_SCHEMA_PROBES = [
  {
    id: 'clients',
    table: 'clients',
    columns: 'id,name,legal_name,country,default_language,industry,company_summary,is_active,created_by,updated_by',
  },
  {
    id: 'domains',
    table: 'client_domains',
    columns: 'id,client_id,hostname,is_primary,include_subdomains,is_active',
  },
  {
    id: 'assignments',
    table: 'client_assignments',
    columns: 'id,client_id,user_id,access_level,is_active,assigned_by',
  },
  {
    id: 'pages',
    table: 'client_pages',
    columns: 'id,client_id,source,input_url,final_url,canonical_url,crawl_status,page_title,meta_description,h1,h2,h3,page_language,robots_index,is_enabled,word_count,response_content_type,redirect_count,last_crawl_duration_ms,crawl_generation',
  },
  {
    id: 'crawlJobs',
    table: 'client_page_crawl_jobs',
    columns: 'id,client_id,page_id,requested_by,status,attempt_count,max_attempts,idempotency_key,next_attempt_at,crawl_run_id,crawl_depth',
  },
  {
    id: 'siteCrawlRuns',
    table: 'client_site_crawl_runs',
    columns: 'id,client_id,started_by,start_url,status,provider,max_pages,max_depth,pages_discovered,pages_queued,pages_completed,pages_failed,pages_reused,external_requests_used,max_external_requests,external_reuse_days,force_external_refresh,limit_reached',
  },
  {
    id: 'crawlerProviderSecrets',
    table: 'crawler_provider_secrets',
    columns: 'provider,enabled,key_suffix,updated_at',
  },
  {
    id: 'crawlerProviderUsage',
    table: 'crawler_provider_usage_events',
    columns: 'id,crawl_job_id,crawl_run_id,client_id,page_id,requested_by,job_attempt,requested_provider,provider,credential_source,key_suffix,status,target_url,final_url,http_status,duration_ms,word_count,internal_link_count,fallback_reason,error_code,retryable,started_at,completed_at,created_at',
  },
  {
    id: 'crawlerProviderMonthlyUsage',
    table: 'crawler_provider_monthly_usage',
    columns: 'provider,month_start,reserved_attempts,updated_at',
  },
  {
    id: 'internalLinkGraph',
    table: 'client_internal_links',
    columns: 'id,client_id,source_page_id,target_page_id,target_url,anchor_text,rel_nofollow,crawlable,occurrence_count,is_active,last_seen_run_id',
  },
  {
    id: 'articleClientContexts',
    table: 'article_client_contexts',
    columns: 'article_id,client_id,current_page_url,selected_by,created_at,updated_at',
  },
  {
    id: 'internalLinkActions',
    table: 'internal_link_actions',
    columns: 'id,article_id,client_id,page_id,actor_id,action,anchor_text,target_url,score,reason_details,article_signature,created_at',
  },
  {
    id: 'linkDictionaries',
    table: 'client_link_dictionaries',
    columns: 'id,client_id,dictionary_type,label,terms,is_active,created_by,updated_by,created_at,updated_at',
  },
  {
    id: 'semanticProfiles',
    table: 'client_page_semantic_profiles',
    columns: 'page_id,client_id,profile_version,source_signature,dictionary_signature,page_language,path_segments,weighted_terms,phrases,light_stems,dictionary_matches,document_length,completeness_score,completeness_details,indexed_at,updated_at',
  },
  {
    id: 'aiLinkProfiles',
    table: 'client_page_ai_link_profiles',
    columns: 'page_id,client_id,profile_version,source_signature,generation_status,review_status,primary_phrase,alternative_phrases,long_tail_phrases,related_entities,negative_phrases,page_intent,confidence,provider,model,error_code,error_message,generated_at,reviewed_by,reviewed_at,created_at,updated_at',
  },
  {
    id: 'suggestionRuns',
    table: 'client_link_suggestion_runs',
    columns: 'id,article_id,client_id,article_signature,inventory_signature,current_page_url,page_count,suggestion_count,top_score,algorithm_version,result_summary,created_by,created_at',
  },
  {
    id: 'qualityPolicies',
    table: 'internal_link_quality_policies',
    columns: 'id,scope,client_id,minimum_score,max_links_per_1000_words,absolute_maximum_links,maximum_links_per_target,minimum_matched_terms,forbidden_anchors,policy_version,created_by,updated_by,created_at,updated_at',
  },
] as const;
import {
  CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION,
} from './crawlerProviders.ts';

export {
  CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION,
} from './crawlerProviders.ts';
