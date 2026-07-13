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
  const environmentModel = process.env.GEMINI_MODEL?.trim() || GEMINI_ANALYSIS_MODEL;
  const allowedModels = uniqueModelIds([
    environmentModel,
    ...GEMINI_FREE_MODEL_VALUES,
    ...String(process.env.GEMINI_ALLOWED_MODELS || '').split(/[\n,;]+/),
  ]);
  const normalizedAi = normalizeSystemSettingsMap({
    ai: {
      ...settings,
      defaultGeminiModel: toTrimmedString(settings.defaultGeminiModel) || environmentModel,
    },
  }, { allowedGeminiModels: allowedModels }).ai;
  return {
    enabled: normalizedAi.geminiFreeEnabled !== false,
    model: normalizedAi.defaultGeminiModel,
    allowModelFallback: normalizedAi.geminiFreeModelFallbackEnabled !== false,
  };
};
