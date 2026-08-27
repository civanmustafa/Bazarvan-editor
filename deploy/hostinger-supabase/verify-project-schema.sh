#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="${STACK_DIR:-/opt/bazarvan-supabase}"
readonly MIGRATIONS_DIR="${1:-/var/www/bazarvan-editor-staging/supabase/migrations}"
readonly DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
readonly DB_NAME="${DB_NAME:-postgres}"
readonly DB_USER="${DB_USER:-postgres}"
readonly EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-88}"
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

(( PUBLIC_TABLES == EXPECTED_PUBLIC_TABLES )) \
  || fail "Public table count is ${PUBLIC_TABLES}; expected ${EXPECTED_PUBLIC_TABLES}."
(( PUBLIC_FUNCTIONS > 0 )) || fail "No public functions were created."
(( RLS_POLICIES > 0 )) || fail "No RLS policies were created."
(( PUBLIC_TRIGGERS > 0 )) || fail "No project triggers were created."
(( REALTIME_TABLES > 0 )) || fail "No project tables were added to supabase_realtime."

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
