import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_OPTIONS,
  GEMINI_FREE_MODEL_VALUES,
  getGeminiFreeModelLabel,
} from '../constants/aiModels';

export const GEMINI_FREE_MODEL_STORAGE_KEY = 'bazarvan:gemini-free-default-model';
export const GEMINI_FREE_MODEL_CHANGED_EVENT = 'bazarvan:gemini-free-model-changed';
export const GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY = 'bazarvan:gemini-free-model-fallback-enabled';
export const GEMINI_FREE_MODEL_FALLBACK_CHANGED_EVENT = 'bazarvan:gemini-free-model-fallback-changed';

const uniqueModels = (models: string[]): string[] => (
  Array.from(new Set(models.map(model => model.trim()).filter(Boolean)))
);

export const buildGeminiFreeModelOptions = (
  extraModels: string[] = [],
): { value: string; label: string }[] => (
  uniqueModels([...GEMINI_FREE_MODEL_VALUES, ...extraModels])
    .map(model => ({
      value: model,
      label: getGeminiFreeModelLabel(model),
    }))
);

export const normalizeGeminiFreeModel = (
  value: unknown,
  allowedModels: string[] = GEMINI_FREE_MODEL_VALUES,
): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const allowed = uniqueModels(allowedModels);
  if (normalized && allowed.includes(normalized)) return normalized;
  return allowed[0] || GEMINI_ANALYSIS_MODEL;
};

export const getSelectedGeminiFreeModel = (): string => {
  if (typeof window === 'undefined') return GEMINI_ANALYSIS_MODEL;
  try {
    return localStorage.getItem(GEMINI_FREE_MODEL_STORAGE_KEY)?.trim() || GEMINI_ANALYSIS_MODEL;
  } catch {
    return GEMINI_ANALYSIS_MODEL;
  }
};

export const setSelectedGeminiFreeModel = (
  value: string,
  allowedModels?: string[],
): string => {
  const selectedModel = allowedModels
    ? normalizeGeminiFreeModel(value, allowedModels)
    : value.trim() || GEMINI_ANALYSIS_MODEL;

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(GEMINI_FREE_MODEL_STORAGE_KEY, selectedModel);
      window.dispatchEvent(new CustomEvent(GEMINI_FREE_MODEL_CHANGED_EVENT, {
        detail: { model: selectedModel },
      }));
    } catch {
      // Ignore storage failures; the server still falls back to its default model.
    }
  }

  return selectedModel;
};

export const isGeminiFreeModelFallbackEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const setGeminiFreeModelFallbackEnabled = (enabled: boolean): boolean => {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(GEMINI_FREE_MODEL_FALLBACK_STORAGE_KEY, enabled ? 'true' : 'false');
      window.dispatchEvent(new CustomEvent(GEMINI_FREE_MODEL_FALLBACK_CHANGED_EVENT, {
        detail: { enabled },
      }));
    } catch {
      // Ignore storage failures; requests will keep using the explicit selected model.
    }
  }

  return enabled;
};
