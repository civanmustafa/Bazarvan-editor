export const GEMINI_FREE_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
] as const;

export const GEMINI_FREE_MODEL_VALUES = GEMINI_FREE_MODEL_OPTIONS.map(option => option.value);

// Use a stable Flash model for production content analysis and URL context requests.
export const GEMINI_ANALYSIS_MODEL = GEMINI_FREE_MODEL_OPTIONS[0].value;
export const GEMINI_PAID_ANALYSIS_MODEL = 'gemini-2.5-pro';

export const getGeminiFreeModelLabel = (model: string): string => (
  GEMINI_FREE_MODEL_OPTIONS.find(option => option.value === model)?.label || model
);
