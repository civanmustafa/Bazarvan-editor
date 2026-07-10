import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

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
  return {
    enabled: settings.geminiFreeEnabled !== false,
    model: toTrimmedString(settings.defaultGeminiModel)
      || process.env.GEMINI_MODEL?.trim()
      || 'gemini-3.5-flash',
    allowModelFallback: settings.geminiFreeModelFallbackEnabled !== false,
  };
};
