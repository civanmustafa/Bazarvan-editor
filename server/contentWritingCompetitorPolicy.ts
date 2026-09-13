import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';
import { normalizeContentWritingMinimumCompetitors } from '../constants/competitors';
import { CONTENT_WRITING_MIN_COMPETITOR_COUNT } from '../utils/contentWritingContext';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const readContentWritingMinimumCompetitors = async (): Promise<number> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();
  if (error && error.code !== '42P01') throw error;
  const ai = normalizeSystemSettingsMap({
    ai: isRecord(data?.value) ? data.value : {},
  }).ai;
  return normalizeContentWritingMinimumCompetitors(
    ai.contentWritingAutomationMinimumCompetitors
      ?? CONTENT_WRITING_MIN_COMPETITOR_COUNT,
  );
};
