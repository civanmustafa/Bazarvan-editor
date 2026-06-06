
import { GoogleGenAI } from "@google/genai";

// Keep the serverless function self-contained: Vercel executes this compiled
// ESM file directly and cannot resolve extensionless frontend module imports.
const GEMINI_ANALYSIS_MODEL = "gemini-2.5-flash";

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type GeminiErrorDetails = {
  status: number;
  message: string;
};

type GeminiHistoryContent = {
  role: "user" | "model";
  parts: { text: string }[];
};

const RETRIABLE_GEMINI_STATUSES = new Set([500, 502, 503, 504]);

const createApiKeyFingerprint = (key: string): string => {
  const normalizedKey = key.trim();
  let hash = 2166136261;
  for (let index = 0; index < normalizedKey.length; index += 1) {
    hash ^= normalizedKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/*
 * Local Gemini API route used by the Vite dev middleware.
 * The UI may send user-provided keys; otherwise this route reads server keys.
 * Key attempts are randomized so quota errors on one key do not block the request.
 */
const randomizeKeyOrder = (keys: string[]): string[] => {
  const shuffled = [...keys];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
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

const toWebResponse = (result: ApiResult): Response => new Response(JSON.stringify(result.body), {
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
  res.end(JSON.stringify(result.body));
};

const parseEnvGeminiKeys = (): string[] => {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  return raw
    .split(/[\n,;]+/)
    .map(key => key.trim())
    .filter(Boolean);
};

const normalizeGeminiHistory = (history: unknown): GeminiHistoryContent[] => {
  if (!Array.isArray(history)) return [];

  return history
    .map((item): GeminiHistoryContent | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const role = record.role === "user" || record.role === "model"
        ? record.role
        : null;
      const text = typeof record.text === "string" ? record.text.trim() : "";

      if (!role || !text) return null;
      return { role, parts: [{ text }] };
    })
    .filter((item): item is GeminiHistoryContent => Boolean(item));
};

const getGeminiErrorDetails = (error: unknown): GeminiErrorDetails => {
  const value = error && typeof error === "object" ? error as Record<string, any> : {};
  const nestedError = value.error && typeof value.error === "object" ? value.error : {};
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof nestedError.message === "string"
        ? nestedError.message
        : typeof value.message === "string"
          ? value.message
          : "خطأ غير معروف";
  const statusFromValue = typeof value.status === "number"
    ? value.status
    : typeof nestedError.code === "number"
      ? nestedError.code
      : undefined;
  const statusFromMessage = message.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/)?.[1];

  return {
    status: statusFromValue || (statusFromMessage ? Number(statusFromMessage) : 502),
    message,
  };
};

const wait = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));

const handleGeminiRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  try {
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const { prompt, apiKey, apiKeys, useUrlContext, history } = await readRequestBody(req) as any;
    const requestKeys = Array.isArray(apiKeys)
      ? apiKeys
      : typeof apiKey === 'string'
        ? [apiKey]
        : [];
    const GEMINI_API_KEYS = requestKeys
      .map(key => typeof key === 'string' ? key.trim() : '')
      .filter(Boolean);
    if (GEMINI_API_KEYS.length === 0) {
      GEMINI_API_KEYS.push(...parseEnvGeminiKeys());
    }

    if (GEMINI_API_KEYS.length === 0) {
      return { status: 503, body: { error: "لم يتم تكوين مفتاح Gemini API على الخادم." } };
    }
    
    if (!prompt) {
      return { status: 400, body: { error: "الموجه مطلوب" } };
    }

    const normalizedPrompt = typeof prompt === "string" ? prompt : String(prompt);
    const normalizedHistory = normalizeGeminiHistory(history);
    const contents = normalizedHistory.length > 0
      ? [...normalizedHistory, { role: "user" as const, parts: [{ text: normalizedPrompt }] }]
      : normalizedPrompt;

    // Flash has a free-tier quota, while Pro can return limit 0 on unpaid projects.
    let lastError: GeminiErrorDetails | null = null;
    for (const GEMINI_API_KEY of randomizeKeyOrder(GEMINI_API_KEYS)) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
          const response = await ai.models.generateContent({
            model: GEMINI_ANALYSIS_MODEL,
            contents,
            config: useUrlContext
              ? {
                  tools: [{ urlContext: {} }],
                  toolConfig: { includeServerSideToolInvocations: true },
                }
              : undefined,
          });

          const text = response.text;

          return { status: 200, body: { text, keyFingerprint: createApiKeyFingerprint(GEMINI_API_KEY) } };
        } catch (error) {
          lastError = getGeminiErrorDetails(error);
          if (attempt === 0 && RETRIABLE_GEMINI_STATUSES.has(lastError.status)) {
            await wait(400);
            continue;
          }
          break;
        }
      }
    }

    const responseStatus = lastError && lastError.status >= 400 && lastError.status < 500
      ? lastError.status
      : 502;
    return {
      status: responseStatus,
      body: {
        error: `خطأ من Gemini API باستخدام النموذج ${GEMINI_ANALYSIS_MODEL}: ${lastError?.message || "فشلت كل مفاتيح Gemini."}`,
      },
    };

  } catch (error) {
    console.error("Error processing request:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }
    const errorMessage = getGeminiErrorDetails(error).message;
    return { status: 500, body: { error: `خطأ من Gemini API: ${errorMessage}` } };
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = await handleGeminiRequest(req);
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}
