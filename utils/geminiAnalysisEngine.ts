import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

export type GeminiEngineProvider = 'gemini' | 'geminiPaid';

export type GeminiProgressSnapshot = {
    id?: string;
    progressId?: string;
    stage?: string;
    provider?: GeminiEngineProvider;
    model?: string;
    requestedModel?: string;
    currentModelIndex?: number;
    modelCount?: number;
    modelOrder?: string[];
    attemptedModels?: string[];
    keyCount?: number;
    attemptedKeyCount?: number;
    attemptedModelKeyCount?: number;
    totalAttemptCount?: number;
    currentKeyIndex?: number;
    currentAttempt?: number;
    keySuffix?: string;
    status?: number;
    reason?: string;
    message?: string;
    updatedAt?: string;
    completed?: boolean;
    jobStatus?: 'running' | 'completed' | 'cancelled';
    resultStatus?: number;
    result?: unknown;
};

export type GeminiProgressCallback = (progress: GeminiProgressSnapshot) => void;

export type GeminiEngineRequest = {
    prompt: string;
    history?: Array<{ role: 'user' | 'model'; text: string }>;
    model: string;
    provider: GeminiEngineProvider;
    useUrlContext?: boolean;
    allowModelFallback?: boolean;
    fallbackModels?: string[];
    telemetry?: {
        source?: string;
        articleId?: string;
        articleTitle?: string;
        articleKey?: string;
        commandId?: string;
        commandLabel?: string;
        action?: string;
        batchIndex?: number;
        batchTotal?: number;
        ruleTitle?: string;
        rules?: string[];
    };
};

export type GeminiEngineResult = {
    status: number;
    data: Record<string, any>;
    rawBody: string;
    progressId: string;
    progress?: GeminiProgressSnapshot;
};

type RunGeminiEngineOptions = {
    request: GeminiEngineRequest;
    onProgress?: GeminiProgressCallback;
    timeoutMs?: number;
};

const GEMINI_JOB_POLL_INTERVAL_MS = 600;
const GEMINI_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const GEMINI_JOB_START_TIMEOUT_MS = 30 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 50;

const wait = (duration: number): Promise<void> => new Promise(resolve => {
    window.setTimeout(resolve, duration);
});

const createGeminiProgressId = (): string => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return `gemini-${globalThis.crypto.randomUUID()}`;
    }

    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const randomPart = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `gemini-${randomPart}`;
};

const parseJsonRecord = (rawBody: string): Record<string, any> => {
    try {
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

const normalizeJobResult = (
    progressId: string,
    progress: GeminiProgressSnapshot,
): GeminiEngineResult | null => {
    if (typeof progress.resultStatus !== 'number') return null;
    const data = progress.result && typeof progress.result === 'object' && !Array.isArray(progress.result)
        ? progress.result as Record<string, any>
        : {};

    return {
        status: progress.resultStatus,
        data,
        rawBody: JSON.stringify(progress.result ?? {}),
        progressId,
        progress,
    };
};

const waitForGeminiJob = async (
    progressId: string,
    accessToken: string,
    onProgress: GeminiProgressCallback | undefined,
    timeoutMs: number,
): Promise<GeminiEngineResult> => {
    const startedAt = Date.now();
    let consecutiveFailures = 0;
    let latestProgress: GeminiProgressSnapshot | undefined;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(`/api/gemini/progress/${encodeURIComponent(progressId)}`, {
                cache: 'no-store',
                headers: getAuthenticatedApiHeaders(accessToken),
            });
            if (response.ok) {
                const progress = await response.json() as GeminiProgressSnapshot;
                latestProgress = progress;
                consecutiveFailures = 0;
                const { result: _result, ...visibleProgress } = progress;
                onProgress?.(visibleProgress);
                const result = normalizeJobResult(progressId, progress);
                if (result) return result;
            } else {
                consecutiveFailures += 1;
            }
        } catch {
            consecutiveFailures += 1;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new Error('تعذر متابعة مهمة Gemini بسبب انقطاع الاتصال بالسيرفر. المهمة قد تستمر في الخلفية؛ تحقق من الاتصال ثم أعد المحاولة.');
        }
        await wait(GEMINI_JOB_POLL_INTERVAL_MS);
    }

    const lastStep = latestProgress?.message ? ` آخر خطوة مسجلة: ${latestProgress.message}` : '';
    throw new Error(`تجاوزت مهمة Gemini مدة الانتظار القصوى دون نتيجة نهائية.${lastStep}`);
};

export const runGeminiAnalysisEngine = async ({
    request,
    onProgress,
    timeoutMs = GEMINI_JOB_TIMEOUT_MS,
}: RunGeminiEngineOptions): Promise<GeminiEngineResult> => {
    const progressId = createGeminiProgressId();
    const accessToken = await getAuthenticatedApiToken();
    const controller = new AbortController();
    const startTimeoutId = window.setTimeout(() => controller.abort(), GEMINI_JOB_START_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch('/api/gemini', {
            method: 'POST',
            headers: getAuthenticatedApiHeaders(accessToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                ...request,
                progressId,
                async: true,
            }),
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('تعذر بدء مهمة Gemini خلال 30 ثانية. تحقق من اتصال السيرفر ثم أعد المحاولة.');
        }
        throw error;
    } finally {
        window.clearTimeout(startTimeoutId);
    }

    const rawBody = await response.text().catch(() => '');
    const data = parseJsonRecord(rawBody);
    const result = response.status === 202 && data.accepted === true
        ? await waitForGeminiJob(progressId, accessToken, onProgress, timeoutMs)
        : {
            status: response.status,
            data,
            rawBody,
            progressId,
        };
    window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
    return result;
};

export const cancelGeminiAnalysisEngine = async (progressId: string): Promise<void> => {
    const normalizedProgressId = progressId.trim();
    if (!normalizedProgressId) return;

    const accessToken = await getAuthenticatedApiToken();
    const response = await fetch(`/api/gemini/progress/${encodeURIComponent(normalizedProgressId)}/cancel`, {
        method: 'POST',
        headers: getAuthenticatedApiHeaders(accessToken, { 'Content-Type': 'application/json' }),
    });
    const rawBody = await response.text().catch(() => '');
    const data = parseJsonRecord(rawBody);
    if (response.status === 409 && data.jobStatus === 'completed') return;
    if (!response.ok || data.cancelled !== true) {
        const message = typeof data.error === 'string'
            ? data.error
            : `تعذر إيقاف مهمة Gemini (HTTP ${response.status}).`;
        throw new Error(message);
    }
};
