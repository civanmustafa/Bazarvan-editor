export type AiModelProvider = 'gemini' | 'geminiPaid' | 'openai';

export type AiModelDefinition = {
  id: string;
  label: string;
  provider: AiModelProvider;
  tier: 'free' | 'paid';
  priority: number;
};

const GEMINI_FREE_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash - الأقوى مجانًا', provider: 'gemini', tier: 'free', priority: 10 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro - استدلال متقدم', provider: 'gemini', tier: 'free', priority: 20 },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview - أداء متقدم', provider: 'gemini', tier: 'free', priority: 30 },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash - متوازن', provider: 'gemini', tier: 'free', priority: 40 },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite - سريع', provider: 'gemini', tier: 'free', priority: 50 },
  { id: 'gemini-2.5-flash-lite-preview-09-2025', label: 'Gemini 2.5 Flash-Lite Preview - سريع', provider: 'gemini', tier: 'free', priority: 60 },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite - الأخف', provider: 'gemini', tier: 'free', priority: 70 },
] as const satisfies readonly AiModelDefinition[];

const GEMINI_PAID_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'geminiPaid', tier: 'paid', priority: 10 },
] as const satisfies readonly AiModelDefinition[];

const OPENAI_MODELS = [
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', provider: 'openai', tier: 'paid', priority: 10 },
] as const satisfies readonly AiModelDefinition[];

export const MODEL_REGISTRY_VERSION = 1;

export const MODEL_REGISTRY = Object.freeze({
  gemini: Object.freeze({
    free: GEMINI_FREE_MODELS,
    paid: GEMINI_PAID_MODELS,
  }),
  openai: Object.freeze({
    models: OPENAI_MODELS,
  }),
});

export const GEMINI_FREE_MODEL_OPTIONS = MODEL_REGISTRY.gemini.free.map(model => ({
  value: model.id,
  label: model.label,
}));

export const GEMINI_FREE_MODEL_VALUES = MODEL_REGISTRY.gemini.free.map(model => model.id);

// Registry order is the shared fallback order used by the browser, API, and worker.
export const GEMINI_ANALYSIS_MODEL = MODEL_REGISTRY.gemini.free[0].id;
export const GEMINI_PAID_ANALYSIS_MODEL = MODEL_REGISTRY.gemini.paid[0].id;
export const OPENAI_ANALYSIS_MODEL = MODEL_REGISTRY.openai.models[0].id;

export const uniqueModelIds = (models: readonly unknown[]): string[] => (
  Array.from(new Set(
    models
      .filter((model): model is string => typeof model === 'string')
      .map(model => model.trim())
      .filter(Boolean),
  ))
);

export const getGeminiFreeModelIds = (extraModels: readonly unknown[] = []): string[] => (
  uniqueModelIds([...GEMINI_FREE_MODEL_VALUES, ...extraModels])
);

export const getGeminiFreeModelLabel = (model: string): string => (
  MODEL_REGISTRY.gemini.free.find(definition => definition.id === model)?.label || model
);

export const normalizeGeminiFreeModelId = (
  value: unknown,
  allowedModels: readonly unknown[] = GEMINI_FREE_MODEL_VALUES,
): string => {
  const allowed = uniqueModelIds(allowedModels);
  const requested = typeof value === 'string' ? value.trim() : '';
  if (requested && allowed.includes(requested)) return requested;
  return allowed[0] || GEMINI_ANALYSIS_MODEL;
};
