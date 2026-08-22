import type { AiRuntimeProvider } from './aiProviderCapabilities';
import type {
  AdminAiSecretProvider,
  ContentWritingResumeSecretProvider,
} from './adminAiProviderSecrets';

const RESUME_MODEL_SEPARATOR = '::';

const RESUME_SECRET_PROVIDER_BY_RUNTIME: Record<AiRuntimeProvider, ContentWritingResumeSecretProvider> = {
  gemini: 'content_writing_resume_gemini',
  geminiPaid: 'content_writing_resume_gemini_paid',
  openai: 'content_writing_resume_openai',
};

export type ContentWritingResumeModelPreference = {
  provider: AiRuntimeProvider;
  model: string;
};

export const encodeContentWritingResumeModel = (
  provider: AiRuntimeProvider,
  model: string,
): string => `${provider}${RESUME_MODEL_SEPARATOR}${model.trim()}`;

export const parseContentWritingResumeModel = (
  value: unknown,
): ContentWritingResumeModelPreference | null => {
  if (typeof value !== 'string') return null;
  const separatorIndex = value.indexOf(RESUME_MODEL_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const provider = value.slice(0, separatorIndex) as AiRuntimeProvider;
  const model = value.slice(separatorIndex + RESUME_MODEL_SEPARATOR.length).trim();
  if (!['gemini', 'geminiPaid', 'openai'].includes(provider) || !model) return null;
  return { provider, model: model.slice(0, 200) };
};

export const getContentWritingResumeSecretProvider = (
  provider: AiRuntimeProvider,
): ContentWritingResumeSecretProvider => RESUME_SECRET_PROVIDER_BY_RUNTIME[provider];

export const isContentWritingResumeSecretProvider = (
  provider: AdminAiSecretProvider,
): provider is ContentWritingResumeSecretProvider => (
  Object.values(RESUME_SECRET_PROVIDER_BY_RUNTIME).includes(
    provider as ContentWritingResumeSecretProvider,
  )
);
