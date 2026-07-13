import {
  EXTERNAL_AUTOMATIC_COMMAND_IDS,
  EXTERNAL_READY_COMMAND_DEFINITIONS,
} from './externalAnalysisCommands';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_PAID_ANALYSIS_MODEL,
  OPENAI_ANALYSIS_MODEL,
  normalizeGeminiFreeModelId,
} from './modelRegistry';

export const SYSTEM_SETTING_KEYS = ['ai', 'n8n', 'articles', 'roles', 'system'] as const;
export type SystemSettingKey = typeof SYSTEM_SETTING_KEYS[number];
export type SystemSettingsMap = Record<SystemSettingKey, Record<string, any>>;

export const SETTINGS_REGISTRY_VERSION = 1;
export const USER_PREFERENCES_SCHEMA_VERSION = 1;

const ALLOWED_EXTERNAL_COMMAND_IDS = new Set(
  EXTERNAL_READY_COMMAND_DEFINITIONS.map(definition => definition.id),
);

export const SYSTEM_SETTINGS_DEFAULTS: SystemSettingsMap = {
  ai: {
    settingsRegistryVersion: SETTINGS_REGISTRY_VERSION,
    geminiFreeEnabled: true,
    geminiProEnabled: true,
    openAiEnabled: false,
    defaultProvider: 'gemini',
    defaultGeminiModel: GEMINI_ANALYSIS_MODEL,
    geminiFreeModelFallbackEnabled: true,
    externalAnalysisRetryMinutes: 30,
    externalAnalysisDefaultCommandIds: [...EXTERNAL_AUTOMATIC_COMMAND_IDS],
    externalAnalysisCommandExecutionMode: 'independent_batch',
    defaultGeminiPaidModel: GEMINI_PAID_ANALYSIS_MODEL,
    defaultOpenAiModel: OPENAI_ANALYSIS_MODEL,
  },
  n8n: {
    enabled: true,
    defaultVisibility: 'public',
    defaultAccessRole: 'editor',
    autoRunAssignedAutomation: true,
  },
  articles: {
    defaultStatus: 'draft',
    defaultVisibility: 'public',
    defaultLanguage: 'ar',
    trashRetentionDays: 30,
  },
  roles: {
    adminCanSeeAll: true,
    usersCanClaimPublicArticles: true,
    usersCanSeeOnlyAssignedAfterClaim: true,
  },
  system: {
    timezone: 'Europe/Istanbul',
    publicEditorUrl: '',
    dailyReportEnabled: true,
    activityTrackingEnabled: true,
  },
};

export const isSettingsRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasOwn = (value: Record<string, any>, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => (
  typeof value === 'boolean' ? value : fallback
);

const normalizeString = (value: unknown, fallback: string, maxLength = 2_048): string => {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
};

const normalizeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.round(parsed), max));
};

const normalizeEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => (
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
);

export const normalizeExternalAnalysisDefaultCommandIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [...EXTERNAL_AUTOMATIC_COMMAND_IDS];
  const normalized = Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => ALLOWED_EXTERNAL_COMMAND_IDS.has(item)),
  ));
  return normalized.length > 0 ? normalized : [...EXTERNAL_AUTOMATIC_COMMAND_IDS];
};

type SystemSettingsNormalizationOptions = {
  allowedGeminiModels?: readonly unknown[];
};

