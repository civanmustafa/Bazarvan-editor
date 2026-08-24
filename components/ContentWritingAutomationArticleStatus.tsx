import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import {
  CONTENT_WRITING_AUTOMATION_READINESS_CODES,
  cancelContentWritingAutomationItem,
  getContentWritingAutomationErrorMessage,
  getContentWritingAutomationProviderLabel,
  getContentWritingAutomationReadinessLabel,
  loadContentWritingAutomationStatus,
  retryContentWritingAutomationItem,
  type ContentWritingAutomationStatus,
} from '../utils/contentWritingAutomation';

type Props = {
  articleId: string;
  isArabic: boolean;
  onSessionDiscovered?: (sessionId: string, articleId: string) => void;
  onAutomaticActivityChange?: (active: boolean) => void;
  onFullPipelineActivityChange?: (active: boolean) => void;
};

const formatDuration = (milliseconds: number, isArabic: boolean): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    ...(hours ? [`${hours}${isArabic ? 'س' : 'h'}`] : []),
    ...(minutes || hours ? [`${minutes}${isArabic ? 'د' : 'm'}`] : []),
    `${seconds}${isArabic ? 'ث' : 's'}`,
  ];
  return parts.join(' ');
};

const ContentWritingAutomationArticleStatus: React.FC<Props> = ({
  articleId,
  isArabic,
  onSessionDiscovered,
  onAutomaticActivityChange,
  onFullPipelineActivityChange,
}) => {
  const [status, setStatus] = useState<ContentWritingAutomationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'retry' | 'cancel' | ''>('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeArticleIdRef = useRef(articleId);
  const requestSequenceRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  activeArticleIdRef.current = articleId;

  const refresh = useCallback(async (silent = false) => {
    if (!articleId) return;
    const requestedArticleId = articleId;
    const requestSequence = ++requestSequenceRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const nextStatus = await loadContentWritingAutomationStatus(articleId, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted
        || requestSequence !== requestSequenceRef.current
        || activeArticleIdRef.current !== requestedArticleId
      ) return;
      setStatus(nextStatus);
      setError('');
    } catch (requestError) {
      if (
        controller.signal.aborted
        || requestSequence !== requestSequenceRef.current
        || activeArticleIdRef.current !== requestedArticleId
      ) return;
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (
        requestSequence === requestSequenceRef.current
        && activeArticleIdRef.current === requestedArticleId
      ) setLoading(false);
    }
  }, [articleId]);

  useEffect(() => {
    setStatus(null);
    setError('');
    setLoading(true);
    void refresh();
    return () => {
      requestSequenceRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const article = status?.article;
  const item = article?.item || null;
  const activeAutomatic = item?.status === 'claiming' || item?.status === 'writing';
  const activeFullPipeline = Boolean(article?.activeFullPipeline);
  useEffect(() => {
    onAutomaticActivityChange?.(activeAutomatic);
  }, [activeAutomatic, onAutomaticActivityChange]);
  useEffect(() => {
    onFullPipelineActivityChange?.(activeFullPipeline);
  }, [activeFullPipeline, onFullPipelineActivityChange]);
  useEffect(() => {
    if (item?.sessionId) onSessionDiscovered?.(item.sessionId, articleId);
  }, [articleId, item?.sessionId, onSessionDiscovered]);

  const cooldownAt = status?.overview.state?.nextAllowedAt || '';
  const cooldownMs = cooldownAt ? new Date(cooldownAt).getTime() - now : 0;
  const readiness = article?.readiness || null;
  const hasCompletedContentWritingSession = article?.hasCompletedContentWritingSession === true;
  const globalBlocker = status?.overview.globalBlocker || null;
  const configuredMinimum = status?.overview.settings.minimumCompetitors || 1;
  const competitorMinimumMet = (readiness?.usableCompetitorCount || 0) >= configuredMinimum;
  const terminalStateMet = status?.overview.settings.requireCompetitorTerminalState === false
    || readiness?.processingComplete === true;
  const missing = new Set(readiness?.missingFields || []);
  const queueCandidate = status?.overview.candidates.find(candidate => candidate.articleId === articleId) || null;

  const presentation = useMemo(() => {
    if (loading && !status) return {
      tone: 'blue',
      label: isArabic ? 'جار التحقق من جاهزية المقالة' : 'Checking article readiness',
      detail: isArabic ? 'تُقرأ المدخلات وحالة الطابور من الخادم.' : 'Inputs and queue state are being loaded from the server.',
    };
    if (error && !status) return {
      tone: 'red',
      label: isArabic ? 'تعذر تحميل حالة الطابور' : 'Queue status could not be loaded',
      detail: isArabic ? 'تحقق من الاتصال ثم اضغط زر التحديث.' : 'Check the connection, then use the refresh button.',
    };
    if (status && !status.overview.schemaAvailable) return {
      tone: 'amber',
      label: isArabic ? 'ينتظر تطبيق ترحيل قاعدة البيانات' : 'Database migration required',
      detail: isArabic ? 'لن يبدأ الطابور قبل تطبيق الترحيل الجديد.' : 'The queue cannot start until the new migration is applied.',
    };
    if (item?.status === 'claiming') return {
      tone: 'blue',
      label: isArabic ? 'جار حجز المقالة للكتابة' : 'Reserving article for writing',
      detail: status?.overview.settings.enabled === false
        ? (isArabic
          ? 'بدأ هذا الحجز قبل إيقاف الأتمتة وسيُحسم بأمان؛ لن تبدأ مقالات جديدة.'
          : 'This reservation started before automation was paused and will finish safely; no new articles will start.')
        : (isArabic ? 'يُعاد فحص المدخلات قبل إنشاء الجلسة.' : 'Inputs are being revalidated before the session is created.'),
    };
    if (item?.status === 'writing') return {
      tone: 'blue',
      label: isArabic ? 'تُكتب تلقائيًا الآن' : 'Writing automatically now',
      detail: status?.overview.settings.enabled === false
        ? (isArabic
          ? 'تستمر الجلسة التي بدأت قبل الإيقاف حتى تُحفظ للمراجعة؛ لن تبدأ مقالات جديدة.'
          : 'The session that started before automation was paused will continue to review; no new articles will start.')
        : (isArabic ? 'ستُحفظ النتيجة للمراجعة دون إدراج تلقائي.' : 'The result will be saved for review without automatic insertion.'),
    };
    if (activeFullPipeline) return {
      tone: 'blue',
      label: isArabic ? 'محجوزة للإنشاء الشامل' : 'Reserved by the full workflow',
      detail: isArabic ? 'لن يبدأ الطابور التلقائي جلسة أخرى لهذه المقالة.' : 'The automatic queue will not start another session for this article.',
    };
    if (item?.status === 'completed') return {
      tone: 'green',
      label: isArabic ? 'اكتملت وبانتظار المراجعة' : 'Completed and awaiting review',
      detail: isArabic ? 'لن تعيد الأتمتة كتابة هذه المقالة إلا بطلب إعادة صريح.' : 'Automation will not rewrite this article without an explicit retry.',
    };
    if (item?.status === 'blocked') return {
      tone: 'red',
      label: isArabic ? 'تحتاج تدخلًا يدويًا' : 'Needs manual attention',
      detail: getContentWritingAutomationErrorMessage(item.lastError, isArabic),
    };
    if (item?.status === 'cancelled') return {
      tone: 'gray',
      label: isArabic ? 'أُزيلت من الطابور' : 'Removed from queue',
      detail: isArabic ? 'يمكن إعادتها إلى الطابور يدويًا.' : 'It can be returned to the queue manually.',
    };
    if (item?.status === 'ready' && item.eligibleAt && new Date(item.eligibleAt).getTime() > now) return {
      tone: 'amber',
      label: isArabic ? 'إعادة محاولة مجدولة' : 'Retry scheduled',
      detail: isArabic ? `المحاولة التالية بعد ${formatDuration(new Date(item.eligibleAt).getTime() - now, true)}.` : `Next attempt in ${formatDuration(new Date(item.eligibleAt).getTime() - now, false)}.`,
    };
    if (status && !status.overview.settings.enabled) return {
      tone: 'gray',
      label: isArabic ? 'الكتابة التلقائية متوقفة' : 'Automatic writing is off',
      detail: isArabic ? 'يمكن للمسؤول تفعيل الطلبات الجديدة من إعدادات كتابة المحتوى.' : 'An administrator can enable new requests in content-writing settings.',
    };
    if (hasCompletedContentWritingSession) return {
      tone: 'green',
      label: isArabic ? 'كُتبت المقالة سابقًا' : 'Article was written previously',
      detail: isArabic
        ? 'لن يعيد الطابور كتابة مقالة لها جلسة مكتملة. يمكن بدء إعادة كتابة صريحة يدويًا عند الحاجة.'
        : 'The queue will not rewrite an article with a completed session. Start an explicit manual rewrite if needed.',
    };
    if (!readiness?.ready || !competitorMinimumMet || !terminalStateMet) return {
      tone: 'amber',
      label: isArabic ? 'المدخلات غير مكتملة' : 'Inputs are incomplete',
      detail: isArabic ? 'افتح قائمة التحقق لمعرفة ما ينقص المقالة.' : 'Open the checklist to see what is missing.',
    };
    if (cooldownMs > 0) return {
      tone: 'amber',
      label: isArabic ? 'جاهزة وتنتظر الفاصل' : 'Ready and waiting for cooldown',
      detail: isArabic
        ? `المتاح بعد ${formatDuration(cooldownMs, true)}${queueCandidate ? ` · ترتيب تقريبي ضمن المقالات المتاحة لك ${queueCandidate.position}` : ''}.`
        : `Available in ${formatDuration(cooldownMs, false)}${queueCandidate ? ` · approximate position among articles available to you: ${queueCandidate.position}` : ''}.`,
    };
    if (globalBlocker) {
      const blockerType = globalBlocker.type.toLowerCase();
      const isFullWorkflowBlocker = blockerType.includes('pipeline') || blockerType.includes('full');
      return {
        tone: 'amber',
        label: isArabic ? 'جاهزة وتنتظر أولوية أخرى' : 'Ready and waiting for higher-priority work',
        detail: isArabic
          ? `${isFullWorkflowBlocker ? 'يوجد إنشاء شامل نشط' : 'توجد جلسة كتابة يدوية أو مباشرة نشطة'}${globalBlocker.articleTitle ? `: ${globalBlocker.articleTitle}` : ''}. سيُعاد فحص الطابور تلقائيًا بعد انتهائها.`
          : `${isFullWorkflowBlocker ? 'A full workflow is active' : 'A manual or direct writing session is active'}${globalBlocker.articleTitle ? `: ${globalBlocker.articleTitle}` : ''}. The queue will be checked again when it finishes.`,
      };
    }
    return {
      tone: 'green',
      label: isArabic ? 'جاهزة للطابور التلقائي' : 'Ready for the automatic queue',
      detail: isArabic
        ? `سيختارها الخادم بعد الطلبات اليدوية${queueCandidate ? ` · ترتيبها التقريبي ضمن المقالات المتاحة لك ${queueCandidate.position}` : ''}.`
        : `The server will select it after manual requests${queueCandidate ? ` · approximate position among articles available to you: ${queueCandidate.position}` : ''}.`,
    };
  }, [
    activeFullPipeline,
    competitorMinimumMet,
    cooldownMs,
    error,
    globalBlocker,
    hasCompletedContentWritingSession,
    isArabic,
    item,
    loading,
    now,
    queueCandidate,
    readiness?.ready,
    status,
    terminalStateMet,
  ]);

  const toneClass = presentation.tone === 'green'
    ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/15 dark:text-emerald-200'
    : presentation.tone === 'red'
      ? 'border-red-200 bg-red-50/70 text-red-800 dark:border-red-900/50 dark:bg-red-900/15 dark:text-red-200'
      : presentation.tone === 'blue'
        ? 'border-blue-200 bg-blue-50/70 text-blue-800 dark:border-blue-900/50 dark:bg-blue-900/15 dark:text-blue-200'
        : presentation.tone === 'amber'
          ? 'border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/15 dark:text-amber-200'
          : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-[#444] dark:bg-[#222] dark:text-gray-300';

  const retry = async () => {
    if (!item) return;
    setBusy('retry');
    try {
      await retryContentWritingAutomationItem(item.id);
      await refresh(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!item) return;
    setBusy('cancel');
    try {
      await cancelContentWritingAutomationItem(item.id);
      await refresh(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className={`rounded-lg border p-2.5 ${toneClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {loading && !status ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" /> : <Bot size={15} className="mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <div className="mb-0.5 text-[9px] font-black uppercase tracking-wide opacity-60">
              {isArabic ? 'مسار منفصل: الطابور التلقائي' : 'Separate path: automatic queue'}
            </div>
            <div className="text-[11px] font-black">{presentation.label}</div>
            <div className="mt-0.5 text-[10px] font-semibold leading-5 opacity-80">{presentation.detail}</div>
            {item && (
              <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-black opacity-80">
                <span>{isArabic ? 'المحاولة' : 'Attempt'} {item.attemptCount}/{item.maxAttempts}</span>
                <span>·</span>
                <span>{getContentWritingAutomationProviderLabel(item.provider, isArabic)}{item.model ? ` · ${item.model}` : ''}</span>
                {item.qualityScore !== null && <><span>·</span><span>{isArabic ? 'الجودة' : 'Quality'} {item.qualityScore}/100</span></>}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded p-1 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
            title={isArabic ? 'تحديث' : 'Refresh'}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(value => !value)}
            className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5"
            title={isArabic ? 'قائمة التحقق' : 'Checklist'}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 rounded-md bg-white/70 p-2 text-[10px] font-bold dark:bg-black/15">
          {readiness ? (
            <div className="grid gap-1 sm:grid-cols-2">
              {CONTENT_WRITING_AUTOMATION_READINESS_CODES.map(code => {
                const passed = !missing.has(code);
                return (
                  <div key={code} className="flex items-start gap-1.5">
                    {passed ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={12} className="mt-0.5 shrink-0 text-red-600" />}
                    <span>{getContentWritingAutomationReadinessLabel(code, isArabic)}</span>
                  </div>
                );
              })}
              <div className="flex items-start gap-1.5">
                {competitorMinimumMet ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={12} className="mt-0.5 shrink-0 text-red-600" />}
                <span>{isArabic ? `الحد المضبوط للمنافسين (${readiness.usableCompetitorCount}/${configuredMinimum})` : `Configured competitor minimum (${readiness.usableCompetitorCount}/${configuredMinimum})`}</span>
              </div>
              <div className="flex items-start gap-1.5">
                {terminalStateMet ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> : <Clock3 size={12} className="mt-0.5 shrink-0 text-amber-600" />}
                <span>{isArabic ? `انتهاء معالجة المنافسين (المعلّق: ${readiness.pendingCompetitorCount})` : `Competitor processing finished (pending: ${readiness.pendingCompetitorCount})`}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 text-gray-500 dark:text-gray-300">
              {loading ? <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" /> : <AlertCircle size={12} className="mt-0.5 shrink-0" />}
              <span>{isArabic ? 'لم تتوفر بيانات قائمة التحقق بعد. حدّث الحالة للمحاولة مجددًا.' : 'Checklist data is not available yet. Refresh the status to try again.'}</span>
            </div>
          )}

          {item && ['ready', 'blocked', 'cancelled', 'completed'].includes(item.status) && (
            <div className="mt-2 flex flex-wrap gap-2 border-t border-current/10 pt-2">
              {item.status !== 'ready' && (
                <button
                  type="button"
                  onClick={() => void retry()}
                  disabled={busy !== ''}
                  className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[10px] font-black text-white disabled:opacity-50"
                >
                  {busy === 'retry' ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  {isArabic ? 'إعادة إلى الطابور' : 'Return to queue'}
                </button>
              )}
              {item.status !== 'cancelled' && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  disabled={busy !== ''}
                  className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-[10px] font-black text-red-700 disabled:opacity-50 dark:text-red-300"
                >
                  <XCircle size={11} />
                  {isArabic ? 'إزالة من الطابور' : 'Remove from queue'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && status && (
        <div className="mt-2 flex items-start gap-1.5 rounded bg-red-100 px-2 py-1.5 text-[10px] font-bold text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{getContentWritingAutomationErrorMessage(error, isArabic)}</span>
        </div>
      )}
    </section>
  );
};

export default ContentWritingAutomationArticleStatus;
