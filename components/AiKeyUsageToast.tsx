import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  KeyRound,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  AI_EXECUTION_ACTIVITY_EVENT,
  formatAiProviderName,
  getAiExecutionActivities,
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

const getFailureReason = (reason: string | undefined, isArabic: boolean): string => {
  const normalized = String(reason || '').trim();
  if (!normalized) return '';
  if (!isArabic) return normalized;
  const token = normalized.toLowerCase();
  if (token.includes('quota') || token.includes('429')) return 'تجاوز الحصة أو كثرة الطلبات';
  if (token.includes('auth') || token.includes('401') || token.includes('403')) return 'المفتاح غير صالح أو غير مصرح';
  if (token.includes('timeout') || token.includes('timed out')) return 'انتهت مهلة الاتصال';
  if (token.includes('blocked')) return 'المفتاح محظور لدى المزود';
  return normalized;
};

const formatDuration = (startedAt: string, completedAt: string | undefined, now: number): string => {
  const started = new Date(startedAt).getTime();
  const ended = completedAt ? new Date(completedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((ended - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

const StatusIcon: React.FC<{ state: AiExecutionState }> = ({ state }) => {
  if (state === 'running') return <Loader2 size={15} className="animate-spin" />;
  if (state === 'success') return <CheckCircle2 size={15} />;
  if (state === 'failed') return <XCircle size={15} />;
  return <XCircle size={15} />;
};

const AiExecutionMonitor: React.FC = () => {
  const { uiLanguage } = useUser();
  const isArabic = uiLanguage !== 'en';
  const [activities, setActivities] = useState<AiExecutionActivity[]>(() => getAiExecutionActivities());
  const [selectedId, setSelectedId] = useState(() => activities[0]?.id || '');
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const handleActivity = (event: Event) => {
      const incoming = (event as CustomEvent<AiExecutionActivity>).detail;
      if (!incoming?.id) return;
      setActivities(current => {
        const next = [
          incoming,
          ...current.filter(activity => activity.id !== incoming.id),
        ].slice(0, 8);
        return next;
      });
      setSelectedId(current => {
        if (!current || ['queued', 'preparing', 'connecting', 'resuming'].includes(incoming.stage)) {
          return incoming.id;
        }
        return current;
      });
      if (incoming.state !== 'running') {
        const terminalUpdatedAt = incoming.updatedAt;
        window.setTimeout(() => {
          setActivities(current => current.filter(activity => (
            activity.id !== incoming.id
            || activity.state === 'running'
            || activity.updatedAt !== terminalUpdatedAt
          )));
          setSelectedId(current => current === incoming.id ? '' : current);
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

  useEffect(() => {
    if (selectedId && activities.some(activity => activity.id === selectedId)) return;
    setSelectedId(activities[0]?.id || '');
  }, [activities, selectedId]);

  const selected = activities.find(activity => activity.id === selectedId) || activities[0];
  const activeCount = activities.filter(activity => activity.state === 'running').length;
  const orderedEntries = useMemo(() => {
    if (!selected) return [];
    return [...selected.entries].sort((left, right) => {
      if (left.outcome === right.outcome) return 0;
      return left.outcome === 'failed' ? -1 : 1;
    });
  }, [selected]);

  if (!selected) return null;

  const succeededKeys = selected.entries.filter(entry => entry.outcome === 'success').length;
  const failedKeys = selected.entries.filter(entry => entry.outcome === 'failed').length;
  const tierLabel = selected.credentialTier === 'free'
    ? (isArabic ? 'مجاني' : 'Free')
    : selected.credentialTier === 'paid'
      ? (isArabic ? 'مدفوع' : 'Paid')
      : (isArabic ? 'غير محدد' : 'Unknown');
  const requestedProviderChanged = formatAiProviderName(selected.requestedProvider) !== formatAiProviderName(selected.provider);
  const requestedModelChanged = selected.requestedModel
    && selected.model
    && selected.requestedModel !== selected.model;
  const surfaceLabel = selected.action
    || getLabel(SURFACE_LABELS, selected.surface, isArabic);
  const keyStatus = selected.state === 'running'
    ? selected.currentKeyIndex && selected.keyCount
      ? `${isArabic ? 'تجربة المفتاح' : 'Trying key'} ${selected.currentKeyIndex}/${selected.keyCount}`
      : (isArabic ? 'بانتظار بيانات المفتاح' : 'Waiting for key details')
    : selected.state === 'success'
      ? (isArabic ? 'اكتمل الطلب بنجاح' : 'Request completed successfully')
      : selected.state === 'cancelled'
        ? (isArabic ? 'تم إيقاف الطلب' : 'Request stopped')
        : (isArabic ? 'لم ينجح الطلب' : 'Request failed');

  return (
    <div
      className="fixed bottom-4 left-4 z-[10000] w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-[#3C3C3C] dark:bg-[#242424]"
      dir={isArabic ? 'rtl' : 'ltr'}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2.5 dark:border-[#333]">
        <Activity size={16} className="shrink-0 text-[#b8922e]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-black text-gray-800 dark:text-gray-100">
            {isArabic ? 'حالة اتصال الذكاء الاصطناعي' : 'AI connection status'}
          </div>
          <div className="truncate text-[10px] font-bold text-gray-400">
            {surfaceLabel || (isArabic ? 'عملية داخل المحرر' : 'Editor operation')}
            {activeCount > 1 ? ` · ${activeCount} ${isArabic ? 'عمليات مباشرة' : 'live operations'}` : ''}
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-black ${stateStyles[selected.state]}`}>
          <StatusIcon state={selected.state} />
          {STATE_LABELS[selected.state][isArabic ? 0 : 1]}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(current => !current)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-[#333] dark:hover:text-gray-100"
          aria-label={collapsed ? (isArabic ? 'توسيع' : 'Expand') : (isArabic ? 'تصغير' : 'Collapse')}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          type="button"
          onClick={() => setActivities(current => current.filter(activity => activity.id !== selected.id))}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-[#333] dark:hover:text-gray-100"
          aria-label={isArabic ? 'إغلاق' : 'Close'}
        >
          <X size={14} />
        </button>
      </div>

      {!collapsed && (
        <>
          {activities.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-gray-100 px-2 py-1.5 custom-scrollbar dark:border-[#333]">
              {activities.slice(0, 5).map(activity => (
                <button
                  key={activity.id}
                  type="button"
                  onClick={() => setSelectedId(activity.id)}
                  className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[9px] font-black ${
                    activity.id === selected.id
                      ? 'bg-[#d4af37]/15 text-[#8a6f1d] dark:text-[#f2d675]'
                      : 'bg-gray-50 text-gray-500 hover:bg-gray-100 dark:bg-[#2d2d2d] dark:text-gray-300 dark:hover:bg-[#333]'
                  }`}
                >
                  <StatusIcon state={activity.state} />
                  <span className="max-w-28 truncate">
                    {activity.action || getLabel(SURFACE_LABELS, activity.surface, isArabic)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2.5 p-3">
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-lg bg-gray-50 p-2 dark:bg-[#1d1d1d]">
                <div className="mb-1 font-bold text-gray-400">{isArabic ? 'المزوّد والنوع' : 'Provider and tier'}</div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-black text-gray-700 dark:text-gray-100">{formatAiProviderName(selected.provider)}</span>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-black ${
                    selected.credentialTier === 'free'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200'
                      : selected.credentialTier === 'paid'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
                        : 'bg-gray-200 text-gray-600 dark:bg-gray-500/15 dark:text-gray-300'
                  }`}>
                    <CircleDollarSign size={11} />
                    {tierLabel}
                  </span>
                </div>
                {requestedProviderChanged && (
                  <div className="mt-1 truncate font-bold text-amber-600 dark:text-amber-300">
                    {isArabic ? 'الأولوية' : 'Preferred'}: {formatAiProviderName(selected.requestedProvider)}
                  </div>
                )}
              </div>

              <div className="rounded-lg bg-gray-50 p-2 dark:bg-[#1d1d1d]">
                <div className="mb-1 font-bold text-gray-400">{isArabic ? 'الموديل' : 'Model'}</div>
                <div className="truncate font-mono font-black text-gray-700 dark:text-gray-100" dir="ltr">
                  {selected.model || selected.requestedModel || (isArabic ? 'بانتظار التحديد' : 'Pending')}
                </div>
                {requestedModelChanged && (
                  <div className="mt-1 truncate font-mono font-bold text-amber-600 dark:text-amber-300" dir="ltr">
                    {selected.requestedModel}
                  </div>
                )}
              </div>

              <div className="rounded-lg bg-gray-50 p-2 dark:bg-[#1d1d1d]">
                <div className="mb-1 flex items-center gap-1 font-bold text-gray-400">
                  <KeyRound size={11} />
                  {isArabic ? 'المفتاح الحالي' : 'Current key'}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono font-black text-gray-700 dark:text-gray-100" dir="ltr">
                    {selected.keySuffix ? formatAiKeySuffix(selected.keySuffix) : (isArabic ? 'لم يظهر بعد' : 'Not available yet')}
                  </span>
                  {selected.currentKeyIndex && selected.keyCount && (
                    <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-black text-gray-500 dark:bg-[#2d2d2d] dark:text-gray-300">
                      {selected.currentKeyIndex}/{selected.keyCount}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg bg-gray-50 p-2 dark:bg-[#1d1d1d]">
                <div className="mb-1 font-bold text-gray-400">{isArabic ? 'حالة المفاتيح' : 'Key status'}</div>
                <div className="truncate font-black text-gray-700 dark:text-gray-100">{keyStatus}</div>
                {(failedKeys > 0 || succeededKeys > 0) && (
                  <div className="mt-1 flex gap-2 font-black">
                    {failedKeys > 0 && <span className="text-red-600 dark:text-red-300">{isArabic ? 'فشل' : 'Failed'} {failedKeys}</span>}
                    {succeededKeys > 0 && <span className="text-emerald-600 dark:text-emerald-300">{isArabic ? 'نجح' : 'Succeeded'} {succeededKeys}</span>}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-gray-500 dark:text-gray-300">
              <span className={`rounded-md border px-2 py-1 ${stateStyles[selected.state]}`}>
                {getLabel(STAGE_LABELS, selected.stage, isArabic)}
              </span>
              {selected.currentModelIndex && selected.modelCount && (
                <span className="rounded-md bg-gray-100 px-2 py-1 dark:bg-[#333]">
                  {isArabic ? 'الموديل' : 'Model'} {selected.currentModelIndex}/{selected.modelCount}
                </span>
              )}
              {selected.totalAttemptCount && (
                <span className="rounded-md bg-gray-100 px-2 py-1 dark:bg-[#333]">
                  {isArabic ? 'المحاولات' : 'Attempts'} {selected.totalAttemptCount}
                </span>
              )}
              {selected.httpStatus && (
                <span className="rounded-md bg-gray-100 px-2 py-1 font-mono dark:bg-[#333]" dir="ltr">
                  HTTP {selected.httpStatus}
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 font-mono dark:bg-[#333]" dir="ltr">
                <Clock3 size={10} />
                {formatDuration(selected.startedAt, selected.completedAt, now)}
              </span>
            </div>

            {selected.message && (
              <div className={`rounded-lg px-2.5 py-2 text-[10px] font-bold leading-5 ${
                selected.state === 'failed'
                  ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200'
                  : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'
              }`}>
                {selected.message}
              </div>
            )}

            {orderedEntries.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-black text-gray-500 dark:text-gray-300">
                  {isArabic ? 'سجل محاولات المفاتيح' : 'Key attempt history'}
                </div>
                <div className="max-h-32 space-y-1 overflow-y-auto custom-scrollbar">
                  {orderedEntries.map((entry, index) => (
                    <div
                      key={`${entry.outcome}-${entry.keySuffix}-${entry.status || 0}-${entry.model || ''}-${index}`}
                      className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-[10px] font-bold ${
                        entry.outcome === 'success'
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
                          : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200'
                      }`}
                    >
                      {entry.outcome === 'success'
                        ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                        : <XCircle size={12} className="mt-0.5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            {entry.outcome === 'success'
                              ? (isArabic ? 'نجح المفتاح' : 'Key succeeded')
                              : (isArabic ? 'فشل المفتاح' : 'Key failed')}
                          </span>
                          <span className="font-mono font-black" dir="ltr">{formatAiKeySuffix(entry.keySuffix)}</span>
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 opacity-80">
                          {entry.model && <span className="truncate font-mono" dir="ltr">{entry.model}</span>}
                          {entry.status && <span className="shrink-0 font-mono" dir="ltr">HTTP {entry.status}</span>}
                        </div>
                        {entry.outcome === 'failed' && getFailureReason(entry.reason, isArabic) && (
                          <div className="mt-0.5 truncate opacity-80">{getFailureReason(entry.reason, isArabic)}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AiExecutionMonitor;
