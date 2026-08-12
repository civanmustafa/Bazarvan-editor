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

export type AiModelKeyAvailability = {
  source: string;
  configuredCount: number;
  excludedCount: number;
  inactiveCount: number;
  disabledCount: number;
  leasedCount: number;
  cooldownCount: number;
  eligibleCount: number;
  nextEligibleAt?: string;
};

export type AiModelKeyReport = {
  provider?: string;
  credentialSource?: string;
  model: string;
  status: string;
  configuredKeyCount: number;
  attemptedKeyCount: number;
  attemptCount: number;
  availabilityCheckCount: number;
  waitedMs: number;
  successfulKeySuffix?: string;
  lastAvailability?: AiModelKeyAvailability;
  entries: AiKeyUsageEntry[];
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

  const add = (source: Record<string, unknown>, fallbackOutcome?: AiKeyUsageOutcome): void => {
    const keySuffix = normalizeAiKeySuffix(source.keySuffix ?? source.key_suffix);
    const status = toStatus(source.status);
    const outcome = toOutcome(source.outcome) || outcomeFromStatus(status) || fallbackOutcome;
    if (!keySuffix || !outcome) return;
    const reason = toText(source.reason || source.error || source.errorCode || source.error_code);
    const model = toText(source.model);
    const duplicate = collected.some(entry => (
      entry.keySuffix === keySuffix
      && entry.outcome === outcome
      && entry.status === status
      && (!entry.model || !model || entry.model === model)
    ));
    if (duplicate) return;
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

    const nestedKeys = ['execution', 'providerMetadata', 'responseMetadata', 'result', 'progress', 'gemini'] as const;
    nestedKeys.forEach(key => {
      if (source[key] !== undefined) visit(source[key], sourceOutcome, depth + 1);
    });
  };

  visit(value, defaultOutcome);
  return collected;
};

export const collectAiModelKeyReports = (value: unknown): AiModelKeyReport[] => {
  const rawReports: Record<string, unknown>[] = [];
  const visit = (
    source: unknown,
    depth = 0,
    inherited: { provider?: string; credentialSource?: string } = {},
  ): void => {
    if (depth > 6) return;
    if (Array.isArray(source)) {
      source.forEach(item => visit(item, depth + 1, inherited));
      return;
    }
    if (!isRecord(source)) return;
    const context = {
      provider: toText(source.provider) || inherited.provider,
      credentialSource: toText(source.credentialSource) || inherited.credentialSource,
    };
    if (Array.isArray(source.modelKeyReports)) {
      source.modelKeyReports.forEach(report => {
        if (isRecord(report)) rawReports.push({
          ...report,
          ...(context.provider ? { reportProvider: context.provider } : {}),
          ...(context.credentialSource ? { reportCredentialSource: context.credentialSource } : {}),
        });
      });
    }
    const nestedKeys = [
      'execution',
      'providerMetadata',
      'responseMetadata',
      'result',
      'gemini',
      'credentialFallbackChain',
      'providerFallbackChain',
      'credentialFallbackAttempts',
      'providerFallbackAttempts',
    ] as const;
    nestedKeys.forEach(key => {
      if (source[key] !== undefined) visit(source[key], depth + 1, context);
    });
  };
  visit(value);

  const entries = collectAiKeyUsageEntries(value);
  const number = (input: unknown): number => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  };
  const reports = rawReports.map((report): AiModelKeyReport | null => {
    const model = toText(report.model);
    if (!model) return null;
    const availability = isRecord(report.lastAvailability)
      ? report.lastAvailability
      : null;
    const successfulKeySuffix = normalizeAiKeySuffix(report.successfulKeySuffix);
    const reportEntries = Array.isArray(report.keyAttempts)
      ? collectAiKeyUsageEntries({ attempts: report.keyAttempts })
        .map(entry => ({ ...entry, model }))
      : [];
    const modelEntries = reportEntries.length > 0
      ? reportEntries
      : entries.filter(entry => entry.model === model);
    if (successfulKeySuffix && !modelEntries.some(entry => (
      entry.keySuffix === successfulKeySuffix && entry.outcome === 'success'
    ))) {
      modelEntries.push({ keySuffix: successfulKeySuffix, outcome: 'success', status: 200, model });
    }
    return {
      ...(toText(report.reportProvider) ? { provider: toText(report.reportProvider) } : {}),
      ...(toText(report.reportCredentialSource)
        ? { credentialSource: toText(report.reportCredentialSource) }
        : {}),
      model,
      status: toText(report.status) || 'unknown',
      configuredKeyCount: number(report.configuredKeyCount),
      attemptedKeyCount: number(report.attemptedKeyCount),
      attemptCount: number(report.attemptCount),
      availabilityCheckCount: number(report.availabilityCheckCount),
      waitedMs: number(report.waitedMs),
      ...(successfulKeySuffix ? { successfulKeySuffix } : {}),
      ...(availability ? {
        lastAvailability: {
          source: toText(availability.source) || 'unknown',
          configuredCount: number(availability.configuredCount),
          excludedCount: number(availability.excludedCount),
          inactiveCount: number(availability.inactiveCount),
          disabledCount: number(availability.disabledCount),
          leasedCount: number(availability.leasedCount),
          cooldownCount: number(availability.cooldownCount),
          eligibleCount: number(availability.eligibleCount),
          ...(toText(availability.nextEligibleAt)
            ? { nextEligibleAt: toText(availability.nextEligibleAt) }
            : {}),
        },
      } : {}),
      entries: modelEntries,
    };
  }).filter((report): report is AiModelKeyReport => Boolean(report));

  return reports.filter((report, index) => reports.findIndex(candidate => (
    candidate.model === report.model
    && candidate.provider === report.provider
    && candidate.credentialSource === report.credentialSource
    && candidate.status === report.status
    && candidate.attemptCount === report.attemptCount
    && candidate.waitedMs === report.waitedMs
  )) === index);
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
