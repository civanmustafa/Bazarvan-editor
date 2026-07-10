
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
  model?: string;
};

type GeminiHistoryContent = {
  role: "user" | "model";
  parts: { text: string }[];
};

type GeminiProvider = "gemini" | "geminiPaid";
type GeminiProgressStage = "queued" | "attempting" | "failed-key" | "switching-key" | "switching-model" | "success" | "failed" | "cancelled";

type GeminiProgressState = {
  id: string;
  stage: GeminiProgressStage;
  provider: GeminiProvider;
  model: string;
  requestedModel?: string;
  currentModelIndex?: number;
  modelCount?: number;
  modelOrder?: string[];
  attemptedModels?: string[];
  keyCount: number;
  attemptedKeyCount: number;
  attemptedModelKeyCount?: number;
  totalAttemptCount?: number;
  currentKeyIndex?: number;
  currentAttempt?: number;
  keySuffix?: string;
  status?: number;
  reason?: GeminiAttemptFailureReason;
  message: string;
  updatedAt: string;
  completed: boolean;
};

type GeminiJobState = {
  status: "running" | "completed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  result?: ApiResult;
  cancelRequested: boolean;
  cancelListeners: Set<() => void>;
};

class GeminiJobCancelledError extends Error {
  constructor() {
    super("Gemini analysis was cancelled by the user");
    this.name = "GeminiJobCancelledError";
  }
}

const RETRIABLE_GEMINI_STATUSES = new Set([500, 502, 503, 504]);
const GEMINI_PROGRESS_TTL_MS = 10 * 60 * 1000;
const geminiProgressStore = new Map<string, GeminiProgressState>();
const geminiJobStore = new Map<string, GeminiJobState>();

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
  for (const [id, job] of geminiJobStore.entries()) {
    const updatedAt = Date.parse(job.updatedAt);
    if (job.status !== "running" && Number.isFinite(updatedAt) && updatedAt < cutoff) {
      geminiJobStore.delete(id);
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
  const job = geminiJobStore.get(progressId);
  if (job?.cancelRequested && patch.stage !== "cancelled") return;
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
    const pathParts = pathname.split("/").filter(Boolean);
    const idPart = pathParts[pathParts.length - 1] === "cancel"
      ? pathParts[pathParts.length - 2]
      : pathParts[pathParts.length - 1];
    return normalizeProgressId(idPart);
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

const getAllowedGeminiFreeModels = (): string[] => (
  Array.from(new Set([
    GEMINI_ANALYSIS_MODEL,
    ...DEFAULT_GEMINI_FREE_MODELS,
    ...((process.env.GEMINI_ALLOWED_MODELS || "")
      .split(/[\n,;]+/)
      .map(model => model.trim())
      .filter(Boolean)
      .filter(model => model !== GEMINI_PAID_ANALYSIS_MODEL)),
  ].filter(Boolean)))
);

const normalizeRequestedGeminiFreeModels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(model => typeof model === "string" ? model.trim() : "")
      .filter(model => (
        Boolean(model) &&
        model !== GEMINI_PAID_ANALYSIS_MODEL &&
        ALLOWED_GEMINI_MODELS.has(model)
      )),
  ));
};

