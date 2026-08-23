#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly MIN_MEMORY_AFTER_START_MB="${MIN_MEMORY_AFTER_START_MB:-1536}"
readonly SELECTED_SERVICES=(db auth rest realtime api-gw)
declare -a STARTED_SERVICES=()
declare -a BASELINE_CONTAINER_IDS=()

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

rollback_new_services() {
  if (( ${#STARTED_SERVICES[@]} > 0 )); then
    printf 'Rolling back only the new Bazarvan Supabase services: %s\n' "${STARTED_SERVICES[*]}" >&2
    compose stop "${STARTED_SERVICES[@]}" >/dev/null 2>&1 || true
  fi
}

on_exit() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    rollback_new_services
  fi
}

check_existing_containers() {
  local container_id
  local running

  for container_id in "${BASELINE_CONTAINER_IDS[@]}"; do
    running="$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null || printf 'false')"
    [[ "${running}" == "true" ]] \
      || fail "An existing Docker container stopped during startup: ${container_id}"
  done

  if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    local pm2_not_online
    pm2_not_online="$(pm2 jlist | jq '[.[] | select(.pm2_env.status != "online")] | length')"
    (( pm2_not_online == 0 )) \
      || fail "An existing PM2 process is no longer online."
  fi
}

check_memory_headroom() {
  local available_memory_mb
  available_memory_mb="$(awk '/MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
  (( available_memory_mb >= MIN_MEMORY_AFTER_START_MB )) \
    || fail "Available memory fell to ${available_memory_mb} MB."
}

if [[ "${BAZARVAN_SUPABASE_APPROVE_START:-}" != "1" ]]; then
  fail "Set BAZARVAN_SUPABASE_APPROVE_START=1 for this one startup after reviewing the plan."
fi

"${STACK_DIR}/preflight.sh"
mapfile -t BASELINE_CONTAINER_IDS < <(docker ps --format '{{.ID}}')
trap on_exit EXIT

for service in "${SELECTED_SERVICES[@]}"; do
  printf 'Starting isolated service: %s\n' "${service}"
  compose up -d --no-deps --wait --wait-timeout 180 "${service}"
  STARTED_SERVICES+=("${service}")
  check_existing_containers
  check_memory_headroom
done

"${STACK_DIR}/verify-minimal.sh"
trap - EXIT

printf 'Minimal Bazarvan Supabase staging stack is running locally.\n'
printf 'No pre-existing Docker container or PM2 process was stopped.\n'
