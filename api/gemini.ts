
import { GoogleGenAI } from "@google/genai";

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/*
 * Local Gemini API route used by the Vite dev middleware.
 * The UI sends one or more user-provided keys; this route randomizes attempts
 * so quota errors on one key do not block the whole request.
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

const handleGeminiRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  try {
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const { prompt, apiKey, apiKeys, useUrlContext } = await readRequestBody(req) as any;
    const requestKeys = Array.isArray(apiKeys)
      ? apiKeys
      : typeof apiKey === 'string'
        ? [apiKey]
        : [];
    const GEMINI_API_KEYS = requestKeys
      .map(key => typeof key === 'string' ? key.trim() : '')
      .filter(Boolean);
    const serverKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (GEMINI_API_KEYS.length === 0 && serverKey) {
      GEMINI_API_KEYS.push(serverKey);
    }

    if (GEMINI_API_KEYS.length === 0) {
      return { status: 500, body: { error: "لم يتم تكوين مفتاح Gemini API على الخادم." } };
    }
    
    if (!prompt) {
      return { status: 400, body: { error: "الموجه مطلوب" } };
    }

    // Flash has a free-tier quota, while Pro can return limit 0 on unpaid projects.
    let lastError: unknown = null;
    for (const GEMINI_API_KEY of randomizeKeyOrder(GEMINI_API_KEYS)) {
      try {
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: useUrlContext
            ? {
                tools: [{ urlContext: {} }],
                toolConfig: { includeServerSideToolInvocations: true },
              }
            : undefined,
        });

        const text = response.text;

        return { status: 200, body: { text } };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("فشلت كل مفاتيح Gemini.");

  } catch (error) {
    console.error("Error processing request:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }
    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
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
