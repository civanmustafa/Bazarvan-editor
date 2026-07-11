# Hostinger canonical deployment path

Use this server path for Bazarvan Editor deployments:

Before the first external-analysis worker deployment, apply these migrations in Supabase SQL Editor in order:

1. `supabase/migrations/20260710000000_external_analysis_foundation.sql`
2. `supabase/migrations/20260710010000_external_analysis_worker_queue.sql`
3. `supabase/migrations/20260710020000_external_semantic_generation.sql`
4. `supabase/migrations/20260710030000_external_engineering_commands.sql`
5. `supabase/migrations/20260711000000_external_analysis_job_controls.sql`

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
```

Notes:

- PM2 runs `bazarvan-editor` and `bazarvan-ai-worker` from `/var/www/bazarvan-editor`, so this is the canonical path.
- Do not use `/var/www/bazarvan-smarteditor` for future deploy instructions unless PM2 is intentionally reconfigured.
- If deployment behavior is unclear, verify both processes with `pm2 status`, then inspect them with `pm2 describe bazarvan-editor` and `pm2 describe bazarvan-ai-worker`.
