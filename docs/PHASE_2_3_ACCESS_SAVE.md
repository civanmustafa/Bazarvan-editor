# Phase 2/3: Canonical Access And Atomic Article Save

## Access policy

`public.article_access_level_for_user(article_id, user_id)` is the single source of truth for article access. It returns one of:

- `none`
- `read`
- `write`
- `admin`

RLS, dashboard pagination, assigned-article automation, and external-analysis requests now delegate to this policy. Server code must not rebuild ownership or assignment checks locally.

## Save transaction

`public.save_article_snapshot(...)` performs these operations in one database transaction:

1. Verifies the authenticated active profile and write permission.
2. Locks the idempotency key for the current transaction.
3. Creates or updates the article.
4. Inserts the matching `article_versions` row.
5. Stores the small request key, article ID, and version number in `article_save_requests`.

Reusing the same idempotency key returns the same article and original version reference without creating another article or version. The browser retries one failed network/server request with the same key.
Idempotency rows older than seven days are removed opportunistically during later saves; full article content is never duplicated into this table.

Only the compact dashboard statistics are saved. Detailed analysis results and duplicate-tab data are not written by the article-save transaction.

## Deployment order

1. Back up Supabase.
2. Apply `20260713000000_phase_0_1_security_hardening.sql` if it has not been applied.
3. Apply `20260713010000_phase_2_3_access_and_atomic_article_save.sql`.
4. Deploy and restart both PM2 processes from `/var/www/bazarvan-editor`.
5. Verify `/healthz`, create a new article, manually save it, reload it, and wait for one autosave cycle.
