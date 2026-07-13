import {
  USER_PREFERENCES_DEFAULTS,
  USER_PREFERENCES_SCHEMA_VERSION,
  mergeUserPreferencesPatch,
  migrateLegacyUserPreferences,
  normalizeUserPreferences,
  type UserPreferences,
  type UserPreferencesPatch,
} from '../constants/settingsRegistry';
import { getSupabaseClient } from './supabaseClient';

export const USER_PREFERENCES_CHANGED_EVENT = 'bazarvan:user-preferences-changed';

let activeUserId: string | null = null;
let cachedPreferences: UserPreferences = normalizeUserPreferences(USER_PREFERENCES_DEFAULTS);
let persistenceQueue: Promise<unknown> = Promise.resolve();

const isMissingPreferencesStorage = (error: any): boolean => (
  error?.code === '42P01'
  || error?.code === 'PGRST202'
  || error?.code === 'PGRST205'
);

const emitPreferencesChanged = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(USER_PREFERENCES_CHANGED_EVENT, {
    detail: { preferences: cachedPreferences },
  }));
};

const setCache = (userId: string | null, preferences: unknown): UserPreferences => {
  activeUserId = userId;
  cachedPreferences = normalizeUserPreferences(preferences);
  emitPreferencesChanged();
  return cachedPreferences;
};

const buildDatabasePatch = (
  next: UserPreferences,
  patch: UserPreferencesPatch,
): Record<string, unknown> => {
  const databasePatch: Record<string, unknown> = {
    schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
  };
  if (patch.appearance) databasePatch.appearance = next.appearance;
  if (patch.editor) databasePatch.editor = next.editor;
  if (patch.ai) databasePatch.ai = next.ai;
  if (patch.clientGoalContexts) databasePatch.clientGoalContexts = next.clientGoalContexts;
  if (patch.engineeringPrompts) databasePatch.engineeringPrompts = next.engineeringPrompts;
  return databasePatch;
};

export type UserPreferencesHydrationResult = {
  preferences: UserPreferences;
  migratedLegacyValues: boolean;
  persistedOnline: boolean;
};

export const getCachedUserPreferences = (): UserPreferences => cachedPreferences;

export const resetUserPreferencesCache = () => {
  setCache(null, USER_PREFERENCES_DEFAULTS);
};

export const hydrateCurrentUserPreferences = async (
  userId: string,
  legacyPreferences: UserPreferences,
): Promise<UserPreferencesHydrationResult> => {
  activeUserId = userId;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_preferences')
    .select('preferences,schema_version')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (!isMissingPreferencesStorage(error)) throw error;
    return {
      preferences: setCache(userId, legacyPreferences),
      migratedLegacyValues: false,
      persistedOnline: false,
    };
  }

  const storedVersion = typeof data?.schema_version === 'number' ? data.schema_version : 0;
  const needsMigration = !data || storedVersion < USER_PREFERENCES_SCHEMA_VERSION;
  const preferences = needsMigration
    ? migrateLegacyUserPreferences(data?.preferences, legacyPreferences)
    : normalizeUserPreferences(data.preferences);

  if (needsMigration) {
    const { error: saveError } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: userId,
        preferences,
        schema_version: USER_PREFERENCES_SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (saveError) throw saveError;
  }

  return {
    preferences: setCache(userId, preferences),
    migratedLegacyValues: needsMigration,
    persistedOnline: true,
  };
};

export const saveCurrentUserPreferencesPatch = (
  patch: UserPreferencesPatch,
): Promise<UserPreferences> => {
  const next = mergeUserPreferencesPatch(cachedPreferences, patch);
  cachedPreferences = next;
  emitPreferencesChanged();

  const userId = activeUserId;
  if (!userId) return Promise.resolve(next);

  const databasePatch = buildDatabasePatch(next, patch);
  const persist = async (): Promise<UserPreferences> => {
    const supabase = getSupabaseClient();
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.user.id !== userId) return next;

    const { data, error } = await supabase.rpc('merge_current_user_preferences', {
      p_patch: databasePatch,
    });

    if (error) {
      if (isMissingPreferencesStorage(error)) {
        const { error: upsertError } = await supabase
          .from('user_preferences')
          .upsert({
            user_id: userId,
            preferences: next,
            schema_version: USER_PREFERENCES_SCHEMA_VERSION,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
        if (upsertError) throw upsertError;
        return next;
      }
      throw error;
    }

    if (data && activeUserId === userId) setCache(userId, data);
    return activeUserId === userId ? cachedPreferences : next;
  };

  const operation = persistenceQueue.catch(() => undefined).then(persist);
  persistenceQueue = operation;
  return operation;
};
