export const USER_AI_SECRET_PROVIDERS = [
  'gemini_free',
  'gemini_paid',
  'openai_paid',
  'firecrawl',
  'browserless',
] as const;

export type UserAiSecretProvider = (typeof USER_AI_SECRET_PROVIDERS)[number];

export const USER_AI_PROVIDER_SECRETS_MIGRATION = '20260726000000_user_ai_provider_secrets.sql';
export const USER_AI_PROVIDER_KEY_LIMIT = 20;
