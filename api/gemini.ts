
import { GoogleGenAI } from "@google/genai";

// Keep the serverless function self-contained: Vercel executes this compiled
// ESM file directly and cannot resolve extensionless frontend module imports.
const DEFAULT_GEMINI_ANALYSIS_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_PAID_ANALYSIS_MODEL = "gemini-2.5-pro";
const DEFAULT_GEMINI_FREE_MODELS = [
  DEFAULT_GEMINI_ANALYSIS_MODEL,
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
];
const GEMINI_ANALYSIS_MODEL = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_ANALYSIS_MODEL;
const GEMINI_PAID_ANALYSIS_MODEL = process.env.GEMINI_PAID_MODEL?.trim() || DEFAULT_GEMINI_PAID_ANALYSIS_MODEL;
const ALLOWED_GEMINI_MODELS = new Set([
  ...DEFAULT_GEMINI_FREE_MODELS,
  GEMINI_ANALYSIS_MODEL,
  GEMINI_PAID_ANALYSIS_MODEL,
  ...((process.env.GEMINI_ALLOWED_MODELS || "")
    .split(/[\n,;]+/)
    .map(model => model.trim())
    .filter(Boolean)),
]);

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type GeminiErrorDetails = {
  status: number;
  message: string;
};

type GeminiAttemptFailureReason = "quota" | "auth" | "server" | "blocked" | "unknown";

type GeminiAttemptDetail = {
  keyFingerprint: string;
  keySuffix: string;
  status: number;
  reason: GeminiAttemptFailureReason;
  attempt: number;
};

type GeminiHistoryContent = {
  role: "user" | "model";
  parts: { text: string }[];
};

type GeminiProvider = "gemini" | "geminiPaid";
type GeminiProgressStage = "queued" | "attempting" | "retrying" | "failed-key" | "switching-key" | "success" | "failed";

type GeminiProgressState = {
  id: string;
  stage: GeminiProgressStage;
  provider: GeminiProvider;
  model: string;
  keyCount: number;
  attemptedKeyCount: number;
  currentKeyIndex?: number;
  currentAttempt?: number;
  keySuffix?: string;
  status?: number;
  reason?: GeminiAttemptFailureReason;
  message: string;
  updatedAt: string;
  completed: boolean;
};

const RETRIABLE_GEMINI_STATUSES = new Set([500, 502, 503, 504]);
const GEMINI_PROGRESS_TTL_MS = 10 * 60 * 1000;
const geminiProgressStore = new Map<string, GeminiProgressState>();

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

const normalizeProgressId = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(normalized) ? normalized : "";
};

const cleanupGeminiProgressStore = () => {
  const cutoff = Date.now() - GEMINI_PROGRESS_TTL_MS;
  for (const [id, progress] of geminiProgressStore.entries()) {
    const updatedAt = Date.parse(progress.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
      geminiProgressStore.delete(id);
    }
  }
};

