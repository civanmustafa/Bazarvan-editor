# Hostinger canonical deployment path

Use this server path for Bazarvan Editor deployments:

```bash
cd /var/www/bazarvan-editor
git pull origin main
set -a
source .env.server
set +a
npm run build
pm2 restart bazarvan-editor --update-env
pm2 save
curl -I https://smarteditor.bazarvan.com/admin
```

Notes:

- PM2 `script path` is `/var/www/bazarvan-editor`, so this is the canonical path.
- Do not use `/var/www/bazarvan-smarteditor` for future deploy instructions unless PM2 is intentionally reconfigured.
- If deployment behavior is unclear, verify with `pm2 describe bazarvan-editor` and use the `exec cwd` / `script path` shown there.
