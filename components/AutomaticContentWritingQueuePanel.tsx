import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Bot,
  ChartNoAxesCombined,
  Clock3,
  Download,
  ExternalLink,
  FilePenLine,
  Link2,
  ListTree,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Sparkles,
  Tags,
  PlayCircle,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { UserAutomationPreferences } from '../constants/userAutomation';
import { buildEditorArticlePath, navigateToAppPath } from '../utils/appRoutes';
import {
  getContentWritingAutomationErrorMessage,
  loadContentWritingAutomationStatus,
  resumeAutomaticArticleFocus,
  retryRecoverableAutomationFailures,
  skipAutomaticArticleFocus,
  type AutomationTaskInventoryItem,
  type ContentWritingAutomationOverview,
} from '../utils/contentWritingAutomation';
import {
  buildDashboardAutomationOperations,
  countDashboardAutomationIssues,
  type DashboardAutomationArticleSnapshot,
  type DashboardAutomationOperation,
  type DashboardAutomationOperationKey,
  type DashboardAutomationOperationStatus,
} from '../utils/dashboardAutomationQueue';
import type { ExternalAnalysisDashboardSummary } from '../utils/externalAnalysis';
import {
  beginAiExecutionActivity,
  finishAiExecutionActivity,
  getAiExecutionActivities,
  removeAiExecutionActivity,
} from '../utils/aiExecutionActivity';
import {
  loadUserAutomationPreferences,
  USER_AUTOMATION_CHANGED_EVENT,
} from '../utils/userAutomation';
import { DashboardAiExecutionMonitor } from './AiKeyUsageToast';

type Props = {
  isArabic: boolean;
  isAdmin: boolean;
  externalAnalysisSummaries?: Record<string, ExternalAnalysisDashboardSummary>;
  articleTitles?: Record<string, string>;
  articleSnapshots?: Record<string, DashboardAutomationArticleSnapshot>;
  onRefreshExternalAnalysis?: () => Promise<void> | void;
};

const OPERATION_PRESENTATION: Record<DashboardAutomationOperationKey, {
  icon: LucideIcon;
  label: [string, string];
  description: [string, string];
}> = {
  alternative_keywords: {
    icon: Sparkles,
    label: ['الصيغ البديلة', 'Alternative forms'],
    description: ['ضمن مهمة الدلالات الموحدة', 'Part of the unified semantic job'],
  },
  lsi_keywords: {
    icon: Tags,
    label: ['كلمات LSI', 'LSI keywords'],
    description: ['كلمات الموضوع والارتباط الدلالي', 'Topic and semantic terms'],
  },
  google_metadata: {
    icon: FilePenLine,
    label: ['عناوين وأوصاف Google', 'Google titles and descriptions'],
    description: ['اقتراحان للعنوان والوصف', 'Two title and description suggestions'],
  },
  competitor_discovery: {
    icon: Search,
    label: ['بحث المنافسين', 'Competitor discovery'],
    description: ['اكتشاف الروابط والتحقق من الاستهداف', 'Find links and verify targeting'],
  },
  competitor_extraction: {
    icon: Download,
    label: ['سحب نصوص المنافسين', 'Competitor text import'],
    description: ['السحب المباشر والمسارات الاحتياطية', 'Direct and fallback extraction paths'],
  },
  external_analysis: {
    icon: ChartNoAxesCombined,
    label: ['التحليل الخارجي', 'External analysis'],
    description: ['الأوامر الهندسية الجاهزة المختارة', 'Selected ready engineering commands'],
  },
  content_writing: {
    icon: Bot,
    label: ['كتابة المقالات', 'Article writing'],
    description: ['التجهيز والكتابة والمراجعة المرحلية', 'Preparation, writing, and staged review'],
  },
  duplicate_suggestions: {
    icon: ListTree,
    label: ['اقتراحات التكرار', 'Duplicate suggestions'],
    description: ['فحص العبارات العامة واقتراح تنقيتها', 'Inspect repeated generic phrases and suggest cleanup'],
  },
  internal_linking: {
    icon: Link2,
    label: ['الربط الداخلي المؤكد', 'Confirmed internal linking'],
    description: ['يُطبّق داخل المحرر عند تحقق شروط الثقة', 'Applied in the editor when confidence rules pass'],
  },
};

