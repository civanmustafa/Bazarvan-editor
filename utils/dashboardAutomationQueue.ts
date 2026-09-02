import type { UserAutomationPreferences } from '../constants/userAutomation';
import type { ContentWritingAutomationOverview } from './contentWritingAutomation';
import type {
  ExternalAnalysisDashboardSummary,
  ExternalAnalysisJobRow,
  ExternalAnalysisJobStatus,
} from './externalAnalysis';

export type DashboardAutomationOperationKey =
  | 'alternative_keywords'
  | 'lsi_keywords'
  | 'google_metadata'
  | 'competitor_discovery'
  | 'competitor_extraction'
  | 'external_analysis'
  | 'content_writing'
  | 'internal_linking';

export type DashboardAutomationOperationStatus =
  | 'running'
  | 'waiting'
  | 'attention'
  | 'completed'
  | 'ready'
  | 'disabled'
  | 'unknown';

export type DashboardAutomationArticleSnapshot = {
  title: string;
  alternativeKeywordsReady: boolean;
  lsiKeywordsReady: boolean;
  googleMetadataReady: boolean;
};

export type DashboardAutomationOperation = {
  key: DashboardAutomationOperationKey;
  issueGroup: string;
  issueIds: string[];
  enabled: boolean | null;
  status: DashboardAutomationOperationStatus;
  runningCount: number;
  waitingCount: number;
  completedCount: number;
  failedCount: number;
  articleId: string | null;
  articleTitle: string;
  latestJobStatus: string;
  errorCode: string;
  errorMessage: string;
  readyItemCount?: number;
  totalItemCount?: number;
};

type BuildOptions = {
  summaries: Record<string, ExternalAnalysisDashboardSummary>;
  writingOverview: ContentWritingAutomationOverview | null;
  effectivePreferences: UserAutomationPreferences | null;
  articleTitles: Record<string, string>;
  articleSnapshots?: Record<string, DashboardAutomationArticleSnapshot>;
};

type JobEntry = {
  articleId: string;
  job: ExternalAnalysisJobRow | null;
};

type JobSummaryOptions = {
  issueGroup?: string;
  isResolved?: (articleId: string) => boolean;
  overrides?: Partial<Pick<DashboardAutomationOperation,
    'runningCount' | 'waitingCount' | 'completedCount' | 'failedCount' | 'readyItemCount' | 'totalItemCount'>>;
};

const RUNNING_STATUSES = new Set<ExternalAnalysisJobStatus>(['running']);
const WAITING_STATUSES = new Set<ExternalAnalysisJobStatus>([
  'waiting_for_prerequisites',
  'queued',
  'retry_scheduled',
  'paused',
]);
const FAILED_STATUSES = new Set<ExternalAnalysisJobStatus>(['failed', 'blocked']);

