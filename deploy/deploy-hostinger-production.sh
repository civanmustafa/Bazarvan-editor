#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="${HOSTINGER_DEPLOY_PATH:-/var/www/bazarvan-editor-staging}"
readonly BRANCH="${DEPLOY_BRANCH:-main}"
readonly TARGET_COMMIT="${DEPLOY_COMMIT:?DEPLOY_COMMIT is required}"
readonly DEPLOY_LOCK="/tmp/bazarvan-hostinger-production-deploy.lock"

if [[ ! "${TARGET_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_COMMIT must be a full Git commit SHA." >&2
  exit 1
fi

for command_name in git npm pm2 curl flock; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required deployment command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "The Hostinger deployment repository was not found at ${APP_DIR}." >&2
  exit 1
fi

exec 9>"${DEPLOY_LOCK}"
if ! flock -w 600 9; then
  echo "Another Hostinger deployment is still running." >&2
  exit 1
fi

cd "${APP_DIR}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked changes exist on the Hostinger checkout; deployment stopped to preserve them." >&2
  exit 1
fi

git fetch --prune origin "${BRANCH}"
readonly REMOTE_COMMIT="$(git rev-parse "origin/${BRANCH}")"

if [[ "${REMOTE_COMMIT}" != "${TARGET_COMMIT}" ]]; then
  echo "Skipping superseded deployment ${TARGET_COMMIT}; origin/${BRANCH} is ${REMOTE_COMMIT}."
  exit 0
fi

git switch "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

readonly CHECKED_OUT_COMMIT="$(git rev-parse HEAD)"
if [[ "${CHECKED_OUT_COMMIT}" != "${TARGET_COMMIT}" ]]; then
  echo "Checked-out commit ${CHECKED_OUT_COMMIT} does not match ${TARGET_COMMIT}." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing ${APP_DIR}/.env.production." >&2
  exit 1
fi

readonly PM2_APPS=(
  bazarvan-editor-staging
  bazarvan-staging-competitor-worker
  bazarvan-staging-ai-worker
  bazarvan-staging-full-article-pipeline-worker
  bazarvan-staging-ai-job-worker
  bazarvan-staging-content-writing-worker
  bazarvan-staging-client-page-crawler
)
readonly CONTENT_WRITING_PREPARATION_APP="bazarvan-staging-content-writing-preparation-worker"

for app_name in "${PM2_APPS[@]}"; do
  if ! pm2 describe "${app_name}" >/dev/null 2>&1; then
    echo "Required PM2 process is unavailable: ${app_name}" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1091
source .env.production
set +a

npm ci --include=dev
npm run build

for app_name in "${PM2_APPS[@]}"; do
  if [[ "${app_name}" == "bazarvan-staging-ai-worker" ]]; then
    EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=semantic_keywords_lsi,content_brief_generation,meta_description_generation,engineering_command \
      pm2 restart "${app_name}" --update-env
  else
    pm2 restart "${app_name}" --update-env
  fi
done

if pm2 describe "${CONTENT_WRITING_PREPARATION_APP}" >/dev/null 2>&1; then
  pm2 restart "${CONTENT_WRITING_PREPARATION_APP}" --update-env
else
  NODE_ENV=production \
  EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=content_writing_preparation \
  EXTERNAL_ANALYSIS_WORKER_POLL_MS="${CONTENT_WRITING_PREPARATION_WORKER_POLL_MS:-5000}" \
  EXTERNAL_ANALYSIS_WORKER_IDLE_MAX_MS="${CONTENT_WRITING_PREPARATION_WORKER_IDLE_MAX_MS:-30000}" \
  EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS="${CONTENT_WRITING_PREPARATION_LEASE_SECONDS:-1800}" \
  EXTERNAL_ANALYSIS_RETRY_MINUTES="${EXTERNAL_ANALYSIS_RETRY_MINUTES:-30}" \
  EXTERNAL_ANALYSIS_MAX_RETRY_COUNT="${EXTERNAL_ANALYSIS_MAX_RETRY_COUNT:-5}" \
  EXTERNAL_ANALYSIS_WORKER_CONCURRENCY=1 \
    pm2 start server-dist/external-analysis-worker.mjs \
      --name "${CONTENT_WRITING_PREPARATION_APP}" \
      --cwd "${APP_DIR}" \
      --restart-delay 2000 \
      --kill-timeout 15000
fi

pm2 describe "${CONTENT_WRITING_PREPARATION_APP}" >/dev/null
pm2 save

wait_for_endpoint() {
  local endpoint="$1"
  local attempt
  for attempt in {1..12}; do
    if curl --fail --silent --show-error --max-time 15 "${endpoint}" >/dev/null; then
      return 0
    fi
    if (( attempt < 12 )); then
      sleep 5
    fi
  done
  echo "Deployment health check failed: ${endpoint}" >&2
  return 1
}

wait_for_endpoint "https://smarteditor.bazarvan.com/healthz"
wait_for_endpoint "https://smarteditor.bazarvan.com/readyz"

echo "Hostinger deployment completed successfully at ${CHECKED_OUT_COMMIT}."