const normalizeSystemSection = (
  key: SystemSettingKey,
  value: unknown,
  options: SystemSettingsNormalizationOptions = {},
): Record<string, unknown> => {
  const source = isSettingsRecord(value) ? value : {};
  const defaults = SYSTEM_SETTINGS_DEFAULTS[key];
  const normalized: Record<string, unknown> = {};
  const setWhenPresent = (field: string, normalizer: (fieldValue: unknown) => unknown) => {
    if (hasOwn(source, field)) normalized[field] = normalizer(source[field]);
  };

  if (key === 'ai') {
    setWhenPresent('settingsRegistryVersion', () => SETTINGS_REGISTRY_VERSION);
    setWhenPresent('geminiFreeEnabled', field => normalizeBoolean(field, defaults.geminiFreeEnabled));
    setWhenPresent('geminiProEnabled', field => normalizeBoolean(field, defaults.geminiProEnabled));
    setWhenPresent('openAiEnabled', field => normalizeBoolean(field, defaults.openAiEnabled));
    setWhenPresent('defaultProvider', field => normalizeEnum(field, ['gemini', 'geminiPaid', 'openai'], defaults.defaultProvider));
    setWhenPresent('defaultGeminiModel', field => normalizeGeminiFreeModelId(
      field,
      options.allowedGeminiModels,
    ));
    setWhenPresent('geminiFreeModelFallbackEnabled', field => normalizeBoolean(field, defaults.geminiFreeModelFallbackEnabled));
    setWhenPresent('externalAnalysisRetryMinutes', field => normalizeInteger(field, defaults.externalAnalysisRetryMinutes, 5, 1_440));
    setWhenPresent('externalAnalysisDefaultCommandIds', normalizeExternalAnalysisDefaultCommandIds);
    setWhenPresent('externalAnalysisCommandExecutionMode', field => normalizeEnum(
      field,
      ['independent_batch', 'sequential'],
      defaults.externalAnalysisCommandExecutionMode,
    ));
    setWhenPresent('defaultGeminiPaidModel', field => normalizeString(field, defaults.defaultGeminiPaidModel, 120) || defaults.defaultGeminiPaidModel);
    setWhenPresent('defaultOpenAiModel', field => normalizeString(field, defaults.defaultOpenAiModel, 120) || defaults.defaultOpenAiModel);
    return normalized;
  }

  if (key === 'n8n') {
    setWhenPresent('enabled', field => normalizeBoolean(field, defaults.enabled));
    setWhenPresent('defaultVisibility', field => normalizeEnum(field, ['public', 'private'], defaults.defaultVisibility));
    setWhenPresent('defaultAccessRole', field => normalizeEnum(field, ['viewer', 'editor'], defaults.defaultAccessRole));
    setWhenPresent('autoRunAssignedAutomation', field => normalizeBoolean(field, defaults.autoRunAssignedAutomation));
    return normalized;
  }

  if (key === 'articles') {
    setWhenPresent('defaultStatus', field => normalizeEnum(field, ['draft', 'in_review', 'published', 'archived'], defaults.defaultStatus));
    setWhenPresent('defaultVisibility', field => normalizeEnum(field, ['public', 'private'], defaults.defaultVisibility));
    setWhenPresent('defaultLanguage', field => normalizeEnum(field, ['ar', 'en'], defaults.defaultLanguage));
    setWhenPresent('trashRetentionDays', field => normalizeInteger(field, defaults.trashRetentionDays, 1, 3_650));
    return normalized;
  }

  if (key === 'roles') {
    setWhenPresent('adminCanSeeAll', field => normalizeBoolean(field, defaults.adminCanSeeAll));
    setWhenPresent('usersCanClaimPublicArticles', field => normalizeBoolean(field, defaults.usersCanClaimPublicArticles));
    setWhenPresent('usersCanSeeOnlyAssignedAfterClaim', field => normalizeBoolean(field, defaults.usersCanSeeOnlyAssignedAfterClaim));
    return normalized;
  }

  setWhenPresent('timezone', field => normalizeString(field, defaults.timezone, 100) || defaults.timezone);
  setWhenPresent('publicEditorUrl', field => normalizeString(field, defaults.publicEditorUrl, 2_048));
  setWhenPresent('dailyReportEnabled', field => normalizeBoolean(field, defaults.dailyReportEnabled));
  setWhenPresent('activityTrackingEnabled', field => normalizeBoolean(field, defaults.activityTrackingEnabled));
  return normalized;
};

export const getDefaultSystemSettings = (): SystemSettingsMap => (
  Object.fromEntries(SYSTEM_SETTING_KEYS.map(key => [key, {
    ...SYSTEM_SETTINGS_DEFAULTS[key],
    ...(key === 'ai' ? {
      externalAnalysisDefaultCommandIds: [...SYSTEM_SETTINGS_DEFAULTS.ai.externalAnalysisDefaultCommandIds],
    } : {}),
  }])) as SystemSettingsMap
);

