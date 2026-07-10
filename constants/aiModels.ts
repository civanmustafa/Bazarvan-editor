export const GEMINI_FREE_MODEL_OPTIONS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash - الأقوى مجانًا' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro - استدلال متقدم' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview - أداء متقدم' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash - متوازن' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite - سريع' },
  { value: 'gemini-2.5-flash-lite-preview-09-2025', label: 'Gemini 2.5 Flash-Lite Preview - سريع' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite - الأخف' },
] as const;

export const GEMINI_FREE_MODEL_VALUES = GEMINI_FREE_MODEL_OPTIONS.map(option => option.value);

// Ordered from the strongest free text model to the lightest fallback.
export const GEMINI_ANALYSIS_MODEL = GEMINI_FREE_MODEL_OPTIONS[0].value;
export const GEMINI_PAID_ANALYSIS_MODEL = 'gemini-2.5-pro';

export const getGeminiFreeModelLabel = (model: string): string => (
  GEMINI_FREE_MODEL_OPTIONS.find(option => option.value === model)?.label || model
);
