import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getExternalEngineeringCommand } from '../server/externalEngineeringCommands';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

type ArticleRow = {
  id: string;
  owner_id: string | null;
  created_by: string | null;
  assigned_to: string | null;
  status: string;
  title: string | null;
  plain_text: string | null;
  keywords: unknown;
  goal_context: unknown;
  metadata: unknown;
  article_language: string | null;
  updated_at: string;
};

type AnalysisStateRow = {
  article_id: string;
  semantic_ready: boolean;
  external_analysis_ready: boolean;
  semantic_missing_fields: unknown;
  external_analysis_missing_fields: unknown;
  semantic_readiness_signature: string;
  external_analysis_readiness_signature: string;
  engineering_command_mode: 'default' | 'custom';
  custom_engineering_command_ids: unknown;
};

const ACTIVE_JOB_STATUSES = [
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
];

class ExternalAnalysisApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(options: {
    message: string;
    status?: number;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = 'ExternalAnalysisApiError';
    this.status = options.status ?? 400;
    this.code = options.code ?? 'external_analysis_request_failed';
    this.details = options.details;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toStringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(toTrimmedString).filter(Boolean)
    : []
);

const uniqueStrings = (items: string[]): string[] => (
  Array.from(new Set(items.map(item => item.trim()).filter(Boolean)))
);

const readNodeBody = async (req: any): Promise<unknown> => {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req.json === 'function' && typeof req.headers?.get === 'function') {
    return req.json();
  }
  return readNodeBody(req);
};

const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }
  const directValue = req.headers?.[headerName.toLowerCase()] || req.headers?.[headerName];
  return Array.isArray(directValue) ? String(directValue[0] || '') : String(directValue || '');
};

