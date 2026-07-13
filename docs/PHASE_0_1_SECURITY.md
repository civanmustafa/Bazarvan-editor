# Phase 0/1 Security Baseline

This release establishes the first security baseline without changing the AI generation strategy.

## Implemented controls

- Gemini and OpenAI browser routes require an active Supabase session.
- Gemini progress and cancellation are restricted to the user who created the job.
- AI request rate, body size, prompt size, history size, model selection, and browser origin are bounded.
- The public health endpoint returns service availability only.
- Article status mutation requires write access, and viewer access cannot run assigned automation.
- Production builds scan tracked files for credential-shaped values.

## Production actions required

1. Back up the Supabase database before applying the new migration.
2. Rotate every credential that has appeared in a terminal screenshot, chat, or local note file.
3. Update `.env.production` on Hostinger with the rotated values and restart both PM2 processes.
4. Apply `supabase/migrations/20260713000000_phase_0_1_security_hardening.sql`.
5. Keep local secret notes outside the repository. Files matching `supabase/migrations/*.txt` are now ignored.

Do not print secret values while verifying them. Verify only presence and key counts.

## Optional limits

```text
ALLOWED_API_ORIGINS=https://smarteditor.bazarvan.com
API_JSON_LIMIT=12mb
AI_MAX_PROMPT_CHARS=500000
API_AUTH_CACHE_TTL_SECONDS=30
GEMINI_START_RATE_LIMIT_PER_MINUTE=30
GEMINI_PROGRESS_RATE_LIMIT_PER_MINUTE=600
GEMINI_CANCEL_RATE_LIMIT_PER_MINUTE=30
OPENAI_START_RATE_LIMIT_PER_MINUTE=20
OPENAI_ALLOWED_MODELS=gpt-5.4
```

## Verification

```bash
npm run verify:security
npm run build
curl -fsS https://smarteditor.bazarvan.com/healthz
```

An unauthenticated `POST /api/gemini` or `POST /api/chatgpt` must return `401`. The application itself must continue to work because authenticated browser requests now attach the Supabase access token.
