export const CONTENT_WRITING_PROVIDERS = [
  'gemini',
  'geminiPaid',
  'openai',
] as const;

export type UserContentWritingProvider = (typeof CONTENT_WRITING_PROVIDERS)[number];

export const AUTOMATIC_CONTENT_WRITING_PROVIDER_CHOICES = [
  'system',
  ...CONTENT_WRITING_PROVIDERS,
] as const;

export type UserAutomaticContentWritingProvider =
  (typeof AUTOMATIC_CONTENT_WRITING_PROVIDER_CHOICES)[number];

export const PAID_CONTENT_WRITING_PROVIDERS = ['geminiPaid', 'openai'] as const;
export type UserPaidContentWritingProvider = (typeof PAID_CONTENT_WRITING_PROVIDERS)[number];

export type UserAiRoutingPreferences = {
  contentWritingProvider: UserContentWritingProvider;
  automaticContentWritingProvider: UserAutomaticContentWritingProvider;
  freeFirstFallbackEnabled: boolean;
  paidFallbackProvider: UserPaidContentWritingProvider;
};

export const USER_AI_ROUTING_DEFAULTS: UserAiRoutingPreferences = {
  contentWritingProvider: 'gemini',
  automaticContentWritingProvider: 'system',
  // Never opt an existing user into paid traffic without an explicit choice.
  freeFirstFallbackEnabled: false,
  paidFallbackProvider: 'geminiPaid',
};

export const isUserContentWritingProvider = (
  value: unknown,
): value is UserContentWritingProvider => (
  typeof value === 'string'
  && CONTENT_WRITING_PROVIDERS.includes(value as UserContentWritingProvider)
);

export const isUserAutomaticContentWritingProvider = (
  value: unknown,
): value is UserAutomaticContentWritingProvider => (
  typeof value === 'string'
  && AUTOMATIC_CONTENT_WRITING_PROVIDER_CHOICES.includes(
    value as UserAutomaticContentWritingProvider,
  )
);

export const isUserPaidContentWritingProvider = (
  value: unknown,
): value is UserPaidContentWritingProvider => (
  typeof value === 'string'
  && PAID_CONTENT_WRITING_PROVIDERS.includes(value as UserPaidContentWritingProvider)
);

export const normalizeUserAiRoutingPreferences = (
  value: unknown,
): UserAiRoutingPreferences => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    contentWritingProvider: isUserContentWritingProvider(source.contentWritingProvider)
      ? source.contentWritingProvider
      : USER_AI_ROUTING_DEFAULTS.contentWritingProvider,
    automaticContentWritingProvider: isUserAutomaticContentWritingProvider(
      source.automaticContentWritingProvider,
    )
      ? source.automaticContentWritingProvider
      : USER_AI_ROUTING_DEFAULTS.automaticContentWritingProvider,
    freeFirstFallbackEnabled: typeof source.freeFirstFallbackEnabled === 'boolean'
      ? source.freeFirstFallbackEnabled
      : USER_AI_ROUTING_DEFAULTS.freeFirstFallbackEnabled,
    paidFallbackProvider: isUserPaidContentWritingProvider(source.paidFallbackProvider)
      ? source.paidFallbackProvider
      : USER_AI_ROUTING_DEFAULTS.paidFallbackProvider,
  };
};
