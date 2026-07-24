import {
  normalizePromptRegistrySettings,
  type PromptRegistrySettings,
} from '../constants/promptRegistry';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

export const readPromptRegistrySettings = async (): Promise<PromptRegistrySettings> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'prompts')
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  return normalizePromptRegistrySettings(data?.value);
};
