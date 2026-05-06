const OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 120000;

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/*
 * Local OpenAI/ChatGPT API route used by the Vite dev middleware.
 * Keep browser code away from direct OpenAI calls; add request/response changes here.
 */
const normalizeKeys = (apiKey?: unknown, apiKeys?: unknown): string[] => {
  const rawKeys = Array.isArray(apiKeys)
    ? apiKeys
    : typeof apiKey === "string"
      ? [apiKey]
      : [];

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
  res.end(JSON.stringify(result.body));
};

const randomizeKeyOrder = (keys: string[]): string[] => {
  const shuffled = [...keys];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
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

const handleChatGptRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === "OPTIONS") {
    return {
      status: 204,
      body: {},
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    };
  }

  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  try {
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const { prompt, apiKey, apiKeys, model } = await readRequestBody(req) as any;
    if (!prompt || typeof prompt !== "string") {
      return { status: 400, body: { error: "الموجه مطلوب" } };
    }

    const openAiKeys = normalizeKeys(apiKey, apiKeys);
    const serverKey = process.env.OPENAI_API_KEY;
    if (openAiKeys.length === 0 && serverKey) {
      openAiKeys.push(serverKey);
    }

    if (openAiKeys.length === 0) {
      return { status: 500, body: { error: "لم يتم تكوين مفتاح ChatGPT API." } };
    }

    const selectedModel = typeof model === "string" && model.trim()
      ? model.trim()
      : OPENAI_MODEL;

    let lastError: unknown = null;
    for (const openAiKey of randomizeKeyOrder(openAiKeys)) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

      try {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: selectedModel,
            instructions: "أنت خبير SEO وAEO وGEO وLLM SEO. أجب بالعربية بشكل عملي ومنظم.",
            input: prompt,
            max_output_tokens: 3000,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await extractErrorMessage(response));
        }

        const data = await response.json();
        const text = extractResponseText(data);
        if (!text) {
          throw new Error("لم يرجع OpenAI نصًا صالحًا.");
        }

        return {
          status: 200,
          body: { text },
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        };
      } catch (error) {
        lastError = error instanceof Error && error.name === "AbortError"
          ? new Error("انتهت مهلة اتصال الخادم بـ OpenAI قبل وصول رد.")
          : error;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || new Error("فشلت كل مفاتيح ChatGPT.");
  } catch (error) {
    console.error("ChatGPT API Error:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }

    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
    return { status: 500, body: { error: `خطأ من ChatGPT API: ${errorMessage}` } };
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = await handleChatGptRequest(req);
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}
