#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="${STACK_DIR:-/opt/bazarvan-supabase}"
readonly MIGRATIONS_DIR="${1:-/var/www/bazarvan-editor-staging/supabase/migrations}"
readonly DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
readonly DB_NAME="${DB_NAME:-postgres}"
readonly DB_USER="${DB_USER:-postgres}"
readonly EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-79}"
readonly MIN_AVAILABLE_MEMORY_MB="${MIN_AVAILABLE_MEMORY_MB:-1536}"
readonly BACKUP_DIR="${STACK_DIR}/backups"

declare -a BASELINE_CONTAINER_IDS=()
declare -a MIGRATION_FILES=()

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sql_scalar() {
  docker exec "${DB_CONTAINER}" \
    psql -X -U "${DB_USER}" -d "${DB_NAME}" -Atqc "$1"
}

check_existing_services() {
  local container_id
  local running

  for container_id in "${BASELINE_CONTAINER_IDS[@]}"; do
    running="$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null || printf 'false')"
    [[ "${running}" == "true" ]] \
      || fail "A Docker container that was running before migration has stopped: ${container_id}"
  done

  if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    local pm2_not_online
    pm2_not_online="$(pm2 jlist | jq '[.[] | select(.pm2_env.status != "online")] | length')"
    (( pm2_not_online == 0 )) \
      || fail "An existing PM2 process is not online."
  fi
}

if [[ "${BAZARVAN_APPROVE_MIGRATIONS:-}" != "1" ]]; then
  fail "Set BAZARVAN_APPROVE_MIGRATIONS=1 after reviewing the target and backup plan."
fi

for required_command in docker find sort sha256sum awk sed grep mktemp flock install date cp cat head tail tr rm chmod; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Required command is missing: ${required_command}"
done

[[ -d "${MIGRATIONS_DIR}" ]] \
  || fail "Migration directory does not exist: ${MIGRATIONS_DIR}"

exec 9>"${STACK_DIR}/.project-migrations.lock"
flock -n 9 || fail "Another project migration process is already running."

readonly DB_RUNNING="$(docker inspect --format '{{.State.Running}}' "${DB_CONTAINER}" 2>/dev/null || printf 'false')"
readonly DB_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${DB_CONTAINER}" 2>/dev/null || printf 'missing')"
[[ "${DB_RUNNING}" == "true" && "${DB_HEALTH}" == "healthy" ]] \
  || fail "Target database container is not healthy: ${DB_CONTAINER} (${DB_RUNNING}/${DB_HEALTH})"

readonly AVAILABLE_MEMORY_MB="$(awk '/MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
(( AVAILABLE_MEMORY_MB >= MIN_AVAILABLE_MEMORY_MB )) \
  || fail "Only ${AVAILABLE_MEMORY_MB} MB memory is available."

mapfile -t MIGRATION_FILES < <(
  find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort
)

