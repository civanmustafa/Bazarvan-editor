import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';
import {
  queueContentWritingSession,
  type QueuedContentWritingSession,
} from './contentWritingEngine';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import type {
  ContentWritingProvider,
  ContentWritingSession,
} from './contentWritingSessionService';

export type ContentWritingAutomationSettings = {
  enabled: boolean;
  intervalMinutes: number;
  provider: ContentWritingProvider;
  model: string;
  minimumCompetitors: number;
  requireCompetitorTerminalState: boolean;
  maxAttempts: number;
  retryMinutes: number;
};

export type ContentWritingAutomationItemRow = {
  id: string;
  article_id: string;
  requested_by: string;
  status: 'ready' | 'claiming' | 'writing' | 'completed' | 'blocked' | 'cancelled';
  readiness_signature: string;
  usable_competitor_count: number;
  pending_competitor_count: number;
  provider: ContentWritingProvider;
  model: string;
  content_writing_session_id: string | null;
  run_generation: number;
  session_sequence: number;
  attempt_count: number;
  max_attempts: number;
  ready_at: string;
  eligible_at: string;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExplicitContentWritingIntent =
  | 'manual'
  | 'resume'
  | 'apply'
  | 'full_pipeline'
  | 'full_pipeline_resume';

export type ExplicitContentWritingReservation = {
  schemaAvailable: boolean;
  reserved: boolean;
  reason: string;
  automationItemId: string | null;
  automationSessionId: string | null;
  activeContentWritingSessionId: string | null;
  activeFullPipelineJobId: string | null;
  activeFullPipelineStatus: string | null;
  hasCompletedContentWritingSession: boolean;
};

const isRecord = (value: unknown): value is ExternalAnalysisJson => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const firstRow = <T>(value: unknown): T | null => {
  if (Array.isArray(value)) return (value[0] as T | undefined) || null;
  return isRecord(value) ? value as T : null;
};

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(Math.round(parsed), maximum))
    : fallback;
};

const providerValue = (value: unknown): ContentWritingProvider => {
  if (value === 'geminiPaid' || value === 'openai') return value;
  return 'gemini';
};

const AUTOMATION_SCHEMA_UNAVAILABLE_CODES = new Set([
  '42883',
  '42P01',
  'PGRST202',
  'PGRST205',
]);

export const isContentWritingAutomationSchemaUnavailableError = (error: unknown): boolean => (
  isRecord(error)
  && typeof error.code === 'string'
  && AUTOMATION_SCHEMA_UNAVAILABLE_CODES.has(error.code)
);

const textValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const reserveArticleForExplicitContentWriting = async (input: {
  articleId: string;
  requestedBy: string;
  intent: ExplicitContentWritingIntent;
  allowedSessionId?: string | null;
  allowedFullPipelineJobId?: string | null;
  provider?: ContentWritingProvider;
  model?: string;
}): Promise<ExplicitContentWritingReservation> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'reserve_article_for_explicit_content_writing',
    {
      p_article_id: input.articleId,
      p_requested_by: input.requestedBy,
      p_intent: input.intent,
      p_allowed_session_id: input.allowedSessionId || null,
      p_allowed_pipeline_job_id: input.allowedFullPipelineJobId || null,
      p_provider: input.provider || 'gemini',
      p_model: textValue(input.model).slice(0, 160),
    },
  );
  if (error) {
    // Explicit/manual work remains available while an automation migration is
    // still rolling out. Until the RPC exists there is no automatic claimant
    // to arbitrate with, so continuing is safe.
    if (isContentWritingAutomationSchemaUnavailableError(error)) {
      return {
        schemaAvailable: false,
        reserved: true,
        reason: 'automation_schema_unavailable',
        automationItemId: null,
        automationSessionId: null,
        activeContentWritingSessionId: null,
        activeFullPipelineJobId: null,
        activeFullPipelineStatus: null,
        hasCompletedContentWritingSession: false,
      };
    }
    throw error;
  }

  const source = firstRow<ExternalAnalysisJson>(data) || {};
  const rawReason = textValue(source.reason);
  const reason = rawReason === 'active_content_writing_session'
    ? 'content_writing_active'
    : rawReason === 'active_full_article_pipeline'
      || rawReason === 'different_full_article_pipeline_active'
      ? 'full_pipeline_active'
      : rawReason;
  return {
    schemaAvailable: true,
    reserved: source.reserved !== false,
    reason: reason || (source.reserved === false ? 'explicit_reservation_conflict' : 'reserved'),
    automationItemId: textValue(source.automationItemId ?? source.automation_item_id) || null,
    automationSessionId: textValue(source.automationSessionId ?? source.automation_session_id) || null,
    activeContentWritingSessionId: textValue(
      source.activeContentWritingSessionId ?? source.active_content_writing_session_id,
    ) || null,
    activeFullPipelineJobId: textValue(source.activeFullPipelineJobId ?? source.active_full_pipeline_job_id) || null,
    activeFullPipelineStatus: textValue(source.activeFullPipelineStatus ?? source.active_full_pipeline_status) || null,
    hasCompletedContentWritingSession:
      source.hasCompletedContentWritingSession === true
      || source.has_completed_content_writing_session === true,
  };
};

