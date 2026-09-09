import {
  normalizeUserAiRoutingPreferences,
  type UserAiRoutingPreferences,
} from '../constants/userAiRouting.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readUserAiRoutingPreferences = async (
  userIdValue: unknown,
): Promise<UserAiRoutingPreferences> => {
  const userId = typeof userIdValue === 'string' ? userIdValue.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(userId)) return normalizeUserAiRoutingPreferences({});

  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (['42P01', 'PGRST205'].includes(String(error.code || ''))) {
      return normalizeUserAiRoutingPreferences({});
    }
    throw error;
  }
  const preferences = data?.preferences && typeof data.preferences === 'object'
    ? data.preferences as Record<string, unknown>
    : {};
  return normalizeUserAiRoutingPreferences(preferences.ai);
};
