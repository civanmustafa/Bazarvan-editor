#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="${STACK_DIR:-/opt/bazarvan-supabase}"
readonly MIGRATIONS_DIR="${1:-/var/www/bazarvan-editor-staging/supabase/migrations}"
readonly DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
readonly DB_NAME="${DB_NAME:-postgres}"
readonly DB_USER="${DB_USER:-postgres}"
readonly EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-93}"
readonly EXPECTED_PUBLIC_TABLES="${EXPECTED_PUBLIC_TABLES:-57}"
readonly API_URL="http://127.0.0.1:18000"
readonly ENV_FILE="${STACK_DIR}/.env"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sql_scalar() {
  docker exec "${DB_CONTAINER}" \
    psql -X -U "${DB_USER}" -d "${DB_NAME}" -Atqc "$1"
}

read_env_value() {
  local key="$1"
  grep "^${key}=" "${ENV_FILE}" | head -n 1 | cut -d= -f2-
}

for required_command in curl docker find sort sha256sum awk grep cut; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Required command is missing: ${required_command}"
done

[[ -f "${ENV_FILE}" ]] || fail "Supabase environment file is missing."
[[ -d "${MIGRATIONS_DIR}" ]] || fail "Migration directory is missing."

readonly APPLIED_COUNT="$(sql_scalar 'select count(*) from bazarvan_migrations.applied_migrations')"
(( APPLIED_COUNT == EXPECTED_MIGRATIONS )) \
  || fail "Applied migration count is ${APPLIED_COUNT}; expected ${EXPECTED_MIGRATIONS}."

while IFS= read -r migration_file; do
  version="${migration_file%%_*}"
  checksum="$(sha256sum "${MIGRATIONS_DIR}/${migration_file}" | awk '{print $1}')"
  recorded_checksum="$(sql_scalar "select checksum_sha256 from bazarvan_migrations.applied_migrations where version = '${version}'")"
  [[ "${checksum}" == "${recorded_checksum}" ]] \
    || fail "Migration checksum verification failed: ${migration_file}"
done < <(find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)

readonly PUBLIC_TABLES="$(sql_scalar "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')")"
readonly PUBLIC_FUNCTIONS="$(sql_scalar "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")"
readonly RLS_POLICIES="$(sql_scalar "select count(*) from pg_policies where schemaname = 'public'")"
readonly PUBLIC_TRIGGERS="$(sql_scalar "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal")"
readonly REALTIME_TABLES="$(sql_scalar "select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")"
readonly META_DESCRIPTION_COLUMNS="$(sql_scalar "select count(*) from information_schema.columns where table_schema = 'public' and ((table_name = 'articles' and column_name in ('meta_description','meta_description_source','meta_description_generated_at','meta_description_signature','meta_description_job_id')) or (table_name = 'article_versions' and column_name = 'meta_description'))")"
readonly CONCURRENT_SAVE_FUNCTION="$(sql_scalar "select to_regprocedure('public.save_article_snapshot_with_content_policy(uuid,text,jsonb,text,boolean,timestamptz,boolean)') is not null")"
readonly META_APPLY_FUNCTION="$(sql_scalar "select to_regprocedure('public.apply_generated_article_meta_description(uuid,text,bigint,uuid,timestamptz,text,text)') is not null")"
readonly READY_ENGINEERING_CONTROLLED_FUNCTION="$(sql_scalar "select to_regprocedure('public.enqueue_external_engineering_jobs_controlled(uuid,uuid,text)') is not null")"
readonly READY_ENGINEERING_CUSTOM_FUNCTION="$(sql_scalar "select to_regprocedure('public.set_external_analysis_custom_commands_controlled(uuid,uuid,jsonb,text)') is not null")"
readonly READY_ENGINEERING_RESET_FUNCTION="$(sql_scalar "select to_regprocedure('public.reset_external_analysis_command_preferences_controlled(uuid,uuid,text)') is not null")"
readonly READY_ENGINEERING_TRIGGER="$(sql_scalar "select exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'ai_external_analysis_article_state' and t.tgname = 'enqueue_external_engineering_jobs' and not t.tgisinternal)")"
readonly READY_ENGINEERING_SETTING="$(sql_scalar "select jsonb_typeof(value->'autoRunReadyEngineeringCommands') = 'boolean' from public.app_settings where key = 'system' and not is_secret limit 1")"
readonly AUTOMATIC_ONCE_ENGINEERING_FUNCTION="$(sql_scalar "select to_regprocedure('public.enqueue_external_engineering_jobs(uuid,text)') is not null")"
readonly AUTOMATIC_ONCE_STAGE_FUNCTION="$(sql_scalar "select to_regprocedure('public.find_external_analysis_stage_job(uuid,text,text)') is not null")"
readonly AUTOMATIC_ONCE_RUN_TRIGGER="$(sql_scalar "select exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'ai_external_analysis_runs' and t.tgname = 'stamp_external_semantic_run_targets' and not t.tgisinternal)")"
readonly DASHBOARD_ACTIVITY_SUMMARY_FUNCTION="$(sql_scalar "select to_regprocedure('public.get_dashboard_activity_summary()') is not null")"

