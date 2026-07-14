import type { SupabaseClient } from '@supabase/supabase-js';
import { ArticleAccessPolicyError, requireArticleWriteAccess } from './articleAccessPolicy';
import { getExternalEngineeringCommand } from '../server/externalEngineeringCommands';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import { MAX_ARTICLE_COMPETITORS } from '../constants/competitors';
import { deliverApiResult, getHeaderValue, isRecord, readRequestBody, type ApiResult } from './http.ts';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

type ArticleRow = {
  id: string;
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

type EnqueuedSemanticJob = {
  id: string;
  [key: string]: unknown;
};

type EnqueueSemanticJobResult = {
  alreadyReady: boolean;
  alreadyActive: boolean;
  job: EnqueuedSemanticJob | null;
};

const ACTIVE_JOB_STATUSES = [
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
];

const ENQUEUED_JOB_SELECT = [
  'id',
  'article_id',
  'job_type',
  'origin',
  'status',
  'batch_key',
  'sequence_number',
  'command_id',
  'command_label',
  'depends_on_job_id',
  'readiness_signature',
  'progress',
  'last_error',
  'last_error_code',
  'attempt_count',
  'retry_count',
  'next_attempt_at',
  'completed_at',
  'created_at',
  'updated_at',
].join(',');

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
      .select('id,status,title,plain_text,keywords,goal_context,metadata,article_language,updated_at')
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

const hasCompetitorInput = (metadata: unknown): boolean => {
  const source = isRecord(metadata) ? metadata : {};
  const competitors = isRecord(source.attachments?.competitors)
    ? source.attachments.competitors
    : isRecord(source.competitors)
      ? source.competitors
      : {};
  return toStringList(competitors.urls).slice(0, MAX_ARTICLE_COMPETITORS).length > 0
    || toStringList(competitors.texts).slice(0, MAX_ARTICLE_COMPETITORS).length > 0;
};

const enqueueSemanticJob = async (
  supabase: SupabaseAdmin,
  article: ArticleRow,
  state: AnalysisStateRow,
): Promise<EnqueueSemanticJobResult> => {
  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const needsSecondaries = toStringList(keywords.secondaries).length === 0;
  const needsLsi = toStringList(keywords.lsi).length === 0;
  if (!needsSecondaries && !needsLsi) {
    return { alreadyReady: true, alreadyActive: false, job: null };
  }

  if (!state.semantic_ready || !state.semantic_readiness_signature) {
    throw new ExternalAnalysisApiError({
      message: 'Semantic analysis prerequisites are incomplete.',
      status: 409,
      code: 'missing_prerequisites',
      details: { missingFields: toStringList(state.semantic_missing_fields) },
    });
  }

  const { data: jobId, error: enqueueError } = await supabase.rpc(
    'enqueue_external_semantic_analysis_job',
    { p_article_id: article.id },
  );
  if (enqueueError) throw enqueueError;
  const normalizedJobId = toTrimmedString(Array.isArray(jobId) ? jobId[0] : jobId);
  if (!normalizedJobId) {
    throw new ExternalAnalysisApiError({
      message: 'The semantic task could not be created or reused.',
      status: 409,
      code: 'semantic_task_unavailable',
    });
  }

  const { data: job, error: jobError } = await supabase
    .from('ai_external_analysis_jobs')
    .select(ENQUEUED_JOB_SELECT)
    .eq('id', normalizedJobId)
    .single();
  if (jobError) throw jobError;
  if (!job) throw new Error('Semantic analysis queue returned no job.');
  const normalizedJob = job as unknown as EnqueuedSemanticJob & { status: string };
  return {
    alreadyReady: false,
    job: normalizedJob,
    alreadyActive: ACTIVE_JOB_STATUSES.includes(normalizedJob.status),
  };
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

  const { error: preferenceError } = await supabase.rpc('set_external_analysis_custom_commands', {
    p_article_id: article.id,
    p_requested_by: requestedBy,
    p_command_ids: normalizedIds,
  });
  if (preferenceError) throw preferenceError;

  const needsSemanticPrerequisite = toStringList(keywords.secondaries).length === 0
    || toStringList(keywords.lsi).length === 0;
  const { data: enqueuedIds, error: enqueueError } = await supabase.rpc(
    'enqueue_external_engineering_jobs',
    { p_article_id: article.id },
  );
  if (enqueueError) throw enqueueError;
  const jobIds = uniqueStrings(Array.isArray(enqueuedIds) ? enqueuedIds.map(String) : []);
  if (jobIds.length === 0) {
    throw new ExternalAnalysisApiError({
      message: 'The selected engineering tasks could not be created or reused.',
      status: 409,
      code: 'engineering_tasks_unavailable',
      details: { commandIds: normalizedIds },
    });
  }

  const { data: queuedJobs, error: jobsError } = await supabase
    .from('ai_external_analysis_jobs')
    .select(ENQUEUED_JOB_SELECT)
    .in('id', jobIds)
    .order('sequence_number', { ascending: true });
  if (jobsError) throw jobsError;
  const jobs = ((queuedJobs || []) as unknown as Array<Record<string, any>>)
    .filter(job => job.last_error_code !== 'duplicate_task_suppressed');
  let semanticDependencyId = '';
  let semanticDependencyStatus = '';
  if (needsSemanticPrerequisite) {
    const { data: semanticJobs, error: semanticError } = await supabase
      .from('ai_external_analysis_jobs')
      .select('id,status,last_error_code,created_at')
      .eq('article_id', article.id)
      .eq('job_type', 'semantic_keywords_lsi')
      .eq('readiness_signature', state.semantic_readiness_signature)
      .order('created_at', { ascending: false })
      .limit(10);
    if (semanticError) throw semanticError;
    const semanticRows = (semanticJobs || []) as unknown as Array<{
      id: string;
      status: string;
      last_error_code: string | null;
    }>;
    const semanticDependency = semanticRows
      .find(job => job.last_error_code !== 'duplicate_task_suppressed');
    semanticDependencyId = toTrimmedString(semanticDependency?.id);
    semanticDependencyStatus = toTrimmedString(semanticDependency?.status);
  }
  const activeBatchKey = toTrimmedString(
    jobs.find(job => ACTIVE_JOB_STATUSES.includes(String(job.status)))?.batch_key
      || jobs[0]?.batch_key,
  );
  return {
    batchId: activeBatchKey,
    batch: null as Record<string, unknown> | null,
    jobs,
    commandSelectionMode: 'custom',
    customCommandIds: normalizedIds,
    semanticPrerequisiteQueued: Boolean(
      semanticDependencyId && ACTIVE_JOB_STATUSES.includes(semanticDependencyStatus),
    ),
    semanticPrerequisiteJobId: semanticDependencyId || null,
    completedCount: jobs.filter(job => job.status === 'completed').length,
    activeCount: jobs.filter(job => ACTIVE_JOB_STATUSES.includes(String(job.status))).length,
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

const retryExternalAnalysisJob = async (
  supabase: SupabaseAdmin,
  articleId: string,
  requestedBy: string,
  jobId: string,
) => {
  if (!jobId) {
    throw new ExternalAnalysisApiError({
      message: 'jobId is required for retry.',
      code: 'job_id_required',
    });
  }

  const { data: existingJob, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,article_id,status,last_error_code')
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

  const { data, error } = await supabase.rpc('retry_external_analysis_job', {
    p_job_id: jobId,
    p_requested_by: requestedBy,
  });
  if (error) throw error;
  const job = Array.isArray(data) ? data[0] : data;
  if (!job) {
    throw new ExternalAnalysisApiError({
      message: 'The external analysis task could not be retried.',
      status: 409,
      code: 'external_analysis_retry_unavailable',
    });
  }
  return {
    job,
    reusedJobId: String(job.id || jobId),
    alreadyCompleted: job.status === 'completed',
    alreadyActive: ACTIVE_JOB_STATUSES.includes(String(job.status)),
  };
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
  await requireArticleWriteAccess(supabase, article.id, profile.id);
  const action = toTrimmedString(body.action);

  if (action === 'semantic') {
    const result = await enqueueSemanticJob(supabase, article, state);
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
  if (action === 'retry') {
    const result = await retryExternalAnalysisJob(
      supabase,
      article.id,
      profile.id,
      toTrimmedString(body.jobId),
    );
    return { status: 200, body: { ok: true, action, ...result } };
  }

  throw new ExternalAnalysisApiError({
    message: 'action must be semantic, engineering, use_default_commands, cancel, cancel_all, or retry.',
    code: 'invalid_action',
  });
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleExternalAnalysisRequest(req);
    return deliverApiResult(result, res);
  } catch (error) {
    const status = error instanceof ExternalAnalysisApiError || error instanceof ArticleAccessPolicyError
      ? error.status
      : 500;
    const code = error instanceof ExternalAnalysisApiError ? error.code : 'external_analysis_request_failed';
    const details = error instanceof ExternalAnalysisApiError ? error.details : undefined;
    const message = error instanceof Error ? error.message : 'Unknown external analysis error.';
    console.error('External analysis request failed:', error);
    const result: ApiResult = {
      status,
      body: { ok: false, code, error: message, ...(details || {}) },
    };
    return deliverApiResult(result, res);
  }
}
