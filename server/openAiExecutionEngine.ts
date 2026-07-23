import { randomUUID } from 'node:crypto';
import { OPENAI_ANALYSIS_MODEL } from '../constants/modelRegistry';
import type { ApiResult } from '../api/http.ts';
import {
  normalizeAiExecutionTelemetryContext,
  type AiExecutionTelemetryContext,
} from './aiExecutionEngine';
import { recordAiExecutionTelemetry } from './aiExecutionTelemetry';
import { readAiProviderCapabilities } from './aiProviderCapabilities';
import { resolveOpenAiApiKeys } from './adminAiProviderSecrets';
import { normalizeOpenAiUsage, type NormalizedAiUsage } from './aiUsage';

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || OPENAI_ANALYSIS_MODEL;
const DEFAULT_OPENAI_INSTRUCTIONS = 'You are an expert SEO, AEO, GEO, and LLM SEO content assistant. Follow the user instructions precisely.';

type OpenAiAttemptDetail = {
  keyFingerprint: string;
  keySuffix: string;
  status: number;
  reason: string;
  attempt: number;
  model: string;
};

export type OpenAiConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type OpenAiExecutionRequest = {
  prompt?: string;
  instructions?: string;
  messages?: OpenAiConversationMessage[];
  model?: string;
  conversationId?: string;
  requestId?: string;
  maxOutputTokens?: number;
  conversationMode?: 'managed' | 'independent';
  promptCacheKey?: string;
};

export type OpenAiExecutionOptions = {
  signal?: AbortSignal;
  telemetry?: AiExecutionTelemetryContext;
};

class OpenAiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenAiRequestError';
    this.status = status;
  }
}

const randomizeKeyOrder = (keys: string[]): string[] => {
  const shuffled = [...keys];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
};

const createApiKeyFingerprint = (key: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const getApiKeySuffix = (key: string): string => key.trim().slice(-4);

const normalizeConversationId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  const raw = await response.text();
  if (!raw) return response.statusText || 'OpenAI request failed.';
  try {
    const data = JSON.parse(raw);
    return String(data?.error?.message || data?.error || raw);
  } catch {
    return raw;
  }
};

const extractResponseText = (data: any): string => {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const textParts = data?.output
    ?.flatMap((item: any) => item?.content || [])
    ?.map((content: any) => content?.text)
    ?.filter((text: unknown): text is string => typeof text === 'string' && Boolean(text.trim()));
  return Array.isArray(textParts) ? textParts.join('\n').trim() : '';
};

const connectAbortSignal = (
  source: AbortSignal | undefined,
  target: AbortController,
): (() => void) => {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
};

const createOpenAiConversation = async (openAiKey: string, signal: AbortSignal): Promise<string> => {
  const response = await fetch('https://api.openai.com/v1/conversations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({ metadata: { source: 'bazarvan-editor' } }),
    signal,
  });
  if (!response.ok) throw new OpenAiRequestError(await extractErrorMessage(response), response.status);
  const data = await response.json();
  const conversationId = normalizeConversationId(data?.id);
  if (!conversationId) throw new Error('OpenAI did not return a valid conversation id.');
  return conversationId;
};

const normalizeInput = (request: OpenAiExecutionRequest): string | OpenAiConversationMessage[] => {
  const messages = Array.isArray(request.messages)
    ? request.messages
      .filter(message => (
        (message?.role === 'user' || message?.role === 'assistant')
        && typeof message.content === 'string'
        && Boolean(message.content.trim())
      ))
      .map(message => ({ role: message.role, content: message.content }))
    : [];
  if (messages.length > 0) return messages;
  return String(request.prompt || '').trim();
};

const createOpenAiResponse = async (options: {
  openAiKey: string;
  signal: AbortSignal;
  model: string;
  conversationId?: string;
  instructions: string;
  input: string | OpenAiConversationMessage[];
  maxOutputTokens: number;
  promptCacheKey?: string;
}): Promise<{
  text: string;
  responseId?: string;
  usage: NormalizedAiUsage;
}> => {
  const body = {
    model: options.model,
    ...(options.conversationId ? { conversation: options.conversationId } : {}),
    instructions: options.instructions,
    input: options.input,
    max_output_tokens: options.maxOutputTokens,
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.openAiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) throw new OpenAiRequestError(await extractErrorMessage(response), response.status);
  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error('OpenAI did not return a valid text response.');
  return {
    text,
    responseId: normalizeConversationId(data?.id),
    usage: normalizeOpenAiUsage(data?.usage),
  };
};

