import {
  assertAiRequestPayload,
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  getPositiveIntegerEnv,
  toApiSecurityResult,
} from "./apiSecurity";

const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.4";
const ALLOWED_OPENAI_MODELS = new Set([
  OPENAI_MODEL,
  ...String(process.env.OPENAI_ALLOWED_MODELS || '')
    .split(/[\n,;]+/)
    .map(model => model.trim())
    .filter(Boolean),
]);
const OPENAI_TIMEOUT_MS = 300000;

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type OpenAiAttemptDetail = {
  keyFingerprint: string;
  keySuffix: string;
  status: number;
  reason: string;
  attempt: number;
  model: string;
};

class OpenAiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = status;
  }
}

/*
 * OpenAI/ChatGPT API route used by Vite dev middleware and the production Node server.
 * API keys are read from server environment variables only.
 */
const normalizeKeys = (apiKey?: unknown, apiKeys?: unknown): string[] => {
  const rawKeys = [
    ...(typeof apiKey === "string" ? apiKey.split(/[\n,;]+/) : []),
    ...(Array.isArray(apiKeys)
      ? apiKeys
      : typeof apiKeys === "string"
        ? apiKeys.split(/[\n,;]+/)
        : []),
  ];

  return rawKeys
    .map(key => typeof key === "string" ? key.trim() : "")
    .filter(Boolean);
};

const readNodeBody = async (req: any): Promise<unknown> => {
  if (req.body !== undefined) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};

const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req.json === "function" && typeof req.headers?.get === "function") {
    return req.json();
  }
  return readNodeBody(req);
};

const getContentType = (req: any): string => {
  if (typeof req.headers?.get === "function") {
    return req.headers.get("content-type") || "";
  }
  return String(req.headers?.["content-type"] || req.headers?.["Content-Type"] || "");
};

const toWebResponse = (result: ApiResult): Response => new Response(result.status === 204 ? null : JSON.stringify(result.body), {
  status: result.status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    ...(result.headers || {}),
  },
});

const sendNodeResponse = (res: any, result: ApiResult) => {
  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(result.status === 204 ? undefined : JSON.stringify(result.body));
};

const withCorsResponseHeaders = (req: any, result: ApiResult): ApiResult => {
  try {
    return {
      ...result,
      headers: {
        ...getCorsResponseHeaders(req),
        ...(result.headers || {}),
      },
    };
  } catch {
    return result;
  }
};

const randomizeKeyOrder = (keys: string[]): string[] => {
  const shuffled = [...keys];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const createApiKeyFingerprint = (key: string): string => {
  const normalizedKey = key.trim();
  let hash = 2166136261;
  for (let index = 0; index < normalizedKey.length; index += 1) {
    hash ^= normalizedKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const getApiKeySuffix = (key: string): string => (
  key.trim().slice(-4)
);

const normalizeConversationId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const createOpenAiConversation = async (openAiKey: string, signal: AbortSignal): Promise<string> => {
  const response = await fetch("https://api.openai.com/v1/conversations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      metadata: {
        source: "bazarvan-editor",
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw new OpenAiRequestError(await extractErrorMessage(response), response.status);
  }

  const data = await response.json();
  const conversationId = normalizeConversationId(data?.id);
  if (!conversationId) {
    throw new Error("OpenAI did not return a valid conversation id.");
  }

  return conversationId;
};

const extractResponseText = (data: any): string => {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  const textParts = data?.output
    ?.flatMap((item: any) => item?.content || [])
    ?.map((content: any) => content?.text)
    ?.filter((text: unknown): text is string => typeof text === "string" && text.trim().length > 0);

  return Array.isArray(textParts) ? textParts.join("\n").trim() : "";
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  const raw = await response.text();
  if (!raw) return response.statusText || "OpenAI request failed";

  try {
    const data = JSON.parse(raw);
    return data?.error?.message || data?.error || raw;
  } catch {
    return raw;
  }
};

const isMissingConversationError = (error: unknown): boolean => (
  error instanceof OpenAiRequestError
  && error.status === 404
  && error.message.toLowerCase().includes("conversation")
);

const getOpenAiAttemptFailure = (
  key: string,
  model: string,
  attempt: number,
  error: unknown,
): OpenAiAttemptDetail => {
  const isTimeout = error instanceof Error && error.name === "AbortError";
  const status = error instanceof OpenAiRequestError
    ? error.status
    : isTimeout
      ? 504
      : 500;
  const reason = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "OpenAI request failed";

  return {
    keyFingerprint: createApiKeyFingerprint(key),
    keySuffix: getApiKeySuffix(key),
    status,
    reason,
    attempt,
    model,
  };
};

const createOpenAiResponse = async (
  openAiKey: string,
  signal: AbortSignal,
  selectedModel: string,
  conversationId: string,
  prompt: string,
): Promise<string> => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      model: selectedModel,
      conversation: conversationId,
      instructions: "أنت خبير SEO وAEO وGEO وLLM SEO. أجب بالعربية بشكل عملي ومنظم.",
      input: prompt,
      max_output_tokens: 8000,
    }),
    signal,
  });

  if (!response.ok) {
    throw new OpenAiRequestError(await extractErrorMessage(response), response.status);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) {
    throw new Error("لم يرجع OpenAI نصًا صالحًا.");
  }

  return text;
};

