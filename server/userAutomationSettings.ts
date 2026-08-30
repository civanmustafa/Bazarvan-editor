import {
  normalizeUserAutomationPreferences,
  USER_AUTOMATION_BOOLEAN_KEYS,
  type UserAutomationPreferences,
  type UserAutomationBlockedReasons,
} from '../constants/userAutomation';
import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { readUserProviderAccessOverview, type UserProviderAccessOverview } from './providerAccessControl';

export const computeEffectiveUserAutomation = (
  preferences: UserAutomationPreferences,
  adminLimits: UserAutomationPreferences,
  providers: UserProviderAccessOverview,
  ai: Record<string, any>,
): { effectivePreferences: UserAutomationPreferences; blockedReasons: UserAutomationBlockedReasons } => {
  const effectivePreferences = normalizeUserAutomationPreferences(preferences);
  const blockedReasons: UserAutomationBlockedReasons = {};
  for (const key of USER_AUTOMATION_BOOLEAN_KEYS) {
    if (!adminLimits[key]) blockedReasons[key] = 'هذه العملية موقوفة حاليًا من إعدادات المسؤول.';
    effectivePreferences[key] = preferences[key] && adminLimits[key] && preferences.enabled;
  }
  const providerUnavailable = (provider: keyof UserProviderAccessOverview['policies']): boolean => {
    const policy = providers.policies[provider];
    const usage = providers.usage[provider];
    return !policy || !policy.enabled || policy.credentialMode === 'disabled'
      || (policy.dailyRequestLimit !== null && usage.dailyUsed >= policy.dailyRequestLimit)
      || (policy.monthlyRequestLimit !== null && usage.monthlyUsed >= policy.monthlyRequestLimit);
  };
  if (ai.geminiFreeEnabled === false || providerUnavailable('gemini_free')) {
    for (const key of ['autoGenerateAlternativeKeywords', 'autoGenerateLsiKeywords', 'autoGenerateGoogleMetadata', 'autoRunReadyEngineeringCommands'] as const) {
      effectivePreferences[key] = false;
      blockedReasons[key] ||= 'Gemini المجاني غير متاح لحسابك حاليًا أو وصلت إلى حد الاستخدام.';
    }
  }
  const writingProvider = ai.contentWritingAutomationProvider === 'openai' ? 'openai'
    : ai.contentWritingAutomationProvider === 'geminiPaid' ? 'gemini_paid' : 'gemini_free';
  if ((writingProvider === 'openai' ? ai.openAiEnabled === false
    : writingProvider === 'gemini_paid' ? ai.geminiProEnabled === false : ai.geminiFreeEnabled === false)
    || providerUnavailable(writingProvider)) {
    effectivePreferences.contentWritingAutomationEnabled = false;
    blockedReasons.contentWritingAutomationEnabled ||= 'مزود الكتابة التلقائية غير متاح لحسابك حاليًا أو وصلت إلى حد الاستخدام.';
  }
  if (preferences.externalAnalysisCommandIds.length === 0) effectivePreferences.autoRunReadyEngineeringCommands = false;
  return { effectivePreferences, blockedReasons };
};

export const readOrSaveUserAutomationSettings = async (userId: string, preferences?: UserAutomationPreferences) => {
  const admin = getExternalAnalysisSupabaseAdmin();
  const [settings, providers, aiResult] = await Promise.all([
    preferences
      ? admin.rpc('save_user_automation_settings', { p_user_id: userId, p_preferences: preferences })
      : admin.rpc('get_user_automation_settings', { p_user_id: userId }),
    readUserProviderAccessOverview(userId),
    admin.from('app_settings').select('value').eq('key', 'ai').eq('is_secret', false).maybeSingle(),
  ]);
  if (settings.error || aiResult.error) {
    throw new Error('تعذر قراءة إعدادات أتمتة المستخدم. تحقق من اكتمال تحديث قاعدة البيانات.');
  }
  const data = settings.data;
  if (!data?.preferences || !data?.adminLimits
    || !USER_AUTOMATION_BOOLEAN_KEYS.every(key => typeof data.adminLimits[key] === 'boolean')) {
    throw new Error('استجابة إعدادات الأتمتة غير مكتملة.');
  }
  const normalized = normalizeUserAutomationPreferences(data.preferences);
  return {
    preferences: normalized,
    ...computeEffectiveUserAutomation(normalized, normalizeUserAutomationPreferences(data.adminLimits), providers,
      normalizeSystemSettingsMap({ ai: aiResult.data?.value || {} }).ai),
    eligibleArticleCount: Number(data.eligibleArticleCount) || 0,
    ...(typeof data.initializedAt === 'string' ? { initializedAt: data.initializedAt } : {}),
  };
};
