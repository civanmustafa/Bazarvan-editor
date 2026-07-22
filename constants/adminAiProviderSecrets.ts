export const ADMIN_AI_SECRET_PROVIDERS = ['openai_latest', 'gemini_latest'] as const;
export type AdminAiSecretProvider = (typeof ADMIN_AI_SECRET_PROVIDERS)[number];

export const ADMIN_AI_PROVIDER_SECRETS_MIGRATION = '20260722050000_admin_ai_provider_secrets.sql';