export const readContentWritingAutomationSettings = async (): Promise<ContentWritingAutomationSettings> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();
  if (error && error.code !== '42P01') throw error;
  const ai = normalizeSystemSettingsMap({
    ai: isRecord(data?.value) ? data.value : {},
  }).ai;
  return {
    enabled: ai.contentWritingAutomationEnabled === true,
    intervalMinutes: boundedInteger(ai.contentWritingAutomationIntervalMinutes, 15, 1, 1_440),
    provider: providerValue(ai.contentWritingAutomationProvider),
    model: typeof ai.contentWritingAutomationModel === 'string'
      ? ai.contentWritingAutomationModel.trim().slice(0, 256)
      : '',
    minimumCompetitors: boundedInteger(ai.contentWritingAutomationMinimumCompetitors, 1, 1, 5),
    requireCompetitorTerminalState: ai.contentWritingAutomationRequireCompetitorTerminalState !== false,
    maxAttempts: boundedInteger(ai.contentWritingAutomationMaxAttempts, 3, 1, 10),
    retryMinutes: boundedInteger(ai.contentWritingAutomationRetryMinutes, 30, 1, 1_440),
  };
};

const claimNextItem = async (
  workerId: string,
  settings: ContentWritingAutomationSettings,
): Promise<ContentWritingAutomationItemRow | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'claim_next_content_writing_automation_item',
    {
      p_worker_id: workerId,
      p_provider: settings.provider,
      p_model: settings.model,
      p_min_competitor_count: settings.minimumCompetitors,
      p_require_processing_complete: settings.requireCompetitorTerminalState,
      p_max_attempts: settings.maxAttempts,
      p_lease_seconds: 300,
    },
  );
  if (error) {
    // Rolling deployments may briefly run new application code before the
    // migration reaches the database. Treat that window as disabled work.
    if (isContentWritingAutomationSchemaUnavailableError(error)) return null;
    throw error;
  }
  return firstRow<ContentWritingAutomationItemRow>(data);
};

const createAutomationSessionIdempotencyKey = (
  item: ContentWritingAutomationItemRow,
): string => (
  `auto-ready:${item.id}:${Math.max(1, item.run_generation)}:${Math.max(1, item.session_sequence)}`
);

const recoverAutomationSessionByIdempotency = async (
  item: ContentWritingAutomationItemRow,
  idempotencyKey: string,
): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_sessions')
    .select('*')
    .eq('created_by', item.requested_by)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    if (isContentWritingAutomationSchemaUnavailableError(error)) return null;
    throw error;
  }
  return isRecord(data) && typeof data.id === 'string'
    ? data as ContentWritingSession
    : null;
};

const attachSession = async (
  item: ContentWritingAutomationItemRow,
  session: QueuedContentWritingSession['session'],
  workerId: string,
): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'attach_content_writing_automation_session',
    {
      p_item_id: item.id,
      p_session_id: session.id,
      p_worker_id: workerId,
    },
  );
  if (error) throw error;
};

const releaseClaim = async (
  item: ContentWritingAutomationItemRow,
  workerId: string,
  settings: ContentWritingAutomationSettings,
  error: unknown,
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : 'automatic_content_writing_prepare_failed';
  const { error: releaseError } = await getExternalAnalysisSupabaseAdmin().rpc(
    'release_content_writing_automation_claim',
    {
      p_item_id: item.id,
      p_worker_id: workerId,
      p_error_code: code,
      p_error_message: message.slice(0, 4_000),
      p_retry_delay_minutes: settings.retryMinutes,
    },
  );
  if (releaseError) throw releaseError;
};

export const scheduleNextAutomaticContentWritingSession = async (
  workerId: string,
): Promise<QueuedContentWritingSession | null> => {
  const settings = await readContentWritingAutomationSettings();
  if (!settings.enabled) return null;

  const item = await claimNextItem(workerId, settings);
  if (!item) return null;

  const idempotencyKey = createAutomationSessionIdempotencyKey(item);

  try {
    const queued = await queueContentWritingSession({
      articleId: item.article_id,
      createdBy: item.requested_by,
      provider: item.provider,
      model: item.model || undefined,
      idempotencyKey,
      contextSnapshotPatch: {
        triggerSource: 'automatic_ready',
        automationItemId: item.id,
        automationRunGeneration: item.run_generation,
        automationSessionSequence: item.session_sequence,
        automationReadinessSignature: item.readiness_signature,
        automationAttempt: item.attempt_count,
        automationUsableCompetitorCount: item.usable_competitor_count,
        automationPendingCompetitorCount: item.pending_competitor_count,
        automationReviewPolicy: 'review_only',
      },
    });
    await attachSession(item, queued.session, workerId);
    console.log(
      `[content-writing-automation] Queued article ${item.article_id}`
      + ` as session ${queued.session.id}; attempt=${item.attempt_count}.`,
    );
    return queued;
  } catch (error) {
    // The session insert and the HTTP/RPC response are not one transaction. If
    // the response was lost after PostgreSQL committed, recover the exact
    // stable session instead of advancing to another idempotency key and
    // creating duplicate prose for the same automatic run.
    const recoveredSession = await recoverAutomationSessionByIdempotency(item, idempotencyKey)
      .catch((recoveryError): ContentWritingSession | null => {
        console.warn(
          `[content-writing-automation] Could not inspect orphan session for item ${item.id}:`,
          recoveryError,
        );
        return null;
      });
    if (recoveredSession) {
      await attachSession(item, recoveredSession, workerId);
      console.log(
        `[content-writing-automation] Recovered article ${item.article_id}`
        + ` as session ${recoveredSession.id}; sequence=${item.session_sequence}.`,
      );
      return {
        created: false,
        reusedActive: true,
        session: recoveredSession,
      };
    }
    await releaseClaim(item, workerId, settings, error);
    throw error;
  }
};
