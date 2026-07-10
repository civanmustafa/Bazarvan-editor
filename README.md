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
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Hostinger Deploy

Canonical server path:

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

PM2 runs the web server and the external-analysis worker from `/var/www/bazarvan-editor`; do not use `/var/www/bazarvan-smarteditor` unless PM2 is intentionally reconfigured.
