export const CLIENT_CENTER_FOUNDATION_MIGRATION = '20260724010000_client_center_foundation.sql';
export const CLIENT_CENTER_CRAWLING_MIGRATION = '20260724020000_client_center_management_and_crawling.sql';
export const CLIENT_CENTER_INTERNAL_LINKING_MIGRATION = '20260724030000_internal_linking_engine.sql';
export const CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION = '20260724040000_client_semantic_index.sql';
export const CLIENT_CENTER_REQUIRED_MIGRATION = '20260724050000_editor_internal_link_suggestions.sql';

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
    columns: 'id,client_id,page_id,requested_by,status,attempt_count,max_attempts,idempotency_key,next_attempt_at',
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
    id: 'suggestionRuns',
    table: 'client_link_suggestion_runs',
    columns: 'id,article_id,client_id,article_signature,inventory_signature,current_page_url,page_count,suggestion_count,top_score,algorithm_version,result_summary,created_by,created_at',
  },
] as const;
