
import { GoogleGenAI } from "@google/genai";

export default async function handler(req: Request): Promise<Response> {
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

    const { prompt, apiKey, apiKeys } = await req.json();
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
      return new Response(JSON.stringify({ error: "لم يتم تكوين مفتاح Gemini API على الخادم." }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    
    if (!prompt) {
      return new Response(JSON.stringify({ error: "الموجه مطلوب" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Flash has a free-tier quota, while Pro can return limit 0 on unpaid projects.
    let lastError: unknown = null;
    for (const GEMINI_API_KEY of GEMINI_API_KEYS) {
      try {
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
        });

        const text = response.text;

        return new Response(JSON.stringify({ text }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("فشلت كل مفاتيح Gemini.");

  } catch (error) {
    console.error("Error processing request:", error);
    if (error instanceof SyntaxError) {
        return new Response(JSON.stringify({ error: "طلب JSON غير صالح" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }
    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
    return new Response(JSON.stringify({ error: `خطأ من Gemini API: ${errorMessage}` }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
