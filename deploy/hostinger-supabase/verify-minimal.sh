#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SELECTED_SERVICES=(db auth rest realtime api-gw)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose \
    -f "${STACK_DIR}/docker-compose.yml" \
    -f "${STACK_DIR}/docker-compose.hostinger.yml" \
    "$@"
}

read_env_value() {
  local key="$1"
  grep "^${key}=" "${STACK_DIR}/.env" | head -n 1 | cut -d= -f2-
}

for required_command in curl docker grep cut; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Required command is missing: ${required_command}"
done

for service in "${SELECTED_SERVICES[@]}"; do
  container_id="$(compose ps -q "${service}")"
  [[ -n "${container_id}" ]] || fail "Service has no container: ${service}"

  state="$(docker inspect --format '{{.State.Status}}' "${container_id}")"
  [[ "${state}" == "running" ]] || fail "Service is not running: ${service} (${state})"

  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}")"
  [[ "${health}" == "healthy" || "${health}" == "none" ]] \
    || fail "Service is not healthy: ${service} (${health})"
done

readonly API_PORT="$(read_env_value BAZARVAN_SUPABASE_API_PORT)"
readonly ANON_KEY="$(read_env_value ANON_KEY)"
readonly API_URL="http://127.0.0.1:${API_PORT}"

curl --fail --silent --show-error "${API_URL}/auth/v1/health" >/dev/null

readonly REST_STATUS="$(curl \
  --silent \
  --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  --header "apikey: ${ANON_KEY}" \
  "${API_URL}/rest/v1/")"
[[ "${REST_STATUS}" == "200" ]] \
  || fail "PostgREST returned HTTP ${REST_STATUS}."

if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  readonly PM2_NOT_ONLINE="$(pm2 jlist | jq '[.[] | select(.pm2_env.status != "online")] | length')"
  (( PM2_NOT_ONLINE == 0 )) || fail "An existing PM2 process is not online."
fi

compose ps
printf 'Auth, PostgREST, Realtime container health, Envoy, PM2, and existing containers passed verification.\n'