const setGeminiProgress = (
  progressId: string,
  patch: Omit<Partial<GeminiProgressState>, "id" | "updatedAt">,
) => {
  if (!progressId) return;
  cleanupGeminiProgressStore();
  const previous = geminiProgressStore.get(progressId);
  geminiProgressStore.set(progressId, {
    id: progressId,
    stage: "queued",
    provider: "gemini",
    model: GEMINI_ANALYSIS_MODEL,
    keyCount: 0,
    attemptedKeyCount: 0,
    message: "",
    completed: false,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
};

const getProgressIdFromRequest = (req: any): string => {
  const routeProgressId = req?.params?.progressId || req?.query?.progressId;
  const normalizedRouteId = normalizeProgressId(routeProgressId);
  if (normalizedRouteId) return normalizedRouteId;

  try {
    const pathname = new URL(String(req?.url || ""), "http://localhost").pathname;
    return normalizeProgressId(pathname.split("/").filter(Boolean).pop());
  } catch {
    return "";
  }
};

/*
 * Gemini API route used by Vite dev middleware and the production Node server.
 * API keys are read from server environment variables only.
 * Key attempts start with the next key in a round-robin order so repeated
 * analyses spread load across server-side keys, then fall back through the rest.
 */
const keyRotationState: Record<GeminiProvider, { signature: string; nextIndex: number }> = {
  gemini: { signature: "", nextIndex: 0 },
  geminiPaid: { signature: "", nextIndex: 0 },
};

const getRoundRobinKeyOrder = (provider: GeminiProvider, keys: string[]): string[] => {
  if (keys.length <= 1) return [...keys];

  const signature = keys.join("\n");
  const state = keyRotationState[provider];
  if (state.signature !== signature) {
    state.signature = signature;
    state.nextIndex = 0;
  }

  const startIndex = state.nextIndex % keys.length;
  state.nextIndex = (startIndex + 1) % keys.length;
  return [...keys.slice(startIndex), ...keys.slice(0, startIndex)];
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

const parseGeminiKeyList = (...rawValues: Array<string | undefined>): string[] => (
  Array.from(new Set(
    rawValues
      .flatMap(raw => String(raw || '').split(/[\n,;]+/))
      .map(key => key.trim())
      .filter(Boolean)
  ))
);

const parseEnvGeminiKeys = (provider: GeminiProvider): string[] => {
  return provider === "geminiPaid"
    ? parseGeminiKeyList(
        process.env.GEMINI_PAID_API_KEYS,
        process.env.GEMINI_PAID_API_KEY,
        process.env.GEMINI_PRO_API_KEYS,
        process.env.GEMINI_PRO_API_KEY,
      )
    : parseGeminiKeyList(
        process.env.GEMINI_API_KEYS,
        process.env.GEMINI_API_KEY,
        process.env.API_KEY,
      );
};

const getProviderEnvHint = (provider: GeminiProvider): string => (
  provider === "geminiPaid"
    ? "GEMINI_PAID_API_KEYS أو GEMINI_PAID_API_KEY"
    : "GEMINI_API_KEYS أو GEMINI_API_KEY"
);

const normalizeGeminiProvider = (value: unknown): GeminiProvider => (
  value === "geminiPaid" ? "geminiPaid" : "gemini"
);

const selectGeminiProvider = (requestedProvider: GeminiProvider, selectedModel: string): GeminiProvider => (
  requestedProvider === "geminiPaid" || selectedModel === GEMINI_PAID_ANALYSIS_MODEL
    ? "geminiPaid"
    : "gemini"
);

const selectGeminiModel = (model: unknown, provider: GeminiProvider): string => {
  if (typeof model === "string" && ALLOWED_GEMINI_MODELS.has(model)) {
    return model;
  }

  return provider === "geminiPaid" ? GEMINI_PAID_ANALYSIS_MODEL : GEMINI_ANALYSIS_MODEL;
};

const getSafeGeminiModel = (selectedModel: string, provider: GeminiProvider): string => {
  if (ALLOWED_GEMINI_MODELS.has(selectedModel)) return selectedModel;
  return provider === "geminiPaid" ? GEMINI_PAID_ANALYSIS_MODEL : GEMINI_ANALYSIS_MODEL;
};

const getGeminiProviderLabel = (provider: GeminiProvider): string => (
  provider === "geminiPaid" ? "Gemini Pro" : "Gemini"
);

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

const getGeminiFailureReason = (details: GeminiErrorDetails): GeminiAttemptFailureReason => {
  if (
    details.status === 429 ||
    /quota|RESOURCE_EXHAUSTED|rate.?limit|too many requests|exceeded/i.test(details.message)
  ) {
    return "quota";
  }
  if (
    details.status === 401 ||
    details.status === 403 ||
    /API key not valid|API_KEY_INVALID|invalid api key|PERMISSION_DENIED|forbidden|unauthorized/i.test(details.message)
  ) {
    return "auth";
  }
  if (RETRIABLE_GEMINI_STATUSES.has(details.status)) return "server";
  if (/blocked|safety|SAFETY|RECITATION/i.test(details.message)) return "blocked";
  return "unknown";
};

const getGeminiFailureReasonLabel = (reason: GeminiAttemptFailureReason): string => {
  switch (reason) {
    case "quota":
      return "تجاوز الحصة أو 429";
    case "auth":
      return "مفتاح غير صالح أو غير مصرح";
    case "server":
      return "خطأ خادم مؤقت";
    case "blocked":
      return "حظر أمان من Gemini";
    default:
      return "سبب غير معروف";
  }
};

const getUniqueAttemptCount = (attempts: GeminiAttemptDetail[]): number => (
  new Set(attempts.map(attempt => attempt.keyFingerprint)).size
);

const summarizeAttemptReasons = (attempts: GeminiAttemptDetail[]): Record<GeminiAttemptFailureReason, number> => {
  const grouped = attempts.reduce<Record<GeminiAttemptFailureReason, Set<string>>>((groups, attempt) => {
    groups[attempt.reason].add(attempt.keyFingerprint);
    return groups;
  }, {
    quota: new Set<string>(),
    auth: new Set<string>(),
    server: new Set<string>(),
    blocked: new Set<string>(),
    unknown: new Set<string>(),
  });

  return {
    quota: grouped.quota.size,
    auth: grouped.auth.size,
    server: grouped.server.size,
    blocked: grouped.blocked.size,
    unknown: grouped.unknown.size,
  };
};

const buildGeminiFailureMessage = (
  provider: GeminiProvider,
  model: string,
  keyCount: number,
  attempts: GeminiAttemptDetail[],
  lastError: GeminiErrorDetails | null,
): string => {
  const providerLabel = getGeminiProviderLabel(provider);
  const attemptedKeyCount = getUniqueAttemptCount(attempts);
  const summary = summarizeAttemptReasons(attempts);
  const parts = [
    `فشل طلب ${providerLabel} للنموذج ${model}.`,
    `تمت تجربة ${attemptedKeyCount} من ${keyCount} مفتاح.`,
  ];

  const reasonParts = [
    summary.quota ? `${summary.quota} حصة/429` : '',
    summary.auth ? `${summary.auth} غير صالح/غير مصرح` : '',
    summary.server ? `${summary.server} خطأ خادم` : '',
    summary.blocked ? `${summary.blocked} حظر أمان` : '',
    summary.unknown ? `${summary.unknown} غير معروف` : '',
  ].filter(Boolean);

  if (reasonParts.length > 0) {
    parts.push(`الأسباب: ${reasonParts.join('، ')}.`);
  }

  if (summary.quota > 0 && summary.quota === attemptedKeyCount) {
    parts.push('إذا كانت هذه المفاتيح من نفس مشروع Google فهي غالبا تشترك في نفس حصة المشروع، وتبديل المفاتيح لن يزيد الحصة.');
    parts.push('استخدم مفاتيح من مشاريع Google مختلفة لديها حصة متاحة، أو اختر موديل Gemini آخر من الإعدادات.');
  } else if (lastError?.message) {
    parts.push(`آخر خطأ: ${lastError.message.slice(0, 300)}`);
  }

  return parts.join(' ');
};

const handleGeminiRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  try {
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const { prompt, useUrlContext, history, model, provider, progressId: rawProgressId } = await readRequestBody(req) as any;
    const progressId = normalizeProgressId(rawProgressId);
    const requestedProvider = normalizeGeminiProvider(provider);
    const selectedModel = getSafeGeminiModel(
      selectGeminiModel(model, requestedProvider),
      requestedProvider,
    );
    const selectedProvider = selectGeminiProvider(requestedProvider, selectedModel);
    const GEMINI_API_KEYS = parseEnvGeminiKeys(selectedProvider);

    if (GEMINI_API_KEYS.length === 0) {
      setGeminiProgress(progressId, {
        stage: "failed",
        provider: selectedProvider,
        model: selectedModel,
        keyCount: 0,
        attemptedKeyCount: 0,
        completed: true,
        message: `لم يتم العثور على مفاتيح ${getGeminiProviderLabel(selectedProvider)} في بيئة السيرفر.`,
      });
      return {
        status: 503,
        body: {
          error: `لم يتم تكوين مفاتيح ${getGeminiProviderLabel(selectedProvider)} على السيرفر. أضف ${getProviderEnvHint(selectedProvider)} ثم أعد تشغيل PM2.`,
          provider: selectedProvider,
          model: selectedModel,
          progressId,
        },
      };
    }
    
    if (!prompt) {
      setGeminiProgress(progressId, {
        stage: "failed",
        provider: selectedProvider,
        model: selectedModel,
        keyCount: GEMINI_API_KEYS.length,
        attemptedKeyCount: 0,
        completed: true,
        message: "الموجه مطلوب قبل إرسال طلب Gemini.",
      });
      return { status: 400, body: { error: "الموجه مطلوب" } };
    }

    const normalizedPrompt = typeof prompt === "string" ? prompt : String(prompt);
    const normalizedHistory = normalizeGeminiHistory(history);
    const contents = normalizedHistory.length > 0
      ? [...normalizedHistory, { role: "user" as const, parts: [{ text: normalizedPrompt }] }]
      : normalizedPrompt;

    let lastError: GeminiErrorDetails | null = null;
    const attempts: GeminiAttemptDetail[] = [];
    const orderedKeys = getRoundRobinKeyOrder(selectedProvider, GEMINI_API_KEYS);
    setGeminiProgress(progressId, {
      stage: "queued",
      provider: selectedProvider,
      model: selectedModel,
      keyCount: orderedKeys.length,
      attemptedKeyCount: 0,
      completed: false,
      message: `بدء طلب ${getGeminiProviderLabel(selectedProvider)} للنموذج ${selectedModel}.`,
    });

    for (let keyIndex = 0; keyIndex < orderedKeys.length; keyIndex += 1) {
      const GEMINI_API_KEY = orderedKeys[keyIndex];
      const keyFingerprint = createApiKeyFingerprint(GEMINI_API_KEY);
      const keySuffix = getApiKeySuffix(GEMINI_API_KEY);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptedKeyCount = new Set([
          ...attempts.map(item => item.keyFingerprint),
          keyFingerprint,
        ]).size;
        setGeminiProgress(progressId, {
          stage: attempt > 0 ? "retrying" : "attempting",
          provider: selectedProvider,
          model: selectedModel,
          keyCount: orderedKeys.length,
          attemptedKeyCount,
          currentKeyIndex: keyIndex + 1,
          currentAttempt: attempt + 1,
          keySuffix,
          status: undefined,
          reason: undefined,
          completed: false,
          message: attempt > 0
            ? `إعادة محاولة المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) للنموذج ${selectedModel}.`
            : `تجربة المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) للنموذج ${selectedModel}.`,
        });
        try {
          const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
          const response = await ai.models.generateContent({
            model: selectedModel,
            contents,
            config: useUrlContext
              ? {
                  tools: [{ urlContext: {} }],
                  toolConfig: { includeServerSideToolInvocations: true },
                }
              : undefined,
          });

          const text = response.text;
          setGeminiProgress(progressId, {
            stage: "success",
            provider: selectedProvider,
            model: selectedModel,
            keyCount: orderedKeys.length,
            attemptedKeyCount,
            currentKeyIndex: keyIndex + 1,
            currentAttempt: attempt + 1,
            keySuffix,
            status: 200,
            completed: true,
            message: `تم تلقي رد Gemini بنجاح من المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}).`,
          });

          return {
            status: 200,
            body: {
              text,
              keyFingerprint,
              keySuffix,
              provider: selectedProvider,
              model: selectedModel,
              keyCount: GEMINI_API_KEYS.length,
              attemptedKeyCount: new Set([
                ...attempts.map(item => item.keyFingerprint),
                keyFingerprint,
              ]).size,
              progressId,
            },
          };
        } catch (error) {
          lastError = getGeminiErrorDetails(error);
          const reason = getGeminiFailureReason(lastError);
          attempts.push({
            keyFingerprint,
            keySuffix,
            status: lastError.status,
            reason,
            attempt: attempt + 1,
          });
          const failedAttemptedKeyCount = getUniqueAttemptCount(attempts);
          const hasServerRetry = attempt === 0 && reason === "server";
          const hasNextKey = keyIndex < orderedKeys.length - 1;
          setGeminiProgress(progressId, {
            stage: hasServerRetry ? "retrying" : "failed-key",
            provider: selectedProvider,
            model: selectedModel,
            keyCount: orderedKeys.length,
            attemptedKeyCount: failedAttemptedKeyCount,
            currentKeyIndex: keyIndex + 1,
            currentAttempt: attempt + 1,
            keySuffix,
            status: lastError.status,
            reason,
            completed: false,
            message: hasServerRetry
              ? `خطأ خادم مؤقت مع المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}). سيتم إعادة المحاولة مرة واحدة.`
              : `فشل المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) بسبب ${getGeminiFailureReasonLabel(reason)}.${hasNextKey ? " سيتم الانتقال للمفتاح التالي." : ""}`,
          });
          console.warn('Gemini key attempt failed', {
            provider: selectedProvider,
            model: selectedModel,
            keyFingerprint,
            status: lastError.status,
            reason,
            attempt: attempt + 1,
          });
          if (attempt === 0 && reason === "server") {
            await wait(400);
            continue;
          }
          if (hasNextKey) {
            setGeminiProgress(progressId, {
              stage: "switching-key",
              provider: selectedProvider,
              model: selectedModel,
              keyCount: orderedKeys.length,
              attemptedKeyCount: failedAttemptedKeyCount,
              currentKeyIndex: keyIndex + 2,
              currentAttempt: 1,
              keySuffix: getApiKeySuffix(orderedKeys[keyIndex + 1]),
              status: undefined,
              reason: undefined,
              completed: false,
              message: `تم تبديل المفتاح. الانتقال إلى المفتاح ${keyIndex + 2} من ${orderedKeys.length}.`,
            });
          }
          break;
        }
      }
    }

    const responseStatus = lastError && lastError.status >= 400 && lastError.status < 500
      ? lastError.status
      : 502;
    const failureBody = {
      error: buildGeminiFailureMessage(
        selectedProvider,
        selectedModel,
        GEMINI_API_KEYS.length,
        attempts,
        lastError,
      ),
      provider: selectedProvider,
      model: selectedModel,
      keyCount: GEMINI_API_KEYS.length,
      attemptedKeyCount: getUniqueAttemptCount(attempts),
      attempts,
      attemptSummary: summarizeAttemptReasons(attempts),
      progressId,
    };
    setGeminiProgress(progressId, {
      stage: "failed",
      provider: selectedProvider,
      model: selectedModel,
      keyCount: orderedKeys.length,
      attemptedKeyCount: getUniqueAttemptCount(attempts),
      currentKeyIndex: orderedKeys.length,
      completed: true,
      message: `فشل طلب Gemini بعد تجربة ${getUniqueAttemptCount(attempts)} من ${orderedKeys.length} مفتاح.`,
    });
    return {
      status: responseStatus,
      body: failureBody,
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

const handleGeminiProgressRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return { status: 405, body: { error: "Method not allowed" } };
  }

  cleanupGeminiProgressStore();
  const progressId = getProgressIdFromRequest(req);
  const progress = progressId ? geminiProgressStore.get(progressId) : undefined;
  if (!progress) {
    return {
      status: 404,
      body: {
        error: "Gemini progress not found",
        progressId,
      },
    };
  }

  return { status: 200, body: progress };
};

export async function geminiProgressHandler(req: any, res?: any): Promise<Response | void> {
  const result = await handleGeminiProgressRequest(req);
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = await handleGeminiRequest(req);
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}
