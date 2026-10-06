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

for command_name in git npm pm2 curl flock docker; do
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

readonly AUTOMATION_APP="bazarvan-staging-automation-worker"
readonly REQUIRED_PM2_APPS=(
  bazarvan-editor-staging
  bazarvan-staging-ai-job-worker
  bazarvan-staging-content-writing-worker
  bazarvan-staging-client-page-crawler
)
readonly LEGACY_AUTOMATION_APPS=(
  bazarvan-staging-competitor-worker
  bazarvan-staging-ai-worker
  bazarvan-staging-full-article-pipeline-worker
  bazarvan-staging-content-writing-preparation-worker
)

for app_name in "${REQUIRED_PM2_APPS[@]}"; do
  if ! pm2 describe "${app_name}" >/dev/null 2>&1; then
    echo "Required PM2 process is unavailable: ${app_name}" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1091
source .env.production
set +a

BAZARVAN_APPROVE_MIGRATIONS=1 BAZARVAN_ALLOW_STOPPED_PM2=1 EXPECTED_MIGRATIONS=158 \
  bash deploy/hostinger-supabase/apply-project-migrations.sh

npm ci --include=dev
npm run build

pm2 restart bazarvan-editor-staging --update-env

AI_JOB_WORKER_POLL_MS=10000 \
AI_JOB_WORKER_IDLE_MAX_MS=30000 \
AI_JOB_WORKER_CONCURRENCY=1 \
  pm2 restart bazarvan-staging-ai-job-worker --update-env

CONTENT_WRITING_WORKER_POLL_MS=10000 \
CONTENT_WRITING_WORKER_IDLE_MAX_MS=30000 \
CONTENT_WRITING_WORKER_CONCURRENCY=1 \
  pm2 restart bazarvan-staging-content-writing-worker --update-env

CLIENT_PAGE_CRAWLER_POLL_MS=10000 \
CLIENT_PAGE_CRAWLER_IDLE_MAX_MS=30000 \
CLIENT_PAGE_CRAWLER_CONCURRENCY=1 \
  pm2 restart bazarvan-staging-client-page-crawler --update-env

if pm2 describe "${AUTOMATION_APP}" >/dev/null 2>&1; then
  EXTERNAL_ANALYSIS_AUTOMATION_MASTER=true \
  EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=semantic_keywords_lsi,content_brief_generation,meta_description_generation,engineering_command,duplicate_cleanup,competitor_discovery,competitor_extraction,full_article_pipeline,content_writing_preparation \
  EXTERNAL_ANALYSIS_WORKER_POLL_MS=10000 \
  EXTERNAL_ANALYSIS_WORKER_IDLE_MAX_MS=30000 \
  EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS=1800 \
  EXTERNAL_ANALYSIS_WORKER_CONCURRENCY=2 \
    pm2 restart "${AUTOMATION_APP}" --update-env
else
  NODE_ENV=production \
  EXTERNAL_ANALYSIS_AUTOMATION_MASTER=true \
  EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=semantic_keywords_lsi,content_brief_generation,meta_description_generation,engineering_command,duplicate_cleanup,competitor_discovery,competitor_extraction,full_article_pipeline,content_writing_preparation \
  EXTERNAL_ANALYSIS_WORKER_POLL_MS=10000 \
  EXTERNAL_ANALYSIS_WORKER_IDLE_MAX_MS=30000 \
  EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS=1800 \
  EXTERNAL_ANALYSIS_RETRY_MINUTES="${EXTERNAL_ANALYSIS_RETRY_MINUTES:-30}" \
  EXTERNAL_ANALYSIS_MAX_RETRY_COUNT="${EXTERNAL_ANALYSIS_MAX_RETRY_COUNT:-5}" \
  EXTERNAL_ANALYSIS_WORKER_CONCURRENCY=2 \
    pm2 start server-dist/external-analysis-worker.mjs \
      --name "${AUTOMATION_APP}" \
      --cwd "${APP_DIR}" \
      --restart-delay 2000 \
      --kill-timeout 15000
fi

pm2 describe "${AUTOMATION_APP}" >/dev/null

# Retire only the four exact legacy processes after the unified worker is up.
for app_name in "${LEGACY_AUTOMATION_APPS[@]}"; do
  if pm2 describe "${app_name}" >/dev/null 2>&1; then
    pm2 delete "${app_name}"
  fi
done
pm2 save

# A migration can revive competitor-discovery rows while the previous worker
# process is still serving. Run the idempotent recovery function again only
# after every worker has restarted on the deployed commit, so an old runtime
# cannot put the rows back behind the retired semantic-keywords prerequisite.
docker exec -i "${DB_CONTAINER:-supabase-db}" \
  psql -X -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" \
    -v ON_ERROR_STOP=1 -Atq <<'SQL'
select public.enqueue_competitor_discovery_job_by_signature(
  recoverable.article_id,
  null,
  'auto'
)
from (
  select distinct job.article_id
  from public.ai_external_analysis_jobs as job
  where job.job_type = 'competitor_discovery'
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status = 'waiting_for_prerequisites'
    and job.result is null
    and job.last_error_code = 'content_research_automation_changed'
    and job.progress->>'blockedBy' = 'semantic_keywords'
) as recoverable;

select public.release_recoverable_automatic_focus_stalls(50);
SQL

EXPECTED_MIGRATIONS=158 \
  bash deploy/hostinger-supabase/verify-project-schema.sh

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
