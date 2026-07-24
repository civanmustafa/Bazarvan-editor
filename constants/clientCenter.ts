export const CLIENT_CENTER_FOUNDATION_MIGRATION = '20260724010000_client_center_foundation.sql';
export const CLIENT_CENTER_REQUIRED_MIGRATION = '20260724020000_client_center_management_and_crawling.sql';

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
] as const;
