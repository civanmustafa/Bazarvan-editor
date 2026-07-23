export type NormalizedAiUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const tokenCount = (value: unknown): number => (
  Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0
);

export const normalizeOpenAiUsage = (value: unknown): NormalizedAiUsage => {
  const usage = isRecord(value) ? value : {};
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: tokenCount(inputDetails.cached_tokens),
    cacheWriteTokens: tokenCount(usage.cache_write_tokens),
    outputTokens,
    reasoningTokens: tokenCount(outputDetails.reasoning_tokens),
    totalTokens: tokenCount(usage.total_tokens) || inputTokens + outputTokens,
  };
};

export const normalizeGeminiUsage = (value: unknown): NormalizedAiUsage => {
  const usage = isRecord(value) ? value : {};
  const inputTokens = tokenCount(usage.promptTokenCount);
  const outputTokens = tokenCount(usage.candidatesTokenCount);
  return {
    inputTokens,
    cachedInputTokens: tokenCount(usage.cachedContentTokenCount),
    cacheWriteTokens: 0,
    outputTokens,
    reasoningTokens: tokenCount(usage.thoughtsTokenCount),
    totalTokens: tokenCount(usage.totalTokenCount) || inputTokens + outputTokens,
  };
};

export const normalizeAiUsage = (value: unknown): NormalizedAiUsage => {
  const usage = isRecord(value) ? value : {};
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  return {
    inputTokens,
    cachedInputTokens: tokenCount(usage.cachedInputTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
    outputTokens,
    reasoningTokens: tokenCount(usage.reasoningTokens),
    totalTokens: tokenCount(usage.totalTokens) || inputTokens + outputTokens,
  };
};

export const sumAiUsage = (values: readonly unknown[]): NormalizedAiUsage => (
  values.map(normalizeAiUsage).reduce<NormalizedAiUsage>((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  })
);

