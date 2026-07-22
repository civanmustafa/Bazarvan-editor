import {
  getDefaultAiProviderCapabilities,
  normalizeAiProviderCapabilities,
  type AiProviderCapabilities,
} from '../constants/aiProviderCapabilities';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_PAID_ANALYSIS_MODEL,
  OPENAI_ANALYSIS_MODEL,
} from '../constants/modelRegistry';
import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import {
  getEnvironmentGeminiApiKeys,
  readAiProviderCredentialAvailability,
} from './adminAiProviderSecrets';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const readAiProviderCapabilities = async (): Promise<AiProviderCapabilities> => {
  const defaults = getDefaultAiProviderCapabilities();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  const storedAi = isRecord(data?.value) ? data.value : {};
  const settings = normalizeSystemSettingsMap({ ai: storedAi }).ai;
  const geminiConfigured = getEnvironmentGeminiApiKeys('gemini').length > 0;
  const credentialAvailability = await readAiProviderCredentialAvailability();

  return normalizeAiProviderCapabilities({
    providers: {
      gemini: {
        enabled: settings.geminiFreeEnabled !== false,
        configured: geminiConfigured,
        model: String(settings.defaultGeminiModel || process.env.GEMINI_MODEL || GEMINI_ANALYSIS_MODEL),
      },
      geminiPaid: {
        enabled: settings.geminiProEnabled !== false,
        configured: credentialAvailability.geminiPaid.configured,
        model: String(
          settings.defaultGeminiPaidModel
          || process.env.GEMINI_PAID_MODEL
          || process.env.GEMINI_PRO_MODEL
          || GEMINI_PAID_ANALYSIS_MODEL
        ),
      },
      openai: {
        enabled: settings.openAiEnabled === true,
        configured: credentialAvailability.openai.configured,
        model: String(settings.defaultOpenAiModel || process.env.OPENAI_MODEL || OPENAI_ANALYSIS_MODEL),
      },
    },
    defaultProvider: settings.defaultProvider || defaults.defaultProvider,
  });
};