const jobTime = (job: ExternalAnalysisJobRow): number => {
  const parsed = new Date(job.updated_at || job.created_at).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const operationStatus = (values: {
  enabled: boolean | null;
  runningCount: number;
  waitingCount: number;
  completedCount: number;
  failedCount: number;
}): DashboardAutomationOperationStatus => {
  if (values.enabled === false) return 'disabled';
  if (values.runningCount > 0) return 'running';
  if (values.waitingCount > 0) return 'waiting';
  if (values.failedCount > 0) return 'attention';
  if (values.completedCount > 0) return 'completed';
  if (values.enabled === true) return 'ready';
  return 'unknown';
};

const summarizeJobs = (
  key: DashboardAutomationOperationKey,
  enabled: boolean | null,
  entries: JobEntry[],
  articleTitles: Record<string, string>,
  articleSnapshots: Record<string, DashboardAutomationArticleSnapshot>,
  options: JobSummaryOptions = {},
): DashboardAutomationOperation => {
  const isResolved = options.isResolved || (() => false);
  const availableEntries = entries.filter(
    (entry): entry is JobEntry & { job: ExternalAnalysisJobRow } => Boolean(entry.job),
  );
  const resolvedCount = entries.filter(entry => isResolved(entry.articleId)).length;
  const failedEntries = availableEntries.filter(entry => (
    !isResolved(entry.articleId) && FAILED_STATUSES.has(entry.job.status)
  ));
  const isActive = (job: ExternalAnalysisJobRow | null): boolean => Boolean(
    job && (RUNNING_STATUSES.has(job.status) || WAITING_STATUSES.has(job.status)),
  );
  const baseCounts = {
    runningCount: availableEntries.filter(entry => RUNNING_STATUSES.has(entry.job.status)).length,
    waitingCount: availableEntries.filter(entry => WAITING_STATUSES.has(entry.job.status)).length,
    completedCount: availableEntries.filter(entry => entry.job.status === 'completed').length
      + entries.filter(entry => (
        isResolved(entry.articleId) && entry.job?.status !== 'completed' && !isActive(entry.job)
      )).length,
    failedCount: failedEntries.length,
  };
  const counts = { ...baseCounts, ...(options.overrides || {}) };
  const status = operationStatus({ enabled, ...counts });
  const matchesStatus = (entry: JobEntry & { job: ExternalAnalysisJobRow }): boolean => {
    if (status === 'running') return RUNNING_STATUSES.has(entry.job.status);
    if (status === 'waiting') return WAITING_STATUSES.has(entry.job.status);
    if (status === 'attention') return !isResolved(entry.articleId) && FAILED_STATUSES.has(entry.job.status);
    if (status === 'completed') return isResolved(entry.articleId) || entry.job.status === 'completed';
    return true;
  };
  const latestEntry = [...availableEntries]
    .filter(matchesStatus)
    .sort((left, right) => jobTime(right.job) - jobTime(left.job))[0]
    || [...availableEntries].sort((left, right) => jobTime(right.job) - jobTime(left.job))[0]
    || null;
  const resolvedEntry = entries.find(entry => isResolved(entry.articleId)) || null;
  const articleId = latestEntry?.articleId || resolvedEntry?.articleId || null;
  const latestResolved = Boolean(latestEntry && isResolved(latestEntry.articleId));

  return {
    key,
    issueGroup: options.issueGroup || key,
    issueIds: failedEntries.map(entry => `external:${entry.job.id}`),
    enabled,
    status,
    ...counts,
    articleId,
    articleTitle: articleId
      ? articleSnapshots[articleId]?.title || articleTitles[articleId] || articleId
      : '',
    latestJobStatus: latestEntry
      ? (latestResolved && FAILED_STATUSES.has(latestEntry.job.status)
        ? 'resolved_current_state'
        : latestEntry.job.status)
      : (resolvedCount > 0 ? 'resolved_current_state' : ''),
    errorCode: status === 'attention' ? latestEntry?.job.last_error_code || '' : '',
    errorMessage: status === 'attention' ? latestEntry?.job.last_error || '' : '',
  };
};

const preference = (
  preferences: UserAutomationPreferences | null,
  key: keyof UserAutomationPreferences,
): boolean | null => preferences ? preferences[key] === true : null;

export const countDashboardAutomationIssues = (operations: DashboardAutomationOperation[]): number => (
  new Set(operations
    .filter(operation => operation.enabled !== false)
    .flatMap(operation => operation.issueIds)).size
);

export const buildDashboardAutomationOperations = ({
  summaries,
  writingOverview,
  effectivePreferences,
  articleTitles,
  articleSnapshots = {},
}: BuildOptions): DashboardAutomationOperation[] => {
  const values = Object.values(summaries);
  const jobEntries = (
    selector: (summary: ExternalAnalysisDashboardSummary) => ExternalAnalysisJobRow | null,
  ): JobEntry[] => values.map(summary => ({
    articleId: summary.articleId,
    job: selector(summary),
  }));
  const semanticJobs = jobEntries(summary => summary.latestAutomaticSemanticJob);
  const summarizedArticleIds = new Set(semanticJobs.map(entry => entry.articleId));
  Object.keys(articleSnapshots).forEach(articleId => {
    if (!summarizedArticleIds.has(articleId)) semanticJobs.push({ articleId, job: null });
  });
  const discoveryJobs = jobEntries(summary => summary.latestAutomaticCompetitorDiscoveryJob);
  const extractionJobs = jobEntries(summary => summary.latestAutomaticCompetitorExtractionJob);
  const engineeringJobs = jobEntries(summary => summary.latestAutomaticEngineeringJob);
  const semanticEnabled = {
    alternative_keywords: preference(effectivePreferences, 'autoGenerateAlternativeKeywords'),
    lsi_keywords: preference(effectivePreferences, 'autoGenerateLsiKeywords'),
    google_metadata: preference(effectivePreferences, 'autoGenerateGoogleMetadata'),
  } as const;
  const runningEngineeringCount = values.reduce(
    (sum, summary) => sum + summary.runningAutomaticEngineeringCount,
    0,
  );
  const waitingEngineeringCount = values.reduce(
    (sum, summary) => sum + summary.waitingAutomaticEngineeringCount,
    0,
  );
  const completedEngineeringCount = values.reduce(
    (sum, summary) => sum + summary.completedAutomaticEngineeringCount,
    0,
  );
  const competitorReadyCount = values.reduce((sum, summary) => sum + summary.competitorReadyCount, 0);
  const competitorTotalCount = values.reduce((sum, summary) => sum + summary.competitorTotalCount, 0);
  const competitorSummaryByArticle = new Map(values.map(summary => [summary.articleId, summary]));

  const writingEnabledPreference = preference(effectivePreferences, 'contentWritingAutomationEnabled');
  const writingEnabled = writingEnabledPreference === null
    ? (writingOverview ? writingOverview.settings.enabled : null)
    : writingEnabledPreference && (writingOverview?.settings.enabled ?? true);
  const writingLastItem = writingOverview?.lastItem || null;
  // A partial editor body is not proof that a failed writing session completed.
  const writingLastItemResolved = writingLastItem?.status === 'completed';
  const writingCounts = {
    runningCount: writingOverview?.active ? 1 : 0,
    waitingCount: writingOverview?.candidates.length || 0,
    completedCount: writingLastItemResolved ? 1 : 0,
    failedCount: writingLastItem?.status === 'blocked' && !writingLastItemResolved ? 1 : 0,
  };
  const writingStatus = operationStatus({ enabled: writingEnabled, ...writingCounts });
  const writingArticleId = writingOverview?.active?.articleId
    || writingOverview?.candidates[0]?.articleId
    || writingLastItem?.articleId
    || writingOverview?.state?.lastArticleId
    || null;
  const writingOperation: DashboardAutomationOperation = {
    key: 'content_writing',
    issueGroup: 'content_writing',
    issueIds: writingLastItem?.status === 'blocked' ? [`writing:${writingLastItem.id}`] : [],
    enabled: writingEnabled,
    status: writingStatus,
    ...writingCounts,
    articleId: writingArticleId,
    articleTitle: writingOverview?.active?.articleTitle
      || writingOverview?.candidates[0]?.articleTitle
      || writingLastItem?.articleTitle
      || (writingArticleId
        ? articleSnapshots[writingArticleId]?.title || articleTitles[writingArticleId] || writingArticleId
        : ''),
    latestJobStatus: writingOverview?.active?.sessionStatus
      || writingOverview?.active?.status
      || writingLastItem?.sessionStatus
      || writingLastItem?.status
      || String(writingOverview?.state?.lastOutcome || ''),
    errorCode: writingStatus === 'attention' ? writingLastItem?.lastErrorCode || '' : '',
    errorMessage: writingStatus === 'attention' ? writingLastItem?.lastError || '' : '',
  };

  return [
    summarizeJobs(
      'alternative_keywords',
      semanticEnabled.alternative_keywords,
      semanticJobs,
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.alternativeKeywordsReady === true,
      },
    ),
    summarizeJobs(
      'lsi_keywords',
      semanticEnabled.lsi_keywords,
      semanticJobs,
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.lsiKeywordsReady === true,
      },
    ),
    summarizeJobs(
      'google_metadata',
      semanticEnabled.google_metadata,
      semanticJobs,
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.googleMetadataReady === true,
      },
    ),
    summarizeJobs(
      'competitor_discovery',
      preference(effectivePreferences, 'autoDiscoverCompetitors'),
      discoveryJobs,
      articleTitles,
      articleSnapshots,
      {
        isResolved: articleId => (competitorSummaryByArticle.get(articleId)?.competitorTotalCount || 0) > 0,
        overrides: { readyItemCount: competitorReadyCount, totalItemCount: competitorTotalCount },
      },
    ),
    summarizeJobs(
      'competitor_extraction',
      preference(effectivePreferences, 'autoExtractCompetitorContent'),
      extractionJobs,
      articleTitles,
      articleSnapshots,
      {
        isResolved: articleId => {
          const summary = competitorSummaryByArticle.get(articleId);
          return Boolean(
            summary
            && summary.competitorTotalCount > 0
            && summary.competitorReadyCount >= summary.competitorTotalCount,
          );
        },
        overrides: { readyItemCount: competitorReadyCount, totalItemCount: competitorTotalCount },
      },
    ),
    summarizeJobs(
      'external_analysis',
      preference(effectivePreferences, 'autoRunReadyEngineeringCommands'),
      engineeringJobs,
      articleTitles,
      articleSnapshots,
      {
        overrides: {
          runningCount: runningEngineeringCount,
          waitingCount: waitingEngineeringCount,
          completedCount: completedEngineeringCount,
        },
      },
    ),
    writingOperation,
    {
      key: 'internal_linking',
      issueGroup: 'internal_linking',
      issueIds: [],
      enabled: preference(effectivePreferences, 'autoApplyStrongInternalLinkSuggestions'),
      status: preference(effectivePreferences, 'autoApplyStrongInternalLinkSuggestions') === false
        ? 'disabled'
        : preference(effectivePreferences, 'autoApplyStrongInternalLinkSuggestions') === true
          ? 'ready'
          : 'unknown',
      runningCount: 0,
      waitingCount: 0,
      completedCount: 0,
      failedCount: 0,
      articleId: null,
      articleTitle: '',
      latestJobStatus: '',
      errorCode: '',
      errorMessage: '',
    },
  ];
};
