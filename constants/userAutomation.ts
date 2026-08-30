import {
  EXTERNAL_AUTOMATIC_COMMAND_IDS,
  EXTERNAL_READY_COMMAND_DEFINITIONS,
} from './externalAnalysisCommands';

export const USER_AUTOMATION_SCHEMA_VERSION = 1;

export const USER_AUTOMATION_BOOLEAN_KEYS = [
  'enabled',
  'autoGenerateAlternativeKeywords',
  'autoGenerateLsiKeywords',
  'autoGenerateGoogleMetadata',
  'autoDiscoverCompetitors',
  'autoExtractCompetitorContent',
  'autoRunReadyEngineeringCommands',
  'contentWritingAutomationEnabled',
  'autoApplyStrongInternalLinkSuggestions',
] as const;

export type UserAutomationBooleanKey = typeof USER_AUTOMATION_BOOLEAN_KEYS[number];

export type UserAutomationPreferences = Record<UserAutomationBooleanKey, boolean> & {
  schemaVersion: number;
  externalAnalysisCommandIds: string[];
};

export type UserAutomationBlockedReasons = Partial<Record<UserAutomationBooleanKey, string>>;

export const USER_AUTOMATION_DEFAULTS: UserAutomationPreferences = {
  schemaVersion: USER_AUTOMATION_SCHEMA_VERSION,
  enabled: true,
  autoGenerateAlternativeKeywords: true,
  autoGenerateLsiKeywords: true,
  autoGenerateGoogleMetadata: true,
  autoDiscoverCompetitors: true,
  autoExtractCompetitorContent: true,
  autoRunReadyEngineeringCommands: true,
  contentWritingAutomationEnabled: false,
  autoApplyStrongInternalLinkSuggestions: true,
  externalAnalysisCommandIds: [...EXTERNAL_AUTOMATIC_COMMAND_IDS],
};

const ALLOWED_COMMAND_IDS = new Set(EXTERNAL_READY_COMMAND_DEFINITIONS.map(command => command.id));
const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

// An explicit empty selection means no automatic commands. Never restore defaults for [].
export const normalizeUserAutomationCommandIds = (
  value: unknown,
  fallback: readonly string[] = USER_AUTOMATION_DEFAULTS.externalAnalysisCommandIds,
): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : fallback)
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => ALLOWED_COMMAND_IDS.has(item)),
));

export const normalizeUserAutomationPreferences = (
  value: unknown,
  fallback: UserAutomationPreferences = USER_AUTOMATION_DEFAULTS,
): UserAutomationPreferences => {
  const source = isRecord(value) ? value : {};
  const normalized = {
    schemaVersion: USER_AUTOMATION_SCHEMA_VERSION,
    externalAnalysisCommandIds: normalizeUserAutomationCommandIds(
      source.externalAnalysisCommandIds,
      fallback.externalAnalysisCommandIds,
    ),
  } as UserAutomationPreferences;
  for (const key of USER_AUTOMATION_BOOLEAN_KEYS) {
    normalized[key] = typeof source[key] === 'boolean' ? source[key] : fallback[key];
  }
  return normalized;
};
