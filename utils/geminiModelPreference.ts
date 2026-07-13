import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_VALUES,
  getGeminiFreeModelLabel,
  normalizeGeminiFreeModelId,
  uniqueModelIds,
} from '../constants/modelRegistry';
import type { UserPreferences } from '../constants/settingsRegistry';
import { saveCurrentUserPreferencesPatch } from './userPreferences';

export const GEMINI_FREE_MODEL_STORAGE_KEY = 'bazarvan:gemini-free-default-model';
export const GEMINI_FREE_MODEL_CHANGED_EVENT = 'bazarvan:gemini-free-model-changed';
export const GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY = 'bazarvan:gemini-free-model-fallback-enabled';
export const GEMINI_FREE_MODEL_FALLBACK_CHANGED_EVENT = 'bazarvan:gemini-free-model-fallback-changed';

const readLegacyStorageValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

let selectedModel = normalizeGeminiFreeModelId(
  readLegacyStorageValue(GEMINI_FREE_MODEL_STORAGE_KEY),
);
let allowModelFallback = readLegacyStorageValue(GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY) !== 'false';

const emitModelChanged = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GEMINI_FREE_MODEL_CHANGED_EVENT, {
    detail: { model: selectedModel },
  }));
};

const emitFallbackChanged = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GEMINI_FREE_MODEL_FALLBACK_CHANGED_EVENT, {
    detail: { enabled: allowModelFallback },
  }));
};

const persistAiPreferences = () => {
  void saveCurrentUserPreferencesPatch({
    ai: {
      defaultGeminiModel: selectedModel,
      allowGeminiModelFallback: allowModelFallback,
    },
  }).catch(error => {
    console.error('Failed to save Gemini user preferences to Supabase:', error);
  });
};

export const buildGeminiFreeModelOptions = (
  extraModels: string[] = [],
): { value: string; label: string }[] => (
  uniqueModelIds([...GEMINI_FREE_MODEL_VALUES, ...extraModels])
    .map(model => ({
      value: model,
      label: getGeminiFreeModelLabel(model),
    }))
);

export const normalizeGeminiFreeModel = (
  value: unknown,
  allowedModels: string[] = GEMINI_FREE_MODEL_VALUES,
): string => normalizeGeminiFreeModelId(value, allowedModels);

export const readLegacyGeminiModelPreferences = (): {
  model: string;
  allowModelFallback: boolean;
} => ({
  model: normalizeGeminiFreeModelId(readLegacyStorageValue(GEMINI_FREE_MODEL_STORAGE_KEY)),
  allowModelFallback: readLegacyStorageValue(GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY) !== 'false',
});

export const clearLegacyGeminiModelPreferences = () => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(GEMINI_FREE_MODEL_STORAGE_KEY);
    localStorage.removeItem(GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY);
  } catch {
    // The online preferences are already saved; an unavailable cache can be ignored.
  }
};

export const hydrateGeminiModelPreferences = (preferences: UserPreferences['ai']) => {
  selectedModel = normalizeGeminiFreeModelId(preferences.defaultGeminiModel);
  allowModelFallback = preferences.allowGeminiModelFallback !== false;
  emitModelChanged();
  emitFallbackChanged();
};

export const resetGeminiModelPreferences = () => {
  selectedModel = GEMINI_ANALYSIS_MODEL;
  allowModelFallback = true;
  emitModelChanged();
  emitFallbackChanged();
};

export const getSelectedGeminiFreeModel = (): string => selectedModel;

export const setSelectedGeminiFreeModel = (
  value: string,
  allowedModels?: string[],
): string => {
  selectedModel = normalizeGeminiFreeModelId(value, allowedModels || GEMINI_FREE_MODEL_VALUES);
  emitModelChanged();
  persistAiPreferences();
  return selectedModel;
};

export const isGeminiFreeModelFallbackEnabled = (): boolean => allowModelFallback;

export const setGeminiFreeModelFallbackEnabled = (enabled: boolean): boolean => {
  allowModelFallback = enabled;
  emitFallbackChanged();
  persistAiPreferences();
  return allowModelFallback;
};