export const normalizeSystemSettingsPatch = (
  value: unknown,
  options: SystemSettingsNormalizationOptions = {},
): Partial<SystemSettingsMap> => {
  const source = isSettingsRecord(value) ? value : {};
  return SYSTEM_SETTING_KEYS.reduce<Partial<SystemSettingsMap>>((patch, key) => {
    if (!hasOwn(source, key) || !isSettingsRecord(source[key])) return patch;
    patch[key] = normalizeSystemSection(key, source[key], options);
    return patch;
  }, {});
};

export const normalizeSystemSettingsMap = (
  value: unknown,
  options: SystemSettingsNormalizationOptions = {},
): SystemSettingsMap => {
  const defaults = getDefaultSystemSettings();
  const patch = normalizeSystemSettingsPatch(value, options);
  return SYSTEM_SETTING_KEYS.reduce<SystemSettingsMap>((settings, key) => {
    settings[key] = {
      ...defaults[key],
      ...(patch[key] || {}),
      ...(key === 'ai' ? { settingsRegistryVersion: SETTINGS_REGISTRY_VERSION } : {}),
    };
    return settings;
  }, defaults);
};

export type UserPreferences = {
  schemaVersion: number;
  appearance: {
    theme: 'dark' | 'light';
    highlightStyle: 'background' | 'underline';
    keywordViewMode: 'classic' | 'modern';
    structureViewMode: 'grid' | 'list';
  };
  editor: {
    chatGptOpenMode: 'window' | 'tab';
    preferredLanguage: 'ar' | 'en';
    uiLanguage: 'ar' | 'en';
  };
  ai: {
    defaultGeminiModel: string;
    allowGeminiModelFallback: boolean;
  };
  clientGoalContexts: Record<string, unknown>;
  engineeringPrompts: Record<string, unknown>;
};

export type UserPreferencesPatch = {
  appearance?: Partial<UserPreferences['appearance']>;
  editor?: Partial<UserPreferences['editor']>;
  ai?: Partial<UserPreferences['ai']>;
  clientGoalContexts?: Record<string, unknown>;
  engineeringPrompts?: Record<string, unknown>;
};

export const USER_PREFERENCES_DEFAULTS: UserPreferences = {
  schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
  appearance: {
    theme: 'dark',
    highlightStyle: 'background',
    keywordViewMode: 'classic',
    structureViewMode: 'grid',
  },
  editor: {
    chatGptOpenMode: 'window',
    preferredLanguage: 'ar',
    uiLanguage: 'ar',
  },
  ai: {
    defaultGeminiModel: GEMINI_ANALYSIS_MODEL,
    allowGeminiModelFallback: true,
  },
  clientGoalContexts: {},
  engineeringPrompts: {},
};