const getGeminiModelOrder = (
  selectedProvider: GeminiProvider,
  selectedModel: string,
  allowModelFallback: boolean,
  requestedFallbackModels?: unknown,
): string[] => {
  if (selectedProvider !== "gemini" || !allowModelFallback) return [selectedModel];
  const freeModels = Array.from(new Set([
    ...normalizeRequestedGeminiFreeModels(requestedFallbackModels),
    ...getAllowedGeminiFreeModels(),
  ]));
  return Array.from(new Set([
    selectedModel,
    ...freeModels.filter(model => model !== selectedModel),
  ]));
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

const getGeminiProgressDelay = (envName: string, fallback: number): number => {
  const rawValue = process.env[envName];
  const parsedValue = rawValue ? Number(rawValue) : fallback;
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.max(0, Math.min(2000, Math.floor(parsedValue)));
};

const GEMINI_PROGRESS_MIN_ATTEMPT_MS = getGeminiProgressDelay("GEMINI_PROGRESS_MIN_ATTEMPT_MS", 250);
const GEMINI_PROGRESS_STEP_DELAY_MS = getGeminiProgressDelay("GEMINI_PROGRESS_STEP_DELAY_MS", 350);
const GEMINI_PROGRESS_SWITCH_DELAY_MS = getGeminiProgressDelay("GEMINI_PROGRESS_SWITCH_DELAY_MS", 250);

const getGeminiRequestTimeout = (): number => {
  const rawValue = process.env.GEMINI_PER_KEY_TIMEOUT_MS;
  const parsedValue = rawValue ? Number(rawValue) : 30000;
  if (!Number.isFinite(parsedValue)) return 30000;
  return Math.max(5000, Math.min(120000, Math.floor(parsedValue)));
};

const GEMINI_PER_KEY_TIMEOUT_MS = getGeminiRequestTimeout();

const isGeminiJobCancelledError = (error: unknown): error is GeminiJobCancelledError => (
  error instanceof GeminiJobCancelledError
);

const throwIfGeminiJobCancelled = (progressId: string) => {
  if (progressId && geminiJobStore.get(progressId)?.cancelRequested) {
    throw new GeminiJobCancelledError();
  }
};

const raceWithGeminiCancellation = async <T,>(
  request: Promise<T>,
  progressId: string,
): Promise<T> => {
  if (!progressId) return request;
  const job = geminiJobStore.get(progressId);
  if (!job) return request;
  throwIfGeminiJobCancelled(progressId);

  let cancelListener: (() => void) | undefined;
  const cancelled = new Promise<T>((_, reject) => {
    cancelListener = () => reject(new GeminiJobCancelledError());
    job.cancelListeners.add(cancelListener);
  });

  try {
    return await Promise.race([request, cancelled]);
  } finally {
    if (cancelListener) {
      job.cancelListeners.delete(cancelListener);
    }
  }
};

const withGeminiKeyTimeout = async <T,>(
  request: Promise<T>,
  model: string,
  keySuffix: string,
  progressId: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await raceWithGeminiCancellation(
      Promise.race([
        request,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Gemini request timed out after ${GEMINI_PER_KEY_TIMEOUT_MS}ms for model ${model} and key ...${keySuffix} (504)`));
          }, GEMINI_PER_KEY_TIMEOUT_MS);
        }),
      ]),
      progressId,
    );
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const waitForVisibleGeminiProgress = async (
  progressId: string,
  minimumDelayMs: number,
  startedAt?: number,
) => {
  throwIfGeminiJobCancelled(progressId);
  if (!progressId || minimumDelayMs <= 0) return;
  const elapsed = typeof startedAt === "number" ? Date.now() - startedAt : 0;
  const remainingDelay = Math.max(0, minimumDelayMs - elapsed);
  if (remainingDelay > 0) {
    await raceWithGeminiCancellation(wait(remainingDelay), progressId);
  }
  throwIfGeminiJobCancelled(progressId);
};

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

const getUniqueAttemptCountForModel = (attempts: GeminiAttemptDetail[], model: string): number => (
  new Set(attempts
    .filter(attempt => attempt.model === model)
    .map(attempt => attempt.keyFingerprint)).size
);

const getUniqueKeyModelAttemptCount = (attempts: GeminiAttemptDetail[]): number => (
  new Set(attempts.map(attempt => `${attempt.model || "-"}:${attempt.keyFingerprint}`)).size
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

const executeGeminiRequest = async (requestBody: any): Promise<ApiResult> => {
  try {
    const { prompt, useUrlContext, history, model, provider, progressId: rawProgressId, allowModelFallback, fallbackModels } = requestBody || {};
    const progressId = normalizeProgressId(rawProgressId);
    throwIfGeminiJobCancelled(progressId);
    const requestedProvider = normalizeGeminiProvider(provider);
    const selectedModel = getSafeGeminiModel(
      selectGeminiModel(model, requestedProvider),
      requestedProvider,
    );
    const selectedProvider = selectGeminiProvider(requestedProvider, selectedModel);
    const modelOrder = getGeminiModelOrder(
      selectedProvider,
      selectedModel,
      allowModelFallback === true,
      fallbackModels,
    );
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
    let lastAttemptedModel = selectedModel;
    let lastOrderedKeys = GEMINI_API_KEYS;
    setGeminiProgress(progressId, {
      stage: "queued",
      provider: selectedProvider,
      model: selectedModel,
      requestedModel: selectedModel,
      currentModelIndex: 1,
      modelCount: modelOrder.length,
      modelOrder,
      attemptedModels: [],
      keyCount: GEMINI_API_KEYS.length,
      attemptedKeyCount: 0,
      attemptedModelKeyCount: 0,
      totalAttemptCount: 0,
      completed: false,
      message: modelOrder.length > 1
        ? `بدء طلب ${getGeminiProviderLabel(selectedProvider)} للنموذج ${selectedModel}. عند فشل كل المفاتيح سيتم تجربة موديل مجاني آخر.`
        : `بدء طلب ${getGeminiProviderLabel(selectedProvider)} للنموذج ${selectedModel}.`,
    });

    for (let modelIndex = 0; modelIndex < modelOrder.length; modelIndex += 1) {
      throwIfGeminiJobCancelled(progressId);
      const activeModel = modelOrder[modelIndex];
      lastAttemptedModel = activeModel;
      const orderedKeys = getRoundRobinKeyOrder(selectedProvider, GEMINI_API_KEYS);
      lastOrderedKeys = orderedKeys;
      if (modelIndex > 0) {
        setGeminiProgress(progressId, {
          stage: "switching-model",
          provider: selectedProvider,
          model: activeModel,
          requestedModel: selectedModel,
          currentModelIndex: modelIndex + 1,
          modelCount: modelOrder.length,
          modelOrder,
          attemptedModels: modelOrder.slice(0, modelIndex + 1),
          keyCount: orderedKeys.length,
          attemptedKeyCount: 0,
          attemptedModelKeyCount: 0,
          totalAttemptCount: attempts.length,
          currentKeyIndex: 1,
          currentAttempt: 1,
          status: undefined,
          reason: undefined,
          completed: false,
          message: `فشلت مفاتيح الموديل السابق. تم التبديل إلى النموذج ${activeModel} وتجربة المفاتيح من جديد.`,
        });
        await waitForVisibleGeminiProgress(progressId, GEMINI_PROGRESS_SWITCH_DELAY_MS);
      }

      for (let keyIndex = 0; keyIndex < orderedKeys.length; keyIndex += 1) {
        throwIfGeminiJobCancelled(progressId);
        const GEMINI_API_KEY = orderedKeys[keyIndex];
        const keyFingerprint = createApiKeyFingerprint(GEMINI_API_KEY);
        const keySuffix = getApiKeySuffix(GEMINI_API_KEY);
        for (let attempt = 0; attempt < 1; attempt += 1) {
          throwIfGeminiJobCancelled(progressId);
          const attemptStartedAt = Date.now();
          const attemptedKeyCount = new Set([
            ...attempts.filter(item => item.model === activeModel).map(item => item.keyFingerprint),
            keyFingerprint,
          ]).size;
          setGeminiProgress(progressId, {
            stage: "attempting",
            provider: selectedProvider,
            model: activeModel,
            requestedModel: selectedModel,
            currentModelIndex: modelIndex + 1,
            modelCount: modelOrder.length,
            modelOrder,
            attemptedModels: modelOrder.slice(0, modelIndex + 1),
            keyCount: orderedKeys.length,
            attemptedKeyCount,
            attemptedModelKeyCount: attemptedKeyCount,
            totalAttemptCount: attempts.length + 1,
            currentKeyIndex: keyIndex + 1,
            currentAttempt: attempt + 1,
            keySuffix,
            status: undefined,
            reason: undefined,
            completed: false,
            message: attempt > 0
              ? `إعادة محاولة المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) للنموذج ${activeModel}.`
              : `تجربة المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) للنموذج ${activeModel}.`,
          });
          try {
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            const response = await withGeminiKeyTimeout(
              ai.models.generateContent({
                model: activeModel,
                contents,
                config: useUrlContext
                  ? {
                      tools: [{ urlContext: {} }],
                      toolConfig: { includeServerSideToolInvocations: true },
                    }
                  : undefined,
              }),
              activeModel,
              keySuffix,
              progressId,
            );
            throwIfGeminiJobCancelled(progressId);

            const text = typeof response.text === "string" ? response.text.trim() : "";
            if (!text) {
              throw new Error(`Gemini returned an empty response for model ${activeModel} (502)`);
            }
            const successAttemptedKeyCount = new Set([
              ...attempts.filter(item => item.model === activeModel).map(item => item.keyFingerprint),
              keyFingerprint,
            ]).size;
            setGeminiProgress(progressId, {
              stage: "success",
              provider: selectedProvider,
              model: activeModel,
              requestedModel: selectedModel,
              currentModelIndex: modelIndex + 1,
              modelCount: modelOrder.length,
              modelOrder,
              attemptedModels: modelOrder.slice(0, modelIndex + 1),
              keyCount: orderedKeys.length,
              attemptedKeyCount: successAttemptedKeyCount,
              attemptedModelKeyCount: successAttemptedKeyCount,
              totalAttemptCount: attempts.length + 1,
              currentKeyIndex: keyIndex + 1,
              currentAttempt: attempt + 1,
              keySuffix,
              status: 200,
              completed: true,
              message: `تم تلقي رد Gemini بنجاح من المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) على النموذج ${activeModel}.`,
            });

            return {
              status: 200,
              body: {
                text,
                keyFingerprint,
                keySuffix,
                provider: selectedProvider,
                model: activeModel,
                requestedModel: selectedModel,
                modelFallbackUsed: activeModel !== selectedModel,
                modelOrder,
                attemptedModels: modelOrder.slice(0, modelIndex + 1),
                keyCount: GEMINI_API_KEYS.length,
                attemptedKeyCount: new Set([
                  ...attempts.map(item => item.keyFingerprint),
                  keyFingerprint,
                ]).size,
                progressId,
              },
            };
          } catch (error) {
            if (isGeminiJobCancelledError(error)) {
              throw error;
            }
            lastError = getGeminiErrorDetails(error);
            const reason = getGeminiFailureReason(lastError);
            await waitForVisibleGeminiProgress(progressId, GEMINI_PROGRESS_MIN_ATTEMPT_MS, attemptStartedAt);
            attempts.push({
              keyFingerprint,
              keySuffix,
              status: lastError.status,
              reason,
              attempt: attempt + 1,
              model: activeModel,
            });
            const failedModelAttemptedKeyCount = getUniqueAttemptCountForModel(attempts, activeModel);
            const hasNextKey = keyIndex < orderedKeys.length - 1;
            const hasNextModel = modelIndex < modelOrder.length - 1;
            setGeminiProgress(progressId, {
              stage: "failed-key",
              provider: selectedProvider,
              model: activeModel,
              requestedModel: selectedModel,
              currentModelIndex: modelIndex + 1,
              modelCount: modelOrder.length,
              modelOrder,
              attemptedModels: modelOrder.slice(0, modelIndex + 1),
              keyCount: orderedKeys.length,
              attemptedKeyCount: failedModelAttemptedKeyCount,
              attemptedModelKeyCount: failedModelAttemptedKeyCount,
              totalAttemptCount: attempts.length,
              currentKeyIndex: keyIndex + 1,
              currentAttempt: attempt + 1,
              keySuffix,
              status: lastError.status,
              reason,
              completed: false,
              message: `فشل المفتاح ${keyIndex + 1} من ${orderedKeys.length} (...${keySuffix}) على النموذج ${activeModel} بسبب ${getGeminiFailureReasonLabel(reason)}.${hasNextKey ? " سيتم الانتقال للمفتاح التالي." : hasNextModel ? " سيتم الانتقال لموديل مجاني آخر." : ""}`,
            });
            console.warn('Gemini key attempt failed', {
              provider: selectedProvider,
              model: activeModel,
              keyFingerprint,
              status: lastError.status,
              reason,
              attempt: attempt + 1,
            });
            if (hasNextKey) {
              await waitForVisibleGeminiProgress(progressId, GEMINI_PROGRESS_STEP_DELAY_MS);
              setGeminiProgress(progressId, {
                stage: "switching-key",
                provider: selectedProvider,
                model: activeModel,
                requestedModel: selectedModel,
                currentModelIndex: modelIndex + 1,
                modelCount: modelOrder.length,
                modelOrder,
                attemptedModels: modelOrder.slice(0, modelIndex + 1),
                keyCount: orderedKeys.length,
                attemptedKeyCount: failedModelAttemptedKeyCount,
                attemptedModelKeyCount: failedModelAttemptedKeyCount,
                totalAttemptCount: attempts.length,
                currentKeyIndex: keyIndex + 2,
                currentAttempt: 1,
                keySuffix: getApiKeySuffix(orderedKeys[keyIndex + 1]),
                status: undefined,
                reason: undefined,
                completed: false,
                message: `تم تبديل المفتاح. الانتقال إلى المفتاح ${keyIndex + 2} من ${orderedKeys.length} على النموذج ${activeModel}.`,
              });
              await waitForVisibleGeminiProgress(progressId, GEMINI_PROGRESS_SWITCH_DELAY_MS);
            } else if (hasNextModel) {
              await waitForVisibleGeminiProgress(progressId, GEMINI_PROGRESS_STEP_DELAY_MS);
            }
            break;
          }
        }
      }
    }

    const responseStatus = lastError && lastError.status >= 400 && lastError.status < 500
      ? lastError.status
      : 502;
    const failureBody = {
      error: buildGeminiFailureMessage(
        selectedProvider,
        lastAttemptedModel,
        GEMINI_API_KEYS.length,
        attempts,
        lastError,
      ),
      provider: selectedProvider,
      model: lastAttemptedModel,
      requestedModel: selectedModel,
      modelFallbackEnabled: modelOrder.length > 1,
      modelCount: modelOrder.length,
      modelOrder,
      attemptedModels: Array.from(new Set(attempts.map(item => item.model).filter(Boolean))),
      keyCount: GEMINI_API_KEYS.length,
      attemptedKeyCount: getUniqueAttemptCount(attempts),
      keyModelAttemptCount: getUniqueKeyModelAttemptCount(attempts),
      totalAttemptCount: attempts.length,
      attempts,
      attemptSummary: summarizeAttemptReasons(attempts),
      progressId,
    };
    setGeminiProgress(progressId, {
      stage: "failed",
      provider: selectedProvider,
      model: lastAttemptedModel,
      requestedModel: selectedModel,
      currentModelIndex: modelOrder.length,
      modelCount: modelOrder.length,
      modelOrder,
      attemptedModels: Array.from(new Set(attempts.map(item => item.model).filter((model): model is string => Boolean(model)))),
      keyCount: lastOrderedKeys.length,
      attemptedKeyCount: getUniqueAttemptCountForModel(attempts, lastAttemptedModel),
      attemptedModelKeyCount: getUniqueAttemptCountForModel(attempts, lastAttemptedModel),
      totalAttemptCount: getUniqueKeyModelAttemptCount(attempts),
      currentKeyIndex: lastOrderedKeys.length,
      completed: true,
      message: modelOrder.length > 1
        ? `فشل طلب Gemini بعد تجربة ${modelOrder.length} موديل و ${getUniqueKeyModelAttemptCount(attempts)} محاولة مفتاح/موديل.`
        : `فشل طلب Gemini بعد تجربة ${getUniqueAttemptCount(attempts)} من ${lastOrderedKeys.length} مفتاح.`,
    });
    return {
      status: responseStatus,
      body: failureBody,
    };

  } catch (error) {
    if (isGeminiJobCancelledError(error)) {
      const progressId = normalizeProgressId(requestBody?.progressId);
      const currentProgress = progressId ? geminiProgressStore.get(progressId) : undefined;
      setGeminiProgress(progressId, {
        stage: "cancelled",
        provider: currentProgress?.provider || normalizeGeminiProvider(requestBody?.provider),
        model: currentProgress?.model || selectGeminiModel(requestBody?.model, normalizeGeminiProvider(requestBody?.provider)),
        requestedModel: currentProgress?.requestedModel,
        currentModelIndex: currentProgress?.currentModelIndex,
        modelCount: currentProgress?.modelCount,
        modelOrder: currentProgress?.modelOrder,
        attemptedModels: currentProgress?.attemptedModels,
        keyCount: currentProgress?.keyCount || 0,
        attemptedKeyCount: currentProgress?.attemptedKeyCount || 0,
        attemptedModelKeyCount: currentProgress?.attemptedModelKeyCount || 0,
        totalAttemptCount: currentProgress?.totalAttemptCount || 0,
        currentKeyIndex: currentProgress?.currentKeyIndex,
        keySuffix: currentProgress?.keySuffix,
        status: 499,
        completed: true,
        message: "تم إيقاف التحليل يدويًا.",
      });
      return {
        status: 499,
        body: {
          error: "تم إيقاف التحليل يدويًا.",
          cancelled: true,
          progressId,
          provider: currentProgress?.provider,
          model: currentProgress?.model,
          attemptedKeyCount: currentProgress?.attemptedKeyCount || 0,
          keyCount: currentProgress?.keyCount || 0,
        },
      };
    }
    console.error("Error processing request:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }
    const errorMessage = getGeminiErrorDetails(error).message;
    return { status: 500, body: { error: `خطأ من Gemini API: ${errorMessage}` } };
  }
};

const getInitialJobProgress = (requestBody: any) => {
  const requestedProvider = normalizeGeminiProvider(requestBody?.provider);
  const selectedModel = getSafeGeminiModel(
    selectGeminiModel(requestBody?.model, requestedProvider),
    requestedProvider,
  );
  const selectedProvider = selectGeminiProvider(requestedProvider, selectedModel);
  const modelOrder = getGeminiModelOrder(
    selectedProvider,
    selectedModel,
    requestBody?.allowModelFallback === true,
    requestBody?.fallbackModels,
  );

  return {
    provider: selectedProvider,
    model: selectedModel,
    modelCount: modelOrder.length,
    modelOrder,
    keyCount: parseEnvGeminiKeys(selectedProvider).length,
  };
};

const ensureGeminiJobCompletedProgress = (
  progressId: string,
  requestBody: any,
  result: ApiResult,
) => {
  const currentProgress = geminiProgressStore.get(progressId);
  if (currentProgress?.completed) return;

  const initial = getInitialJobProgress(requestBody);
  const resultBody = result.body && typeof result.body === "object"
    ? result.body as Record<string, unknown>
    : {};
  const succeeded = result.status >= 200 && result.status < 300 && typeof resultBody.text === "string";
  const errorMessage = typeof resultBody.error === "string"
    ? resultBody.error
    : succeeded
      ? "تم تلقي رد Gemini بنجاح."
      : `انتهت مهمة Gemini بالحالة ${result.status}.`;

  setGeminiProgress(progressId, {
    stage: succeeded ? "success" : "failed",
    provider: initial.provider,
    model: typeof resultBody.model === "string" ? resultBody.model : initial.model,
    requestedModel: initial.model,
    modelCount: initial.modelCount,
    modelOrder: initial.modelOrder,
    attemptedModels: Array.isArray(resultBody.attemptedModels)
      ? resultBody.attemptedModels.filter((model): model is string => typeof model === "string")
      : currentProgress?.attemptedModels || [],
    keyCount: initial.keyCount,
    attemptedKeyCount: typeof resultBody.attemptedKeyCount === "number"
      ? resultBody.attemptedKeyCount
      : currentProgress?.attemptedKeyCount || 0,
    status: result.status,
    completed: true,
    message: errorMessage,
  });
};

const startGeminiJob = (progressId: string, requestBody: any): GeminiJobState => {
  const existingJob = geminiJobStore.get(progressId);
  if (existingJob) return existingJob;

  const now = new Date().toISOString();
  const initial = getInitialJobProgress(requestBody);
  const job: GeminiJobState = {
    status: "running",
    startedAt: now,
    updatedAt: now,
    cancelRequested: false,
    cancelListeners: new Set(),
  };
  geminiJobStore.set(progressId, job);
  setGeminiProgress(progressId, {
    stage: "queued",
    provider: initial.provider,
    model: initial.model,
    requestedModel: initial.model,
    currentModelIndex: 1,
    modelCount: initial.modelCount,
    modelOrder: initial.modelOrder,
    attemptedModels: [],
    keyCount: initial.keyCount,
    attemptedKeyCount: 0,
    attemptedModelKeyCount: 0,
    totalAttemptCount: 0,
    completed: false,
    message: "تم إنشاء مهمة Gemini، ويجري تجهيز أول محاولة.",
  });

  void executeGeminiRequest(requestBody)
    .catch((error): ApiResult => ({
      status: 500,
      body: {
        error: `خطأ غير متوقع داخل محرك Gemini: ${getGeminiErrorDetails(error).message}`,
        progressId,
      },
    }))
    .then(result => {
      if (job.cancelRequested || job.status === "cancelled") {
        job.status = "cancelled";
        job.updatedAt = new Date().toISOString();
        return;
      }
      job.status = "completed";
      job.result = result;
      job.updatedAt = new Date().toISOString();
      ensureGeminiJobCompletedProgress(progressId, requestBody, result);
    });

  return job;
};

const handleGeminiCancelRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "Method not allowed" } };
  }

  cleanupGeminiProgressStore();
  const progressId = getProgressIdFromRequest(req);
  const job = progressId ? geminiJobStore.get(progressId) : undefined;
  const progress = progressId ? geminiProgressStore.get(progressId) : undefined;
  if (!job) {
    return {
      status: 404,
      body: {
        error: "Gemini job not found",
        progressId,
      },
    };
  }

  if (job.status === "completed") {
    return {
      status: 409,
      body: {
        error: "Gemini job is already completed",
        progressId,
        jobStatus: job.status,
        resultStatus: job.result?.status,
      },
    };
  }

  if (job.status === "cancelled") {
    return {
      status: 200,
      body: {
        cancelled: true,
        progressId,
        jobStatus: job.status,
      },
    };
  }

  const cancellationResult: ApiResult = {
    status: 499,
    body: {
      error: "تم إيقاف التحليل يدويًا.",
      cancelled: true,
      progressId,
      provider: progress?.provider,
      model: progress?.model,
      attemptedKeyCount: progress?.attemptedKeyCount || 0,
      keyCount: progress?.keyCount || 0,
    },
  };
  job.cancelRequested = true;
  job.status = "cancelled";
  job.result = cancellationResult;
  job.updatedAt = new Date().toISOString();
  setGeminiProgress(progressId, {
    stage: "cancelled",
    provider: progress?.provider || "gemini",
    model: progress?.model || GEMINI_ANALYSIS_MODEL,
    requestedModel: progress?.requestedModel,
    currentModelIndex: progress?.currentModelIndex,
    modelCount: progress?.modelCount,
    modelOrder: progress?.modelOrder,
    attemptedModels: progress?.attemptedModels,
    keyCount: progress?.keyCount || 0,
    attemptedKeyCount: progress?.attemptedKeyCount || 0,
    attemptedModelKeyCount: progress?.attemptedModelKeyCount || 0,
    totalAttemptCount: progress?.totalAttemptCount || 0,
    currentKeyIndex: progress?.currentKeyIndex,
    keySuffix: progress?.keySuffix,
    status: 499,
    completed: true,
    message: "تم إيقاف التحليل يدويًا.",
  });
  for (const listener of job.cancelListeners) {
    listener();
  }
  job.cancelListeners.clear();

  return {
    status: 200,
    body: {
      cancelled: true,
      progressId,
      jobStatus: job.status,
    },
  };
};

const handleGeminiRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "الطريقة غير مسموح بها" } };
  }

  try {
    if (!getContentType(req).includes("application/json")) {
      return { status: 415, body: { error: "يجب أن يكون نوع المحتوى application/json" } };
    }

    const requestBody = await readRequestBody(req) as any;
    const progressId = normalizeProgressId(requestBody?.progressId);
    if (requestBody?.async === true && progressId) {
      const job = startGeminiJob(progressId, requestBody);
      return {
        status: 202,
        body: {
          accepted: true,
          progressId,
          jobStatus: job.status,
        },
      };
    }

    return executeGeminiRequest(requestBody);
  } catch (error) {
    console.error("Error starting Gemini request:", error);
    if (error instanceof SyntaxError) {
      return { status: 400, body: { error: "طلب JSON غير صالح" } };
    }
    return {
      status: 500,
      body: { error: `خطأ من Gemini API: ${getGeminiErrorDetails(error).message}` },
    };
  }
};

const handleGeminiProgressRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return { status: 405, body: { error: "Method not allowed" } };
  }

  cleanupGeminiProgressStore();
  const progressId = getProgressIdFromRequest(req);
  const progress = progressId ? geminiProgressStore.get(progressId) : undefined;
  const job = progressId ? geminiJobStore.get(progressId) : undefined;
  if (!progress && !job) {
    return {
      status: 404,
      body: {
        error: "Gemini progress not found",
        progressId,
      },
    };
  }

  return {
    status: 200,
    body: {
      ...(progress || {}),
      progressId,
      jobStatus: job?.status,
      resultStatus: job?.result?.status,
      result: job?.result?.body,
    },
  };
};

export async function geminiProgressHandler(req: any, res?: any): Promise<Response | void> {
  const pathname = (() => {
    try {
      return new URL(String(req?.url || ""), "http://localhost").pathname;
    } catch {
      return "";
    }
  })();
  const result = pathname.endsWith("/cancel")
    ? await handleGeminiCancelRequest(req)
    : await handleGeminiProgressRequest(req);
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
