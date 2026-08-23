#!/usr/bin/env bash
set -Eeuo pipefail

readonly SUPABASE_RELEASE="self-hosted/v0.8.0"
readonly SUPABASE_REPOSITORY="https://github.com/supabase/supabase.git"
readonly TARGET_DIR="${1:-/opt/bazarvan-supabase}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  fail "Run this preparation script as root."
fi

for required_command in git docker openssl jq install sed grep mktemp; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Required command is missing: ${required_command}"
done

docker compose version >/dev/null 2>&1 \
  || fail "Docker Compose is unavailable."

if [[ -e "${TARGET_DIR}" ]]; then
  fail "Target already exists; refusing to overwrite it: ${TARGET_DIR}"
fi

readonly TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "${TEMP_DIR}"
}
trap cleanup EXIT

git clone \
  --filter=blob:none \
  --no-checkout \
  --depth=1 \
  --branch "${SUPABASE_RELEASE}" \
  "${SUPABASE_REPOSITORY}" \
  "${TEMP_DIR}/supabase"

git -C "${TEMP_DIR}/supabase" sparse-checkout init --cone
git -C "${TEMP_DIR}/supabase" sparse-checkout set docker
git -C "${TEMP_DIR}/supabase" checkout --quiet

install -d -m 0750 "${TARGET_DIR}"
cp -a "${TEMP_DIR}/supabase/docker/." "${TARGET_DIR}/"

install -m 0644 \
  "${SCRIPT_DIR}/docker-compose.hostinger.yml" \
  "${TARGET_DIR}/docker-compose.hostinger.yml"
install -m 0750 \
  "${SCRIPT_DIR}/preflight.sh" \
  "${SCRIPT_DIR}/start-minimal.sh" \
  "${SCRIPT_DIR}/verify-minimal.sh" \
  "${SCRIPT_DIR}/stop-minimal.sh" \
  "${TARGET_DIR}/"

cp "${TARGET_DIR}/.env.example" "${TARGET_DIR}/.env"
chmod 0600 "${TARGET_DIR}/.env"

set_env_value() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${TARGET_DIR}/.env"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "${TARGET_DIR}/.env"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${TARGET_DIR}/.env"
  fi
}

set_env_value COMPOSE_FILE "docker-compose.yml:docker-compose.hostinger.yml"
set_env_value API_GW_HTTP_PORT "18000"
set_env_value BAZARVAN_SUPABASE_API_PORT "18000"
set_env_value SUPABASE_PUBLIC_URL "http://127.0.0.1:18000"
set_env_value API_EXTERNAL_URL "http://127.0.0.1:18000/auth/v1"
set_env_value SITE_URL "https://smarteditor.bazarvan.com"
set_env_value ADDITIONAL_REDIRECT_URLS "https://smarteditor.bazarvan.com"
set_env_value DISABLE_SIGNUP "true"
set_env_value ENABLE_PHONE_SIGNUP "false"
set_env_value ENABLE_PHONE_AUTOCONFIRM "false"
set_env_value ENABLE_EMAIL_AUTOCONFIRM "false"

(
  cd "${TARGET_DIR}"
  sh utils/generate-keys.sh --update-env >/dev/null
  sh utils/add-new-auth-keys.sh --update-env >/dev/null
  printf 'ref=%s\n' "${SUPABASE_RELEASE}" > .supabase-version
  docker compose config --quiet
)

printf 'Prepared Supabase %s at %s.\n' "${SUPABASE_RELEASE}" "${TARGET_DIR}"
printf 'No container was pulled or started. Run ./preflight.sh next.\n'
