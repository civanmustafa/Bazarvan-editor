export const AI_KEY_USAGE_FEEDBACK_EVENT = 'bazarvan:ai-credential-feedback';

export type AiKeyUsageOutcome = 'success' | 'failed';

export type AiKeyUsageEntry = {
  keySuffix: string;
  outcome: AiKeyUsageOutcome;
  status?: number;
  reason?: string;
  model?: string;
};

export type AiKeyUsageFeedback = {
  id: string;
  provider: string;
  surface?: string;
  entries: AiKeyUsageEntry[];
  createdAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const toStatus = (value: unknown): number | undefined => {
  const status = Number(value);
  return Number.isFinite(status) && status > 0 ? Math.round(status) : undefined;
};

const toOutcome = (value: unknown): AiKeyUsageOutcome | undefined => {
  if (value === 'success') return 'success';
  if (value === 'failed' || value === 'failure' || value === 'error') return 'failed';
  return undefined;
};

const outcomeFromStatus = (status: number | undefined): AiKeyUsageOutcome | undefined => {
  if (!status || status === 499) return undefined;
  return status >= 200 && status < 300 ? 'success' : status >= 400 ? 'failed' : undefined;
};

export const normalizeAiKeySuffix = (value: unknown): string => (
  toText(value).replace(/^[.…•]+/, '').slice(-6)
);

export const formatAiKeySuffix = (value: unknown): string => {
  const suffix = normalizeAiKeySuffix(value);
  return suffix ? `••••${suffix}` : '';
};

export const collectAiKeyUsageEntries = (
  value: unknown,
  defaultOutcome?: AiKeyUsageOutcome,
): AiKeyUsageEntry[] => {
  const collected: AiKeyUsageEntry[] = [];
  const seen = new Set<string>();

  const add = (source: Record<string, unknown>, fallbackOutcome?: AiKeyUsageOutcome): void => {
    const keySuffix = normalizeAiKeySuffix(source.keySuffix ?? source.key_suffix);
    const status = toStatus(source.status);
    const outcome = toOutcome(source.outcome) || outcomeFromStatus(status) || fallbackOutcome;
    if (!keySuffix || !outcome) return;
    const reason = toText(source.reason || source.error || source.errorCode || source.error_code);
    const model = toText(source.model);
    const dedupeKey = [keySuffix, outcome, status || ''].join(':');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    collected.push({
      keySuffix,
      outcome,
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
      ...(model ? { model } : {}),
    });
  };

  const visit = (source: unknown, fallbackOutcome?: AiKeyUsageOutcome, depth = 0): void => {
    if (depth > 6) return;
    if (Array.isArray(source)) {
      source.forEach(item => visit(item, fallbackOutcome, depth + 1));
      return;
    }
    if (!isRecord(source)) return;

    const sourceOutcome = toOutcome(source.outcome) || outcomeFromStatus(toStatus(source.status)) || fallbackOutcome;
    add(source, sourceOutcome);
    if (Array.isArray(source.attempts)) visit(source.attempts, 'failed', depth + 1);
    if (Array.isArray(source.keyAttempts)) visit(source.keyAttempts, 'failed', depth + 1);
    if (Array.isArray(source.key_attempts)) visit(source.key_attempts, 'failed', depth + 1);
    if (Array.isArray(source.credentialFallbackChain)) visit(source.credentialFallbackChain, undefined, depth + 1);
    if (Array.isArray(source.credentialFallbackAttempts)) visit(source.credentialFallbackAttempts, 'failed', depth + 1);
    if (Array.isArray(source.providerFallbackChain)) visit(source.providerFallbackChain, undefined, depth + 1);
    if (Array.isArray(source.providerFallbackAttempts)) visit(source.providerFallbackAttempts, 'failed', depth + 1);

    const nestedKeys = ['execution', 'providerMetadata', 'responseMetadata', 'result'] as const;
    nestedKeys.forEach(key => {
      if (source[key] !== undefined) visit(source[key], sourceOutcome, depth + 1);
    });
  };

  visit(value, defaultOutcome);
  return collected;
};

export const notifyAiKeyUsageFeedback = (options: {
  provider: string;
  status?: number;
  payload: unknown;
  surface?: string;
}): AiKeyUsageFeedback | null => {
  const defaultOutcome = outcomeFromStatus(options.status);
  const entries = collectAiKeyUsageEntries(options.payload, defaultOutcome);
  if (entries.length === 0) return null;
  const feedback: AiKeyUsageFeedback = {
    id: typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: toText(options.provider) || 'AI',
    ...(toText(options.surface) ? { surface: toText(options.surface) } : {}),
    entries,
    createdAt: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AiKeyUsageFeedback>(AI_KEY_USAGE_FEEDBACK_EVENT, {
      detail: feedback,
    }));
  }
  return feedback;
};
