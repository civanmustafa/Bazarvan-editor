<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1fFOcvdpfbinFoVmTjLpdhQ8JL89L1p7u

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Configure the Supabase values and the server-only `AI_SETTINGS_ENCRYPTION_KEY` from [.env.example](.env.example). Provider API keys are saved from the authenticated dashboard, not from `.env.local`.
3. Run the app:
   `npm run dev`

## Hostinger Deploy

Canonical server path:

```bash
cd /var/www/bazarvan-editor-staging
git pull --ff-only origin main
BAZARVAN_APPROVE_MIGRATIONS=1 bash deploy/hostinger-supabase/apply-project-migrations.sh
bash deploy/hostinger-supabase/verify-project-schema.sh
DEPLOY_COMMIT=<FULL_40_CHARACTER_GIT_SHA> bash deploy/deploy-hostinger-production.sh
```

PM2 runs the public self-hosted-Supabase release from `/var/www/bazarvan-editor-staging`.
The older `/var/www/bazarvan-editor` checkout is archival and must not be restarted.
See `deploy/HOSTINGER_CANONICAL_DEPLOY.md` for the protected deployment and verification procedure.
