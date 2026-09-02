import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  ChartNoAxesCombined,
  Clock3,
  Download,
  ExternalLink,
  FilePenLine,
  Link2,
  Loader2,
  PauseCircle,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { UserAutomationPreferences } from '../constants/userAutomation';
import { buildEditorArticlePath, navigateToAppPath } from '../utils/appRoutes';
import {
  getContentWritingAutomationErrorMessage,
  getContentWritingAutomationProviderLabel,
  loadContentWritingAutomationStatus,
  type ContentWritingAutomationOverview,
} from '../utils/contentWritingAutomation';
import {
  buildDashboardAutomationOperations,
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

type Props = {
  isArabic: boolean;
  isAdmin: boolean;
  externalAnalysisSummaries?: Record<string, ExternalAnalysisDashboardSummary>;
  articleTitles?: Record<string, string>;
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
  onRefreshExternalAnalysis,
}) => {
  const [overview, setOverview] = useState<ContentWritingAutomationOverview | null>(null);
  const [effectivePreferences, setEffectivePreferences] = useState<UserAutomationPreferences | null>(null);
  const [preferencesError, setPreferencesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const refreshRequestRef = useRef(0);

  const refresh = useCallback(async (silent = false) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (!silent) setLoading(true);
    try {
      const [statusResult, preferencesResult] = await Promise.allSettled([
        loadContentWritingAutomationStatus(),
        loadUserAutomationPreferences(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      if (statusResult.status === 'fulfilled') {
        setOverview(statusResult.value.overview);
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
    const handleAutomationChange = () => void refresh(true);
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
  const visibleCandidates = useMemo(() => (
    [...(overview?.candidates || [])]
      .sort((left, right) => {
        const leftAt = left.eligibleAt ? new Date(left.eligibleAt).getTime() : 0;
        const rightAt = right.eligibleAt ? new Date(right.eligibleAt).getTime() : 0;
        const leftWaiting = Number.isFinite(leftAt) && leftAt > now;
        const rightWaiting = Number.isFinite(rightAt) && rightAt > now;
        if (leftWaiting !== rightWaiting) return leftWaiting ? 1 : -1;
        return left.position - right.position;
      })
      .slice(0, 5)
  ), [now, overview?.candidates]);
  const availableCandidateCount = useMemo(() => (
    (overview?.candidates || []).filter(candidate => {
      if (!candidate.eligibleAt) return true;
      const eligibleAt = new Date(candidate.eligibleAt).getTime();
      return !Number.isFinite(eligibleAt) || eligibleAt <= now;
    }).length
  ), [now, overview?.candidates]);
  const operations = useMemo(() => buildDashboardAutomationOperations({
    summaries: externalAnalysisSummaries,
    writingOverview: overview,
    effectivePreferences,
    articleTitles,
  }), [articleTitles, effectivePreferences, externalAnalysisSummaries, overview]);
  const operationCounts = useMemo(() => ({
    running: operations.filter(operation => operation.status === 'running').length,
    waiting: operations.filter(operation => operation.status === 'waiting').length,
    attention: operations.filter(operation => operation.status === 'attention').length,
    enabled: operations.filter(operation => operation.enabled === true).length,
  }), [operations]);

  const handleRefresh = () => {
    void refresh();
    void onRefreshExternalAnalysis?.();
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
      <button
        key={operation.key}
        type="button"
        disabled={!operation.articleId}
        onClick={() => operation.articleId && navigateToAppPath(buildEditorArticlePath(operation.articleId))}
        className="min-w-0 rounded-lg border border-gray-200 p-2.5 text-start transition enabled:hover:border-blue-300 enabled:hover:bg-blue-50/60 disabled:cursor-default dark:border-[#444] dark:enabled:hover:border-blue-800 dark:enabled:hover:bg-blue-900/10"
      >
        <span className="flex items-start justify-between gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-black text-gray-800 dark:text-gray-100">
            <OperationIcon size={14} className="shrink-0 text-blue-600 dark:text-blue-300" />
            <span className="line-clamp-2">{presentation.label[isArabic ? 0 : 1]}</span>
          </span>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-black ${OPERATION_STATUS_STYLE[operation.status]}`}>
            {getOperationStatusLabel(operation.status, isArabic)}
          </span>
        </span>
        <span className="mt-1.5 block text-[9px] font-semibold leading-4 text-gray-500 dark:text-gray-400">
          {presentation.description[isArabic ? 0 : 1]}
        </span>
        {hasCounts ? (
          <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[9px] font-black">
            {operation.runningCount > 0 && <span className="text-blue-600 dark:text-blue-300">{isArabic ? 'يعمل' : 'Running'} {operation.runningCount}</span>}
            {operation.waitingCount > 0 && <span className="text-amber-600 dark:text-amber-300">{isArabic ? 'ينتظر' : 'Waiting'} {operation.waitingCount}</span>}
            {operation.completedCount > 0 && <span className="text-emerald-600 dark:text-emerald-300">{isArabic ? 'اكتمل' : 'Done'} {operation.completedCount}</span>}
            {operation.failedCount > 0 && <span className="text-red-600 dark:text-red-300">{isArabic ? 'تعذر' : 'Failed'} {operation.failedCount}</span>}
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
        {operation.articleTitle && (
          <span className="mt-1.5 flex items-center gap-1 truncate text-[9px] font-bold text-gray-500 dark:text-gray-400">
            <ExternalLink size={9} className="shrink-0" />
            <span className="truncate">{operation.articleTitle}</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <section data-automation-operations-queue="true" className="rounded-xl border border-blue-200 bg-white p-4 dark:border-blue-900/50 dark:bg-[#2A2A2A]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Workflow size={19} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-300" />
          <div>
            <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">
              {isArabic ? 'طابور العمليات المؤتمتة' : 'Automated operations queue'}
            </h3>
            <p className="mt-1 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
              {isArabic ? 'الصيغ وLSI وGoogle والمنافسون والتحليل والكتابة والربط الداخلي في صندوق واحد.' : 'Semantics, Google metadata, competitors, analysis, writing, and internal links in one place.'}
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
        <div className="mt-2 grid grid-cols-2 gap-2">
          {operations.map(renderOperation)}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[9px] font-bold text-gray-400 dark:text-gray-500">
          <span>{isArabic ? `${operationCounts.enabled}/8 أنواع مفعّلة لحسابك` : `${operationCounts.enabled}/8 types enabled for your account`}</span>
          <button
            type="button"
            onClick={() => navigateToAppPath('/settings/automation')}
            className="font-black text-blue-600 hover:underline dark:text-blue-300"
          >
            {isArabic ? 'إدارة الأتمتة' : 'Manage automation'}
          </button>
        </div>
      </div>

      {preferencesError && (
        <div className="mt-2 text-[10px] font-bold text-amber-600 dark:text-amber-300">{preferencesError}</div>
      )}

      {loading && !overview ? (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-blue-50 p-2 text-xs font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          <Loader2 size={15} className="shrink-0 animate-spin" />
          {isArabic ? 'جار تحميل تفاصيل طابور كتابة المقالات...' : 'Loading article-writing queue details...'}
        </div>
      ) : error && !overview ? (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 p-2 text-xs font-bold text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{isArabic ? 'تعذر الاتصال بحالة الطابور. تحقق من الاتصال ثم أعد المحاولة.' : 'Queue status could not be reached. Check the connection and try again.'}</span>
        </div>
      ) : overview && !overview.schemaAvailable ? (
        <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {isArabic ? 'يلزم تطبيق ترحيل الطابور على قاعدة البيانات.' : 'The queue database migration must be applied.'}
        </div>
      ) : overview ? (
        <>
          {overview.active && (
            <button
              type="button"
              onClick={() => navigateToAppPath(buildEditorArticlePath(overview.active!.articleId))}
              className="mt-3 w-full rounded-lg border border-blue-200 bg-blue-50 p-2 text-start hover:bg-blue-100 dark:border-blue-900/50 dark:bg-blue-900/15 dark:hover:bg-blue-900/25"
            >
              <div className="flex items-center justify-between gap-2 text-[10px] font-black text-blue-700 dark:text-blue-200">
                <span>{overview.active.status === 'claiming'
                  ? (isArabic ? 'جار حجز المقالة' : 'Reserving article')
                  : (isArabic ? 'تُكتب الآن' : 'Writing now')}</span>
                <ExternalLink size={12} />
              </div>
              <div className="mt-1 line-clamp-2 text-xs font-black text-gray-800 dark:text-gray-100">
                {overview.active.articleTitle || overview.active.articleId}
              </div>
              <div className="mt-1 text-[10px] font-bold text-gray-500 dark:text-gray-400">
                {getContentWritingAutomationProviderLabel(overview.active.provider, isArabic)}{overview.active.model ? ` · ${overview.active.model}` : ''}
                {' · '}{isArabic ? `المحاولة ${overview.active.attemptCount}/${overview.active.maxAttempts}` : `Attempt ${overview.active.attemptCount}/${overview.active.maxAttempts}`}
              </div>
              {!overview.settings.enabled && (
                <div className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  {isArabic ? 'تستمر الجلسة الحالية بأمان، لكن لن تبدأ مقالات جديدة.' : 'The current session will finish safely, but no new articles will start.'}
                </div>
              )}
            </button>
          )}

          {!overview.settings.enabled ? (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-gray-50 p-2 text-xs font-bold text-gray-600 dark:bg-[#222] dark:text-gray-300">
              <PauseCircle size={15} className="mt-0.5 shrink-0" />
              <div>
                <div>{isArabic ? 'الطلبات الجديدة متوقفة من إعدادات المسؤول.' : 'New queue requests are paused in administrator settings.'}</div>
                <button
                  type="button"
                  onClick={() => navigateToAppPath(isAdmin ? '/settings/ai' : '/guide')}
                  className="mt-1 text-[11px] font-black text-blue-600 hover:underline dark:text-blue-300"
                >
                  {isAdmin
                    ? (isArabic ? 'فتح إعدادات كتابة المحتوى' : 'Open content-writing settings')
                    : (isArabic ? 'قراءة دليل الكتابة التلقائية' : 'Read the automatic-writing guide')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-3 flex items-center gap-1.5 text-[11px] font-black text-gray-700 dark:text-gray-200">
                <Bot size={13} />
                {isArabic ? 'تفاصيل طابور كتابة المقالات' : 'Article-writing queue details'}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                <div className="rounded-md bg-blue-50 p-2 dark:bg-blue-900/15">
                  <div className="text-lg font-black text-blue-700 dark:text-blue-200">{availableCandidateCount}</div>
                  <div className="text-[10px] font-bold text-gray-500 dark:text-gray-400">{isArabic ? 'مؤهلة الآن ومرئية لك' : 'Eligible now and visible to you'}</div>
                </div>
                <div className="rounded-md bg-amber-50 p-2 dark:bg-amber-900/15">
                  <div className="text-sm font-black text-amber-700 dark:text-amber-200">
                    {cooldownMs > 0 ? formatCountdown(cooldownMs, isArabic) : (isArabic ? 'متاح' : 'Available')}
                  </div>
                  <div className="text-[10px] font-bold text-gray-500 dark:text-gray-400">{isArabic ? 'الفاصل العالمي' : 'Global cooldown'}</div>
                </div>
              </div>

              {overview.globalBlocker && (
                <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 p-2 text-[11px] font-bold leading-5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  <Clock3 size={14} className="mt-0.5 shrink-0" />
                  <span>{isArabic
                    ? `الطابور ينتظر انتهاء مسار أعلى أولوية${overview.globalBlocker.articleTitle ? `: ${overview.globalBlocker.articleTitle}` : ''}.`
                    : `The queue is waiting for higher-priority work to finish${overview.globalBlocker.articleTitle ? `: ${overview.globalBlocker.articleTitle}` : ''}.`}</span>
                </div>
              )}

              <div className="mt-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-black text-gray-700 dark:text-gray-200">
                  <Clock3 size={13} />
                  {isArabic ? 'ترتيب تقريبي ضمن المقالات المتاحة لك' : 'Approximate order among articles available to you'}
                </div>
                {visibleCandidates.length > 0 ? visibleCandidates.map(candidate => {
                  const eligibleAt = candidate.eligibleAt ? new Date(candidate.eligibleAt).getTime() : 0;
                  const scheduled = Number.isFinite(eligibleAt) && eligibleAt > now;
                  return (
                    <button
                      key={candidate.articleId}
                      type="button"
                      onClick={() => navigateToAppPath(buildEditorArticlePath(candidate.articleId))}
                      className="flex w-full items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-2 text-start hover:border-blue-200 hover:bg-blue-50 dark:border-[#3b3b3b] dark:bg-[#222] dark:hover:border-blue-900/50"
                    >
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-black text-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
                        title={isArabic ? 'ترتيب ضمن العناصر المرئية لك، وليس ترتيبًا عالميًا' : 'Order among items visible to you, not a global rank'}
                      >
                        {candidate.position}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-bold text-gray-700 dark:text-gray-200">
                          {candidate.articleTitle || candidate.articleId}
                        </span>
                        {scheduled && (
                          <span className="mt-0.5 block text-[9px] font-bold text-amber-600 dark:text-amber-300">
                            {isArabic ? `إعادة مجدولة بعد ${formatCountdown(eligibleAt - now, true)}` : `Retry scheduled in ${formatCountdown(eligibleAt - now, false)}`}
                          </span>
                        )}
                      </span>
                      <ExternalLink size={11} className="shrink-0 text-gray-400" />
                    </button>
                  );
                }) : (
                  <div className="rounded-md border border-dashed border-gray-200 p-3 text-center text-[11px] font-bold text-gray-400 dark:border-[#444]">
                    {isArabic ? 'لا توجد مقالات جاهزة حاليًا.' : 'No articles are ready right now.'}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      ) : null}

      {error && overview && (
        <div className="mt-2 text-[10px] font-bold text-red-600 dark:text-red-300">
          {getContentWritingAutomationErrorMessage(error, isArabic)}
        </div>
      )}
    </section>
  );
};

export default AutomaticContentWritingQueuePanel;