const OPERATION_STATUS_STYLE: Record<DashboardAutomationOperationStatus, string> = {
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200',
  waiting: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  attention: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200',
  ready: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
  disabled: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

const getOperationStatusLabel = (
  status: DashboardAutomationOperationStatus,
  isArabic: boolean,
): string => ({
  running: isArabic ? 'يعمل الآن' : 'Running',
  waiting: isArabic ? 'في الانتظار' : 'Waiting',
  attention: isArabic ? 'يحتاج مراجعة' : 'Needs review',
  completed: isArabic ? 'مكتمل' : 'Completed',
  ready: isArabic ? 'جاهز تلقائيًا' : 'Automation ready',
  disabled: isArabic ? 'متوقف' : 'Disabled',
  unknown: isArabic ? 'جار التحقق' : 'Checking',
})[status];

const getOperationErrorMessage = (
  operation: DashboardAutomationOperation,
  isArabic: boolean,
): string => {
  const raw = String(operation.errorMessage || operation.errorCode || '').trim();
  const normalized = `${operation.errorCode} ${raw}`.toLowerCase();
  if (/429|cooldown|quota|rate.?limit/.test(normalized)) {
    return isArabic
      ? 'بلغ مزود الذكاء الاصطناعي حد الاستخدام. راجع الحصة وأعد المحاولة بعد التهدئة.'
      : 'The AI provider reached its usage limit. Check the quota and retry after cooldown.';
  }
  if (/timeout|timed.?out/.test(normalized)) {
    return isArabic
      ? 'انتهت مهلة الاتصال بالمزود قبل اكتمال الطلب. افتح المقالة لإعادة المحاولة.'
      : 'The provider timed out before completion. Open the article to retry.';
  }
  if (operation.key === 'content_writing') {
    return getContentWritingAutomationErrorMessage(raw, isArabic);
  }
  if (raw) return raw;
  return isArabic
    ? 'لم تكتمل آخر محاولة وما زالت النتيجة المطلوبة ناقصة.'
    : 'The latest attempt did not complete and the required result is still missing.';
};

const TASK_STATUS_STYLE: Record<AutomationTaskInventoryItem['status'], string> = {
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200',
  scheduled: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  ready: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
  unscheduled: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200',
};

const getTaskStatusLabel = (task: AutomationTaskInventoryItem, isArabic: boolean): string => {
  if (task.manualReview && task.status === 'failed') {
    return isArabic ? 'تحتاج مراجعة' : 'Needs review';
  }
  return ({
    running: isArabic ? 'جارية الآن' : 'Running now',
    scheduled: isArabic ? 'مجدولة' : 'Scheduled',
    ready: isArabic ? 'جاهزة للتنفيذ' : 'Ready to run',
    unscheduled: isArabic ? 'بانتظار متطلبات' : 'Waiting for requirements',
    failed: isArabic ? 'متعثرة' : 'Failed',
  })[task.status];
};

const getTaskReasonLabel = (task: AutomationTaskInventoryItem, isArabic: boolean): string => {
  const reasonCode = String(task.reasonCode || '').trim();
  const known: Record<string, [string, string]> = {
    execution_in_progress: ['يتم تنفيذ هذه المهمة الآن.', 'This task is running now.'],
    waiting_for_prerequisites: ['بانتظار اكتمال المتطلبات', 'Waiting for prerequisites'],
    waiting_for_editor_idle: ['بانتظار مرور 15 دقيقة دون تحرير', 'Waiting for 15 minutes of editor inactivity'],
    waiting_for_queue_turn: ['بانتظار دورها في الطابور', 'Waiting for its queue turn'],
    eligible_not_scheduled: ['مستوفية للشروط وسيحجزها المحرك الرئيسي في الدورة التالية.', 'Eligible; the master engine will claim it on the next cycle.'],
    retry_scheduled: ['إعادة المحاولة مجدولة', 'Retry is scheduled'],
    automatic_article_focus: ['بانتظار اكتمال المقالة ذات الأولوية', 'Waiting for the focused article to finish'],
    automation_disabled: ['الأتمتة معطلة لهذه المقالة أو لمنشئها.', 'Automation is disabled for this article or its creator.'],
    manual_review_required: ['أوقفت تلقائيًا ونُقلت إلى المراجعة اليدوية. عالج السبب ثم استخدم الاستئناف.', 'Automatically paused for manual review. Resolve the cause, then resume it.'],
    automatic_recovery_exhausted: [
      `استنفدت دورات الاسترداد التلقائي (${task.recoveryCount}/${Math.max(task.maxRecoveries, task.recoveryCount)}). تحتاج مراجعة يدوية.`,
      `Automatic recovery cycles are exhausted (${task.recoveryCount}/${Math.max(task.maxRecoveries, task.recoveryCount)}). Manual review is required.`,
    ],
    retry_limit_reached: [
      `استنفدت محاولات التنفيذ (${task.attemptCount}/${task.maxAttempts}). عالج السبب ثم أعد المحاولة يدويًا.`,
      `Execution attempts are exhausted (${task.attemptCount}/${task.maxAttempts}). Resolve the cause, then retry manually.`,
    ],
    recovery_due: ['حان موعد الاسترداد؛ بانتظار دورة المحرك الرئيسي.', 'Recovery is due and is waiting for the master-engine cycle.'],
    competitor_preparation_running: ['يجري الآن تجهيز المنافسين المطلوبين للكتابة.', 'Required competitors are being prepared now.'],
    competitor_preparation_scheduled: ['تجهيز المنافسين مجدول ولم يبدأ بعد.', 'Competitor preparation is scheduled and has not started yet.'],
    competitor_preparation_exhausted: [
      `لم يُعثر على العدد المطلوب من المنافسين بعد ${task.attemptCount}/${task.maxAttempts} محاولات. أضف منافسًا صالحًا أو راجع المقالة يدويًا.`,
      `The required competitors were not found after ${task.attemptCount}/${task.maxAttempts} attempts. Add a valid competitor or review the article manually.`,
    ],
    missing_competitors: [
      `ينقص المقالة ${Math.max(0, task.minimumCompetitorCount - task.usableCompetitorCount)} منافس صالح (${task.usableCompetitorCount}/${task.minimumCompetitorCount}).`,
      `The article needs ${Math.max(0, task.minimumCompetitorCount - task.usableCompetitorCount)} more valid competitor(s) (${task.usableCompetitorCount}/${task.minimumCompetitorCount}).`,
    ],
    task_failed: ['فشلت آخر محاولة ولم تعد هناك جدولة فعالة.', 'The last attempt failed and no active schedule remains.'],
    superseded_by_manual_request: ['أوقفت الكتابة التلقائية لأن طلب كتابة يدويًا حلّ محلها.', 'Automatic writing was stopped because an explicit manual writing request replaced it.'],
    task_cancelled: ['ألغيت مهمة الكتابة التلقائية ولا توجد لها جدولة نشطة.', 'The automatic writing task was cancelled and has no active schedule.'],
  };
  if (known[reasonCode]) return known[reasonCode][isArabic ? 0 : 1];
  const rawReason = String(task.reason || '').trim();
  return rawReason;
};

const getFocusStageLabel = (stage: string | null, isArabic: boolean): string => {
  const labels: Record<string, [string, string]> = {
    preparation: ['تجهيز المدخلات', 'Preparing inputs'],
    semantic_keywords: ['الصيغ البديلة والدلالات وبيانات Google', 'Keywords, semantics, and Google metadata'],
    competitor_discovery: ['اكتشاف المنافسين', 'Discovering competitors'],
    competitor_extraction: ['سحب نصوص المنافسين', 'Extracting competitor text'],
    competitor_preparation: ['استكمال جاهزية المنافسين', 'Preparing competitor sources'],
    content_writing: ['كتابة المقالة', 'Writing the article'],
    duplicate_cleanup: ['إصلاح التكرارات', 'Cleaning duplicate phrases'],
    external_audits: ['التدقيقات الخارجية', 'Running external audits'],
    ready: ['جاهزة للعمل', 'Ready for work'],
  };
  const normalized = String(stage || '').trim();
  return labels[normalized]?.[isArabic ? 0 : 1]
    || (normalized || (isArabic ? 'تجهيز المدخلات' : 'Preparing inputs'));
};

const getFocusStateLabel = (state: string, isArabic: boolean): string => ({
  idle: isArabic ? 'المسار متاح' : 'Lane available',
  active: isArabic ? 'قيد التنفيذ' : 'In progress',
  waiting_retry: isArabic ? 'بانتظار إعادة المحاولة' : 'Waiting to retry',
  needs_attention: isArabic ? 'تحتاج مراجعة يدوية' : 'Manual review needed',
})[state] || state;

const taskDateDetails = (
  task: AutomationTaskInventoryItem,
  isArabic: boolean,
): { label: string; value: string } | null => {
  const source = task.status === 'running'
    ? task.startedAt
    : task.status === 'scheduled'
      ? task.scheduleAt
      : task.status === 'ready'
        ? task.readyAt
        : task.updatedAt;
  if (!source || !Number.isFinite(Date.parse(source))) return null;
  const label = task.status === 'running'
    ? (isArabic ? 'بدأت في' : 'Started at')
    : task.status === 'scheduled'
      ? (isArabic ? 'مؤهلة للتنفيذ في' : 'Eligible to run at')
      : task.status === 'ready'
        ? (isArabic ? 'جاهزة منذ' : 'Ready since')
        : (isArabic ? 'آخر تحديث' : 'Last updated');
  return { label, value: new Date(source).toLocaleString(isArabic ? 'ar' : 'en') };
};

const formatCountdown = (milliseconds: number, isArabic: boolean): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    ...(hours ? [`${hours}${isArabic ? 'س' : 'h'}`] : []),
    `${minutes}${isArabic ? 'د' : 'm'}`,
    `${remainingSeconds}${isArabic ? 'ث' : 's'}`,
  ].join(' ');
};

