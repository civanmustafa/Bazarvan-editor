import type {
  AiProviderCapabilities,
  AiRuntimeProvider,
} from '../constants/aiProviderCapabilities';
import type { ApiResult } from '../api/http.ts';

type JsonRecord = Record<string, unknown>;

export type AiFallbackStep = {
  provider: AiRuntimeProvider;
  status: number;
  outcome: 'success' | 'failed';
  model?: string;
  keySuffix?: string;
  credentialSource?: string;
  reason?: string;
};

const PROVIDER_FALLBACK_ORDER: Record<AiRuntimeProvider, readonly AiRuntimeProvider[]> = {
  openai: ['openai', 'geminiPaid', 'gemini'],
  geminiPaid: ['geminiPaid', 'gemini'],
  gemini: ['gemini'],
};

const isRecord = (value: unknown): value is JsonRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toProvider = (value: unknown, fallback: AiRuntimeProvider): AiRuntimeProvider => (
  value === 'openai' || value === 'geminiPaid' || value === 'gemini'
    ? value
    : fallback
);

const toSafeAttempt = (value: unknown): JsonRecord | null => {
  if (!isRecord(value)) return null;
  const { keyFingerprint: _keyFingerprint, ...safeAttempt } = value;
  return safeAttempt;
};

const toSafeAttempts = (value: unknown): JsonRecord[] => (
  Array.isArray(value)
    ? value.map(toSafeAttempt).filter((attempt): attempt is JsonRecord => Boolean(attempt))
    : []
);

const toFallbackStep = (
  result: ApiResult,
  fallbackProvider: AiRuntimeProvider,
): AiFallbackStep => {
  const body = isRecord(result.body) ? result.body : {};
  const status = Number.isFinite(result.status) ? result.status : 500;
  const reason = toText(body.code) || toText(body.error).slice(0, 300);
  return {
    provider: toProvider(body.provider, fallbackProvider),
    status,
    outcome: status >= 200 && status < 300 ? 'success' : 'failed',
    ...(toText(body.model) ? { model: toText(body.model) } : {}),
    ...(toText(body.keySuffix) ? { keySuffix: toText(body.keySuffix) } : {}),
    ...(toText(body.credentialSource) ? { credentialSource: toText(body.credentialSource) } : {}),
    ...(reason ? { reason } : {}),
  };
};

const getFallbackSteps = (
  result: ApiResult,
  fallbackProvider: AiRuntimeProvider,
  field: 'providerFallbackChain' | 'credentialFallbackChain',
): AiFallbackStep[] => {
  const body = isRecord(result.body) ? result.body : {};
  const stored = Array.isArray(body[field])
    ? body[field].filter(isRecord).map(step => ({
        provider: toProvider(step.provider, fallbackProvider),
        status: Number.isFinite(Number(step.status)) ? Number(step.status) : result.status,
        outcome: step.outcome === 'success' ? 'success' as const : 'failed' as const,
        ...(toText(step.model) ? { model: toText(step.model) } : {}),
        ...(toText(step.keySuffix) ? { keySuffix: toText(step.keySuffix) } : {}),
        ...(toText(step.credentialSource) ? { credentialSource: toText(step.credentialSource) } : {}),
        ...(toText(step.reason) ? { reason: toText(step.reason) } : {}),
      }))
    : [];
  return stored.length > 0 ? stored : [toFallbackStep(result, fallbackProvider)];
};

const getNestedFallbackAttempts = (
  body: JsonRecord,
  field: 'providerFallbackAttempts' | 'credentialFallbackAttempts',
): JsonRecord[] => (
  Array.isArray(body[field]) ? body[field].filter(isRecord) : []
);

export const getAiProviderFallbackOrder = (
  requestedProvider: AiRuntimeProvider,
): readonly AiRuntimeProvider[] => PROVIDER_FALLBACK_ORDER[requestedProvider];

