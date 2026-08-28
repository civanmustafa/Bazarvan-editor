import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_VALUES,
  uniqueModelIds,
} from '../constants/modelRegistry';
import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';

export type ExternalGeminiSettings = {
  enabled: boolean;
  model: string;
  allowModelFallback: boolean;
};

export type ContentResearchAutomationSettings = {
  autoGenerateAlternativeKeywords: boolean;
  autoGenerateLsiKeywords: boolean;
  autoDiscoverCompetitors: boolean;
  autoGenerateMetaDescription: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const readExternalGeminiSettings = async (): Promise<ExternalGeminiSettings> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  const settings = isRecord(data?.value) ? data.value : {};
  const allowedModels = uniqueModelIds(GEMINI_FREE_MODEL_VALUES);
  const normalizedAi = normalizeSystemSettingsMap({
    ai: {
      ...settings,
      defaultGeminiModel: toTrimmedString(settings.defaultGeminiModel) || GEMINI_ANALYSIS_MODEL,
    },
  }, { allowedGeminiModels: allowedModels }).ai;
  return {
    enabled: normalizedAi.geminiFreeEnabled !== false,
    model: normalizedAi.defaultGeminiModel,
    allowModelFallback: normalizedAi.geminiFreeModelFallbackEnabled !== false,
  };
};

export const readContentResearchAutomationSettings = async (): Promise<ContentResearchAutomationSettings> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'system')
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  const storedSystem = isRecord(data?.value) ? data.value : {};
  const system = normalizeSystemSettingsMap({ system: storedSystem }).system;
  return {
    autoGenerateAlternativeKeywords: system.autoGenerateAlternativeKeywords !== false,
    autoGenerateLsiKeywords: system.autoGenerateLsiKeywords !== false,
    autoDiscoverCompetitors: system.autoDiscoverCompetitors !== false,
    autoGenerateMetaDescription: system.autoGenerateMetaDescription !== false,
  };
};
