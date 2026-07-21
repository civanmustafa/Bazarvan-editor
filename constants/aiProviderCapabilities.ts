import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_PAID_ANALYSIS_MODEL,
  OPENAI_ANALYSIS_MODEL,
  type AiModelProvider,
} from './modelRegistry';
import type { AiPatchProvider } from '../types';

export type AiRuntimeProvider = AiModelProvider;

export type AiProviderCapability = {
  enabled: boolean;
  configured: boolean;
  available: boolean;
  model: string;
};

export type AiProviderCapabilities = {
  providers: Record<AiRuntimeProvider, AiProviderCapability>;
  defaultProvider: AiRuntimeProvider;
};

export const AI_RUNTIME_PROVIDER_ORDER: readonly AiRuntimeProvider[] = [
  'gemini',
  'geminiPaid',
  'openai',
];

const DEFAULT_PROVIDER_MODELS: Record<AiRuntimeProvider, string> = {
  gemini: GEMINI_ANALYSIS_MODEL,
  geminiPaid: GEMINI_PAID_ANALYSIS_MODEL,
  openai: OPENAI_ANALYSIS_MODEL,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeCapability = (
  value: unknown,
  fallback: AiProviderCapability,
): AiProviderCapability => {
  const source = isRecord(value) ? value : {};
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled;
  const configured = typeof source.configured === 'boolean' ? source.configured : fallback.configured;
  const model = typeof source.model === 'string' && source.model.trim()
    ? source.model.trim()
    : fallback.model;
  return {
    enabled,
    configured,
    available: enabled && configured,
    model,
  };
};

export const getDefaultAiProviderCapabilities = (): AiProviderCapabilities => ({
  providers: {
    gemini: {
      enabled: true,
      configured: true,
      available: true,
      model: GEMINI_ANALYSIS_MODEL,
    },
    geminiPaid: {
      enabled: true,
      configured: true,
      available: true,
      model: GEMINI_PAID_ANALYSIS_MODEL,
    },
    openai: {
      enabled: false,
      configured: false,
      available: false,
      model: OPENAI_ANALYSIS_MODEL,
    },
  },
  defaultProvider: 'gemini',
});

export const normalizeAiProviderCapabilities = (value: unknown): AiProviderCapabilities => {
  const fallback = getDefaultAiProviderCapabilities();
  const source = isRecord(value) ? value : {};
  const providersSource = isRecord(source.providers) ? source.providers : {};
  const providers = Object.fromEntries(
    AI_RUNTIME_PROVIDER_ORDER.map(provider => [
      provider,
      normalizeCapability(providersSource[provider], fallback.providers[provider]),
    ]),
  ) as Record<AiRuntimeProvider, AiProviderCapability>;
  const requestedDefault = typeof source.defaultProvider === 'string'
    ? source.defaultProvider as AiRuntimeProvider
    : fallback.defaultProvider;
  const defaultProvider = AI_RUNTIME_PROVIDER_ORDER.includes(requestedDefault)
    && providers[requestedDefault].available
    ? requestedDefault
    : AI_RUNTIME_PROVIDER_ORDER.find(provider => providers[provider].available) || 'gemini';

  return { providers, defaultProvider };
};

export const getRuntimeProviderForPatchProvider = (
  provider: AiPatchProvider,
): AiRuntimeProvider => provider === 'chatgpt' ? 'openai' : provider;

export const getPatchProviderForRuntimeProvider = (
  provider: AiRuntimeProvider,
): AiPatchProvider => provider === 'openai' ? 'chatgpt' : provider;

export const isAiPatchProviderEnabled = (
  capabilities: AiProviderCapabilities,
  provider: AiPatchProvider,
): boolean => capabilities.providers[getRuntimeProviderForPatchProvider(provider)].enabled;

export const isAiPatchProviderAvailable = (
  capabilities: AiProviderCapabilities,
  provider: AiPatchProvider,
): boolean => capabilities.providers[getRuntimeProviderForPatchProvider(provider)].available;

export const getDefaultAiPatchProvider = (
  capabilities: AiProviderCapabilities,
): AiPatchProvider => getPatchProviderForRuntimeProvider(capabilities.defaultProvider);

export const getAiProviderModel = (
  capabilities: AiProviderCapabilities,
  provider: AiPatchProvider,
): string => capabilities.providers[getRuntimeProviderForPatchProvider(provider)].model
  || DEFAULT_PROVIDER_MODELS[getRuntimeProviderForPatchProvider(provider)];
