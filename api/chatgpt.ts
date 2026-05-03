const OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 120000;

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

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "الطريقة غير مسموح بها" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    if (!req.headers.get("content-type")?.includes("application/json")) {
      return new Response(JSON.stringify({ error: "يجب أن يكون نوع المحتوى application/json" }), {
        status: 415,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const { prompt, apiKey, apiKeys, model } = await req.json();
    if (!prompt || typeof prompt !== "string") {
      return new Response(JSON.stringify({ error: "الموجه مطلوب" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const openAiKeys = normalizeKeys(apiKey, apiKeys);
    const serverKey = process.env.OPENAI_API_KEY;
    if (openAiKeys.length === 0 && serverKey) {
      openAiKeys.push(serverKey);
    }

    if (openAiKeys.length === 0) {
      return new Response(JSON.stringify({ error: "لم يتم تكوين مفتاح ChatGPT API." }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const selectedModel = typeof model === "string" && model.trim()
      ? model.trim()
      : OPENAI_MODEL;

    let lastError: unknown = null;
    for (const openAiKey of openAiKeys) {
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

        return new Response(JSON.stringify({ text }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
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
      return new Response(JSON.stringify({ error: "طلب JSON غير صالح" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
    return new Response(JSON.stringify({ error: `خطأ من ChatGPT API: ${errorMessage}` }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
