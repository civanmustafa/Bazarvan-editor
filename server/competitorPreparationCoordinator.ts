import type { ExternalAnalysisJson } from './externalAnalysisQueue';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

type ContentWritingDiscoveryRequest = {
  mode: 'content_writing';
  articleId: string;
  requestedBy: string;
  origin: 'auto' | 'manual';
};

type FullArticlePipelineDiscoveryRequest = {
  mode: 'full_article_pipeline';
  pipelineJobId: string;
  requestedBy: string;
  workerId: string;
  leaseGeneration: number;
  forceRefresh: boolean;
};

export type CompetitorPreparationDiscoveryRequest =
  | ContentWritingDiscoveryRequest
  | FullArticlePipelineDiscoveryRequest;

export type CompetitorPreparationExtractionRequest = {
  articleId: string;
  requestedBy: string;
  origin: 'auto' | 'manual' | 'full_article_pipeline';
  queryType: string;
  queryText: string;
  sources: ExternalAnalysisJson[];
  reserveSources?: ExternalAnalysisJson[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const boundedCount = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(Math.round(parsed), 5))
    : fallback;
};

/**
 * Converts a discovery result into the one canonical extraction-source shape.
 * Both the standalone writing preparation job and the full-article pipeline
 * must use this function so selection order, de-duplication, and qualification
 * metadata cannot drift between the two entry points.
 */
export const selectCompetitorPreparationSources = (
  result: ExternalAnalysisJson | null,
  desiredCount: number,
): ExternalAnalysisJson[] => {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const valid = rows
    .filter(isRecord)
    .filter(row => row.eligible !== false && Boolean(text(row.canonicalUrl) || text(row.url)));
  const preferred = [
    ...valid.filter(row => row.autoSelected === true),
    ...valid.filter(row => row.autoSelected !== true),
  ];
  const seen = new Set<string>();
  return preferred.flatMap(row => {
    const url = text(row.canonicalUrl) || text(row.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      url,
      canonicalUrl: url,
      domain: text(row.domain),
      title: text(row.title),
      description: text(row.description),
      autoSelected: row.autoSelected === true,
      contentQualification: isRecord(row.contentQualification) ? row.contentQualification : {},
    }];
  }).slice(0, boundedCount(desiredCount, 5));
};

/**
 * Keeps the remaining confirmed discovery results available to the extraction
 * worker. They are not inserted as article competitors up front; the worker
 * promotes one into a failed slot only when every extraction provider for the
 * original source has been exhausted.
 */
export const selectCompetitorPreparationReserveSources = (
  result: ExternalAnalysisJson | null,
  selectedSources: ExternalAnalysisJson[],
  maximum = 10,
): ExternalAnalysisJson[] => {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const selectedUrls = new Set(selectedSources.map(source => (
    text(source.canonicalUrl) || text(source.url)
  )).filter(Boolean));
  const selectedDomains = new Set(selectedSources.map(source => text(source.domain)).filter(Boolean));
  const seenUrls = new Set(selectedUrls);
  const seenDomains = new Set(selectedDomains);
  return rows
    .filter(isRecord)
    .filter(row => row.eligible !== false && Boolean(text(row.canonicalUrl) || text(row.url)))
    .flatMap(row => {
      const url = text(row.canonicalUrl) || text(row.url);
      const domain = text(row.domain);
      if (!url || seenUrls.has(url) || (domain && seenDomains.has(domain))) return [];
      seenUrls.add(url);
      if (domain) seenDomains.add(domain);
      return [{
        url,
        canonicalUrl: url,
        domain,
        title: text(row.title),
        description: text(row.description),
        autoSelected: row.autoSelected === true,
        targetingStatus: text(row.targetingStatus),
        contentStatus: text(row.contentStatus),
        targetingEvidence: Array.isArray(row.targetingEvidence) ? row.targetingEvidence : [],
        contentQualification: isRecord(row.contentQualification) ? row.contentQualification : {},
      }];
    })
    .slice(0, Math.max(0, Math.min(Math.round(maximum), 15)));
};

/**
 * Keeps the two database ownership contracts explicit while exposing a single
 * discovery coordinator to every content-writing entry point. The full-pipeline
 * RPC retains its worker/lease fence; automatic preparation retains its
 * controlled enqueue RPC and manual preparation retains its explicit RPC.
 */
export const enqueueCompetitorPreparationDiscovery = async (
  request: CompetitorPreparationDiscoveryRequest,
): Promise<string> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const response = request.mode === 'full_article_pipeline'
    ? await supabase.rpc(
      'enqueue_full_article_pipeline_competitor_discovery',
      {
        p_pipeline_job_id: request.pipelineJobId,
        p_requested_by: request.requestedBy,
        p_worker_id: request.workerId,
        p_lease_generation: request.leaseGeneration,
        p_force_refresh: request.forceRefresh,
      },
    )
    : await supabase.rpc(
      request.origin === 'auto'
        ? 'enqueue_competitor_discovery_job_controlled'
        : 'enqueue_competitor_discovery_job',
      {
        p_article_id: request.articleId,
        p_requested_by: request.requestedBy,
        p_origin: request.origin,
      },
    );
  if (response.error) throw response.error;
  const jobId = text(response.data);
  if (!jobId) throw new Error('Competitor discovery prerequisites are incomplete.');
  return jobId;
};

const buildSelectedQualifications = (
  sources: ExternalAnalysisJson[],
): Record<string, ExternalAnalysisJson> => Object.fromEntries(sources.map(source => {
  const url = text(source.canonicalUrl) || text(source.url);
  const qualification = isRecord(source.contentQualification) ? source.contentQualification : {};
  return [url, {
    autoSelected: source.autoSelected === true,
    qualificationRequired: text(qualification.status) === 'qualified',
    status: text(qualification.status),
    matchedKeyword: text(qualification.matchedKeyword),
    matchKind: text(qualification.matchKind),
  }];
}));

/**
 * Enqueues extraction and persists the discovery qualification envelope in one
 * place. This prevents one writing path from losing the audit metadata that the
 * other path records.
 */
export const enqueueCompetitorPreparationExtraction = async (
  request: CompetitorPreparationExtractionRequest,
): Promise<string> => {
  const isControlledAutomaticRequest = request.origin === 'auto';
  const supabase = getExternalAnalysisSupabaseAdmin();
  const { data, error } = await supabase.rpc(
    isControlledAutomaticRequest
      ? 'enqueue_competitor_extraction_job_controlled'
      : 'enqueue_competitor_extraction_job',
    {
      p_article_id: request.articleId,
      p_requested_by: request.requestedBy,
      p_query_type: request.queryType,
      p_query_text: request.queryText,
      p_sources: request.sources,
      ...(isControlledAutomaticRequest ? { p_origin: 'auto' } : {}),
    },
  );
  if (error) throw error;
  const source = isRecord(data) ? data : {};
  const job = isRecord(source.job) ? source.job : {};
  const jobId = text(job.id);
  if (!jobId) throw new Error('Competitor extraction did not return a job.');

  const { error: metadataError } = await supabase
    .from('ai_external_analysis_jobs')
    .update({
      input_snapshot: {
        ...(isRecord(job.input_snapshot) ? job.input_snapshot : {}),
        reserveSources: request.reserveSources || [],
        selectedQualifications: buildSelectedQualifications([
          ...request.sources,
          ...(request.reserveSources || []),
        ]),
      },
    })
    .eq('id', jobId);
  if (metadataError) throw metadataError;
  return jobId;
};