(( ${#MIGRATION_FILES[@]} == EXPECTED_MIGRATIONS )) \
  || fail "Expected ${EXPECTED_MIGRATIONS} migration files, found ${#MIGRATION_FILES[@]}."

for migration_file in "${MIGRATION_FILES[@]}"; do
  [[ "${migration_file}" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]] \
    || fail "Unsafe migration filename: ${migration_file}"
done

mapfile -t BASELINE_CONTAINER_IDS < <(docker ps --format '{{.ID}}')
check_existing_services

readonly TRACKING_EXISTS="$(sql_scalar "select to_regclass('bazarvan_migrations.applied_migrations') is not null")"
readonly PUBLIC_TABLES_BEFORE="$(sql_scalar "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')")"

if [[ "${TRACKING_EXISTS}" == "f" ]] && (( PUBLIC_TABLES_BEFORE != 0 )); then
  fail "The untracked target is not empty: ${PUBLIC_TABLES_BEFORE} public tables exist."
fi

install -d -m 0700 "${BACKUP_DIR}"
readonly BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly DATABASE_BACKUP="${BACKUP_DIR}/pre-project-migrations-${BACKUP_STAMP}.dump"
readonly GLOBALS_BACKUP="${BACKUP_DIR}/pre-project-migrations-${BACKUP_STAMP}-globals.sql"
readonly RUN_LOG="${BACKUP_DIR}/project-migrations-${BACKUP_STAMP}.log"

docker exec "${DB_CONTAINER}" \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" --format=custom --no-owner --no-acl \
  >"${DATABASE_BACKUP}"
docker exec "${DB_CONTAINER}" \
  pg_dumpall -U "${DB_USER}" --globals-only \
  >"${GLOBALS_BACKUP}"
chmod 0600 "${DATABASE_BACKUP}" "${GLOBALS_BACKUP}"
docker exec -i "${DB_CONTAINER}" pg_restore --list <"${DATABASE_BACKUP}" >/dev/null
sha256sum "${DATABASE_BACKUP}" "${GLOBALS_BACKUP}" >"${BACKUP_DIR}/pre-project-migrations-${BACKUP_STAMP}.sha256"
chmod 0600 "${BACKUP_DIR}/pre-project-migrations-${BACKUP_STAMP}.sha256"
: >"${RUN_LOG}"
chmod 0600 "${RUN_LOG}"

docker exec -i "${DB_CONTAINER}" \
  psql -X -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema if not exists bazarvan_migrations;

create table if not exists bazarvan_migrations.applied_migrations (
  version text primary key,
  name text not null,
  checksum_sha256 text not null,
  applied_at timestamptz not null default now(),
  constraint applied_migrations_checksum_format
    check (checksum_sha256 ~ '^[0-9a-f]{64}$')
);
SQL

for migration_file in "${MIGRATION_FILES[@]}"; do
  migration_path="${MIGRATIONS_DIR}/${migration_file}"
  version="${migration_file%%_*}"
  name="${migration_file#*_}"
  name="${name%.sql}"
  checksum="$(sha256sum "${migration_path}" | awk '{print $1}')"
  recorded_checksum="$(sql_scalar "select checksum_sha256 from bazarvan_migrations.applied_migrations where version = '${version}'")"

  if [[ -n "${recorded_checksum}" ]]; then
    [[ "${recorded_checksum}" == "${checksum}" ]] \
      || fail "Checksum mismatch for an already-applied migration: ${migration_file}"
    printf 'Already applied: %s\n' "${migration_file}"
    continue
  fi

  normalized_sql="$(mktemp)"
  first_line="$(head -n 1 "${migration_path}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  last_line="$(tail -n 1 "${migration_path}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

  if [[ "${first_line}" == "begin;" && "${last_line}" == "commit;" ]]; then
    sed '1d;$d' "${migration_path}" >"${normalized_sql}"
  else
    cp "${migration_path}" "${normalized_sql}"
  fi

  printf 'Applying: %s\n' "${migration_file}"
  if ! {
    printf '%s\n' '\set ON_ERROR_STOP on' 'begin;'
    cat "${normalized_sql}"
    printf "\ninsert into bazarvan_migrations.applied_migrations (version, name, checksum_sha256) values ('%s', '%s', '%s');\n" \
      "${version}" "${name}" "${checksum}"
    printf '%s\n' 'commit;'
  } | docker exec -i "${DB_CONTAINER}" \
      psql -X -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
      >>"${RUN_LOG}" 2>&1; then
    rm -f -- "${normalized_sql}"
    tail -n 80 "${RUN_LOG}" >&2
    fail "Migration failed and its transaction was rolled back: ${migration_file}"
  fi

  rm -f -- "${normalized_sql}"
  check_existing_services
done

readonly APPLIED_COUNT="$(sql_scalar 'select count(*) from bazarvan_migrations.applied_migrations')"
(( APPLIED_COUNT == EXPECTED_MIGRATIONS )) \
  || fail "Applied migration count is ${APPLIED_COUNT}; expected ${EXPECTED_MIGRATIONS}."

check_existing_services
printf 'Applied and tracked %s project migrations.\n' "${APPLIED_COUNT}"
printf 'Verified backup: %s\n' "${DATABASE_BACKUP}"
printf 'Migration log: %s\n' "${RUN_LOG}"
