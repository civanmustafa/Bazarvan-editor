import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Loader2,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  AI_EXECUTION_ACTIVITY_EVENT,
  formatAiProviderName,
  getAiExecutionActivities,
  getVisibleAiExecutionMessage,
  requestAiExecutionActivityCancel,
  type AiExecutionActivity,
  type AiExecutionState,
} from '../utils/aiExecutionActivity';
import { formatAiKeySuffix } from '../utils/aiKeyUsageFeedback';

const TERMINAL_NOTICE_TTL_MS = 18_000;

const SURFACE_LABELS: Record<string, [string, string]> = {
  semantic_keywords_lsi: ['توليد الصيغ وLSI', 'Alternatives and LSI'],
  smart_analysis: ['التحليل الذكي', 'Smart analysis'],
  quick_provider: ['أمر سريع', 'Quick command'],
  bulk_fix_review: ['مراجعة إصلاح المخالفات', 'Violation repair review'],
  bulk_fix_all: ['إصلاح المخالفات', 'Fix violations'],
  content_writing: ['كتابة المقالة', 'Article writing'],
  engineering_command: ['أمر هندسي جاهز', 'Engineering command'],
  internal_linking_ai_review: ['مراجعة الربط الداخلي', 'Internal-link review'],
  goal_context_generation: ['توليد سياق هدف الصفحة', 'Page goal context'],
  draft_title_generation: ['اقتراح عنوان المقالة', 'Draft title'],
  ready_commands_batch: ['حزمة الأوامر الجاهزة', 'Ready commands bundle'],
  floating_toolbar: ['شريط المحرر العائم', 'Floating editor toolbar'],
  heading_analysis: ['تحليل العناوين', 'Heading analysis'],
  plain_ai_analysis: ['أمر ذكاء اصطناعي مباشر', 'Direct AI command'],
};

const STAGE_LABELS: Record<string, [string, string]> = {
  queued: ['في قائمة التنفيذ', 'Queued'],
  preparing: ['جار التجهيز', 'Preparing'],
  connecting: ['جار الاتصال', 'Connecting'],
  running: ['جار التنفيذ', 'Running'],
  attempting: ['جار تجربة المفتاح', 'Trying key'],
  retrying: ['إعادة المحاولة', 'Retrying'],
  retry_scheduled: ['إعادة المحاولة مجدولة', 'Retry scheduled'],
  resuming: ['جار الاستئناف', 'Resuming'],
  reconnecting: ['إعادة الاتصال بالحالة', 'Reconnecting'],
  cancelling: ['جار طلب الإيقاف', 'Stopping'],
  cancel_requested: ['تم إرسال طلب الإيقاف', 'Stop requested'],
  cancellation_failed: ['تعذر الإيقاف', 'Stop failed'],
  'failed-key': ['فشل المفتاح', 'Key failed'],
  'switching-key': ['الانتقال إلى مفتاح آخر', 'Switching key'],
  'switching-model': ['الانتقال إلى موديل آخر', 'Switching model'],
  'switching-provider': ['الانتقال إلى مزود آخر', 'Switching provider'],
  success: ['نجاح', 'Success'],
  completed: ['مكتمل', 'Completed'],
  failed: ['فشل', 'Failed'],
  cancelled: ['تم الإيقاف', 'Cancelled'],
};

const STATE_LABELS: Record<AiExecutionState, [string, string]> = {
  running: ['مباشر', 'Live'],
  success: ['نجاح', 'Success'],
  failed: ['فشل', 'Failed'],
  cancelled: ['متوقف', 'Stopped'],
};

const stateStyles: Record<AiExecutionState, string> = {
  running: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  failed: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  cancelled: 'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-500/30 dark:bg-gray-500/10 dark:text-gray-300',
};

const getLabel = (
  labels: Record<string, [string, string]>,
  key: string,
  isArabic: boolean,
): string => {
  const normalized = key.trim();
  const pair = labels[normalized];
  if (pair) return pair[isArabic ? 0 : 1];
  return normalized.replace(/[_-]+/g, ' ') || (isArabic ? 'جار التنفيذ' : 'Running');
};

