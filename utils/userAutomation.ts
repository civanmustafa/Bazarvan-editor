import {
  normalizeUserAutomationPreferences,
  USER_AUTOMATION_BOOLEAN_KEYS,
  type UserAutomationBlockedReasons,
  type UserAutomationPreferences,
} from '../constants/userAutomation';
import { getSupabaseClient } from './supabaseClient';
import { notifyInternalLinkAutomationSettingsChanged } from './internalLinkAutomationSettings';

export const USER_AUTOMATION_CHANGED_EVENT = 'bazarvan:user-automation-changed';

export type UserAutomationResponse = {
  preferences: UserAutomationPreferences;
  effectivePreferences: UserAutomationPreferences;
  blockedReasons: UserAutomationBlockedReasons;
  initializedAt?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const requestUserAutomation = async (
  preferences?: UserAutomationPreferences,
): Promise<UserAutomationResponse> => {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('يجب تسجيل الدخول لتعديل أتمتة مقالاتك.');
  }
  const response = await fetch('/api/user/automation', {
    method: preferences ? 'PUT' : 'GET',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      ...(preferences ? { 'Content-Type': 'application/json' } : {}),
    },
    cache: 'no-store',
    body: preferences
      ? JSON.stringify({ preferences: normalizeUserAutomationPreferences(preferences) })
      : undefined,
  });
  const payload = await response.json().catch((): null => null);
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `تعذر ${preferences ? 'حفظ' : 'تحميل'} إعدادات الأتمتة (${response.status}).`);
  }
  if (!isRecord(payload) || !isRecord(payload.preferences) || !isRecord(payload.effectivePreferences)) {
    throw new Error('استجابة إعدادات الأتمتة غير مكتملة. أعد المحاولة.');
  }
  const blockedReasons: UserAutomationBlockedReasons = {};
  if (isRecord(payload.blockedReasons)) {
    for (const key of USER_AUTOMATION_BOOLEAN_KEYS) {
      const reason = payload.blockedReasons[key];
      if (typeof reason === 'string' && reason.trim()) blockedReasons[key] = reason.trim();
    }
  }
  return {
    preferences: normalizeUserAutomationPreferences(payload.preferences),
    effectivePreferences: normalizeUserAutomationPreferences(payload.effectivePreferences),
    blockedReasons,
    ...(typeof payload.initializedAt === 'string' ? { initializedAt: payload.initializedAt } : {}),
  };
};

export const loadUserAutomationPreferences = (): Promise<UserAutomationResponse> => requestUserAutomation();

export const saveUserAutomationPreferences = async (
  preferences: UserAutomationPreferences,
): Promise<UserAutomationResponse> => {
  const response = await requestUserAutomation(preferences);
  window.dispatchEvent(new Event(USER_AUTOMATION_CHANGED_EVENT));
  notifyInternalLinkAutomationSettingsChanged();
  return response;
};