const isMissingConversationError = (error: unknown): boolean => (
  error instanceof OpenAiRequestError
  && error.status === 404
  && error.message.toLowerCase().includes('conversation')
);

const getAttemptFailure = (
  key: string,
  model: string,
  attempt: number,
  error: unknown,
): OpenAiAttemptDetail => {
  const aborted = error instanceof Error && error.name === 'AbortError';
  return {
    keyFingerprint: createApiKeyFingerprint(key),
    keySuffix: getApiKeySuffix(key),
    status: error instanceof OpenAiRequestError ? error.status : aborted ? 504 : 500,
    reason: error instanceof Error && error.message.trim() ? error.message.trim() : 'OpenAI request failed.',
    attempt,
    model,
  };
};

const sanitizeResult = (result: ApiResult): ApiResult => {
  if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) return result;
  const body = result.body as Record<string, unknown>;
  const attempts = Array.isArray(body.attempts)
    ? body.attempts.map(attempt => {
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return attempt;
      const { keyFingerprint: _fingerprint, ...safeAttempt } = attempt as Record<string, unknown>;
      return safeAttempt;
    })
    : body.attempts;
  const { keyFingerprint: _fingerprint, ...safeBody } = body;
  return {
    ...result,
    body: { ...safeBody, ...(attempts !== undefined ? { attempts } : {}) },
  };
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.round(parsed), maximum)) : fallback;
};