const AutomaticContentWritingQueuePanel: React.FC<Props> = ({
  isArabic,
  isAdmin,
  externalAnalysisSummaries = {},
  articleTitles = {},
  articleSnapshots = {},
  onRefreshExternalAnalysis,
}) => {
  const [overview, setOverview] = useState<ContentWritingAutomationOverview | null>(null);
  const [taskInventory, setTaskInventory] = useState<AutomationTaskInventoryItem[]>([]);
  const [taskScope, setTaskScope] = useState<'system' | 'accessible'>('accessible');
  const [expandedOperationKey, setExpandedOperationKey] = useState<DashboardAutomationOperationKey | null>(null);
  const [effectivePreferences, setEffectivePreferences] = useState<UserAutomationPreferences | null>(null);
  const [preferencesError, setPreferencesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [focusMutating, setFocusMutating] = useState(false);
  const [focusMessage, setFocusMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const refreshRequestRef = useRef(0);
  const modalCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!expandedOperationKey) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => modalCloseButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedOperationKey(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [expandedOperationKey]);

  const refresh = useCallback(async (silent = false) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (!silent) setLoading(true);
    try {
      const [statusResult, preferencesResult] = await Promise.allSettled([
        loadContentWritingAutomationStatus(undefined, { draftOnly: true }),
        loadUserAutomationPreferences(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      if (statusResult.status === 'fulfilled') {
        setOverview(statusResult.value.overview);
        setTaskInventory(statusResult.value.taskInventory);
        setTaskScope(statusResult.value.taskScope);
        setError('');
      } else {
        setError(statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason));
      }
      if (preferencesResult.status === 'fulfilled') {
        setEffectivePreferences(preferencesResult.value.effectivePreferences);
        setPreferencesError('');
      } else {
        setPreferencesError(isArabic
          ? 'تعذر تحديث تفضيلات بعض العمليات؛ ستبقى حالاتها الحية ظاهرة.'
          : 'Some automation preferences could not be refreshed; live task states remain visible.');
      }
    } finally {
      if (refreshRequestRef.current === requestId) setLoading(false);
    }
  }, [isArabic]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refresh]);

  useEffect(() => {
    const handleAutomationChange = (): void => { void refresh(true); };
    window.addEventListener(USER_AUTOMATION_CHANGED_EVENT, handleAutomationChange);
    return () => window.removeEventListener(USER_AUTOMATION_CHANGED_EVENT, handleAutomationChange);
  }, [refresh]);

  useEffect(() => {
    const active = overview?.active || null;
    const activeActivityId = active ? `automatic-writing:${active.id}` : '';
    const lastItemId = overview?.state?.lastItemId || '';
    const lastOutcome = String(overview?.state?.lastOutcome || '').trim().toLowerCase();
    const storedActivities = getAiExecutionActivities().filter(activity => (
      activity.state === 'running'
      && activity.id.startsWith('automatic-writing:')
    ));

    storedActivities.forEach(storedActivity => {
      if (storedActivity.id === activeActivityId) return;
      const itemId = storedActivity.id.slice('automatic-writing:'.length);
      if (itemId !== lastItemId || !lastOutcome) {
        removeAiExecutionActivity(storedActivity.id);
        return;
      }

      const outcome = lastOutcome.includes('cancel')
        ? 'cancelled'
        : lastOutcome.includes('complete') || lastOutcome.includes('success')
          ? 'success'
          : lastOutcome.includes('fail') || lastOutcome.includes('block') || lastOutcome.includes('error')
            ? 'failed'
            : null;
      if (!outcome) {
        removeAiExecutionActivity(storedActivity.id);
        return;
      }
      finishAiExecutionActivity(storedActivity.id, {
        articleId: storedActivity.articleId,
        articleTitle: storedActivity.articleTitle,
        provider: storedActivity.provider,
        requestedProvider: storedActivity.requestedProvider,
        model: storedActivity.model,
        requestedModel: storedActivity.requestedModel,
        surface: 'automatic_content_writing',
        stage: lastOutcome,
        outcome,
        payload: { lastOutcome },
      });
    });

    if (!active) return;
    beginAiExecutionActivity({
      id: activeActivityId,
      articleId: active.articleId,
      articleTitle: active.articleTitle,
      provider: active.provider,
      requestedProvider: active.provider,
      model: active.model,
      requestedModel: active.model,
      surface: 'automatic_content_writing',
      stage: active.sessionStatus || active.status,
      message: isArabic ? 'تعمل الكتابة التلقائية في الخلفية.' : 'Automatic writing is running in the background.',
      startedAt: active.startedAt || active.readyAt,
      completed: false,
      payload: active,
    });
  }, [isArabic, overview]);

  const cooldownMs = useMemo(() => {
    const value = overview?.state?.nextAllowedAt;
    return value ? Math.max(0, new Date(value).getTime() - now) : 0;
  }, [now, overview?.state?.nextAllowedAt]);
  const operations = useMemo(() => buildDashboardAutomationOperations({
    summaries: externalAnalysisSummaries,
    writingOverview: overview,
    effectivePreferences,
    articleTitles,
    articleSnapshots,
    taskInventory,
  }), [articleSnapshots, articleTitles, effectivePreferences, externalAnalysisSummaries, overview, taskInventory]);
  const expandedOperation = useMemo(() => (
    operations.find(operation => operation.key === expandedOperationKey) || null
  ), [expandedOperationKey, operations]);
  const operationCounts = useMemo(() => ({
    running: operations.filter(operation => operation.status === 'running').length,
    waiting: operations.filter(operation => operation.status === 'waiting').length,
    attention: countDashboardAutomationIssues(operations),
    enabled: operations.filter(operation => operation.enabled === true).length,
  }), [operations]);
  const hasRunnableWritingTask = useMemo(() => taskInventory.some(task => (
    task.operationKey === 'content_writing' && task.runnable && task.status === 'ready'
  )), [taskInventory]);

  const handleRefresh = () => {
    void refresh();
    void onRefreshExternalAnalysis?.();
  };

  const handleRecoverableRetry = async () => {
    if (!isAdmin || recovering) return;
    setRecovering(true);
    setRecoveryMessage('');
    try {
      const result = await retryRecoverableAutomationFailures({ draftOnly: true });
      setOverview(result.overview);
      setRecoveryMessage(isArabic
        ? `أُعيدت ${result.requeued.total} مهمة قابلة للاسترداد إلى الطابور (${result.requeued.externalAnalysis} تحليل، ${result.requeued.contentWriting} كتابة).`
        : `${result.requeued.total} recoverable tasks returned to the queue (${result.requeued.externalAnalysis} analysis, ${result.requeued.contentWriting} writing).`);
      await onRefreshExternalAnalysis?.();
      await refresh(true);
    } catch (requestError) {
      setRecoveryMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRecovering(false);
    }
  };

  const handleFocusMutation = async (action: 'skip' | 'resume') => {
    if (!isAdmin || focusMutating) return;
    setFocusMutating(true);
    setFocusMessage('');
    try {
      const focus = overview?.focus;
      const nextOverview = action === 'skip'
        ? await skipAutomaticArticleFocus({ draftOnly: true })
        : await resumeAutomaticArticleFocus(focus?.lastArticleId, { draftOnly: true });
      setOverview(nextOverview);
      setFocusMessage(action === 'skip'
        ? (isArabic
          ? 'نُقلت المقالة المركزة إلى المراجعة اليدوية، وأصبح المسار متاحًا للمقالة التالية.'
          : 'The focused article moved to manual review and the lane is available for the next article.')
        : (isArabic
          ? 'استؤنفت المقالة وعادت لتملك أولوية المسار حتى اكتمالها.'
          : 'The article resumed and owns the lane until it finishes.'));
      await onRefreshExternalAnalysis?.();
      await refresh(true);
    } catch (requestError) {
      setFocusMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setFocusMutating(false);
    }
  };

  const renderOperation = (operation: DashboardAutomationOperation) => {
    const presentation = OPERATION_PRESENTATION[operation.key];
    const OperationIcon = presentation.icon;
    const hasCounts = operation.runningCount > 0
      || operation.waitingCount > 0
      || operation.completedCount > 0
      || operation.failedCount > 0;
    const competitorProgress = operation.readyItemCount !== undefined && operation.totalItemCount !== undefined
      ? `${operation.readyItemCount}/${operation.totalItemCount}`
      : '';
    return (
      <div
        key={operation.key}
        className={`min-w-0 rounded-lg border p-2.5 text-start transition dark:border-[#444] ${expandedOperationKey === operation.key
          ? 'border-blue-400 bg-blue-50/60 dark:border-blue-700 dark:bg-blue-900/10'
          : 'border-gray-200'}`}
      >
        <span className="flex items-start justify-between gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-black text-gray-800 dark:text-gray-100">
            <OperationIcon size={14} className="shrink-0 text-blue-600 dark:text-blue-300" />
            <span className="line-clamp-2">{presentation.label[isArabic ? 0 : 1]}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-black ${OPERATION_STATUS_STYLE[operation.status]}`}>
              {operation.attemptsExhausted
                ? (isArabic ? 'استُنفدت المحاولات' : 'Attempts exhausted')
                : getOperationStatusLabel(operation.status, isArabic)}
            </span>
            <button
              type="button"
              onClick={() => setExpandedOperationKey(current => current === operation.key ? null : operation.key)}
              className="inline-flex items-center gap-0.5 rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[8px] font-black text-blue-600 hover:border-blue-300 dark:border-[#555] dark:bg-[#222] dark:text-blue-300"
              title={isArabic ? 'عرض المهام المتبقية وغير المكتملة' : 'Show remaining and incomplete tasks'}
              aria-haspopup="dialog"
              aria-expanded={expandedOperationKey === operation.key}
            >
              <ListTree size={11} />
              {operation.tasks?.length || 0}
            </button>
          </span>
        </span>
        <span className="mt-1.5 block text-[9px] font-semibold leading-4 text-gray-500 dark:text-gray-400">
          {presentation.description[isArabic ? 0 : 1]}
        </span>
        {hasCounts ? (
          <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[9px] font-black">
            {operation.runningCount > 0 && <span className="text-blue-600 dark:text-blue-300">{isArabic ? 'يعمل' : 'Running'} {operation.runningCount}</span>}
            {(operation.scheduledCount || 0) > 0 && <span className="text-amber-600 dark:text-amber-300">{isArabic ? 'مجدولة' : 'Scheduled'} {operation.scheduledCount}</span>}
            {(operation.readyCount || 0) > 0 && <span className="text-sky-600 dark:text-sky-300">{isArabic ? 'جاهزة' : 'Ready'} {operation.readyCount}</span>}
            {(operation.unscheduledCount || 0) > 0 && <span className="text-gray-500 dark:text-gray-300">{isArabic ? 'غير مجدولة' : 'Unscheduled'} {operation.unscheduledCount}</span>}
            {operation.waitingCount > 0
              && !(operation.scheduledCount || operation.readyCount || operation.unscheduledCount)
              && <span className="text-amber-600 dark:text-amber-300">{isArabic ? 'ينتظر' : 'Waiting'} {operation.waitingCount}</span>}
            {operation.completedCount > 0 && <span className="text-emerald-600 dark:text-emerald-300">{isArabic ? 'اكتمل' : 'Done'} {operation.completedCount}</span>}
            {operation.failedCount > 0 && <span className="text-red-600 dark:text-red-300">{isArabic ? 'مهام متعثرة' : 'Failed tasks'} {operation.failedCount}</span>}
          </span>
        ) : (
          <span className="mt-2 block text-[9px] font-bold text-gray-400 dark:text-gray-500">
            {operation.enabled === false
              ? (isArabic ? 'موقوف وفق إعدادات الأتمتة' : 'Disabled in automation settings')
              : (isArabic ? 'لا توجد مهمة نشطة الآن' : 'No active task right now')}
          </span>
        )}
        {competitorProgress && (
          <span className="mt-1.5 block text-[9px] font-black text-violet-600 dark:text-violet-300">
            {isArabic ? `نصوص المنافسين الجاهزة ${competitorProgress}` : `Ready competitor texts ${competitorProgress}`}
          </span>
        )}
        {(operation.completedLinkCount || 0) > 0 && (
          <span className="mt-1.5 block text-[9px] font-bold text-emerald-600 dark:text-emerald-300">
            {isArabic ? `روابط مطبّقة ومحفوظة: ${operation.completedLinkCount}` : `Applied and saved links: ${operation.completedLinkCount}`}
          </span>
        )}
        {operation.articleTitle && operation.articleId && (
          <button
            type="button"
            onClick={() => navigateToAppPath(buildEditorArticlePath(operation.articleId!))}
            className="mt-1.5 flex max-w-full items-center gap-1 truncate text-[9px] font-bold text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-300"
          >
            <ExternalLink size={9} className="shrink-0" />
            <span className="truncate">{operation.articleTitle}</span>
          </button>
        )}
        {operation.attemptCount !== undefined && operation.maxAttempts !== undefined && (
          <span className="mt-1.5 block text-[9px] font-bold text-gray-500 dark:text-gray-400">
            {isArabic ? `المحاولة ${operation.attemptCount}/${operation.maxAttempts}` : `Attempt ${operation.attemptCount}/${operation.maxAttempts}`}
          </span>
        )}
        {operation.retryScheduled && operation.retryAt && (
          <span className="mt-1.5 block text-[9px] font-bold leading-4 text-amber-600 dark:text-amber-300">
            {Date.parse(operation.retryAt) > now
              ? (isArabic ? 'الإعادة متاحة بعد ' : 'Retry eligible in ') + formatCountdown(Date.parse(operation.retryAt) - now, isArabic)
              : (isArabic ? 'انتهت التهدئة؛ بانتظار دورها وتوفر المزود.' : 'Cooldown finished; waiting for its turn and provider availability.')}
            <span className="block">{new Date(operation.retryAt).toLocaleString(isArabic ? 'ar' : 'en')}</span>
          </span>
        )}
        {operation.attemptsExhausted && (
          <span className="mt-1.5 block text-[9px] text-red-600 dark:text-red-300">
            {isArabic ? 'لن تُعاد تلقائيًا؛ افتح المقالة وأعد المحاولة يدويًا بعد معالجة السبب.' : 'No automatic retry remains. Open the article to retry after addressing the cause.'}
          </span>
        )}
        {operation.status === 'attention' && (
          <span className="mt-1.5 line-clamp-2 block text-[9px] font-bold leading-4 text-red-600 dark:text-red-300">
            {getOperationErrorMessage(operation, isArabic)}
          </span>
        )}
      </div>
    );
  };

  return (
    <section
      data-ai-automation-status="true"
      data-automation-operations-queue="true"
      className="rounded-xl border border-blue-200 bg-white p-4 dark:border-blue-900/50 dark:bg-[#2A2A2A]"
      dir={isArabic ? 'rtl' : 'ltr'}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Workflow size={19} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-300" />
          <div>
            <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">
              {isArabic ? 'حالة الذكاء الاصطناعي وطابور العمليات' : 'AI status and automation queue'}
            </h3>
            <p className="mt-1 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
              {isArabic
                ? (taskScope === 'system'
                  ? 'مخزون موحّد لمهام مقالات المسودة فقط على مستوى النظام كله.'
                  : 'مخزون موحّد لمهام مقالات المسودة المتاحة لك فقط.')
                : (taskScope === 'system'
                  ? 'A unified inventory limited to draft-article tasks across the system.'
                  : 'A unified inventory limited to draft-article tasks you can access.')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:text-blue-600 disabled:opacity-40 dark:border-[#444]"
          title={isArabic ? 'تحديث' : 'Refresh'}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <DashboardAiExecutionMonitor embedded isArabic={isArabic} />

      <div className="mt-3 rounded-lg border border-gray-200 p-2.5 dark:border-[#444]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[11px] font-black text-gray-700 dark:text-gray-200">
            {isArabic ? 'حالة جميع مراحل الأتمتة' : 'All automation stages'}
          </h4>
          <div className="flex flex-wrap gap-1 text-[8px] font-black">
            <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200">
              {operationCounts.running} {isArabic ? 'تعمل' : 'running'}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              {operationCounts.waiting} {isArabic ? 'تنتظر' : 'waiting'}
            </span>
            <span className="rounded-full bg-red-100 px-2 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-200">
              {operationCounts.attention} {isArabic ? 'للمراجعة' : 'to review'}
            </span>
          </div>
        </div>
        {overview?.focus && (
          <div
            data-automatic-article-focus="true"
            className={`mt-2 rounded-lg border px-3 py-2.5 ${overview.focus.state === 'needs_attention'
              ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-900/10'
              : overview.focus.articleId
                ? 'border-blue-200 bg-blue-50/70 dark:border-blue-900/60 dark:bg-blue-900/10'
                : 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-900/10'}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[11px] font-black text-gray-800 dark:text-gray-100">
                  <Workflow size={13} className="shrink-0 text-blue-600 dark:text-blue-300" />
                  {isArabic ? 'أولوية إنهاء المقالة الحالية' : 'Finish-current-article priority'}
                </span>
                <span className="mt-1 block text-[9px] font-semibold leading-4 text-gray-500 dark:text-gray-400">
                  {isArabic
                    ? 'لا تبدأ مقالة تلقائية جديدة حتى تصبح الحالية جاهزة، أو تُنقل إلى مراجعة يدوية بسبب مانع دائم.'
                    : 'No new automatic article starts until the current one is ready or moved to manual review for a permanent blocker.'}
                </span>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-black ${overview.focus.state === 'needs_attention'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200'
                : overview.focus.articleId
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'}`}
              >
                {getFocusStateLabel(overview.focus.state, isArabic)}
              </span>
            </div>

            {overview.focus.articleId && overview.focus.articleVisible ? (
              <button
                type="button"
                onClick={() => navigateToAppPath(buildEditorArticlePath(overview.focus!.articleId!))}
                className="mt-2 flex max-w-full items-center gap-1 text-start text-[11px] font-black text-blue-700 hover:underline dark:text-blue-300"
              >
                <ExternalLink size={11} className="shrink-0" />
                <span className="truncate">{overview.focus.articleTitle || overview.focus.articleId}</span>
              </button>
            ) : overview.focus.state !== 'idle' && !overview.focus.articleVisible ? (
              <span className="mt-2 block text-[10px] font-bold text-gray-600 dark:text-gray-300">
                {isArabic ? 'توجد مقالة أخرى في مسار النظام ولا تملك صلاحية عرضها.' : 'Another system article owns the lane and is not visible to your account.'}
              </span>
            ) : overview.focus.canResume && overview.focus.lastArticleId ? (
              <button
                type="button"
                onClick={() => navigateToAppPath(buildEditorArticlePath(overview.focus!.lastArticleId!))}
                className="mt-2 flex max-w-full items-center gap-1 text-start text-[11px] font-black text-red-700 hover:underline dark:text-red-300"
              >
                <ExternalLink size={11} className="shrink-0" />
                <span className="truncate">{overview.focus.lastArticleTitle || overview.focus.lastArticleId}</span>
              </button>
            ) : (
              <span className={`mt-2 block text-[10px] font-bold ${hasRunnableWritingTask
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-amber-700 dark:text-amber-300'}`}>
                {hasRunnableWritingTask
                  ? (isArabic
                    ? 'لا توجد مقالة ممسوكة الآن؛ سيختار المحرك الرئيسي أقدم مقالة مستوفية للشروط.'
                    : 'No article owns the lane; the master engine will select the oldest eligible article.')
                  : (isArabic
                    ? 'المسار متاح، لكن لا توجد مهمة مستوفية لشروط التنفيذ الآن. افتح قائمة كتابة المقالات لمعرفة سبب توقف كل مقالة.'
                    : 'The lane is available, but no task currently satisfies the execution requirements. Open the writing-task list to see each blocker.')}
              </span>
            )}

            {(overview.focus.articleId || overview.focus.canResume) && overview.focus.articleVisible && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-bold text-gray-500 dark:text-gray-400">
                <span>{isArabic ? 'المرحلة:' : 'Stage:'} {getFocusStageLabel(overview.focus.currentStage, isArabic)}</span>
                {overview.focus.attemptCount > 0 && (
                  <span>{isArabic ? 'المحاولة' : 'Attempt'} {overview.focus.attemptCount}/{Math.max(overview.focus.maxAttempts, overview.focus.attemptCount)}</span>
                )}
                {overview.focus.acquiredAt && Number.isFinite(Date.parse(overview.focus.acquiredAt)) && (
                  <span>{isArabic ? 'بدأت:' : 'Started:'} {new Date(overview.focus.acquiredAt).toLocaleString(isArabic ? 'ar' : 'en')}</span>
                )}
              </div>
            )}
            {overview.focus.nextRetryAt && Date.parse(overview.focus.nextRetryAt) > now && (
              <span className="mt-1.5 block text-[9px] font-black text-amber-700 dark:text-amber-300">
                {isArabic ? 'إعادة المحاولة بعد ' : 'Retry in '}
                {formatCountdown(Date.parse(overview.focus.nextRetryAt) - now, isArabic)}
              </span>
            )}
            {overview.focus.lastError && overview.focus.articleVisible && (
              <span className="mt-1.5 line-clamp-2 block text-[9px] font-bold text-red-600 dark:text-red-300">
                {overview.focus.lastError}
              </span>
            )}
            {isAdmin && (overview.focus.articleId || overview.focus.canResume) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {overview.focus.articleId ? (
                  <button
                    type="button"
                    onClick={() => void handleFocusMutation('skip')}
                    disabled={focusMutating}
                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[9px] font-black text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-[#222] dark:text-red-300"
                  >
                    {focusMutating ? <Loader2 size={11} className="animate-spin" /> : <SkipForward size={11} />}
                    {isArabic ? 'نقل للمراجعة والانتقال للتالية' : 'Move to review and continue'}
                  </button>
                ) : overview.focus.canResume ? (
                  <button
                    type="button"
                    onClick={() => void handleFocusMutation('resume')}
                    disabled={focusMutating}
                    className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2 py-1 text-[9px] font-black text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:bg-[#222] dark:text-blue-300"
                  >
                    {focusMutating ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={11} />}
                    {isArabic ? 'استئناف المقالة' : 'Resume article'}
                  </button>
                ) : null}
              </div>
            )}
            {focusMessage && (
              <div className="mt-2 rounded-md bg-white/80 px-2 py-1.5 text-[9px] font-bold text-gray-700 dark:bg-[#222]/80 dark:text-gray-200">
                {focusMessage}
              </div>
            )}
          </div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          {operations.map(renderOperation)}
        </div>
        {expandedOperation && createPortal(
          <div
            className="fixed inset-0 z-[160] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[1px] sm:p-6"
            onMouseDown={event => {
              if (event.target === event.currentTarget) setExpandedOperationKey(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="automation-remaining-tasks-title"
              className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-blue-200 bg-white shadow-2xl dark:border-blue-900/60 dark:bg-[#2A2A2A] sm:max-h-[calc(100vh-3rem)]"
            >
              <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-[#444]">
                <div className="min-w-0">
                  <h4
                    id="automation-remaining-tasks-title"
                    className="flex items-center gap-1.5 text-sm font-black text-gray-800 dark:text-gray-100"
                  >
                    <ListTree size={16} className="shrink-0 text-blue-600 dark:text-blue-300" />
                    <span>{isArabic ? 'المهام المتبقية وغير المكتملة' : 'Remaining and incomplete tasks'}</span>
                  </h4>
                  <p className="mt-1 truncate text-[11px] font-black text-blue-600 dark:text-blue-300">
                    {OPERATION_PRESENTATION[expandedOperation.key].label[isArabic ? 0 : 1]}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-full bg-gray-100 px-2 py-1 text-[9px] font-black text-gray-500 dark:bg-[#222] dark:text-gray-300">
                    {taskScope === 'system'
                      ? (isArabic ? 'مسودات النظام فقط' : 'System drafts only')
                      : (isArabic ? 'مسوداتك المتاحة فقط' : 'Your accessible drafts only')}
                  </span>
                  <button
                    ref={modalCloseButtonRef}
                    type="button"
                    onClick={() => setExpandedOperationKey(null)}
                    className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-[#555] dark:hover:border-red-900 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                    aria-label={isArabic ? 'إغلاق النافذة' : 'Close dialog'}
                    title={isArabic ? 'إغلاق' : 'Close'}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {expandedOperation.key === 'content_writing' && overview && (
                  <div className="mb-3 space-y-1.5">
                    {!overview.settings.enabled && (
                      <div className="rounded-md bg-gray-100 px-2 py-1.5 text-[10px] font-bold text-gray-600 dark:bg-[#222] dark:text-gray-300">
                        {isArabic ? 'طلبات الكتابة الجديدة متوقفة من إعدادات المسؤول.' : 'New writing requests are paused in administrator settings.'}
                      </div>
                    )}
                    {overview.globalBlocker && (
                      <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                        <Clock3 size={12} className="mt-0.5 shrink-0" />
                        <span>{isArabic
                          ? `ينتظر طابور الكتابة انتهاء مسار أعلى أولوية${overview.globalBlocker.articleTitle ? `: ${overview.globalBlocker.articleTitle}` : ''}.`
                          : `The writing queue is waiting for higher-priority work${overview.globalBlocker.articleTitle ? `: ${overview.globalBlocker.articleTitle}` : ''}.`}</span>
                      </div>
                    )}
                    {cooldownMs > 0 && (
                      <div className="rounded-md bg-amber-50 px-2 py-1.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                        {isArabic ? `الفاصل العالمي المتبقي: ${formatCountdown(cooldownMs, true)}` : `Global cooldown remaining: ${formatCountdown(cooldownMs, false)}`}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  {(expandedOperation.tasks || []).length > 0 ? expandedOperation.tasks!.map(task => {
                    const dateDetails = taskDateDetails(task, isArabic);
                    const reason = getTaskReasonLabel(task, isArabic);
                    const rawReason = String(task.reason || '').trim();
                    return (
                      <button
                        key={task.taskId}
                        type="button"
                        onClick={() => {
                          setExpandedOperationKey(null);
                          navigateToAppPath(buildEditorArticlePath(task.articleId));
                        }}
                        className="flex w-full items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-start hover:border-blue-300 hover:bg-blue-50 dark:border-[#444] dark:bg-[#252525] dark:hover:border-blue-800"
                      >
                        <span
                          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-black ${task.priorityRank <= 3
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'}`}
                          title={isArabic ? `الأولوية ${task.priorityRank} داخل هذا النوع` : `Priority ${task.priorityRank} within this task type`}
                        >
                          {task.priorityRank}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[11px] font-black text-gray-800 dark:text-gray-100">
                              {task.articleTitle || task.articleId}
                            </span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black ${TASK_STATUS_STYLE[task.status]}`}>
                              {getTaskStatusLabel(task, isArabic)}
                            </span>
                          </span>
                          {dateDetails && (
                            <span className="mt-1 block text-[10px] font-bold text-gray-500 dark:text-gray-400">
                              {dateDetails.label}: {dateDetails.value}
                            </span>
                          )}
                          {reason && (
                            <span className={`mt-1 block text-[10px] font-bold ${task.status === 'failed'
                              ? 'text-red-600 dark:text-red-300'
                              : 'text-gray-500 dark:text-gray-400'}`}>
                              {reason}
                            </span>
                          )}
                          {rawReason && rawReason !== reason && (
                            <span className="mt-1 line-clamp-3 block text-[9px] font-semibold leading-4 text-gray-400 dark:text-gray-500">
                              {isArabic ? 'تفصيل آخر محاولة: ' : 'Last-attempt detail: '}{rawReason}
                            </span>
                          )}
                          {(task.attemptCount > 0 || task.status === 'failed') && (
                            <span className="mt-1 block text-[9px] font-bold text-gray-400 dark:text-gray-500">
                              {isArabic ? `المحاولة ${task.attemptCount}/${task.maxAttempts}` : `Attempt ${task.attemptCount}/${task.maxAttempts}`}
                            </span>
                          )}
                        </span>
                        <ExternalLink size={13} className="mt-1 shrink-0 text-gray-400" />
                      </button>
                    );
                  }) : (
                    <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-[11px] font-bold text-gray-400 dark:border-[#444]">
                      {isArabic ? 'لا توجد مهام متبقية أو غير مكتملة في هذه المرحلة.' : 'No remaining or incomplete tasks in this stage.'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
        <div className="mt-2 flex items-center justify-between gap-2 text-[9px] font-bold text-gray-400 dark:text-gray-500">
          <span>{isArabic ? `${operationCounts.enabled}/${operations.length} أنواع مفعّلة لحسابك` : `${operationCounts.enabled}/${operations.length} types enabled for your account`}</span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 font-black text-emerald-600 dark:text-emerald-300">
              <RotateCcw size={10} />
              {isArabic ? 'الاسترداد التلقائي مفعّل' : 'Automatic recovery enabled'}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => void handleRecoverableRetry()}
                disabled={recovering}
                className="inline-flex items-center gap-1 font-black text-amber-600 hover:underline disabled:opacity-50 dark:text-amber-300"
              >
                {recovering ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                {isArabic ? 'تشغيل الاسترداد الآن' : 'Run recovery now'}
              </button>
            )}
            <button
              type="button"
              onClick={() => navigateToAppPath('/settings/automation')}
              className="font-black text-blue-600 hover:underline dark:text-blue-300"
            >
              {isArabic ? 'إدارة الأتمتة' : 'Manage automation'}
            </button>
          </span>
        </div>
        {recoveryMessage && (
          <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[9px] font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {recoveryMessage}
          </div>
        )}
      </div>

      {preferencesError && (
        <div className="mt-2 text-[10px] font-bold text-amber-600 dark:text-amber-300">{preferencesError}</div>
      )}

      {loading && !overview && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-blue-50 p-2 text-xs font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          <Loader2 size={15} className="shrink-0 animate-spin" />
          {isArabic ? 'جار تحميل مخزون مهام الأتمتة...' : 'Loading the automation task inventory...'}
        </div>
      )}

      {overview && !overview.schemaAvailable && (
        <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {isArabic ? 'يلزم تطبيق ترحيل مخزون المهام على قاعدة البيانات.' : 'The task-inventory database migration must be applied.'}
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-[10px] font-bold text-red-600 dark:text-red-300">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{getContentWritingAutomationErrorMessage(error, isArabic)}</span>
        </div>
      )}
    </section>
  );
};

export default AutomaticContentWritingQueuePanel;
