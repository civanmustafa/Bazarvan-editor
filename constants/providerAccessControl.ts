export const PROVIDER_ACCESS_PROVIDERS = [
  'gemini_free',
  'gemini_paid',
  'openai',
  'firecrawl',
  'browserless',
] as const;

export type ProviderAccessProvider = (typeof PROVIDER_ACCESS_PROVIDERS)[number];

export const PROVIDER_CREDENTIAL_PURPOSES = [
  'default',
  'content_writing_resume',
] as const;

export type ProviderCredentialPurpose = (typeof PROVIDER_CREDENTIAL_PURPOSES)[number];

export const PROVIDER_CREDENTIAL_MODES = [
  'personal_first',
  'assigned_first',
  'assigned_only',
  'personal_only',
  'global_only',
  'disabled',
] as const;

export type ProviderCredentialMode = (typeof PROVIDER_CREDENTIAL_MODES)[number];

export const PROVIDER_ACCESS_MIGRATION = '20260827000000_provider_access_control.sql';
export const PROVIDER_EXPLICIT_GRANTS_MIGRATION =
  '20260829040000_provider_credentials_explicit_grants.sql';

export const PROVIDER_ACCESS_LABELS: Record<ProviderAccessProvider, string> = {
  gemini_free: 'Gemini المجاني',
  gemini_paid: 'Gemini المدفوع',
  openai: 'OpenAI / ChatGPT',
  firecrawl: 'Firecrawl',
  browserless: 'Browserless',
};

export const DEFAULT_PROVIDER_CREDENTIAL_MODE: ProviderCredentialMode = 'personal_first';

export const isProviderAccessProvider = (value: unknown): value is ProviderAccessProvider => (
  typeof value === 'string'
  && PROVIDER_ACCESS_PROVIDERS.includes(value as ProviderAccessProvider)
);

export const isProviderCredentialMode = (value: unknown): value is ProviderCredentialMode => (
  typeof value === 'string'
  && PROVIDER_CREDENTIAL_MODES.includes(value as ProviderCredentialMode)
);