(( PUBLIC_TABLES == EXPECTED_PUBLIC_TABLES )) \
  || fail "Public table count is ${PUBLIC_TABLES}; expected ${EXPECTED_PUBLIC_TABLES}."
(( PUBLIC_FUNCTIONS > 0 )) || fail "No public functions were created."
(( RLS_POLICIES > 0 )) || fail "No RLS policies were created."
(( PUBLIC_TRIGGERS > 0 )) || fail "No project triggers were created."
(( REALTIME_TABLES > 0 )) || fail "No project tables were added to supabase_realtime."
(( META_DESCRIPTION_COLUMNS == 6 )) || fail "Meta-description schema is incomplete (${META_DESCRIPTION_COLUMNS}/6 columns)."
[[ "${CONCURRENT_SAVE_FUNCTION}" == "t" ]] || fail "Concurrent article-save fencing function is missing."
[[ "${META_APPLY_FUNCTION}" == "t" ]] || fail "Fenced meta-description apply function is missing."
[[ "${READY_ENGINEERING_CONTROLLED_FUNCTION}" == "t" ]] || fail "Controlled ready-engineering enqueue function is missing."
[[ "${READY_ENGINEERING_CUSTOM_FUNCTION}" == "t" ]] || fail "Controlled custom ready-engineering function is missing."
[[ "${READY_ENGINEERING_RESET_FUNCTION}" == "t" ]] || fail "Controlled default ready-engineering reset function is missing."
[[ "${READY_ENGINEERING_TRIGGER}" == "t" ]] || fail "Database-owned ready-engineering trigger is missing."
[[ "${READY_ENGINEERING_SETTING}" == "t" ]] || fail "Ready-engineering automation setting is missing or invalid."
[[ "${AUTOMATIC_ONCE_ENGINEERING_FUNCTION}" == "t" ]] || fail "Origin-aware engineering enqueue function is missing."
[[ "${AUTOMATIC_ONCE_STAGE_FUNCTION}" == "t" ]] || fail "Automatic external-analysis once guard is missing."
[[ "${AUTOMATIC_ONCE_RUN_TRIGGER}" == "t" ]] || fail "Semantic target-attempt trigger is missing."
[[ "${DASHBOARD_ACTIVITY_SUMMARY_FUNCTION}" == "t" ]] || fail "Dashboard activity summary function is missing."

for container_name in supabase-db supabase-auth supabase-rest realtime-dev.supabase-realtime supabase-envoy; do
  state="$(docker inspect --format '{{.State.Running}}' "${container_name}")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "${container_name}")"
  [[ "${state}" == "true" && "${health}" == "healthy" ]] \
    || fail "Container is not healthy: ${container_name} (${state}/${health})"
done

readonly PUBLISHABLE_KEY="$(read_env_value SUPABASE_PUBLISHABLE_KEY)"
readonly SECRET_KEY="$(read_env_value SUPABASE_SECRET_KEY)"
readonly AUTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' --header "apikey: ${PUBLISHABLE_KEY}" "${API_URL}/auth/v1/health")"
readonly REST_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' --header "apikey: ${SECRET_KEY}" "${API_URL}/rest/v1/")"
[[ "${AUTH_STATUS}" == "200" ]] || fail "Auth returned HTTP ${AUTH_STATUS}."
[[ "${REST_STATUS}" == "200" ]] || fail "PostgREST returned HTTP ${REST_STATUS}."

if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  readonly PM2_NOT_ONLINE="$(pm2 jlist | jq '[.[] | select(.pm2_env.status != "online")] | length')"
  (( PM2_NOT_ONLINE == 0 )) || fail "An existing PM2 process is not online."
fi

printf 'Migrations=%s tables=%s functions=%s policies=%s triggers=%s realtime_tables=%s auth_http=%s rest_http=%s\n' \
  "${APPLIED_COUNT}" "${PUBLIC_TABLES}" "${PUBLIC_FUNCTIONS}" "${RLS_POLICIES}" \
  "${PUBLIC_TRIGGERS}" "${REALTIME_TABLES}" "${AUTH_STATUS}" "${REST_STATUS}"