const handleChatGptRequest = async (req: any): Promise<ApiResult> => {
  try {
    assertAllowedOrigin(req);
  } catch (error) {
    return toApiSecurityResult(error) || { status: 403, body: { error: "Request origin is not allowed." } };
  }

  if (req.method === "OPTIONS") {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, "POST, OPTIONS"),
    };
  }

  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  const attempts: OpenAiAttemptDetail[] = [];
  let selectedModel = OPENAI_MODEL;

  try {
    const principal = await authenticateApiRequest(req);
    consumeApiRateLimit(
      "openai:start",
      principal.userId,
      getPositiveIntegerEnv("OPENAI_START_RATE_LIMIT_PER_MINUTE", 20),
    );
    assertRequestContentLength(req, 1_500_000);
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const requestBody = await readRequestBody(req) as any;
    assertAiRequestPayload(requestBody);
    const prompt = String(requestBody.prompt);
    const { model, conversationId } = requestBody;

    const openAiKeys = normalizeKeys(process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEYS);

    if (openAiKeys.length === 0) {
      return { status: 500, body: { error: "لم يتم تكوين مفتاح ChatGPT API." } };
    }

    selectedModel = typeof model === "string" && ALLOWED_OPENAI_MODELS.has(model.trim())
      ? model.trim()
      : OPENAI_MODEL;
    const requestedConversationId = normalizeConversationId(conversationId);

    let lastError: unknown = null;
    let sawMissingConversationError = false;
    const openAiKeysToTry = randomizeKeyOrder(openAiKeys);
    for (const openAiKey of openAiKeysToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

      try {
        const activeConversationId = requestedConversationId || await createOpenAiConversation(openAiKey, controller.signal);
        const text = await createOpenAiResponse(openAiKey, controller.signal, selectedModel, activeConversationId, prompt);

        return {
          status: 200,
          body: {
            text,
            conversationId: activeConversationId,
            keyFingerprint: createApiKeyFingerprint(openAiKey),
            keySuffix: getApiKeySuffix(openAiKey),
            provider: "openai",
            model: selectedModel,
            attempts,
          },
        };
      } catch (error) {
        if (requestedConversationId && isMissingConversationError(error)) {
          sawMissingConversationError = true;
          lastError = error;
          continue;
        }

        attempts.push(getOpenAiAttemptFailure(openAiKey, selectedModel, attempts.length + 1, error));
        lastError = error instanceof Error && error.name === "AbortError"
          ? new Error("انتهت مهلة اتصال الخادم بـ OpenAI قبل وصول رد.")
          : error;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (requestedConversationId && sawMissingConversationError) {
      for (const openAiKey of openAiKeysToTry) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

        try {
          const activeConversationId = await createOpenAiConversation(openAiKey, controller.signal);
          const text = await createOpenAiResponse(openAiKey, controller.signal, selectedModel, activeConversationId, prompt);

          return {
            status: 200,
            body: {
              text,
              conversationId: activeConversationId,
              conversationReset: true,
              keyFingerprint: createApiKeyFingerprint(openAiKey),
              keySuffix: getApiKeySuffix(openAiKey),
              provider: "openai",
              model: selectedModel,
              attempts,
            },
          };
        } catch (error) {
          attempts.push(getOpenAiAttemptFailure(openAiKey, selectedModel, attempts.length + 1, error));
          lastError = error instanceof Error && error.name === "AbortError"
            ? new Error("انتهت مهلة اتصال الخادم بـ OpenAI قبل وصول رد.")
            : error;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }

    throw lastError || new Error("فشلت كل مفاتيح ChatGPT.");
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return securityResult;
    console.error("ChatGPT API Error:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }

    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
    const lastAttempt = attempts[attempts.length - 1];
    return {
      status: lastAttempt?.status && lastAttempt.status >= 400 && lastAttempt.status < 500 ? lastAttempt.status : 500,
      body: {
        error: `خطأ من ChatGPT API: ${errorMessage}`,
        provider: "openai",
        model: selectedModel,
        keyFingerprint: lastAttempt?.keyFingerprint,
        keySuffix: lastAttempt?.keySuffix,
        attempts,
      },
    };
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = withCorsResponseHeaders(req, await handleChatGptRequest(req));
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}
