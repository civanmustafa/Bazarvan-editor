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
  attemptCount?: number;
  maxAttempts?: number;
  retryAt?: string | null;
  retryScheduled?: boolean;
  attemptsExhausted?: boolean;
  completedLinkCount?: number;
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
  hasSavedEvidence?: (articleId: string) => boolean;
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
  const isCompleted = (entry: JobEntry): boolean => isResolved(entry.articleId)
    || (!options.hasSavedEvidence?.(entry.articleId) && entry.job?.status === 'completed'
      && !['superseded', 'automation_disabled'].includes(String(entry.job.result?.status || entry.job.progress?.stage)));
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
    completedCount: entries.filter(entry => isCompleted(entry) && !isActive(entry.job)).length,
    failedCount: failedEntries.length,
  };
  const counts = { ...baseCounts, ...(options.overrides || {}) };
  const status = operationStatus({ enabled, ...counts });
  const matchesStatus = (entry: JobEntry & { job: ExternalAnalysisJobRow }): boolean => {
    if (status === 'running') return RUNNING_STATUSES.has(entry.job.status);
    if (status === 'waiting') return WAITING_STATUSES.has(entry.job.status);
    if (status === 'attention') return !isResolved(entry.articleId) && FAILED_STATUSES.has(entry.job.status);
    if (status === 'completed') return isCompleted(entry);
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
  const semanticJobs = jobEntries(summary => summary.latestSemanticJob || summary.latestAutomaticSemanticJob);
  const summarizedArticleIds = new Set(semanticJobs.map(entry => entry.articleId));
  Object.keys(articleSnapshots).forEach(articleId => {
    if (!summarizedArticleIds.has(articleId)) semanticJobs.push({ articleId, job: null });
  });
  const semanticTargetJobs = (target: string): JobEntry[] => semanticJobs.map(entry => ({
    ...entry, job: entry.job?.input_snapshot?.[target] === false ? null : entry.job,
  }));
  const discoveryJobs = jobEntries(summary => summary.latestCompetitorDiscoveryJob || summary.latestAutomaticCompetitorDiscoveryJob);
  const extractionJobs = jobEntries(summary => summary.latestCompetitorExtractionJob || summary.latestAutomaticCompetitorExtractionJob);
  const preparationJobs = jobEntries(summary => (
    summary.latestContentWritingPreparationJob
    || summary.latestAutomaticContentWritingPreparationJob
  ));
  // Current-signature tasks include manual results and are deduplicated by
  // article + command. A success for a different command cannot clear a failure.
  const engineeringJobs: JobEntry[] = values.flatMap(summary => (
    summary.currentEngineeringJobs
      ? summary.currentEngineeringJobs.map(job => ({ articleId: summary.articleId, job }))
      : [{ articleId: summary.articleId, job: summary.latestEngineeringJob || summary.latestAutomaticEngineeringJob }]
  ));
  const semanticEnabled = {
    alternative_keywords: preference(effectivePreferences, 'autoGenerateAlternativeKeywords'),
    lsi_keywords: preference(effectivePreferences, 'autoGenerateLsiKeywords'),
    google_metadata: preference(effectivePreferences, 'autoGenerateGoogleMetadata'),
  } as const;
  const runningEngineeringCount = values.reduce(
    (sum, summary) => sum + (summary.currentEngineeringJobs
      ? summary.currentEngineeringJobs.filter(job => RUNNING_STATUSES.has(job.status)).length
      : summary.runningAutomaticEngineeringCount),
    0,
  );
  const waitingEngineeringCount = values.reduce(
    (sum, summary) => sum + (summary.currentEngineeringJobs
      ? summary.currentEngineeringJobs.filter(job => WAITING_STATUSES.has(job.status)).length
      : summary.waitingAutomaticEngineeringCount),
    0,
  );
  const completedEngineeringCount = values.reduce(
    (sum, summary) => sum + (summary.currentEngineeringJobs
      ? summary.currentEngineeringJobs.filter(job => job.status === 'completed'
        && !['superseded', 'automation_disabled'].includes(String(job.result?.status || job.progress?.stage))).length
      : summary.completedAutomaticEngineeringCount),
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
  const writingLastItemResolved = writingLastItem?.status === 'completed'
    || Boolean(writingLastItem?.resolvedBySessionId && writingLastItem.resolvedAt);
  const writingRecoveryScheduled = !writingLastItemResolved
    && writingLastItem?.status === 'blocked'
    && writingLastItem.failureClass === 'transient'
    && Boolean(writingLastItem.nextRecoveryAt);
  const writingCandidates = (writingOverview?.candidates || []).filter(candidate => (
    !writingLastItemResolved || candidate.articleId !== writingLastItem?.articleId
  ));
  const completedWritingArticles = new Set(values.filter(summary => {
    if (!summary.completedWritingSession || summary.articleId === writingOverview?.active?.articleId) return false;
    return summary.articleId !== writingLastItem?.articleId || writingLastItemResolved;
  }).map(summary => summary.articleId));
  if (writingLastItemResolved && writingLastItem) completedWritingArticles.add(writingLastItem.articleId);
  const minimumCompetitors = writingOverview?.settings.minimumCompetitors || 1;
  const writingCompetitorsReady = new Set(
    (writingOverview?.candidates || [])
      .filter(candidate => (candidate.readiness?.usableCompetitorCount || 0) >= minimumCompetitors)
      .map(candidate => candidate.articleId),
  );
  for (const item of [writingOverview?.active, writingLastItem]) {
    if (item && item.usableCompetitorCount >= minimumCompetitors) writingCompetitorsReady.add(item.articleId);
  }
  const unresolvedPreparationJobs = preparationJobs.filter(entry => {
    if (!entry.job) return false;
    const summary = competitorSummaryByArticle.get(entry.articleId);
    return !completedWritingArticles.has(entry.articleId)
      && !writingCompetitorsReady.has(entry.articleId)
      && (summary?.competitorReadyCount || 0) < minimumCompetitors;
  }) as Array<JobEntry & { job: ExternalAnalysisJobRow }>;
  const runningPreparationJobs = unresolvedPreparationJobs.filter(entry => RUNNING_STATUSES.has(entry.job.status));
  const waitingPreparationJobs = unresolvedPreparationJobs.filter(entry => WAITING_STATUSES.has(entry.job.status));
  const failedPreparationJobs = unresolvedPreparationJobs.filter(entry => FAILED_STATUSES.has(entry.job.status));
  const writingCounts = {
    runningCount: (writingOverview?.active ? 1 : 0) + runningPreparationJobs.length,
    waitingCount: writingCandidates.length + waitingPreparationJobs.length + (writingRecoveryScheduled ? 1 : 0),
    completedCount: completedWritingArticles.size,
    failedCount: (
      writingLastItem?.status === 'blocked' && !writingLastItemResolved && !writingRecoveryScheduled ? 1 : 0
    ) + failedPreparationJobs.length,
  };
  const writingStatus = operationStatus({ enabled: writingEnabled, ...writingCounts });
  const retryCandidate = !writingLastItemResolved && writingLastItem?.status === 'ready'
    ? writingCandidates.find(candidate => candidate.itemId === writingLastItem.id)
    : null;
  const writingCandidate = retryCandidate || writingCandidates[0];
  const preparationForStatus = [...unresolvedPreparationJobs]
    .filter(entry => {
      if (writingStatus === 'running') return RUNNING_STATUSES.has(entry.job.status);
      if (writingStatus === 'waiting') return WAITING_STATUSES.has(entry.job.status);
      if (writingStatus === 'attention') return FAILED_STATUSES.has(entry.job.status);
      return true;
    })
    .sort((left, right) => jobTime(right.job) - jobTime(left.job))[0]
    || null;
  const writingArticleId = writingOverview?.active?.articleId
    || preparationForStatus?.articleId
    || writingCandidate?.articleId
    || writingLastItem?.articleId
    || writingOverview?.state?.lastArticleId
    || [...completedWritingArticles][0]
    || null;
  const displayedWritingItem = writingOverview?.active
    || (writingLastItem?.articleId === writingArticleId ? writingLastItem : null);
  const displayedPreparationJob = !displayedWritingItem ? preparationForStatus?.job || null : null;
  const displayedWritingRecoveryScheduled = displayedWritingItem?.status === 'blocked'
    && displayedWritingItem.failureClass === 'transient'
    && Boolean(displayedWritingItem.nextRecoveryAt);
  const retryScheduled = writingStatus === 'waiting' && (
    Boolean(displayedPreparationJob?.status === 'retry_scheduled')
    || displayedWritingRecoveryScheduled
    || (Boolean(retryCandidate)
      && (displayedWritingItem?.attemptCount || 0) > 0
      && displayedWritingItem!.attemptCount < displayedWritingItem!.maxAttempts)
  );
  const retryTime = Math.max(
    Date.parse(displayedPreparationJob?.next_attempt_at || '') || 0,
    Date.parse(displayedWritingItem?.nextRecoveryAt || displayedWritingItem?.eligibleAt || '') || 0,
    Date.parse(writingOverview?.state?.nextAllowedAt || '') || 0,
  );
  const writingOperation: DashboardAutomationOperation = {
    key: 'content_writing',
    issueGroup: 'content_writing',
    issueIds: [
      ...(!writingRecoveryScheduled && writingLastItem?.status === 'blocked' && !writingLastItemResolved
        ? [`writing:${writingLastItem.id}`]
        : []),
      ...failedPreparationJobs.map(entry => `external:${entry.job.id}`),
    ],
    enabled: writingEnabled,
    status: writingStatus,
    ...writingCounts,
    articleId: writingArticleId,
    articleTitle: writingOverview?.active?.articleTitle
      || (preparationForStatus?.articleId
        ? articleSnapshots[preparationForStatus.articleId]?.title
          || articleTitles[preparationForStatus.articleId]
          || preparationForStatus.articleId
        : '')
      || writingCandidate?.articleTitle
      || writingLastItem?.articleTitle
      || (writingArticleId
        ? articleSnapshots[writingArticleId]?.title || articleTitles[writingArticleId] || writingArticleId
        : ''),
    latestJobStatus: writingLastItemResolved && writingLastItem?.articleId === writingArticleId && !writingOverview?.active
      ? 'resolved_current_state'
      : writingOverview?.active?.sessionStatus
      || writingOverview?.active?.status
      || displayedPreparationJob?.status
      || writingLastItem?.sessionStatus
      || writingLastItem?.status
      || String(writingOverview?.state?.lastOutcome || ''),
    errorCode: writingStatus === 'attention'
      ? displayedPreparationJob?.last_error_code || writingLastItem?.lastErrorCode || ''
      : '',
    errorMessage: writingStatus === 'attention'
      ? displayedPreparationJob?.last_error || writingLastItem?.lastError || ''
      : '',
    attemptCount: displayedPreparationJob?.attempt_count ?? displayedWritingItem?.attemptCount,
    maxAttempts: displayedPreparationJob?.max_attempts ?? displayedWritingItem?.maxAttempts,
    retryScheduled,
    retryAt: retryScheduled && retryTime > 0 ? new Date(retryTime).toISOString() : null,
    attemptsExhausted: writingStatus === 'attention' && (
      Boolean(displayedPreparationJob
        && displayedPreparationJob.attempt_count >= displayedPreparationJob.max_attempts)
      || Boolean(displayedWritingItem
        && displayedWritingItem.attemptCount >= displayedWritingItem.maxAttempts)
    ),
  };
  const linkedArticles = values.filter(summary => (summary.savedInternalLinkCount || 0) > 0);
  const linkingEnabled = preference(effectivePreferences, 'autoApplyStrongInternalLinkSuggestions');

  return [
    summarizeJobs(
      'alternative_keywords',
      semanticEnabled.alternative_keywords,
      semanticTargetJobs('needsSecondaries'),
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.alternativeKeywordsReady === true,
        hasSavedEvidence: articleId => Boolean(articleSnapshots[articleId]),
      },
    ),
    summarizeJobs(
      'lsi_keywords',
      semanticEnabled.lsi_keywords,
      semanticTargetJobs('needsLsi'),
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.lsiKeywordsReady === true,
        hasSavedEvidence: articleId => Boolean(articleSnapshots[articleId]),
      },
    ),
    summarizeJobs(
      'google_metadata',
      semanticEnabled.google_metadata,
      semanticTargetJobs('needsGoogleMetadata'),
      articleTitles,
      articleSnapshots,
      {
        issueGroup: 'semantic_generation',
        isResolved: articleId => articleSnapshots[articleId]?.googleMetadataReady === true,
        hasSavedEvidence: articleId => Boolean(articleSnapshots[articleId]),
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
        hasSavedEvidence: () => true,
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
        hasSavedEvidence: () => true,
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
      enabled: linkingEnabled,
      status: operationStatus({ enabled: linkingEnabled, runningCount: 0, waitingCount: 0,
        failedCount: 0, completedCount: linkedArticles.length }),
      runningCount: 0,
      waitingCount: 0,
      completedCount: linkedArticles.length,
      failedCount: 0,
      completedLinkCount: linkedArticles.reduce((total, summary) => total + summary.savedInternalLinkCount!, 0),
      articleId: linkedArticles[0]?.articleId || null,
      articleTitle: articleTitles[linkedArticles[0]?.articleId] || '',
      latestJobStatus: '',
      errorCode: '',
      errorMessage: '',
    },
  ];
};