export const executeOpenAiRequest = async (
  request: OpenAiExecutionRequest,
  options: OpenAiExecutionOptions = {},
): Promise<ApiResult> => {
  const startedAt = Date.now();
  const telemetry = normalizeAiExecutionTelemetryContext(options.telemetry);
  const attempts: OpenAiAttemptDetail[] = [];
  const requestId = String(request.requestId || '').trim().slice(0, 200) || randomUUID();
  let selectedModel = DEFAULT_OPENAI_MODEL;

  const finalize = async (result: ApiResult): Promise<ApiResult> => {
    const body = result.body && typeof result.body === 'object' && !Array.isArray(result.body)
      ? result.body as Record<string, unknown>
      : {};
    if (telemetry.actorUserId) {
      await recordAiExecutionTelemetry({
        requestId,
        actorUserId: telemetry.actorUserId,
        provider: 'openai',
        model: typeof body.model === 'string' ? body.model : selectedModel,
        source: telemetry.source,
        articleId: telemetry.articleId,
        status: result.status,
        durationMs: Date.now() - startedAt,
        body,
        context: { ...telemetry },
      }).catch(error => {
        console.warn('[openai-engine] Could not persist request telemetry', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return sanitizeResult(result);
  };

  try {
    if (options.signal?.aborted) {
      return finalize({ status: 499, body: { error: 'OpenAI request was cancelled.', code: 'AI_REQUEST_CANCELLED' } });
    }
    const capabilities = await readAiProviderCapabilities();
    const capability = capabilities.providers.openai;
    selectedModel = capability.model || DEFAULT_OPENAI_MODEL;
    if (!capability.enabled) {
      return finalize({
        status: 403,
        body: { error: 'OpenAI is disabled by the system administrator.', code: 'AI_PROVIDER_DISABLED', provider: 'openai', model: selectedModel },
      });
    }
    if (!capability.configured) {
      return finalize({
        status: 503,
        body: { error: 'OpenAI is enabled but no server API key is configured.', code: 'AI_PROVIDER_NOT_CONFIGURED', provider: 'openai', model: selectedModel },
      });
    }

    const allowedModels = new Set([
      DEFAULT_OPENAI_MODEL,
      selectedModel,
      ...String(process.env.OPENAI_ALLOWED_MODELS || '').split(/[\n,;]+/).map(value => value.trim()).filter(Boolean),
    ]);
    const requestedModel = String(request.model || '').trim();
    selectedModel = requestedModel && allowedModels.has(requestedModel) ? requestedModel : selectedModel;
    const input = normalizeInput(request);
    if ((typeof input === 'string' && !input) || (Array.isArray(input) && input.length === 0)) {
      return finalize({ status: 400, body: { error: 'An OpenAI prompt or message list is required.', code: 'AI_PROMPT_REQUIRED' } });
    }

    const credentials = await resolveOpenAiApiKeys();
    const keys = randomizeKeyOrder(credentials.keys);
    if (keys.length === 0) {
      return finalize({ status: 503, body: { error: 'No OpenAI API key is configured.', code: 'AI_PROVIDER_NOT_CONFIGURED', provider: 'openai', model: selectedModel } });
    }

    const timeoutMs = boundedInteger(process.env.OPENAI_TIMEOUT_MS, 300_000, 10_000, 900_000);
    const maxOutputTokens = boundedInteger(request.maxOutputTokens, 8_000, 256, 32_000);
    const instructions = String(request.instructions || '').trim() || DEFAULT_OPENAI_INSTRUCTIONS;
    const requestedConversationId = normalizeConversationId(request.conversationId);
    const conversationMode = request.conversationMode === 'independent' ? 'independent' : 'managed';
    const promptCacheKey = String(request.promptCacheKey || '').trim().slice(0, 200) || undefined;
    let sawMissingConversation = false;
    let lastError: unknown = null;

    const tryKeys = async (resetConversation: boolean): Promise<ApiResult | null> => {
      for (const key of keys) {
        if (options.signal?.aborted) {
          return { status: 499, body: { error: 'OpenAI request was cancelled.', code: 'AI_REQUEST_CANCELLED', provider: 'openai', model: selectedModel, attempts } };
        }
        const controller = new AbortController();
        const disconnect = connectAbortSignal(options.signal, controller);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const conversationId = conversationMode === 'independent'
            ? undefined
            : resetConversation || !requestedConversationId
              ? await createOpenAiConversation(key, controller.signal)
              : requestedConversationId;
          const response = await createOpenAiResponse({
            openAiKey: key,
            signal: controller.signal,
            model: selectedModel,
            conversationId,
            instructions,
            input,
            maxOutputTokens,
            promptCacheKey,
          });
          return {
            status: 200,
            body: {
              text: response.text,
              ...(conversationId ? { conversationId } : {}),
              ...(response.responseId ? { responseId: response.responseId } : {}),
              usage: response.usage,
              ...(resetConversation && requestedConversationId ? { conversationReset: true } : {}),
              keyFingerprint: createApiKeyFingerprint(key),
              keySuffix: getApiKeySuffix(key),
              provider: 'openai',
              model: selectedModel,
              credentialSource: credentials.source,
              attempts,
            },
          };
        } catch (error) {
          if (!resetConversation && requestedConversationId && isMissingConversationError(error)) {
            sawMissingConversation = true;
            lastError = error;
            continue;
          }
          attempts.push(getAttemptFailure(key, selectedModel, attempts.length + 1, error));
          lastError = error;
        } finally {
          clearTimeout(timeoutId);
          disconnect();
        }
      }
      return null;
    };

    const firstResult = await tryKeys(false);
    if (firstResult) return finalize(firstResult);
    if (conversationMode === 'managed' && requestedConversationId && sawMissingConversation) {
      const resetResult = await tryKeys(true);
      if (resetResult) return finalize(resetResult);
    }

    const lastAttempt = attempts[attempts.length - 1];
    const status = lastAttempt?.status && lastAttempt.status >= 400 && lastAttempt.status < 500
      ? lastAttempt.status
      : 500;
    const message = lastError instanceof Error ? lastError.message : 'All OpenAI API keys failed.';
    return finalize({
      status,
      body: {
        error: `OpenAI API request failed: ${message}`,
        code: 'OPENAI_REQUEST_FAILED',
        provider: 'openai',
        model: selectedModel,
        credentialSource: credentials.source,
        keyFingerprint: lastAttempt?.keyFingerprint,
        keySuffix: lastAttempt?.keySuffix,
        attempts,
      },
    });
  } catch (error) {
    return finalize({
      status: 500,
      body: {
        error: error instanceof Error ? error.message : 'Unknown OpenAI execution error.',
        code: 'OPENAI_EXECUTION_FAILED',
        provider: 'openai',
        model: selectedModel,
        attempts,
      },
    });
  }
};

export const openAiExecutionEngine = {
  execute: executeOpenAiRequest,
};
