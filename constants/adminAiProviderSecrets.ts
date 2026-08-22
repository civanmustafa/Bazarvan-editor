export const ADMIN_AI_STANDARD_SECRET_PROVIDERS = ['openai_latest', 'gemini_latest'] as const;

export const CONTENT_WRITING_RESUME_SECRET_PROVIDERS = [
  'content_writing_resume_gemini',
  'content_writing_resume_gemini_paid',
  'content_writing_resume_openai',
] as const;

export const ADMIN_AI_SECRET_PROVIDERS = [
  ...ADMIN_AI_STANDARD_SECRET_PROVIDERS,
  ...CONTENT_WRITING_RESUME_SECRET_PROVIDERS,
] as const;
export type AdminAiSecretProvider = (typeof ADMIN_AI_SECRET_PROVIDERS)[number];

export type ContentWritingResumeSecretProvider =
  (typeof CONTENT_WRITING_RESUME_SECRET_PROVIDERS)[number];

export const CONTENT_WRITING_RESUME_SECRET_MIGRATION =
  '20260823000000_content_writing_resume_secret.sql';

export const ADMIN_AI_PROVIDER_SECRETS_MIGRATION = '20260722050000_admin_ai_provider_secrets.sql';
