import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AiExecutionTelemetryInput = {
  requestId?: string;
  actorUserId?: string;
  provider: string;
  model: string;
  source?: string;
  articleId?: string;
  status: number;
  durationMs: number;
  body: unknown;
  context?: Record<string, unknown>;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

let telemetryClient: SupabaseAdmin | null | undefined;
let lastWarning = '';
let lastWarningAt = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toString = (value: unknown, maximum = 500): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toOptionalNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const toOptionalUuid = (value: unknown): string | null => {
  const normalized = toString(value, 100);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getTelemetryClient = (): SupabaseAdmin | null => {
  if (telemetryClient !== undefined) return telemetryClient;
  const url = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceRoleKey) {
    telemetryClient = null;
    return null;
  }
  telemetryClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return telemetryClient;
};

const warnOnce = (message: string): void => {
  const now = Date.now();
  if (message === lastWarning && now - lastWarningAt < 60_000) return;
  lastWarning = message;
  lastWarningAt = now;
  console.warn(`[ai-execution-telemetry] ${message}`);
};

const normalizeAttempts = (value: unknown): Array<Record<string, unknown>> => (
  Array.isArray(value)
    ? value.filter(isRecord).slice(0, 200).map(attempt => ({
        keySuffix: toString(attempt.keySuffix, 12) || null,
        model: toString(attempt.model, 160) || null,
        status: toOptionalNumber(attempt.status),
        reason: toString(attempt.reason, 80) || 'unknown',
        attempt: toOptionalNumber(attempt.attempt) || 1,
      }))
    : []
);

export const recordAiExecutionTelemetry = async (
  input: AiExecutionTelemetryInput,
): Promise<void> => {
  const client = getTelemetryClient();
  if (!client) return;

  const body = isRecord(input.body) ? input.body : {};
  const attempts = normalizeAttempts(body.attempts);
  const succeeded = input.status >= 200 && input.status < 300 && typeof body.text === 'string';
  const cancelled = input.status === 499 || body.cancelled === true;
  const outcome = cancelled ? 'cancelled' : succeeded ? 'success' : 'failed';
  const requestId = toString(input.requestId || body.progressId, 200) || `ai-${randomUUID()}`;
  const context = isRecord(input.context) ? input.context : {};

  const { error } = await client.from('ai_execution_events').insert({
    request_id: requestId,
    user_id: toOptionalUuid(input.actorUserId),
    provider: toString(body.provider, 80) || toString(input.provider, 80) || 'gemini',
    model: toString(body.model, 160) || toString(input.model, 160) || 'unknown',
    key_suffix: toString(body.keySuffix, 12) || null,
    outcome,
    status: input.status,
    source: toString(input.source, 120) || 'unknown',
    article_id: toOptionalUuid(input.articleId),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    attempts,
    context: {
      articleTitle: toString(context.articleTitle, 500) || null,
      articleKey: toString(context.articleKey, 300) || null,
      commandId: toString(context.commandId, 200) || null,
      commandLabel: toString(context.commandLabel, 500) || null,
      action: toString(context.action, 200) || null,
      batchIndex: toOptionalNumber(context.batchIndex),
      batchTotal: toOptionalNumber(context.batchTotal),
      ruleTitle: toString(context.ruleTitle, 500) || null,
      rules: Array.isArray(context.rules)
        ? context.rules.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 20)
        : [],
      attemptedKeyCount: toOptionalNumber(body.attemptedKeyCount),
      keyCount: toOptionalNumber(body.keyCount),
      requestedModel: toString(body.requestedModel, 160) || null,
      modelFallbackUsed: body.modelFallbackUsed === true,
      error: toString(body.error, 2_000) || null,
    },
  });

  if (error && error.code !== '42P01') {
    warnOnce(`${error.code || 'insert_failed'}: ${error.message}`);
  }
};
