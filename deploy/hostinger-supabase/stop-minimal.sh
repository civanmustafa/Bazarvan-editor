#!/usr/bin/env bash
set -Eeuo pipefail

readonly STACK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SELECTED_SERVICES=(api-gw realtime rest auth db)

if [[ "${BAZARVAN_SUPABASE_APPROVE_STOP:-}" != "1" ]]; then
  printf 'ERROR: Set BAZARVAN_SUPABASE_APPROVE_STOP=1 to stop only the new staging services.\n' >&2
  exit 1
fi

docker compose \
  -f "${STACK_DIR}/docker-compose.yml" \
  -f "${STACK_DIR}/docker-compose.hostinger.yml" \
  stop "${SELECTED_SERVICES[@]}"

printf 'Stopped only the Bazarvan Supabase staging services. Volumes and existing services were preserved.\n'