export const normalizeUserPreferences = (
  value: unknown,
  allowedGeminiModels?: readonly unknown[],
): UserPreferences => {
  const source = isSettingsRecord(value) ? value : {};
  const appearance = isSettingsRecord(source.appearance) ? source.appearance : {};
  const editor = isSettingsRecord(source.editor) ? source.editor : {};
  const ai = isSettingsRecord(source.ai) ? source.ai : {};
  return {
    schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
    appearance: {
      theme: normalizeEnum(appearance.theme, ['dark', 'light'], USER_PREFERENCES_DEFAULTS.appearance.theme),
      highlightStyle: normalizeEnum(appearance.highlightStyle, ['background', 'underline'], USER_PREFERENCES_DEFAULTS.appearance.highlightStyle),
      keywordViewMode: normalizeEnum(appearance.keywordViewMode, ['classic', 'modern'], USER_PREFERENCES_DEFAULTS.appearance.keywordViewMode),
      structureViewMode: normalizeEnum(appearance.structureViewMode, ['grid', 'list'], USER_PREFERENCES_DEFAULTS.appearance.structureViewMode),
    },
    editor: {
      chatGptOpenMode: normalizeEnum(editor.chatGptOpenMode, ['window', 'tab'], USER_PREFERENCES_DEFAULTS.editor.chatGptOpenMode),
      preferredLanguage: normalizeEnum(editor.preferredLanguage, ['ar', 'en'], USER_PREFERENCES_DEFAULTS.editor.preferredLanguage),
      uiLanguage: normalizeEnum(editor.uiLanguage, ['ar', 'en'], USER_PREFERENCES_DEFAULTS.editor.uiLanguage),
    },
    ai: {
      defaultGeminiModel: normalizeGeminiFreeModelId(ai.defaultGeminiModel, allowedGeminiModels),
      allowGeminiModelFallback: normalizeBoolean(ai.allowGeminiModelFallback, USER_PREFERENCES_DEFAULTS.ai.allowGeminiModelFallback),
    },
    clientGoalContexts: isSettingsRecord(source.clientGoalContexts) ? source.clientGoalContexts : {},
    engineeringPrompts: isSettingsRecord(source.engineeringPrompts) ? source.engineeringPrompts : {},
  };
};

export const mergeUserPreferencesPatch = (
  current: unknown,
  patch: UserPreferencesPatch,
  allowedGeminiModels?: readonly unknown[],
): UserPreferences => {
  const normalizedCurrent = normalizeUserPreferences(current, allowedGeminiModels);
  return normalizeUserPreferences({
    ...normalizedCurrent,
    appearance: { ...normalizedCurrent.appearance, ...(patch.appearance || {}) },
    editor: { ...normalizedCurrent.editor, ...(patch.editor || {}) },
    ai: { ...normalizedCurrent.ai, ...(patch.ai || {}) },
    clientGoalContexts: patch.clientGoalContexts ?? normalizedCurrent.clientGoalContexts,
    engineeringPrompts: patch.engineeringPrompts ?? normalizedCurrent.engineeringPrompts,
  }, allowedGeminiModels);
};

export const createLegacyUserPreferences = (
  activity: unknown,
  legacyGemini: { model?: unknown; allowModelFallback?: unknown } = {},
): UserPreferences => {
  const source = isSettingsRecord(activity) ? activity : {};
  return normalizeUserPreferences({
    appearance: {
      theme: source.preferredTheme,
      highlightStyle: source.preferredHighlightStyle,
      keywordViewMode: source.preferredKeywordViewMode,
      structureViewMode: source.preferredStructureViewMode,
    },
    editor: {
      chatGptOpenMode: source.preferredChatGptOpenMode,
      preferredLanguage: source.preferredLanguage,
      uiLanguage: source.preferredUILanguage,
    },
    ai: {
      defaultGeminiModel: legacyGemini.model,
      allowGeminiModelFallback: legacyGemini.allowModelFallback,
    },
    clientGoalContexts: source.clientGoalContexts,
    engineeringPrompts: source.engineeringPrompts,
  });
};

// Server values win; legacy values only fill fields that do not exist online yet.
export const migrateLegacyUserPreferences = (
  onlineValue: unknown,
  legacyValue: unknown,
  allowedGeminiModels?: readonly unknown[],
): UserPreferences => {
  const online = isSettingsRecord(onlineValue) ? onlineValue : {};
  const legacy = isSettingsRecord(legacyValue) ? legacyValue : {};
  const merged = {
    ...legacy,
    ...online,
    appearance: {
      ...(isSettingsRecord(legacy.appearance) ? legacy.appearance : {}),
      ...(isSettingsRecord(online.appearance) ? online.appearance : {}),
    },
    editor: {
      ...(isSettingsRecord(legacy.editor) ? legacy.editor : {}),
      ...(isSettingsRecord(online.editor) ? online.editor : {}),
    },
    ai: {
      ...(isSettingsRecord(legacy.ai) ? legacy.ai : {}),
      ...(isSettingsRecord(online.ai) ? online.ai : {}),
    },
    schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
  };
  return normalizeUserPreferences(merged, allowedGeminiModels);
};
