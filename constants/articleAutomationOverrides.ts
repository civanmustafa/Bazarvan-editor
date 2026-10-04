export const ARTICLE_AUTOMATION_OVERRIDE_SCHEMA_VERSION = 1;

export const ARTICLE_AUTOMATION_CAPABILITIES = [
  'autoGenerateAlternativeKeywords',
  'autoGenerateLsiKeywords',
  'autoGenerateGoogleMetadata',
  'autoDiscoverCompetitors',
  'autoExtractCompetitorContent',
  'autoRunReadyEngineeringCommands',
  'contentWritingAutomationEnabled',
  'autoApplyStrongInternalLinkSuggestions',
] as const;

export type ArticleAutomationCapability = typeof ARTICLE_AUTOMATION_CAPABILITIES[number];
export type ArticleWritingMode = 'strict' | 'available_inputs' | 'manual_only';
export type ArticleAutomationRunningBehavior = 'stop' | 'finish_current';

export type ArticleAutomationOverrideImpact = {
  queuedCancelled: number;
  runningCancellationRequested: number;
  runningAllowedToFinish: number;
  bundledRestartRequested: number;
};

export const EMPTY_ARTICLE_AUTOMATION_OVERRIDE_IMPACT: ArticleAutomationOverrideImpact = {
  queuedCancelled: 0,
  runningCancellationRequested: 0,
  runningAllowedToFinish: 0,
  bundledRestartRequested: 0,
};

export type ArticleAutomationOverrides = {
  schemaVersion: number;
  disabledCapabilities: ArticleAutomationCapability[];
  writingMode: ArticleWritingMode;
  excludedExternalCommandIds: string[];
  reason: string;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export const ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS: ArticleAutomationOverrides = {
  schemaVersion: ARTICLE_AUTOMATION_OVERRIDE_SCHEMA_VERSION,
  disabledCapabilities: [],
  writingMode: 'strict',
  excludedExternalCommandIds: [],
  reason: '',
  revision: 0,
  updatedAt: null,
  updatedBy: null,
};

export const COMPETITOR_COMPARISON_COMMAND_ID = 'smartAnalysis.competitorContentComparison';

const CAPABILITY_SET = new Set<string>(ARTICLE_AUTOMATION_CAPABILITIES);

export const isArticleWritingMode = (value: unknown): value is ArticleWritingMode => (
  value === 'strict' || value === 'available_inputs' || value === 'manual_only'
);

export const isArticleAutomationRunningBehavior = (
  value: unknown,
): value is ArticleAutomationRunningBehavior => value === 'stop' || value === 'finish_current';

export const normalizeArticleAutomationOverrideImpact = (
  value: unknown,
): ArticleAutomationOverrideImpact => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const count = (key: keyof ArticleAutomationOverrideImpact): number => (
    Math.max(0, Math.floor(Number(source[key]) || 0))
  );
  return {
    queuedCancelled: count('queuedCancelled'),
    runningCancellationRequested: count('runningCancellationRequested'),
    runningAllowedToFinish: count('runningAllowedToFinish'),
    bundledRestartRequested: count('bundledRestartRequested'),
  };
};

export const normalizeArticleAutomationOverrides = (
  value: unknown,
): ArticleAutomationOverrides => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const disabledCapabilities = Array.from(new Set(
    (Array.isArray(source.disabledCapabilities) ? source.disabledCapabilities : [])
      .filter((item): item is ArticleAutomationCapability => (
        typeof item === 'string' && CAPABILITY_SET.has(item)
      )),
  ));
  const excludedExternalCommandIds = Array.from(new Set(
    (Array.isArray(source.excludedExternalCommandIds) ? source.excludedExternalCommandIds : [])
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean),
  ));
  const writingMode = isArticleWritingMode(source.writingMode)
    ? source.writingMode
    : 'strict';
  return {
    schemaVersion: ARTICLE_AUTOMATION_OVERRIDE_SCHEMA_VERSION,
    disabledCapabilities,
    writingMode,
    excludedExternalCommandIds,
    reason: typeof source.reason === 'string' ? source.reason.trim().slice(0, 1_000) : '',
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy : null,
  };
};

export const countArticleAutomationExceptions = (
  value: Pick<ArticleAutomationOverrides, 'disabledCapabilities' | 'writingMode' | 'excludedExternalCommandIds'>,
): number => (
  value.disabledCapabilities.length
  + value.excludedExternalCommandIds.length
  + (value.writingMode === 'strict' ? 0 : 1)
);
