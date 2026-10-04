import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Clock3,
  AlertTriangle,
  Bot,
  Download,
  FileSearch,
  Link2,
  ListChecks,
  LoaderCircle,
  Play,
  Repeat,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Tags,
  XCircle,
} from 'lucide-react';
import type { GoalContext } from '../types';
import { useUser } from '../contexts/UserContext';
import {
  EXTERNAL_READY_COMMAND_DEFINITIONS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';
import {
  cancelAllExternalAnalysisJobs,
  cancelExternalAnalysisJob,
  ExternalAnalysisRequestError,
  enqueueExternalEngineeringAnalysis,
  enqueueExternalSemanticAnalysis,
  externalJobHasActiveStatus,
  getExternalMissingFieldLabels,
  type ExternalAnalysisDashboardSummary,
  useDefaultExternalEngineeringCommands,
} from '../utils/externalAnalysis';
import { ensureArticleCompetitorDiscovery } from '../utils/competitorDiscovery';
import { normalizeGoalContext } from '../utils/goalContext';
import {
  beginAiExecutionActivity,
  finishAiExecutionActivity,
  getAiExecutionActivities,
  removeAiExecutionActivity,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity';
import type { ContentWritingArticleSummary } from '../utils/contentWritingAutomation';
import {
  buildArticleAutomationStages,
  type ArticleAutomationStage,
  type ArticleAutomationStageKey,
  type ArticleAutomationStageStatus,
} from '../utils/articleAutomationStages';

const CompetitorDiscoveryModal = React.lazy(() => import('./CompetitorDiscoveryModal'));

type NoticeState = {
  tone: 'success' | 'error' | 'info';
  message: string;
};

type RequirementStatus = 'met' | 'missing' | 'checking';

type RequirementItem = {
  field: string;
  status: RequirementStatus;
};

const SEMANTIC_REQUIREMENT_FIELDS = [
  'draft_status',
  'article_title',
  'primary_keyword',
  'goal_context',
  'company_name',
] as const;

const ENGINEERING_REQUIREMENT_FIELDS = [
  'draft_status',
  'article_title',
  'editor_text',
  'primary_keyword',
  'alternative_keywords',
  'lsi_keywords',
  'goal_context',
  'company_name',
  'competitor_content_or_url',
] as const;

const COMPETITOR_REQUIREMENT_FIELDS = [
  'draft_status',
  'article_title_or_primary_keyword',
  'company_name',
] as const;

const AUTO_GENERATED_ENGINEERING_FIELDS = new Set(['alternative_keywords', 'lsi_keywords']);

const AUTOMATION_STAGE_TONE: Record<ArticleAutomationStageStatus, string> = {
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  running: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  waiting: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200',
  partial: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  attention: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  not_started: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-600 dark:bg-gray-700/30 dark:text-gray-300',
};

const AutomationStageStateIcon: React.FC<{ status: ArticleAutomationStageStatus }> = ({ status }) => {
  if (status === 'completed') return <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-300" />;
  if (status === 'running') return <LoaderCircle size={12} className="animate-spin text-sky-600 dark:text-sky-300" />;
  if (status === 'waiting') return <Clock3 size={12} className="text-violet-600 dark:text-violet-300" />;
  if (status === 'partial') return <AlertTriangle size={12} className="text-amber-600 dark:text-amber-300" />;
  if (status === 'attention') return <XCircle size={12} className="text-red-600 dark:text-red-300" />;
  return <Circle size={11} className="text-gray-400 dark:text-gray-500" />;
};

const AutomationStageChip: React.FC<{
  stage: ArticleAutomationStage;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}> = ({ stage, icon, onClick, disabled = false }) => {
  const content = (
    <>
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      <span className="whitespace-nowrap">{stage.label}</span>
      <AutomationStageStateIcon status={stage.status} />
    </>
  );
  const className = `inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-black transition-colors ${AUTOMATION_STAGE_TONE[stage.status]} ${onClick ? 'hover:brightness-95' : ''} disabled:cursor-wait disabled:opacity-60`;
  const ariaLabel = `${stage.label}: ${stage.statusLabel}. ${stage.details}`;
  return (
    <span className="group/automation-stage relative inline-flex shrink-0">
      {onClick ? (
        <button type="button" onClick={onClick} disabled={disabled} className={className} aria-label={ariaLabel}>
          {content}
        </button>
      ) : (
        <span className={className} tabIndex={0} aria-label={ariaLabel}>
          {content}
        </span>
      )}
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full end-0 z-50 mb-2 w-64 translate-y-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-start text-[10px] font-semibold leading-5 text-gray-700 opacity-0 shadow-xl transition-all group-hover/automation-stage:visible group-hover/automation-stage:translate-y-0 group-hover/automation-stage:opacity-100 group-focus-within/automation-stage:visible group-focus-within/automation-stage:translate-y-0 group-focus-within/automation-stage:opacity-100 dark:border-[#454545] dark:bg-[#252525] dark:text-gray-200"
      >
        <strong className="block text-[11px]">{stage.label} — {stage.statusLabel}</strong>
        <span className="block font-medium text-gray-500 dark:text-gray-400">{stage.details}</span>
      </span>
    </span>
  );
};

interface ExternalAnalysisCardControlsProps {
  articleId: string;
  articleTitle: string;
  articleStatus: string;
  primaryKeyword: string;
  alternativeKeywords?: string[];
  companyName: string;
  articleLanguage: 'ar' | 'en';
  goalContext?: GoalContext;
  hasAlternativeKeywords: boolean;
  hasLsiKeywords: boolean;
  googleMetadataReady: boolean;
  contentWritingSummary?: ContentWritingArticleSummary;
  summary?: ExternalAnalysisDashboardSummary;
  onRefresh: () => Promise<void> | void;
}

const ExternalAnalysisCardControls: React.FC<ExternalAnalysisCardControlsProps> = ({
  articleId,
  articleTitle,
  articleStatus,
  primaryKeyword,
  alternativeKeywords = [],
  companyName,
  articleLanguage,
  goalContext,
  hasAlternativeKeywords,
  hasLsiKeywords,
  googleMetadataReady,
  contentWritingSummary,
  summary,
  onRefresh,
}) => {
  const { t } = useUser();
  const locale = t.locale === 'en' ? 'en' : 'ar';
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCommandIds, setSelectedCommandIds] = useState<string[]>([]);
  const [requirementsOpen, setRequirementsOpen] = useState<'semantic' | 'engineering' | 'competitor' | null>(null);
  const [busyAction, setBusyAction] = useState<'semantic' | 'engineering' | 'competitor' | 'default' | 'cancel' | null>(null);
  const [competitorModalOpen, setCompetitorModalOpen] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const resolvedGoalContext: GoalContext = normalizeGoalContext(goalContext);

  const commands = useMemo(() => EXTERNAL_READY_COMMAND_DEFINITIONS.map(definition => ({
    id: definition.id,
    label: (t.rightSidebar as any)?.[definition.labelKey]
      || getExternalReadyCommandLabel(definition.id, locale),
  })), [locale, t.rightSidebar]);

  const semanticJobActive = externalJobHasActiveStatus(summary?.latestSemanticJob);
  const metaDescriptionJobActive = externalJobHasActiveStatus(summary?.latestMetaDescriptionJob);
  const engineeringActive = (summary?.activeEngineeringCount || 0) > 0;
  const competitorDiscoveryActive = externalJobHasActiveStatus(summary?.latestCompetitorDiscoveryJob);
  const competitorExtractionActive = externalJobHasActiveStatus(summary?.latestCompetitorExtractionJob);
  const competitorJobActive = competitorDiscoveryActive || competitorExtractionActive;
  const customCommandMode = summary?.state?.engineering_command_mode === 'custom';
  // Dashboard requirement checks are intentionally a draft-only editing aid.
  // Active jobs remain synchronized below even if the article status changes.
  const requirementsEnabled = articleStatus === 'draft';

  useEffect(() => {
    const syncJob = (
      kind: 'semantic' | 'meta-description' | 'engineering' | 'competitor-discovery' | 'competitor-extraction',
      active: boolean,
      job: ExternalAnalysisDashboardSummary['latestSemanticJob'],
    ) => {
      if (!job) return;
      const activityId = `external-analysis:${job.id}`;
      const existingActivity = getAiExecutionActivities().find(activity => activity.id === activityId);
      const jobUpdatedAt = new Date(job.updated_at).getTime();
      const activityCompletedAt = existingActivity?.completedAt
        ? new Date(existingActivity.completedAt).getTime()
        : Number.NaN;
      const serverRevisionIsNewer = Boolean(
        existingActivity
        && existingActivity.state !== 'running'
        && Number.isFinite(jobUpdatedAt)
        && (!Number.isFinite(activityCompletedAt) || jobUpdatedAt > activityCompletedAt)
      );
      const action = kind === 'engineering'
        ? ((summary?.activeEngineeringCount || 0) > 1
            ? `حزمة الأوامر الهندسية (${summary?.activeEngineeringCount})`
            : job.command_label || 'الأوامر اليدوية الجاهزة')
        : kind === 'semantic'
          ? 'توليد الصيغ وLSI ومقترحات Google'
          : kind === 'meta-description'
            ? 'كتابة وصف الميتا'
          : kind === 'competitor-discovery'
            ? 'بحث المنافسين'
            : 'سحب محتوى المنافسين';
      const requestedProvider = kind === 'semantic' || kind === 'meta-description' || kind === 'engineering'
        ? 'gemini'
        : 'crawler';
      const fallbackMessage = kind === 'semantic'
        ? 'جار توليد الصيغ البديلة وكلمات LSI...'
        : kind === 'meta-description'
          ? 'جار كتابة وصف الميتا تلقائيًا...'
        : kind === 'engineering'
          ? 'جار تنفيذ الأمر الهندسي...'
          : kind === 'competitor-discovery'
            ? 'جار البحث الخارجي عن المنافسين...'
            : 'جار سحب محتوى المنافسين...';
      const activityContext = {
        articleId,
        articleTitle,
        commandId: job.command_id || undefined,
        surface: job.job_type || (kind === 'semantic'
          ? 'semantic_keywords_lsi'
          : kind === 'engineering'
            ? 'engineering_command'
            : kind === 'competitor-discovery'
              ? 'competitor_discovery'
              : 'competitor_extraction'),
        action,
        startedAt: job.started_at || job.created_at,
        updatedAt: job.updated_at,
        ...(job.completed_at ? { completedAt: job.completed_at } : {}),
      };

      // Queue and prerequisite states belong to the automation-stage cards,
      // not to the live execution monitor. Keeping them in the shared activity
      // store makes an idle queue look busy and eventually raises a false
      // "no server updates" warning for work that has not started.
      if (active && job.status !== 'running') {
        if (existingActivity?.state === 'running') {
          removeAiExecutionActivity(activityId);
        }
        return;
      }

      if (active) {
        if (existingActivity && existingActivity.state !== 'running' && !serverRevisionIsNewer) return;
        if (!existingActivity || serverRevisionIsNewer) {
          beginAiExecutionActivity({
            id: activityId,
            ...activityContext,
            provider: requestedProvider,
            requestedProvider,
            stage: job.status,
            message: fallbackMessage,
            cancel: async () => {
              await cancelExternalAnalysisJob(articleId, job.id);
            },
          });
        }
        updateAiExecutionActivity(activityId, {
          ...activityContext,
          requestedProvider,
          stage: job.status,
          progress: job.progress,
          completed: false,
          message: typeof job.progress.message === 'string'
            ? job.progress.message
            : fallbackMessage,
          cancel: async () => {
            await cancelExternalAnalysisJob(articleId, job.id);
          },
        });
        return;
      }
      if (existingActivity?.state !== 'running') return;
      const outcome = job.status === 'completed'
        ? 'success'
        : job.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
      finishAiExecutionActivity(activityId, {
        ...activityContext,
        requestedProvider,
        stage: job.status,
        progress: job.progress,
        payload: job.result,
        outcome,
        message: job.last_error || undefined,
      });
    };

    syncJob('semantic', semanticJobActive, summary?.latestSemanticJob || null);
    syncJob('meta-description', metaDescriptionJobActive, summary?.latestMetaDescriptionJob || null);
    syncJob(
      'engineering',
      engineeringActive,
      engineeringActive
        ? summary?.activeEngineeringRootJob || summary?.latestEngineeringJob || null
        : summary?.latestEngineeringJob || null,
    );
    syncJob(
      'competitor-discovery',
      competitorDiscoveryActive,
      summary?.latestCompetitorDiscoveryJob || null,
    );
    syncJob(
      'competitor-extraction',
      competitorExtractionActive,
      summary?.latestCompetitorExtractionJob || null,
    );
  }, [
    articleId,
    articleTitle,
    competitorDiscoveryActive,
    competitorExtractionActive,
    engineeringActive,
    metaDescriptionJobActive,
    semanticJobActive,
    summary?.activeEngineeringCount,
    summary?.activeEngineeringRootJob,
    summary?.latestCompetitorDiscoveryJob,
    summary?.latestCompetitorExtractionJob,
    summary?.latestEngineeringJob,
    summary?.latestMetaDescriptionJob,
    summary?.latestSemanticJob,
  ]);

  const readinessState = requirementsEnabled ? summary?.state || null : null;
  const semanticMissingFields = new Set(requirementsEnabled
    ? readinessState?.semantic_missing_fields || []
    : []);
  const engineeringMissingFields = new Set(requirementsEnabled
    ? readinessState?.external_analysis_missing_fields || []
    : []);
  const competitorMissingFields = new Set(requirementsEnabled
    ? readinessState?.competitor_discovery_missing_fields || []
    : []);
  if (requirementsEnabled && !hasAlternativeKeywords) engineeringMissingFields.add('alternative_keywords');
  if (requirementsEnabled && !hasLsiKeywords) engineeringMissingFields.add('lsi_keywords');

  const semanticRequirements: RequirementItem[] = requirementsEnabled
    ? SEMANTIC_REQUIREMENT_FIELDS.map(field => ({
        field,
        status: readinessState
          ? (semanticMissingFields.has(field) ? 'missing' : 'met')
          : 'checking',
      }))
    : [];
  const engineeringRequirements: RequirementItem[] = requirementsEnabled
    ? ENGINEERING_REQUIREMENT_FIELDS.map(field => ({
        field,
        status: field === 'alternative_keywords'
          ? (hasAlternativeKeywords ? 'met' : 'missing')
          : field === 'lsi_keywords'
            ? (hasLsiKeywords ? 'met' : 'missing')
            : readinessState
              ? (engineeringMissingFields.has(field) ? 'missing' : 'met')
              : 'checking',
      }))
    : [];
  const competitorRequirements: RequirementItem[] = requirementsEnabled
    ? COMPETITOR_REQUIREMENT_FIELDS.map(field => ({
        field,
        status: readinessState
          ? (competitorMissingFields.has(field) ? 'missing' : 'met')
          : 'checking',
      }))
    : [];
  const semanticCanStart = Boolean(
    requirementsEnabled
    &&
    readinessState
    && semanticRequirements.every(requirement => requirement.status === 'met'),
  );
  const engineeringCanQueue = Boolean(
    requirementsEnabled
    &&
    readinessState
    && engineeringRequirements.every(requirement => (
      requirement.status === 'met' || AUTO_GENERATED_ENGINEERING_FIELDS.has(requirement.field)
    )),
  );
  const competitorCanStart = Boolean(
    requirementsEnabled
    &&
    readinessState
    && competitorRequirements.every(requirement => requirement.status === 'met'),
  );
  const engineeringArticleTextMissing = engineeringMissingFields.has('editor_text');
  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, []);

  useEffect(() => {
    setSelectedCommandIds([]);
    setMenuOpen(false);
    setRequirementsOpen(null);
    setCompetitorModalOpen(false);
    setNotice(null);
  }, [articleId]);

  useEffect(() => {
    if (requirementsEnabled) return;
    setSelectedCommandIds([]);
    setMenuOpen(false);
    setRequirementsOpen(null);
    setCompetitorModalOpen(false);
    setNotice(null);
  }, [requirementsEnabled]);

  useEffect(() => {
    if (
      menuOpen
      || selectedCommandIds.length > 0
      || summary?.state?.engineering_command_mode !== 'custom'
    ) return;
    const activeCommandIds = new Set(commands.map(command => command.id));
    setSelectedCommandIds(
      (summary.state.custom_engineering_command_ids || []).filter(commandId => activeCommandIds.has(commandId)),
    );
  }, [
    menuOpen,
    selectedCommandIds.length,
    summary?.state?.custom_engineering_command_ids,
    summary?.state?.engineering_command_mode,
    commands,
  ]);

  const formatRequestError = (error: unknown): string => {
    if (error instanceof ExternalAnalysisRequestError) {
      if (error.missingFields.length > 0) {
        const fields = getExternalMissingFieldLabels(error.missingFields, locale).join('، ');
        return locale === 'ar'
          ? `لا يمكن بدء التحليل. أكمل: ${fields}.`
          : `Analysis cannot start. Complete: ${fields}.`;
      }
      if (error.code === 'commands_already_active') {
        return locale === 'ar'
          ? 'يوجد أمر محدد قيد التنفيذ أو بانتظار إعادة المحاولة.'
          : 'A selected command is already active or waiting for retry.';
      }
      if (error.code === 'semantic_already_active') {
        return locale === 'ar'
          ? 'مهمة الصيغ البديلة وLSI موجودة وتعمل في الخلفية.'
          : 'The alternatives and LSI task is already running in the background.';
      }
      if (error.code === 'article_analysis_forbidden') {
        return locale === 'ar'
          ? 'يجب حجز المقالة أو امتلاكها قبل تشغيل التحليل.'
          : 'Claim or own the article before starting analysis.';
      }
      return error.message;
    }
    return error instanceof Error
      ? error.message
      : locale === 'ar'
        ? 'تعذر تعيين مهمة التحليل.'
        : 'Could not enqueue the analysis task.';
  };

  const refreshAfterRequest = async () => {
    await onRefresh();
    window.setTimeout((): void => { void onRefresh(); }, 800);
  };

  const handleCompetitors = async () => {
    if (!competitorCanStart) {
      setRequirementsOpen('competitor');
      return;
    }

    setCompetitorModalOpen(true);
    setNotice(null);
    if (summary?.latestCompetitorDiscoveryJob || busyAction) return;

    setBusyAction('competitor');
    try {
      await ensureArticleCompetitorDiscovery(articleId);
      await refreshAfterRequest();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error
          ? error.message
          : locale === 'ar'
            ? 'تعذر تعيين مهمة اكتشاف المنافسين.'
            : 'Could not enqueue competitor discovery.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSemantic = async () => {
    if (busyAction || semanticJobActive || !semanticCanStart) return;
    setBusyAction('semantic');
    setNotice(null);
    try {
      const result = await enqueueExternalSemanticAnalysis(articleId);
      const message = result.alreadyReady
        ? (locale === 'ar' ? 'الصيغ وLSI ومقترحات Google جاهزة بالفعل.' : 'Alternatives, LSI, and Google metadata are already ready.')
        : result.alreadyActive
          ? (locale === 'ar' ? 'مهمة التوليد موجودة وتعمل في الخلفية.' : 'The generation task is already running in the background.')
          : (locale === 'ar' ? 'تم تعيين مهمة توليد الصيغ وLSI ومقترحات Google.' : 'Alternatives, LSI, and Google metadata task queued.');
      setNotice({ tone: 'success', message });
      await refreshAfterRequest();
    } catch (error) {
      setNotice({ tone: 'error', message: formatRequestError(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const toggleCommand = (commandId: string) => {
    setSelectedCommandIds(current => current.includes(commandId)
      ? current.filter(item => item !== commandId)
      : [...current, commandId]);
  };

  const handleEngineering = async () => {
    if (busyAction || selectedCommandIds.length === 0 || !engineeringCanQueue) return;
    const orderedCommandIds = commands
      .filter(command => selectedCommandIds.includes(command.id))
      .map(command => command.id);
    setBusyAction('engineering');
    setNotice(null);
    try {
      const result = await enqueueExternalEngineeringAnalysis(articleId, orderedCommandIds);
      setNotice({
        tone: 'success',
        message: result.semanticPrerequisiteQueued
          ? (locale === 'ar'
              ? `تم تعيين توليد الصيغ وLSI ومقترحات Google أولاً، ثم ${orderedCommandIds.length} أمر بالتتابع.`
              : `Alternatives, LSI, and Google metadata were queued first, followed by ${orderedCommandIds.length} command(s).`)
          : (locale === 'ar'
              ? `تم تعيين ${orderedCommandIds.length} أمر بالتتابع في الخلفية.`
              : `${orderedCommandIds.length} command(s) queued sequentially in the background.`),
      });
      setSelectedCommandIds([]);
      setMenuOpen(false);
      await refreshAfterRequest();
    } catch (error) {
      setNotice({ tone: 'error', message: formatRequestError(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleUseDefaultCommands = async () => {
    if (busyAction || !customCommandMode) return;
    setBusyAction('default');
    setNotice(null);
    try {
      await useDefaultExternalEngineeringCommands(articleId);
      setSelectedCommandIds([]);
      setMenuOpen(false);
      setNotice({
        tone: 'success',
        message: locale === 'ar'
          ? 'عادت المقالة إلى أوامر التحليل الخارجي الافتراضية التي حددها الأدمن.'
          : 'This article now uses the admin default external analysis commands.',
      });
      await refreshAfterRequest();
    } catch (error) {
      setNotice({ tone: 'error', message: formatRequestError(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelAll = async () => {
    if (busyAction || (!semanticJobActive && !engineeringActive && !competitorJobActive)) return;
    setBusyAction('cancel');
    setNotice(null);
    try {
      const result = await cancelAllExternalAnalysisJobs(articleId);
      const cancelledCount = Number(result.cancelledCount || 0);
      setNotice({
        tone: 'success',
        message: locale === 'ar'
          ? `تم طلب إيقاف ${cancelledCount} مهمة خلفية لهذه المقالة.`
          : `Cancellation requested for ${cancelledCount} background task(s) for this article.`,
      });
      setSelectedCommandIds([]);
      setMenuOpen(false);
      await refreshAfterRequest();
    } catch (error) {
      setNotice({ tone: 'error', message: formatRequestError(error) });
    } finally {
      setBusyAction(null);
    }
  };

  const activeRequirements = requirementsOpen === 'semantic'
    ? semanticRequirements
    : requirementsOpen === 'engineering'
      ? engineeringRequirements
      : requirementsOpen === 'competitor'
        ? competitorRequirements
        : [];
  const activeMetCount = activeRequirements.filter(requirement => requirement.status === 'met').length;
  const activeMissingCount = activeRequirements.filter(requirement => requirement.status === 'missing').length;
  const activeCheckingCount = activeRequirements.filter(requirement => requirement.status === 'checking').length;

  const toggleRequirements = (type: 'semantic' | 'engineering' | 'competitor') => {
    setRequirementsOpen(current => current === type ? null : type);
  };
  const automationStages = buildArticleAutomationStages({
    summary,
    contentWritingSummary,
    hasAlternativeKeywords,
    hasLsiKeywords,
    googleMetadataReady,
    locale,
  });
  const automationStageByKey = new Map<ArticleAutomationStageKey, ArticleAutomationStage>(
    automationStages.map(stage => [stage.key, stage]),
  );
  const getAutomationStage = (key: ArticleAutomationStageKey): ArticleAutomationStage => (
    automationStageByKey.get(key)!
  );
  const handleSemanticStageClick = () => {
    if (!semanticCanStart) {
      toggleRequirements('semantic');
      return;
    }
    void handleSemantic();
  };

  return (
    <div
      className="relative mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3a3a3a]"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5" aria-label={locale === 'ar' ? 'مسار أتمتة المقالة' : 'Article automation workflow'}>
        <div
          data-analysis-control-group="semantic"
          role="group"
          aria-label={locale === 'ar' ? 'توليد الصيغ وLSI وبيانات Google' : 'Alternative forms, LSI, and Google metadata'}
          className="contents"
        >
          <AutomationStageChip
            stage={getAutomationStage('alternative_keywords')}
            icon={<Tags size={12} />}
            onClick={requirementsEnabled ? handleSemanticStageClick : undefined}
            disabled={Boolean(busyAction || semanticJobActive)}
          />
          <AutomationStageChip
            stage={getAutomationStage('lsi_keywords')}
            icon={<Sparkles size={12} />}
            onClick={requirementsEnabled ? handleSemanticStageClick : undefined}
            disabled={Boolean(busyAction || semanticJobActive)}
          />
          <AutomationStageChip
            stage={getAutomationStage('google_metadata')}
            icon={<FileSearch size={12} />}
            onClick={requirementsEnabled ? handleSemanticStageClick : undefined}
            disabled={Boolean(busyAction || semanticJobActive)}
          />
        </div>

        <div
          data-analysis-control-group="competitor"
          role="group"
          aria-label={locale === 'ar' ? 'المنافسون واستخراج نصوصهم' : 'Competitors and content extraction'}
          className="contents"
        >
          <AutomationStageChip
            stage={getAutomationStage('competitor_discovery')}
            icon={<Search size={12} />}
            onClick={requirementsEnabled ? () => { void handleCompetitors(); } : undefined}
            disabled={busyAction === 'competitor'}
          />
          <AutomationStageChip
            stage={getAutomationStage('competitor_extraction')}
            icon={<Download size={12} />}
            onClick={requirementsEnabled ? () => { void handleCompetitors(); } : undefined}
            disabled={busyAction === 'competitor'}
          />
        </div>

        <div
          data-analysis-control-group="engineering"
          role="group"
          aria-label={locale === 'ar' ? 'التدقيقات الخارجية والأوامر الجاهزة' : 'External audits and ready commands'}
          className="contents"
        >
          <div ref={menuRef} className="relative inline-flex">
            <AutomationStageChip
              stage={getAutomationStage('external_analysis')}
              icon={<ListChecks size={12} />}
              onClick={requirementsEnabled ? () => setMenuOpen(open => !open) : undefined}
              disabled={busyAction === 'engineering'}
            />
            {menuOpen && (
              <div className="editor-menu absolute end-0 top-full z-40 mt-1 w-[min(19rem,calc(100vw-2rem))] rounded-md border border-gray-200 bg-white p-1.5 shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-gray-100 px-1 pb-1.5 text-[10px] font-black text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">
                  <span>{locale === 'ar' ? 'اختر التدقيقات المطلوب تشغيلها' : 'Choose audits to run'}</span>
                  <button type="button" onClick={() => toggleRequirements('engineering')} className="text-[#8a6f1d] dark:text-[#f2d675]">
                    {locale === 'ar' ? 'عرض الشروط' : 'Requirements'}
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto custom-scrollbar">
                  {commands.map(command => {
                    const selected = selectedCommandIds.includes(command.id);
                    return (
                      <button
                        key={command.id}
                        type="button"
                        onClick={() => toggleCommand(command.id)}
                        data-selected={selected}
                        className={`editor-menu-item flex w-full items-center gap-2 rounded px-2 py-2.5 text-start text-[11px] font-semibold ${selected ? 'bg-[#d4af37]/15 text-[#8a6f1d] dark:text-[#f2d675]' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-[#333]'}`}
                      >
                        <input type="checkbox" checked={selected} readOnly tabIndex={-1} className="rounded text-[#d4af37] focus:ring-[#d4af37]" />
                        <span className="min-w-0 flex-1 leading-5">{command.label}</span>
                      </button>
                    );
                  })}
                </div>
                {!engineeringCanQueue && (
                  <div className="mt-1.5 border-t border-red-100 pt-1.5 text-[10px] font-bold text-red-600 dark:border-red-900/40 dark:text-red-300">
                    {engineeringArticleTextMissing
                      ? (locale === 'ar'
                          ? 'لا يمكن تشغيل الحزمة قبل أن يحتوي نص المقالة المحفوظ على أكثر من 100 كلمة.'
                          : 'The bundle requires more than 100 saved article words before it can run.')
                      : (locale === 'ar'
                          ? 'توجد شروط أساسية ناقصة. افتح الشروط لمعرفة التفاصيل.'
                          : 'Core requirements are missing. Open requirements for details.')}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleEngineering}
                  disabled={selectedCommandIds.length === 0 || Boolean(busyAction) || !engineeringCanQueue}
                  className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 text-[11px] font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play size={12} />
                  {locale === 'ar' ? 'تشغيل المحدد' : 'Run selected'}
                </button>
                {customCommandMode && (
                  <button
                    type="button"
                    onClick={() => void handleUseDefaultCommands()}
                    disabled={Boolean(busyAction)}
                    className="mt-1 flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#f2d675] dark:hover:bg-[#d4af37]/15"
                  >
                    {busyAction === 'default'
                      ? <LoaderCircle size={12} className="animate-spin" />
                      : <RotateCcw size={12} />}
                    <span>{locale === 'ar' ? 'استخدام أوامر الأدمن الافتراضية' : 'Use admin defaults'}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <AutomationStageChip stage={getAutomationStage('content_writing')} icon={<Bot size={12} />} />
        <AutomationStageChip stage={getAutomationStage('duplicate_suggestions')} icon={<Repeat size={12} />} />
        <AutomationStageChip stage={getAutomationStage('internal_linking')} icon={<Link2 size={12} />} />

        {(semanticJobActive || engineeringActive || competitorJobActive) && (
          <button
            type="button"
            onClick={() => void handleCancelAll()}
            disabled={Boolean(busyAction)}
            className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-black text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/10"
            title={locale === 'ar' ? 'إيقاف مهام التحليل الخارجي لهذه المقالة' : 'Stop external analysis tasks for this article'}
          >
            {busyAction === 'cancel' ? <LoaderCircle size={12} className="animate-spin" /> : <Square size={10} fill="currentColor" />}
            <span>{locale === 'ar' ? 'إيقاف الكل' : 'Stop all'}</span>
          </button>
        )}
      </div>

      {requirementsEnabled && requirementsOpen && (
        <div className="mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3C3C3C]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-black text-gray-700 dark:text-gray-200">
              {requirementsOpen === 'semantic'
                ? (locale === 'ar' ? 'شروط توليد الصيغ وLSI' : 'Alternatives and LSI requirements')
                : requirementsOpen === 'engineering'
                  ? (locale === 'ar' ? 'شروط الأوامر اليدوية الجاهزة' : 'Ready command requirements')
                  : (locale === 'ar' ? 'شروط اكتشاف المنافسين' : 'Competitor discovery requirements')}
            </div>
            <div className="text-[10px] font-bold text-gray-500 dark:text-gray-400">
              {activeCheckingCount > 0
                ? (locale === 'ar' ? `جار التحقق من ${activeCheckingCount} شروط` : `Checking ${activeCheckingCount} requirements`)
                : locale === 'ar'
                  ? `${activeMetCount} محققة · ${activeMissingCount} ناقصة`
                  : `${activeMetCount} met · ${activeMissingCount} missing`}
            </div>
          </div>
          <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {activeRequirements.map(requirement => (
              <div
                key={`${requirementsOpen}-${requirement.field}`}
                className={`flex min-w-0 items-center gap-1.5 text-[10px] font-bold ${requirement.status === 'met' ? 'text-emerald-600 dark:text-emerald-300' : requirement.status === 'missing' ? 'text-red-600 dark:text-red-300' : 'text-gray-400'}`}
              >
                {requirement.status === 'met'
                  ? <CheckCircle2 size={12} className="shrink-0" />
                  : requirement.status === 'missing'
                    ? <XCircle size={12} className="shrink-0" />
                    : <LoaderCircle size={12} className="shrink-0 animate-spin" />}
                <span className="min-w-0 break-words">
                  {getExternalMissingFieldLabels([requirement.field], locale)[0] || requirement.field}
                </span>
                {requirementsOpen === 'engineering'
                  && AUTO_GENERATED_ENGINEERING_FIELDS.has(requirement.field)
                  && requirement.status === 'missing' && (
                    <span className="shrink-0 text-[9px] text-amber-600 dark:text-amber-300">
                      {locale === 'ar' ? 'سيولد أولًا' : 'Auto-generated first'}
                    </span>
                  )}
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`mt-1 text-[10px] font-bold leading-5 ${notice.tone === 'error' ? 'text-red-600 dark:text-red-300' : notice.tone === 'success' ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {notice.message}
        </div>
      )}

      <React.Suspense fallback={null}>
        {requirementsEnabled && competitorModalOpen && (
          <CompetitorDiscoveryModal
            articleId={articleId}
            articleTitle={articleTitle}
            primaryKeyword={primaryKeyword}
            alternativeKeywords={alternativeKeywords}
            companyName={companyName}
            articleLanguage={articleLanguage}
            goalContext={resolvedGoalContext}
            locale={locale}
            onClose={() => {
              setCompetitorModalOpen(false);
              void onRefresh();
            }}
          />
        )}
      </React.Suspense>
    </div>
  );
};

export default ExternalAnalysisCardControls;
