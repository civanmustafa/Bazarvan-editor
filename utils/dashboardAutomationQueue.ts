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

export type DashboardAutomationOperation = {
  key: DashboardAutomationOperationKey;
  enabled: boolean | null;
  status: DashboardAutomationOperationStatus;
  runningCount: number;
  waitingCount: number;
  completedCount: number;
  failedCount: number;
  articleId: string | null;
  articleTitle: string;
  latestJobStatus: string;
  readyItemCount?: number;
  totalItemCount?: number;
};

type BuildOptions = {
  summaries: Record<string, ExternalAnalysisDashboardSummary>;
  writingOverview: ContentWritingAutomationOverview | null;
  effectivePreferences: UserAutomationPreferences | null;
  articleTitles: Record<string, string>;
};

const RUNNING_STATUSES = new Set<ExternalAnalysisJobStatus>(['running']);
const WAITING_STATUSES = new Set<ExternalAnalysisJobStatus>([
  'waiting_for_prerequisites',
  'queued',
  'retry_scheduled',
  'paused',
]);
const FAILED_STATUSES = new Set<ExternalAnalysisJobStatus>(['failed', 'blocked', 'cancelled']);

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
  jobs: Array<ExternalAnalysisJobRow | null>,
  articleTitles: Record<string, string>,
  overrides: Partial<Pick<DashboardAutomationOperation,
    'runningCount' | 'waitingCount' | 'completedCount' | 'failedCount' | 'readyItemCount' | 'totalItemCount'>> = {},
): DashboardAutomationOperation => {
  const availableJobs = jobs.filter((job): job is ExternalAnalysisJobRow => Boolean(job));
  const latest = [...availableJobs].sort((left, right) => jobTime(right) - jobTime(left))[0] || null;
  const counts = {
    runningCount: availableJobs.filter(job => RUNNING_STATUSES.has(job.status)).length,
    waitingCount: availableJobs.filter(job => WAITING_STATUSES.has(job.status)).length,
    completedCount: availableJobs.filter(job => job.status === 'completed').length,
    failedCount: availableJobs.filter(job => FAILED_STATUSES.has(job.status)).length,
    ...overrides,
  };
  return {
    key,
    enabled,
    status: operationStatus({ enabled, ...counts }),
    ...counts,
    articleId: latest?.article_id || null,
    articleTitle: latest ? articleTitles[latest.article_id] || latest.article_id : '',
    latestJobStatus: latest?.status || '',
  };
};

const preference = (
  preferences: UserAutomationPreferences | null,
  key: keyof UserAutomationPreferences,
): boolean | null => preferences ? preferences[key] === true : null;

const outcomeCount = (value: string | null | undefined, pattern: RegExp): number => (
  pattern.test(String(value || '').trim().toLowerCase()) ? 1 : 0
);

export const buildDashboardAutomationOperations = ({
  summaries,
  writingOverview,
  effectivePreferences,
  articleTitles,
}: BuildOptions): DashboardAutomationOperation[] => {
  const values = Object.values(summaries);
  const semanticJobs = values.map(summary => summary.latestAutomaticSemanticJob);
  const discoveryJobs = values.map(summary => summary.latestAutomaticCompetitorDiscoveryJob);
  const extractionJobs = values.map(summary => summary.latestAutomaticCompetitorExtractionJob);
  const engineeringJobs = values.map(summary => summary.latestAutomaticEngineeringJob);
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

  const writingEnabledPreference = preference(effectivePreferences, 'contentWritingAutomationEnabled');
  const writingEnabled = writingEnabledPreference === null
    ? (writingOverview ? writingOverview.settings.enabled : null)
    : writingEnabledPreference && (writingOverview?.settings.enabled ?? true);
  const writingLastOutcome = writingOverview?.state?.lastOutcome;
  const writingCounts = {
    runningCount: writingOverview?.active ? 1 : 0,
    waitingCount: writingOverview?.candidates.length || 0,
    completedCount: outcomeCount(writingLastOutcome, /complete|success/),
    failedCount: outcomeCount(writingLastOutcome, /fail|block|error/),
  };
  const writingArticleId = writingOverview?.active?.articleId
    || writingOverview?.candidates[0]?.articleId
    || writingOverview?.state?.lastArticleId
    || null;
  const writingOperation: DashboardAutomationOperation = {
    key: 'content_writing',
    enabled: writingEnabled,
    status: operationStatus({ enabled: writingEnabled, ...writingCounts }),
    ...writingCounts,
    articleId: writingArticleId,
    articleTitle: writingOverview?.active?.articleTitle
      || writingOverview?.candidates[0]?.articleTitle
      || (writingArticleId ? articleTitles[writingArticleId] || writingArticleId : ''),
    latestJobStatus: writingOverview?.active?.sessionStatus
      || writingOverview?.active?.status
      || String(writingLastOutcome || ''),
  };

  return [
    summarizeJobs('alternative_keywords', semanticEnabled.alternative_keywords, semanticJobs, articleTitles),
    summarizeJobs('lsi_keywords', semanticEnabled.lsi_keywords, semanticJobs, articleTitles),
    summarizeJobs('google_metadata', semanticEnabled.google_metadata, semanticJobs, articleTitles),
    summarizeJobs(
      'competitor_discovery',
      preference(effectivePreferences, 'autoDiscoverCompetitors'),
      discoveryJobs,
      articleTitles,
      { readyItemCount: competitorReadyCount, totalItemCount: competitorTotalCount },
    ),
    summarizeJobs(
      'competitor_extraction',
      preference(effectivePreferences, 'autoExtractCompetitorContent'),
      extractionJobs,
      articleTitles,
      { readyItemCount: competitorReadyCount, totalItemCount: competitorTotalCount },
    ),
    summarizeJobs(
      'external_analysis',
      preference(effectivePreferences, 'autoRunReadyEngineeringCommands'),
      engineeringJobs,
      articleTitles,
      {
        runningCount: runningEngineeringCount,
        waitingCount: waitingEngineeringCount,
        completedCount: completedEngineeringCount,
      },
    ),
    writingOperation,
    {
      key: 'internal_linking',
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
    },
  ];
};
