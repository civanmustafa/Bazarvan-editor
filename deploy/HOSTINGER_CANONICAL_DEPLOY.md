# Hostinger canonical deployment path

Use this server path for Bazarvan Editor deployments:

Before the first external-analysis worker deployment, apply these migrations in Supabase SQL Editor in order:

1. `supabase/migrations/20260710000000_external_analysis_foundation.sql`
2. `supabase/migrations/20260710010000_external_analysis_worker_queue.sql`
3. `supabase/migrations/20260710020000_external_semantic_generation.sql`
4. `supabase/migrations/20260710030000_external_engineering_commands.sql`
5. `supabase/migrations/20260711000000_external_analysis_job_controls.sql`
6. `supabase/migrations/20260711010000_dashboard_filtered_pagination.sql`
7. `supabase/migrations/20260711020000_external_analysis_scheduler_settings.sql`
8. `supabase/migrations/20260711030000_external_analysis_command_preferences.sql`
9. `supabase/migrations/20260712000000_external_analysis_independent_batches.sql`
10. `supabase/migrations/20260713000000_phase_0_1_security_hardening.sql`
11. `supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql`

Apply migrations 10 and 11 before deploying the matching web/server build. The new article-save endpoint depends on the `save_article_snapshot` RPC introduced by migration 11.

Before deploying structured content writing, apply these migrations in order:

1. `supabase/migrations/20260722000000_content_writing_sessions.sql` (skip only if it was already applied successfully)
2. `supabase/migrations/20260722010000_structured_content_writing.sql`
3. `supabase/migrations/20260722020000_content_writing_application.sql`
4. `supabase/migrations/20260722030000_content_writing_external_reporting.sql`
5. `supabase/migrations/20260722040000_content_writing_quality_guards.sql`

These migrations add durable sessions, resumable steps, reviewed insertion, external-result reporting, and the active-session quality guard. Apply all five before deploying the matching server build. The `/readyz` deployment check returns HTTP 503 when the required content-writing schema is unavailable.

Before enabling administrator-managed OpenAI or Gemini paid keys:

1. Apply `supabase/migrations/20260722050000_admin_ai_provider_secrets.sql` in Supabase SQL Editor.
2. Generate one encryption key on the server with `openssl rand -base64 32`.
3. Add the generated value as `AI_SETTINGS_ENCRYPTION_KEY` in `/var/www/bazarvan-editor/.env.production`.
4. Keep the existing `OPENAI_API_KEY` and `GEMINI_PAID_API_KEYS` values; they remain the Hostinger fallback whenever an administrator override is disabled.

The raw administrator keys are encrypted with AES-256-GCM before storage, are never returned by the settings API, and are never readable by the `anon` or `authenticated` Supabase roles. Losing or changing `AI_SETTINGS_ENCRYPTION_KEY` makes already stored administrator overrides unreadable; keep it in the server environment and backup only.

```bash
cd /var/www/bazarvan-editor
git pull --ff-only origin main
set -a
source .env.production
set +a
npm ci
npm run build
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://smarteditor.bazarvan.com/healthz
curl -fsS https://smarteditor.bazarvan.com/readyz
```

Notes:

- PM2 runs the web server and all configured workers, including `bazarvan-content-writing-worker`, from `/var/www/bazarvan-editor`, so this is the canonical path.
- Do not use `/var/www/bazarvan-smarteditor` for future deploy instructions unless PM2 is intentionally reconfigured.
- `/healthz` is the liveness check. `/readyz` additionally verifies the production build, required Supabase schemas, and `AI_SETTINGS_ENCRYPTION_KEY`.
- If deployment behavior is unclear, verify all processes with `pm2 status`, then inspect the web process with `pm2 describe bazarvan-editor` and the writing worker with `pm2 describe bazarvan-content-writing-worker`.