const formatDuration = (startedAt: string, completedAt: string | undefined, now: number): string => {
  const started = new Date(startedAt).getTime();
  const ended = completedAt ? new Date(completedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((ended - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

const formatLastUpdateAge = (updatedAt: string, now: number, isArabic: boolean): string => {
  const updated = new Date(updatedAt).getTime();
  const seconds = Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 1_000)) : 0;
  if (seconds < 5) return isArabic ? 'الآن' : 'now';
  if (seconds < 60) return isArabic ? `منذ ${seconds} ث` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return isArabic ? `منذ ${minutes} د` : `${minutes}m ago`;
};

const StatusIcon: React.FC<{ state: AiExecutionState }> = ({ state }) => {
  if (state === 'running') return <Loader2 size={13} className="animate-spin" />;
  if (state === 'success') return <CheckCircle2 size={13} />;
  return <XCircle size={13} />;
};

const AiExecutionMonitor: React.FC = () => {
  const { uiLanguage } = useUser();
  const isArabic = uiLanguage !== 'en';
  const [activities, setActivities] = useState<AiExecutionActivity[]>(() => getAiExecutionActivities());
  const [now, setNow] = useState(Date.now());
  const [cancellingId, setCancellingId] = useState('');
  const [cancelError, setCancelError] = useState('');

  useEffect(() => {
    const handleActivity = (event: Event) => {
      const incoming = (event as CustomEvent<AiExecutionActivity>).detail;
      if (!incoming?.id) return;
      setActivities(current => [
        incoming,
        ...current.filter(activity => activity.id !== incoming.id),
      ].slice(0, 8));
      setCancelError('');

      if (incoming.state !== 'running') {
        const terminalUpdatedAt = incoming.updatedAt;
        window.setTimeout(() => {
          setActivities(current => current.filter(activity => (
            activity.id !== incoming.id
            || activity.state === 'running'
            || activity.updatedAt !== terminalUpdatedAt
          )));
        }, TERMINAL_NOTICE_TTL_MS);
      }
    };
    window.addEventListener(AI_EXECUTION_ACTIVITY_EVENT, handleActivity);
    return () => window.removeEventListener(AI_EXECUTION_ACTIVITY_EVENT, handleActivity);
  }, []);

  useEffect(() => {
    if (!activities.some(activity => activity.state === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activities]);

  // The first activity is always the one with the latest live update. Keeping the
  // monitor in one row prevents a detached popup from covering editor controls.
  const selected = activities[0];
  if (!selected) return null;

  const activeCount = activities.filter(activity => activity.state === 'running').length;
  const succeededKeys = selected.entries.filter(entry => entry.outcome === 'success').length;
  const failedKeys = selected.entries.filter(entry => entry.outcome === 'failed').length;
  const tierLabel = selected.credentialTier === 'free'
    ? (isArabic ? 'مجاني' : 'Free')
    : selected.credentialTier === 'paid'
      ? (isArabic ? 'مدفوع' : 'Paid')
      : (isArabic ? 'غير محدد' : 'Unknown');
  const requestedProviderChanged = formatAiProviderName(selected.requestedProvider) !== formatAiProviderName(selected.provider);
  const requestedModelChanged = Boolean(
    selected.requestedModel
    && selected.model
    && selected.requestedModel !== selected.model,
  );
  const sourceLabel = selected.surface
    ? getLabel(SURFACE_LABELS, selected.surface, isArabic)
    : (isArabic ? 'داخل المحرر' : 'Inside the editor');
  const actionLabel = selected.action || sourceLabel;
  const stageLabel = selected.state === 'running'
    ? getLabel(STAGE_LABELS, selected.stage, isArabic)
    : STATE_LABELS[selected.state][isArabic ? 0 : 1];
  const visibleMessage = getVisibleAiExecutionMessage(selected, actionLabel, sourceLabel);
  const lastUpdateTime = new Date(selected.updatedAt).getTime();
  const isStale = selected.state === 'running'
    && Number.isFinite(lastUpdateTime)
    && now - lastUpdateTime >= 60_000;
  const isCancelling = cancellingId === selected.id
    || selected.stage === 'cancelling'
    || selected.stage === 'cancel_requested';

  const handleCancel = async () => {
    if (!selected.cancellable || isCancelling) return;
    setCancellingId(selected.id);
    setCancelError('');
    try {
      await requestAiExecutionActivityCancel(selected.id);
    } catch (error) {
      setCancelError(error instanceof Error
        ? error.message
        : (isArabic ? 'تعذر إيقاف العملية.' : 'Could not stop the operation.'));
    } finally {
      setCancellingId('');
    }
  };

  return (
    <div
      data-ai-execution-monitor="inline"
      className="flex min-h-10 shrink-0 items-center border-x border-b border-gray-300 bg-white px-2 text-[10px] font-bold text-gray-600 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-300"
      dir={isArabic ? 'rtl' : 'ltr'}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap py-1.5 custom-scrollbar">
        <span className="inline-flex shrink-0 items-center gap-1 font-black text-gray-800 dark:text-gray-100">
          <Activity size={14} className="text-[#b8922e]" />
          {isArabic ? 'الذكاء الاصطناعي' : 'AI'}
        </span>

        <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-black ${stateStyles[selected.state]}`}>
          <StatusIcon state={selected.state} />
          {stageLabel}
        </span>

        <span className="max-w-44 shrink-0 truncate font-black text-gray-700 dark:text-gray-100" title={`${actionLabel} · ${sourceLabel}`}>
          {actionLabel}
          {actionLabel !== sourceLabel ? ` · ${sourceLabel}` : ''}
          {activeCount > 1 ? ` · +${activeCount - 1}` : ''}
        </span>

        <span className="shrink-0 text-gray-300 dark:text-gray-600">|</span>
        <span className="shrink-0">
          {isArabic ? 'المزوّد' : 'Provider'}: <strong>{formatAiProviderName(selected.provider)}</strong>
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-black ${
          selected.credentialTier === 'free'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200'
            : selected.credentialTier === 'paid'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
              : 'bg-gray-200 text-gray-600 dark:bg-gray-500/15 dark:text-gray-300'
        }`}>
          <CircleDollarSign size={10} />
          {tierLabel}
        </span>
        {requestedProviderChanged && (
          <span className="shrink-0 text-amber-600 dark:text-amber-300">
            {isArabic ? 'الأولوية' : 'Preferred'}: <strong>{formatAiProviderName(selected.requestedProvider)}</strong>
          </span>
        )}

        <span className="shrink-0 text-gray-300 dark:text-gray-600">|</span>
        <span className="shrink-0" dir="ltr">
          <strong>{selected.model || selected.requestedModel || (isArabic ? 'بانتظار الموديل' : 'Model pending')}</strong>
          {requestedModelChanged ? ` ← ${selected.requestedModel}` : ''}
          {selected.currentModelIndex && selected.modelCount
            ? ` (${selected.currentModelIndex}/${selected.modelCount})`
            : ''}
        </span>

        <span className="shrink-0 text-gray-300 dark:text-gray-600">|</span>
        <span className="shrink-0" dir="ltr">
          {selected.keySuffix ? formatAiKeySuffix(selected.keySuffix) : (isArabic ? 'بانتظار المفتاح' : 'Key pending')}
          {selected.currentKeyIndex && selected.keyCount
            ? ` (${selected.currentKeyIndex}/${selected.keyCount})`
            : ''}
        </span>
        {failedKeys > 0 && (
          <span className="shrink-0 text-red-600 dark:text-red-300">
            {isArabic ? 'فشل' : 'Failed'} {failedKeys}
          </span>
        )}
        {succeededKeys > 0 && (
          <span className="shrink-0 text-emerald-600 dark:text-emerald-300">
            {isArabic ? 'نجح' : 'Succeeded'} {succeededKeys}
          </span>
        )}
        {selected.httpStatus && (
          <span className="shrink-0 font-mono" dir="ltr">HTTP {selected.httpStatus}</span>
        )}

        <span className="inline-flex shrink-0 items-center gap-1 font-mono" dir="ltr">
          <Clock3 size={10} />
          {formatDuration(selected.startedAt, selected.completedAt, now)}
        </span>
        <span className={`shrink-0 ${isStale ? 'text-amber-600 dark:text-amber-300' : ''}`}>
          {isArabic ? 'آخر تحديث' : 'Updated'}: {formatLastUpdateAge(selected.updatedAt, now, isArabic)}
        </span>

        {visibleMessage && (
          <span className={`min-w-32 max-w-72 truncate ${
            selected.state === 'failed'
              ? 'text-red-600 dark:text-red-300'
              : 'text-blue-700 dark:text-blue-200'
          }`} title={visibleMessage}>
            {visibleMessage}
          </span>
        )}
        {cancelError && (
          <span className="min-w-32 max-w-72 truncate text-red-600 dark:text-red-300" title={cancelError}>
            {cancelError}
          </span>
        )}
      </div>

      {selected.state === 'running' && (
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={!selected.cancellable || isCancelling}
          className="ms-2 inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 font-black text-red-700 hover:bg-red-100 disabled:cursor-wait disabled:opacity-60 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
          title={!selected.cancellable
            ? (isArabic ? 'سيصبح الإيقاف متاحًا بعد إنشاء المهمة على الخادم' : 'Stop becomes available after the server task is created')
            : undefined}
        >
          {isCancelling ? <Loader2 size={11} className="animate-spin" /> : <Square size={10} fill="currentColor" />}
          {isCancelling
            ? (isArabic ? 'جار الإيقاف' : 'Stopping')
            : (isArabic ? 'إيقاف' : 'Stop')}
        </button>
      )}

      <button
        type="button"
        onClick={() => setActivities(current => current.filter(activity => activity.id !== selected.id))}
        className="ms-1 flex size-6 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-[#333] dark:hover:text-gray-100"
        aria-label={isArabic ? 'إخفاء الإشعار فقط' : 'Hide notification only'}
        title={isArabic ? 'إخفاء الإشعار فقط؛ لا يوقف العملية' : 'Hide notification only; the operation keeps running'}
      >
        <X size={12} />
      </button>
    </div>
  );
};

export default AiExecutionMonitor;
