#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly MIN_AVAILABLE_MEMORY_MB="${MIN_AVAILABLE_MEMORY_MB:-3072}"
readonly MIN_AVAILABLE_DISK_MB="${MIN_AVAILABLE_DISK_MB:-20480}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  grep "^${key}=" "${STACK_DIR}/.env" | head -n 1 | cut -d= -f2-
}

for required_command in docker ss awk df grep sort; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Required command is missing: ${required_command}"
done

[[ -f "${STACK_DIR}/docker-compose.yml" ]] \
  || fail "Official docker-compose.yml is missing from ${STACK_DIR}."
[[ -f "${STACK_DIR}/docker-compose.hostinger.yml" ]] \
  || fail "Hostinger override is missing from ${STACK_DIR}."
[[ -f "${STACK_DIR}/.env" ]] \
  || fail "The generated .env file is missing from ${STACK_DIR}."

docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable."

readonly API_PORT="$(read_env_value BAZARVAN_SUPABASE_API_PORT)"
[[ "${API_PORT}" =~ ^[0-9]+$ ]] || fail "Invalid BAZARVAN_SUPABASE_API_PORT."

if ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${API_PORT}$"; then
  fail "Local API port ${API_PORT} is already in use."
fi

readonly AVAILABLE_MEMORY_MB="$(awk '/MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
readonly AVAILABLE_DISK_MB="$(df -Pm "${STACK_DIR}" | awk 'NR == 2 {print $4}')"

(( AVAILABLE_MEMORY_MB >= MIN_AVAILABLE_MEMORY_MB )) \
  || fail "Only ${AVAILABLE_MEMORY_MB} MB memory is available; ${MIN_AVAILABLE_MEMORY_MB} MB is required before startup."
(( AVAILABLE_DISK_MB >= MIN_AVAILABLE_DISK_MB )) \
  || fail "Only ${AVAILABLE_DISK_MB} MB disk is available; ${MIN_AVAILABLE_DISK_MB} MB is required before startup."

if docker ps -a --format '{{.Names}}' | grep -Eq '^bazarvan-supabase-'; then
  fail "Bazarvan Supabase containers already exist; inspect them instead of creating another stack."
fi

if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  readonly PM2_NOT_ONLINE="$(pm2 jlist | jq '[.[] | select(.pm2_env.status != "online")] | length')"
  (( PM2_NOT_ONLINE == 0 )) \
    || fail "At least one existing PM2 process is not online."
fi

if [[ ! -s /proc/swaps || $(wc -l < /proc/swaps) -le 1 ]]; then
  printf 'WARNING: No swap is active. Resource limits remain mandatory.\n' >&2
fi

if grep -q '^VERSION_ID="25.04"' /etc/os-release; then
  printf 'WARNING: Ubuntu 25.04 is out of support. Do not expose this staging stack publicly.\n' >&2
fi

(
  cd "${STACK_DIR}"
  docker compose config --quiet
)

printf 'Preflight passed. Available memory: %s MB; available disk: %s MB; local API port: %s.\n' \
  "${AVAILABLE_MEMORY_MB}" "${AVAILABLE_DISK_MB}" "${API_PORT}"