export const getAvailableAiProviderFallbacks = (
  capabilities: AiProviderCapabilities,
  requestedProvider: AiRuntimeProvider,
): AiRuntimeProvider[] => (
  getAiProviderFallbackOrder(requestedProvider)
    .slice(1)
    .filter(provider => capabilities.providers[provider].available)
);

export const shouldAttemptAiFallback = (result: ApiResult): boolean => {
  const body = isRecord(result.body) ? result.body : {};
  const code = toText(body.code);
  if (
    result.status === 499
    || body.cancelled === true
    || code === 'AI_REQUEST_CANCELLED'
    || code === 'AI_PROVIDER_DISABLED'
  ) {
    return false;
  }

  const summary = isRecord(body.attemptSummary) ? body.attemptSummary : {};
  const blockedCount = Number(summary.blocked || 0);
  const otherFailureCount = ['quota', 'auth', 'server', 'unknown']
    .reduce((total, key) => total + Number(summary[key] || 0), 0);
  if (blockedCount > 0 && otherFailureCount === 0) return false;

  if (code === 'AI_PROVIDER_NOT_CONFIGURED') return true;
  return [401, 403, 408, 429].includes(result.status) || result.status >= 500;
};

export const mergeCredentialFallbackResult = (options: {
  previous: ApiResult;
  next: ApiResult;
  provider: AiRuntimeProvider;
  requestedCredentialSource: string;
}): ApiResult => {
  const previousBody = isRecord(options.previous.body) ? options.previous.body : {};
  const nextBody = isRecord(options.next.body) ? options.next.body : {};
  const previousAttempts = toSafeAttempts(previousBody.attempts);
  const previousAttemptGroups = getNestedFallbackAttempts(previousBody, 'credentialFallbackAttempts');
  return {
    ...options.next,
    body: {
      ...nextBody,
      requestedCredentialSource: options.requestedCredentialSource,
      credentialFallbackUsed: true,
      credentialFallbackChain: [
        ...getFallbackSteps(options.previous, options.provider, 'credentialFallbackChain'),
        ...getFallbackSteps(options.next, options.provider, 'credentialFallbackChain'),
      ],
      credentialFallbackAttempts: [
        ...previousAttemptGroups,
        ...(previousAttempts.length > 0
          ? [{
              provider: options.provider,
              credentialSource: toText(previousBody.credentialSource),
              attempts: previousAttempts,
            }]
          : []),
        ...getNestedFallbackAttempts(nextBody, 'credentialFallbackAttempts'),
      ],
    },
  };
};

export const mergeProviderFallbackResult = (options: {
  previous: ApiResult;
  next: ApiResult;
  requestedProvider: AiRuntimeProvider;
}): ApiResult => {
  const previousBody = isRecord(options.previous.body) ? options.previous.body : {};
  const nextBody = isRecord(options.next.body) ? options.next.body : {};
  const previousAttempts = toSafeAttempts(previousBody.attempts);
  const previousAttemptGroups = getNestedFallbackAttempts(previousBody, 'providerFallbackAttempts');
  const previousCredentialAttemptGroups = getNestedFallbackAttempts(
    previousBody,
    'credentialFallbackAttempts',
  );
  return {
    ...options.next,
    body: {
      ...nextBody,
      requestedProvider: options.requestedProvider,
      providerFallbackUsed: true,
      providerFallbackChain: [
        ...getFallbackSteps(options.previous, options.requestedProvider, 'providerFallbackChain'),
        ...getFallbackSteps(
          options.next,
          toProvider(nextBody.provider, options.requestedProvider),
          'providerFallbackChain',
        ),
      ],
      providerFallbackAttempts: [
        ...previousAttemptGroups,
        ...previousCredentialAttemptGroups,
        ...(previousAttempts.length > 0
          ? [{
              provider: toProvider(previousBody.provider, options.requestedProvider),
              credentialSource: toText(previousBody.credentialSource),
              attempts: previousAttempts,
            }]
          : []),
        ...getNestedFallbackAttempts(nextBody, 'providerFallbackAttempts'),
      ],
    },
  };
};
