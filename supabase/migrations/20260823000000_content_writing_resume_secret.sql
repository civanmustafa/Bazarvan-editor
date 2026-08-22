begin;

alter table public.ai_provider_secrets
  drop constraint if exists ai_provider_secrets_provider_check;

alter table public.ai_provider_secrets
  add constraint ai_provider_secrets_provider_check
  check (provider in (
    'openai_latest',
    'gemini_latest',
    'content_writing_resume_gemini',
    'content_writing_resume_gemini_paid',
    'content_writing_resume_openai'
  ));

comment on table public.ai_provider_secrets is
  'Server-only AES-256-GCM encrypted administrator keys, including provider defaults and dedicated content-writing resume keys.';

commit;