const getBearerToken = (req: any): string => (
  getHeaderValue(req, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
);

const authenticateProfile = async (supabase: SupabaseAdmin, req: any) => {
  const token = getBearerToken(req);
  if (!token) {
    throw new ExternalAnalysisApiError({
      message: 'Authentication is required.',
      status: 401,
      code: 'authentication_required',
    });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user?.id) {
    throw new ExternalAnalysisApiError({
      message: 'Invalid Supabase session.',
      status: 401,
      code: 'invalid_session',
    });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,role,is_active')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.is_active === false) {
    throw new ExternalAnalysisApiError({
      message: 'The user profile is inactive.',
      status: 403,
      code: 'inactive_profile',
    });
  }
  return profile as { id: string; role: 'admin' | 'user'; is_active: boolean };
};

const readArticleAndState = async (
  supabase: SupabaseAdmin,
  articleId: string,
): Promise<{ article: ArticleRow; state: AnalysisStateRow }> => {
  const [articleResult, stateResult] = await Promise.all([
    supabase
      .from('articles')
      .select('id,owner_id,created_by,assigned_to,status,title,plain_text,keywords,goal_context,metadata,article_language,updated_at')
      .eq('id', articleId)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_article_state')
      .select('article_id,semantic_ready,external_analysis_ready,semantic_missing_fields,external_analysis_missing_fields,semantic_readiness_signature,external_analysis_readiness_signature,engineering_command_mode,custom_engineering_command_ids')
      .eq('article_id', articleId)
      .maybeSingle(),
  ]);
  if (articleResult.error) throw articleResult.error;
  if (stateResult.error) throw stateResult.error;
  if (!articleResult.data) {
    throw new ExternalAnalysisApiError({
      message: 'Article was not found.',
      status: 404,
      code: 'article_not_found',
    });
  }
  if (!stateResult.data) {
    throw new ExternalAnalysisApiError({
      message: 'External analysis state is not available for this article.',
      status: 409,
      code: 'analysis_state_unavailable',
    });
  }
  return {
    article: articleResult.data as ArticleRow,
    state: stateResult.data as AnalysisStateRow,
  };
};

const assertCanManageArticle = (
  article: ArticleRow,
  profile: { id: string; role: 'admin' | 'user' },
): void => {
  if (
    profile.role === 'admin'
    || article.owner_id === profile.id
    || article.assigned_to === profile.id
  ) return;

  throw new ExternalAnalysisApiError({
    message: 'You do not have permission to start analysis for this article.',
    status: 403,
    code: 'article_analysis_forbidden',
  });
};

const toArticleSnapshot = (article: ArticleRow) => ({
  title: article.title,
  plainText: article.plain_text,
  keywords: isRecord(article.keywords) ? article.keywords : {},
  goalContext: isRecord(article.goal_context) ? article.goal_context : {},
  articleLanguage: article.article_language,
  competitors: isRecord(article.metadata)
    ? (article.metadata.attachments?.competitors || article.metadata.competitors || {})
    : {},
  articleUpdatedAt: article.updated_at,
});

const hasCompetitorInput = (metadata: unknown): boolean => {
  const source = isRecord(metadata) ? metadata : {};
  const competitors = isRecord(source.attachments?.competitors)
    ? source.attachments.competitors
    : isRecord(source.competitors)
      ? source.competitors
      : {};
  return toStringList(competitors.urls).slice(0, 3).length > 0
    || toStringList(competitors.texts).slice(0, 3).length > 0;
};

const enqueueSemanticJob = async (
  supabase: SupabaseAdmin,
  article: ArticleRow,
  state: AnalysisStateRow,
  requestedBy: string,
) => {
  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const needsSecondaries = toStringList(keywords.secondaries).length === 0;
  const needsLsi = toStringList(keywords.lsi).length === 0;
  if (!needsSecondaries && !needsLsi) {
    return { alreadyReady: true, job: null };
  }

  if (!state.semantic_ready || !state.semantic_readiness_signature) {
    throw new ExternalAnalysisApiError({
      message: 'Semantic analysis prerequisites are incomplete.',
      status: 409,
      code: 'missing_prerequisites',
      details: { missingFields: toStringList(state.semantic_missing_fields) },
    });
  }

  const { data: activeJob, error: activeError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,article_id,job_type,status,progress,next_attempt_at,created_at,updated_at')
    .eq('article_id', article.id)
    .eq('job_type', 'semantic_keywords_lsi')
    .in('status', ACTIVE_JOB_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (activeJob) return { alreadyReady: false, job: activeJob, alreadyActive: true };

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const { data: job, error } = await supabase
    .from('ai_external_analysis_jobs')
    .insert({
      id: jobId,
      article_id: article.id,
      requested_by: requestedBy,
      job_type: 'semantic_keywords_lsi',
      origin: 'manual',
      status: 'queued',
      idempotency_key: `semantic_keywords_lsi:${state.semantic_readiness_signature}`,
      batch_key: `manual-semantic:${article.id}:${jobId}`,
      sequence_number: 0,
      readiness_signature: state.semantic_readiness_signature,
      input_snapshot: {
        ...toArticleSnapshot(article),
        readinessSignature: state.semantic_readiness_signature,
        needsSecondaries,
        needsLsi,
        source: 'dashboard',
      },
      progress: {
        stage: 'queued',
        source: 'dashboard',
        updatedAt: now,
      },
      next_attempt_at: now,
    })
    .select('id,article_id,job_type,status,progress,next_attempt_at,created_at,updated_at')
    .single();
  if (error?.code === '23505') {
    const { data: conflictingJob, error: conflictReadError } = await supabase
      .from('ai_external_analysis_jobs')
      .select('id,article_id,job_type,status,progress,next_attempt_at,created_at,updated_at')
      .eq('article_id', article.id)
      .eq('job_type', 'semantic_keywords_lsi')
      .in('status', ACTIVE_JOB_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (conflictReadError) throw conflictReadError;
    if (conflictingJob) {
      return { alreadyReady: false, job: conflictingJob, alreadyActive: true };
    }
    throw error;
  }
  if (error) throw error;
  return { alreadyReady: false, job, alreadyActive: false };
};

const enqueueEngineeringJobs = async (
  supabase: SupabaseAdmin,
  article: ArticleRow,
  state: AnalysisStateRow,
  requestedBy: string,
  commandIds: string[],
) => {
  const normalizedIds = uniqueStrings(commandIds).slice(0, 25);
  if (normalizedIds.length === 0) {
    throw new ExternalAnalysisApiError({
      message: 'At least one ready command is required.',
      code: 'commands_required',
    });
  }
  const commands = normalizedIds.map(commandId => getExternalEngineeringCommand(commandId));
  const invalidCommandIds = normalizedIds.filter((_, index) => !commands[index]);
  if (invalidCommandIds.length > 0) {
    throw new ExternalAnalysisApiError({
      message: 'One or more ready commands are not supported by the worker.',
      code: 'unsupported_commands',
      details: { commandIds: invalidCommandIds },
    });
  }

  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const missingFields = [
    ...toStringList(state.external_analysis_missing_fields),
    !toTrimmedString(article.plain_text) ? 'editor_text' : '',
    !hasCompetitorInput(article.metadata) ? 'competitor_content_or_url' : '',
  ].filter(Boolean);
  if (!state.external_analysis_ready || !state.external_analysis_readiness_signature || missingFields.length > 0) {
    throw new ExternalAnalysisApiError({
      message: 'External engineering analysis prerequisites are incomplete.',
      status: 409,
      code: 'missing_prerequisites',
      details: { missingFields: uniqueStrings(missingFields) },
    });
  }

  const { data: activeJobs, error: activeError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,command_id,status')
    .eq('article_id', article.id)
    .eq('job_type', 'engineering_command')
    .eq('origin', 'manual')
    .in('command_id', normalizedIds)
    .in('status', ACTIVE_JOB_STATUSES);
  if (activeError) throw activeError;
  if ((activeJobs || []).length > 0) {
    throw new ExternalAnalysisApiError({
      message: 'One or more selected commands already have an active task.',
      status: 409,
      code: 'commands_already_active',
      details: {
        commandIds: uniqueStrings((activeJobs || []).map(job => toTrimmedString(job.command_id))),
      },
    });
  }

  const { error: preferenceError } = await supabase.rpc('set_external_analysis_custom_commands', {
    p_article_id: article.id,
    p_requested_by: requestedBy,
    p_command_ids: normalizedIds,
  });
  if (preferenceError) throw preferenceError;

  const needsSemanticPrerequisite = toStringList(keywords.secondaries).length === 0
    || toStringList(keywords.lsi).length === 0;
  const semanticResult = needsSemanticPrerequisite
    ? await enqueueSemanticJob(supabase, article, state, requestedBy)
    : null;
  const semanticDependencyId = semanticResult?.job?.id || null;
  if (needsSemanticPrerequisite && !semanticDependencyId && !semanticResult?.alreadyReady) {
    throw new ExternalAnalysisApiError({
      message: 'The semantic prerequisite could not be queued.',
      status: 409,
      code: 'semantic_prerequisite_unavailable',
      details: { missingFields: ['alternative_keywords', 'lsi_keywords'] },
    });
  }

  const batchId = randomUUID();
  const batchKey = `manual-engineering:${article.id}:${batchId}`;
  const now = new Date().toISOString();
  const jobIds = commands.map(() => randomUUID());
  const snapshot = toArticleSnapshot(article);
  const rows = commands.map((command, index) => ({
    id: jobIds[index],
    article_id: article.id,
    requested_by: requestedBy,
    job_type: 'engineering_command',
    origin: 'manual',
    status: 'queued',
    idempotency_key: `manual-engineering:${batchId}:${command!.id}:${state.external_analysis_readiness_signature}`,
    batch_key: batchKey,
    sequence_number: index + 1,
    command_id: command!.id,
    command_label: command!.label,
    depends_on_job_id: index > 0 ? jobIds[index - 1] : semanticDependencyId,
    readiness_signature: state.external_analysis_readiness_signature,
    input_snapshot: {
      ...snapshot,
      readinessSignature: state.external_analysis_readiness_signature,
      commandSequence: index + 1,
      commandTotal: commands.length,
      commandId: command!.id,
      source: 'dashboard',
    },
    progress: {
      stage: 'queued',
      source: 'dashboard',
      commandSequence: index + 1,
      commandTotal: commands.length,
      semanticPrerequisiteJobId: semanticDependencyId,
      updatedAt: now,
    },
    next_attempt_at: now,
  }));

  const { data: jobs, error } = await supabase
    .from('ai_external_analysis_jobs')
    .insert(rows)
    .select('id,article_id,job_type,origin,status,batch_key,sequence_number,command_id,command_label,depends_on_job_id,progress,next_attempt_at,created_at,updated_at');
  if (error?.code === '23505') {
    throw new ExternalAnalysisApiError({
      message: 'One or more selected commands already have an active task.',
      status: 409,
      code: 'commands_already_active',
      details: { commandIds: normalizedIds },
    });
  }
  if (error) throw error;
  const { data: batch, error: batchError } = await supabase.rpc(
    'apply_external_analysis_execution_mode_to_batch',
    { p_batch_key: batchKey },
  );
  if (batchError && !['42883', 'PGRST202'].includes(String(batchError.code || ''))) {
    throw batchError;
  }
  return {
    batchId,
    batch: Array.isArray(batch) ? batch[0] || null : batch || null,
    jobs: jobs || [],
    commandSelectionMode: 'custom',
    customCommandIds: normalizedIds,
    semanticPrerequisiteQueued: Boolean(semanticDependencyId),
    semanticPrerequisiteJobId: semanticDependencyId,
  };
};

const useDefaultEngineeringCommands = async (
  supabase: SupabaseAdmin,
  articleId: string,
  requestedBy: string,
) => {
  const { data, error } = await supabase.rpc('reset_external_analysis_command_preferences', {
    p_article_id: articleId,
    p_requested_by: requestedBy,
  });
  if (error) throw error;
  return {
    commandSelectionMode: 'default',
    state: Array.isArray(data) ? data[0] || null : data || null,
  };
};

const cancelExternalAnalysisJob = async (
  supabase: SupabaseAdmin,
  articleId: string,
  requestedBy: string,
  jobId: string,
) => {
  if (!jobId) {
    throw new ExternalAnalysisApiError({
      message: 'jobId is required for cancellation.',
      code: 'job_id_required',
    });
  }

  const { data: existingJob, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,article_id,job_type,status,command_id,depends_on_job_id,progress,updated_at')
    .eq('id', jobId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existingJob || existingJob.article_id !== articleId) {
    throw new ExternalAnalysisApiError({
      message: 'External analysis job was not found for this article.',
      status: 404,
      code: 'external_analysis_job_not_found',
    });
  }

  if (!ACTIVE_JOB_STATUSES.includes(existingJob.status)) {
    return { job: existingJob, alreadyTerminal: true };
  }

  const { data, error } = await supabase.rpc('request_external_analysis_job_cancel', {
    p_job_id: jobId,
    p_requested_by: requestedBy,
  });
  if (error) throw error;
  const job = Array.isArray(data) ? data[0] : data;
  return { job: job || existingJob, alreadyTerminal: false };
};

const cancelAllExternalAnalysisJobs = async (
  supabase: SupabaseAdmin,
  articleId: string,
  requestedBy: string,
) => {
  const { data: activeJobs, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,depends_on_job_id,status')
    .eq('article_id', articleId)
    .in('status', ACTIVE_JOB_STATUSES);
  if (readError) throw readError;

  const rows = activeJobs || [];
  if (rows.length === 0) {
    return { cancelledCount: 0, rootJobIds: [], alreadyTerminal: true };
  }

  const activeIds = new Set(rows.map(job => String(job.id)));
  const detectedRootJobIds = rows
    .filter(job => !job.depends_on_job_id || !activeIds.has(String(job.depends_on_job_id)))
    .map(job => String(job.id));
  const rootJobIds = detectedRootJobIds.length > 0
    ? detectedRootJobIds
    : rows.map(job => String(job.id));

  for (const rootJobId of rootJobIds) {
    const { error } = await supabase.rpc('request_external_analysis_job_cancel', {
      p_job_id: rootJobId,
      p_requested_by: requestedBy,
    });
    if (error) throw error;
  }

  return {
    cancelledCount: rows.length,
    rootJobIds,
    alreadyTerminal: false,
  };
};

const toWebResponse = (result: ApiResult): Response => new Response(
  result.status === 204 ? null : JSON.stringify(result.body),
  {
    status: result.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(result.headers || {}),
    },
  },
);

const sendNodeResponse = (res: any, result: ApiResult) => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(result.status === 204 ? undefined : JSON.stringify(result.body));
};

const handleExternalAnalysisRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }

  let body: unknown;
  try {
    body = await readRequestBody(req);
  } catch {
    throw new ExternalAnalysisApiError({
      message: 'Request body must contain valid JSON.',
      code: 'invalid_json',
    });
  }
  if (!isRecord(body)) {
    throw new ExternalAnalysisApiError({ message: 'JSON body must be an object.' });
  }
  const articleId = toTrimmedString(body.articleId);
  if (!articleId) {
    throw new ExternalAnalysisApiError({ message: 'articleId is required.', code: 'article_id_required' });
  }
  if (!getBearerToken(req)) {
    throw new ExternalAnalysisApiError({
      message: 'Authentication is required.',
      status: 401,
      code: 'authentication_required',
    });
  }

  const supabase = getExternalAnalysisSupabaseAdmin() as SupabaseAdmin;
  const profile = await authenticateProfile(supabase, req);
  const { article, state } = await readArticleAndState(supabase, articleId);
  assertCanManageArticle(article, profile);
  const action = toTrimmedString(body.action);

  if (action === 'semantic') {
    const result = await enqueueSemanticJob(supabase, article, state, profile.id);
    return { status: result.job && !result.alreadyActive ? 201 : 200, body: { ok: true, action, ...result } };
  }
  if (action === 'engineering') {
    const result = await enqueueEngineeringJobs(
      supabase,
      article,
      state,
      profile.id,
      toStringList(body.commandIds),
    );
    return { status: 201, body: { ok: true, action, ...result } };
  }
  if (action === 'use_default_commands') {
    const result = await useDefaultEngineeringCommands(
      supabase,
      article.id,
      profile.id,
    );
    return { status: 200, body: { ok: true, action, ...result } };
  }
  if (action === 'cancel') {
    const result = await cancelExternalAnalysisJob(
      supabase,
      article.id,
      profile.id,
      toTrimmedString(body.jobId),
    );
    return { status: 200, body: { ok: true, action, ...result } };
  }
  if (action === 'cancel_all') {
    const result = await cancelAllExternalAnalysisJobs(supabase, article.id, profile.id);
    return { status: 200, body: { ok: true, action, ...result } };
  }

  throw new ExternalAnalysisApiError({
    message: 'action must be semantic, engineering, use_default_commands, cancel, or cancel_all.',
    code: 'invalid_action',
  });
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleExternalAnalysisRequest(req);
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  } catch (error) {
    const status = error instanceof ExternalAnalysisApiError ? error.status : 500;
    const code = error instanceof ExternalAnalysisApiError ? error.code : 'external_analysis_request_failed';
    const details = error instanceof ExternalAnalysisApiError ? error.details : undefined;
    const message = error instanceof Error ? error.message : 'Unknown external analysis error.';
    console.error('External analysis request failed:', error);
    const result: ApiResult = {
      status,
      body: { ok: false, code, error: message, ...(details || {}) },
    };
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  }
}
