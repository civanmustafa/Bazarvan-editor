import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  FilePlus2,
  LocateFixed,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Tags,
  Trash2,
} from 'lucide-react';
import { useAISelector } from '../contexts/AIContext';
import { useUser } from '../contexts/UserContext';
import { getExternalReadyCommandLabel } from '../constants/externalAnalysisCommands';
import { copyMarkdownToClipboard, parseMarkdownToHtml } from '../utils/editorUtils';
import { getSupabaseClient, isSupabaseConfigured } from '../utils/supabaseClient';
import {
  cancelExternalAnalysisJob,
  enqueueExternalEngineeringAnalysis,
  enqueueExternalSemanticAnalysis,
  EXTERNAL_ANALYSIS_ACTIVE_STATUSES,
  getExternalJobAnalysisMarkdown,
  listExternalAnalysisJobs,
  toExternalAiPatches,
  type ExternalAnalysisJobRow,
  type ExternalAnalysisJobStatus,
} from '../utils/externalAnalysis';
import type { AiContentPatch } from '../types';

interface ExternalAnalysisResultsTabProps {
  articleId: string | null;
}

type ResultFilter = 'all' | 'active' | 'completed';

const STATUS_LABELS: Record<ExternalAnalysisJobStatus, { ar: string; en: string }> = {
  waiting_for_prerequisites: { ar: 'بانتظار المتطلبات', en: 'Waiting for prerequisites' },
  queued: { ar: 'في قائمة الانتظار', en: 'Queued' },
  running: { ar: 'قيد التنفيذ', en: 'Running' },
  retry_scheduled: { ar: 'إعادة المحاولة مجدولة', en: 'Retry scheduled' },
  completed: { ar: 'مكتمل', en: 'Completed' },
  failed: { ar: 'فشل', en: 'Failed' },
  blocked: { ar: 'متوقف', en: 'Blocked' },
  cancelled: { ar: 'ملغي', en: 'Cancelled' },
  paused: { ar: 'متوقف مؤقتًا', en: 'Paused' },
};

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const statusClassName = (status: ExternalAnalysisJobStatus): string => {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
  if (status === 'running') return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300';
  if (status === 'retry_scheduled' || status === 'waiting_for_prerequisites' || status === 'queued') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
  }
  if (status === 'failed' || status === 'blocked') return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-500/15 dark:text-gray-300';
};

const normalizeMarker = (value?: string): string => (
  (value || '')
    .replace(/^\s*\[\[PATCH:/i, '')
    .replace(/\]\]\s*$/i, '')
    .trim()
);

const ExternalAnalysisResultsTab: React.FC<ExternalAnalysisResultsTabProps> = ({ articleId }) => {
  const { t } = useUser();
  const locale = t.locale === 'en' ? 'en' : 'ar';
  const applyAiContentPatch = useAISelector(context => context.applyAiContentPatch);
  const selectAiContentPatchTarget = useAISelector(context => context.selectAiContentPatchTarget);
  const deleteAiPatchMergeDeleteTarget = useAISelector(context => context.deleteAiPatchMergeDeleteTarget);
  const selectAiPatchMergeDeleteTarget = useAISelector(context => context.selectAiPatchMergeDeleteTarget);
  const [jobs, setJobs] = useState<ExternalAnalysisJobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(() => new Set());
  const [patchOverrides, setPatchOverrides] = useState<Record<string, Partial<AiContentPatch>>>({});
  const [copiedId, setCopiedId] = useState('');
  const [jobActionId, setJobActionId] = useState('');
  const [controlNotice, setControlNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const refreshRequestRef = useRef(0);

  const refreshJobs = useCallback(async (showLoading = false) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (!articleId || !isSupabaseConfigured) {
      if (refreshRequestRef.current === requestId) {
        setJobs([]);
        setLoading(false);
      }
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const rows = (await listExternalAnalysisJobs(articleId))
        .filter(job => job.job_type !== 'competitor_extraction');
      if (refreshRequestRef.current !== requestId) return;
      setJobs(rows);
      setError('');
      setExpandedJobIds(current => {
        if (current.size > 0) return current;
        const latestCompleted = rows.find(job => job.job_type === 'engineering_command' && job.status === 'completed');
        return latestCompleted ? new Set([latestCompleted.id]) : current;
      });
    } catch (loadError) {
      if (refreshRequestRef.current !== requestId) return;
      console.error('Failed to load external analysis results:', loadError);
      setError(loadError instanceof Error ? loadError.message : 'Could not load external analysis results.');
    } finally {
      if (showLoading && refreshRequestRef.current === requestId) setLoading(false);
    }
  }, [articleId]);

  useEffect(() => {
    setJobs([]);
    setPatchOverrides({});
    setExpandedJobIds(new Set());
    setFilter('all');
    setJobActionId('');
    setControlNotice(null);
    void refreshJobs(true);
  }, [articleId, refreshJobs]);

  useEffect(() => {
    if (!articleId || !isSupabaseConfigured) return;
    const hasActiveJobs = jobs.some(job => EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status));
    const intervalId = window.setInterval(() => {
      void refreshJobs(false);
    }, hasActiveJobs ? 6_000 : 30_000);
    return () => window.clearInterval(intervalId);
  }, [articleId, jobs, refreshJobs]);

  useEffect(() => {
    if (!articleId || !isSupabaseConfigured) return;
    const supabase = getSupabaseClient();
    let refreshTimer: number | null = null;
    const channel = supabase
      .channel(`external-analysis-results-${articleId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ai_external_analysis_jobs',
          filter: `article_id=eq.${articleId}`,
        },
        () => {
          if (refreshTimer !== null) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            void refreshJobs(false);
          }, 300);
        },
      )
      .subscribe();
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [articleId, refreshJobs]);

  const semanticJobs = jobs.filter(job => job.job_type === 'semantic_keywords_lsi');
  const latestSemanticJob = semanticJobs[0] || null;
  const latestSemanticGenerated = isRecord(latestSemanticJob?.result?.generated)
    ? latestSemanticJob.result.generated
    : null;
  const engineeringJobs = useMemo(() => jobs.filter(job => {
    if (job.job_type !== 'engineering_command') return false;
    if (filter === 'active') return EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status);
    if (filter === 'completed') return job.status === 'completed';
    return true;
  }), [filter, jobs]);

  const batches = useMemo(() => {
    const grouped = new Map<string, ExternalAnalysisJobRow[]>();
    engineeringJobs.forEach(job => {
      const key = job.batch_key || job.id;
      grouped.set(key, [...(grouped.get(key) || []), job]);
    });
    return Array.from(grouped.entries())
      .map(([key, batchJobs]) => ({
        key,
        jobs: batchJobs.sort((left, right) => left.sequence_number - right.sequence_number),
        createdAt: batchJobs.map(job => job.created_at).sort().at(-1) || '',
      }))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }, [engineeringJobs]);

  const formatDate = (value?: string | null): string => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const updatePatch = (patchId: string, update: Partial<AiContentPatch>) => {
    setPatchOverrides(current => ({
      ...current,
      [patchId]: { ...(current[patchId] || {}), ...update },
    }));
  };

  const getPatches = (job: ExternalAnalysisJobRow): AiContentPatch[] => (
    toExternalAiPatches(job).map(patch => ({ ...patch, ...(patchOverrides[patch.id] || {}) }))
  );

  const handleCopy = async (id: string, text: string) => {
    try {
      await copyMarkdownToClipboard(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(current => current === id ? '' : current), 1500);
    } catch (copyError) {
      console.error('Could not copy external analysis content:', copyError);
    }
  };

  const handleCancelJob = async (job: ExternalAnalysisJobRow) => {
    if (!articleId || jobActionId || !EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status)) return;
    setJobActionId(job.id);
    setControlNotice(null);
    try {
      await cancelExternalAnalysisJob(articleId, job.id);
      setControlNotice({
        tone: 'success',
        message: locale === 'ar'
          ? 'تم طلب إيقاف المهمة. ستتوقف المهمة الجارية خلال ثوانٍ، وألغيت المهام التابعة المنتظرة.'
          : 'Cancellation requested. The running task will stop shortly, and queued dependent tasks were cancelled.',
      });
      await refreshJobs(false);
    } catch (cancelError) {
      setControlNotice({
        tone: 'error',
        message: cancelError instanceof Error
          ? cancelError.message
          : (locale === 'ar' ? 'تعذر إيقاف المهمة.' : 'Could not cancel the task.'),
      });
    } finally {
      setJobActionId('');
    }
  };

  const handleRetryJob = async (job: ExternalAnalysisJobRow) => {
    if (!articleId || jobActionId || !['failed', 'blocked', 'cancelled'].includes(job.status)) return;
    setJobActionId(job.id);
    setControlNotice(null);
    try {
      if (job.job_type === 'semantic_keywords_lsi') {
        await enqueueExternalSemanticAnalysis(articleId);
      } else if (job.command_id) {
        await enqueueExternalEngineeringAnalysis(articleId, [job.command_id]);
      } else {
        throw new Error(locale === 'ar' ? 'لا يوجد أمر محفوظ لإعادة تشغيل هذه المهمة.' : 'No saved command is available for this task.');
      }
      setControlNotice({
        tone: 'success',
        message: locale === 'ar'
          ? 'تم إنشاء محاولة جديدة وستعمل في الخلفية.'
          : 'A new attempt was queued and will run in the background.',
      });
      await refreshJobs(false);
    } catch (retryError) {
      setControlNotice({
        tone: 'error',
        message: retryError instanceof Error
          ? retryError.message
          : (locale === 'ar' ? 'تعذر إعادة تشغيل المهمة.' : 'Could not restart the task.'),
      });
    } finally {
      setJobActionId('');
    }
  };

  const handleSelectPatch = (patch: AiContentPatch) => {
    const result = selectAiContentPatchTarget(patch);
    updatePatch(patch.id, result.error
      ? { status: 'failed', applyError: result.error }
      : { status: patch.status === 'failed' ? 'pending' : patch.status, applyError: undefined, resolvedTarget: result.target });
  };

  const handleApplyPatch = (patch: AiContentPatch) => {
    const result = applyAiContentPatch(patch);
    updatePatch(patch.id, {
      status: result.status,
      applyError: result.status === 'failed' ? result.error : undefined,
    });
  };

  const handleSelectMergeDelete = (patch: AiContentPatch) => {
    const result = selectAiPatchMergeDeleteTarget(patch);
    updatePatch(patch.id, result.error
      ? { mergeDeleteStatus: 'failed', mergeDeleteApplyError: result.error }
      : { mergeDeleteStatus: patch.mergeDeleteStatus === 'failed' ? 'pending' : patch.mergeDeleteStatus, mergeDeleteApplyError: undefined });
  };

  const handleDeleteMergeTarget = (patch: AiContentPatch) => {
    const result = deleteAiPatchMergeDeleteTarget(patch);
    updatePatch(patch.id, {
      mergeDeleteStatus: result.status,
      mergeDeleteApplyError: result.status === 'failed' ? result.error : undefined,
    });
  };

  const renderPatch = (patch: AiContentPatch) => {
    const isDeletePatch = patch.operation === 'delete_block';
    const isReplacePatch = patch.operation === 'replace_block' || patch.operation === 'replace_text';
    const actionLabel = isReplacePatch
      ? (locale === 'ar' ? 'استبدال' : 'Replace')
      : isDeletePatch
        ? (locale === 'ar' ? 'حذف' : 'Delete')
        : (locale === 'ar' ? 'إضافة' : 'Insert');
    const cleanTitle = (patch.title || (locale === 'ar' ? 'نص مقترح' : 'Suggested text'))
      .replace(/^(?:إضافة|اضافة|استبدال|حذف|add|insert|replace|delete)\s*(?:-|:|\u2013)\s*/i, '')
      .trim() || (locale === 'ar' ? 'نص مقترح' : 'Suggested text');
    const reason = patch.reason || (locale === 'ar' ? 'سبب الاقتراح غير محدد.' : 'No reason was provided.');
    const reasonLabel = isDeletePatch
      ? (locale === 'ar' ? 'سبب الحذف' : 'Deletion reason')
      : isReplacePatch
        ? (locale === 'ar' ? 'سبب الاستبدال' : 'Replacement reason')
        : (locale === 'ar' ? 'سبب إضافة النص المقترح' : 'Reason for adding');
    const hasMergeDeleteTarget = Boolean(
      patch.mergeDeleteTargetText?.trim()
      || patch.mergeDeleteAnchorText?.trim()
      || patch.mergeDeletePlacementLabel?.trim(),
    );
    const location = patch.placementLabel || patch.anchorText || patch.targetText
      || (locale === 'ar' ? 'لم يتم تحديد موضع نصي دقيق.' : 'No exact text location was provided.');
    const copyText = isDeletePatch
      ? (patch.targetText || patch.anchorText || patch.placementLabel || '')
      : patch.contentMarkdown;

    return (
      <div key={patch.id} className="my-3 rounded-md border border-[#d4af37]/25 bg-white/80 p-2 dark:border-[#d4af37]/30 dark:bg-[#1F1F1F]/80">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-black text-gray-800 dark:text-gray-100">{actionLabel} - {cleanTitle}</div>
            <div className="mt-1.5 text-[11px] leading-5 text-gray-600 dark:text-gray-300">
              <span className="font-black text-[#8a6f1d] dark:text-[#f2d675]">{reasonLabel}: </span>
              {reason}
            </div>
            <div className="mt-1 break-words text-[10px] leading-5 text-gray-500 dark:text-gray-400">
              <span className="font-bold">{locale === 'ar' ? 'مكان النص في المحرر' : 'Editor location'}: </span>
              {location}
            </div>
          </div>
          {patch.status === 'applied' && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-black text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 size={13} /> {locale === 'ar' ? 'تم' : 'Done'}
            </span>
          )}
          {patch.status === 'failed' && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-black text-red-600 dark:text-red-300">
              <AlertTriangle size={13} /> {locale === 'ar' ? 'تعذر' : 'Failed'}
            </span>
          )}
        </div>

        <div className={`mt-2 rounded-md border p-2 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] ${isDeletePatch ? 'border-red-100 bg-red-50/60' : 'border-gray-100 bg-gray-50/80'}`}>
          <div className="mb-1 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
            {isDeletePatch
              ? (locale === 'ar' ? 'النص المراد حذفه' : 'Text to delete')
              : (locale === 'ar' ? 'النص المقترح' : 'Suggested text')}
          </div>
          {isDeletePatch ? (
            <div className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-gray-800 dark:text-gray-100">
              {patch.targetText || location}
            </div>
          ) : (
            <div className="ai-output text-[11px] leading-6 text-gray-800 dark:text-gray-100" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }} />
          )}
        </div>

        {hasMergeDeleteTarget && (
          <div className="mt-2 border-t border-red-200 pt-2 text-[11px] dark:border-red-900/40">
            <div className="font-bold text-red-700 dark:text-red-300">{locale === 'ar' ? 'الفقرة المدمجة المطلوب حذفها' : 'Merged paragraph to remove'}</div>
            <div className="mt-1 text-gray-600 dark:text-gray-300">{patch.mergeDeletePlacementLabel || patch.mergeDeleteAnchorText || patch.mergeDeleteTargetText}</div>
            {patch.mergeDeleteApplyError && <div className="mt-1 text-red-600 dark:text-red-300">{patch.mergeDeleteApplyError}</div>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => handleSelectMergeDelete(patch)} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[10px] font-bold text-gray-700 hover:bg-red-50 dark:bg-[#333] dark:text-gray-200">
                <LocateFixed size={12} /> {locale === 'ar' ? 'موضع الحذف' : 'Locate removal'}
              </button>
              <button type="button" onClick={() => handleDeleteMergeTarget(patch)} disabled={patch.mergeDeleteStatus === 'applied'} className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-red-700 disabled:opacity-50">
                <Trash2 size={12} /> {patch.mergeDeleteStatus === 'applied' ? (locale === 'ar' ? 'تم الحذف' : 'Removed') : (locale === 'ar' ? 'حذف الفقرة' : 'Remove paragraph')}
              </button>
            </div>
          </div>
        )}

        {patch.applyError && <div className="mt-1 text-[10px] font-bold text-red-600 dark:text-red-300">{patch.applyError}</div>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={() => handleSelectPatch(patch)} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[10px] font-bold text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#333] dark:text-gray-200">
            <LocateFixed size={12} /> {locale === 'ar' ? 'الموضع' : 'Locate'}
          </button>
          <button type="button" onClick={() => handleCopy(patch.id, copyText)} disabled={!copyText} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[10px] font-bold text-gray-700 hover:bg-[#d4af37]/15 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#333] dark:text-gray-200">
            <Copy size={12} /> {copiedId === patch.id ? (locale === 'ar' ? 'تم النسخ' : 'Copied') : (locale === 'ar' ? 'نسخ' : 'Copy')}
          </button>
          <button type="button" onClick={() => handleApplyPatch(patch)} disabled={patch.status !== 'pending'} className="inline-flex items-center gap-1 rounded bg-[#d4af37] px-2 py-1 text-[10px] font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50">
            {isDeletePatch ? <Trash2 size={12} /> : <FilePlus2 size={12} />} {actionLabel}
          </button>
        </div>
      </div>
    );
  };

  const renderAnalysis = (job: ExternalAnalysisJobRow, patches: AiContentPatch[]) => {
    const analysis = getExternalJobAnalysisMarkdown(job);
    if (patches.length === 0) {
      return analysis
        ? <div className="ai-output text-xs leading-6" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(analysis) }} />
        : null;
    }

    const used = new Set<string>();
    const parts: React.ReactNode[] = [];
    const markerPattern = /\[\[PATCH:([^\]]+)\]\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(analysis)) !== null) {
      const text = analysis.slice(lastIndex, match.index);
      if (text.trim()) parts.push(<div key={`text-${lastIndex}`} className="ai-output text-xs leading-6" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(text) }} />);
      const marker = normalizeMarker(match[1]);
      patches.filter(patch => !used.has(patch.id) && normalizeMarker(patch.marker) === marker).forEach(patch => {
        used.add(patch.id);
        parts.push(renderPatch(patch));
      });
      lastIndex = markerPattern.lastIndex;
    }
    const tail = analysis.slice(lastIndex);
    if (tail.trim()) parts.push(<div key="tail" className="ai-output text-xs leading-6" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(tail) }} />);
    patches.filter(patch => !used.has(patch.id)).forEach(patch => parts.push(renderPatch(patch)));
    return <>{parts}</>;
  };

  const progressText = (job: ExternalAnalysisJobRow): string => {
    if (job.status === 'running' && job.cancel_requested_at) {
      return locale === 'ar' ? 'جار إيقاف المهمة الخلفية...' : 'Stopping the background task...';
    }
    const gemini = isRecord(job.progress.gemini) ? job.progress.gemini : {};
    const model = toTrimmedString(gemini.model) || toTrimmedString(job.result?.model);
    const keyIndex = Number(gemini.currentKeyIndex || 0);
    const keyCount = Number(gemini.keyCount || 0);
    const keySuffix = toTrimmedString(gemini.keySuffix) || toTrimmedString(job.result?.keySuffix);
    return [
      model,
      keyIndex > 0 && keyCount > 0 ? `${locale === 'ar' ? 'المفتاح' : 'key'} ${keyIndex}/${keyCount}` : '',
      keySuffix ? `...${keySuffix.replace(/^\.+/, '')}` : '',
    ].filter(Boolean).join(' | ');
  };

  const renderJobControls = (job: ExternalAnalysisJobRow) => {
    const active = EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status);
    const canRetry = ['failed', 'blocked', 'cancelled'].includes(job.status);
    if (!active && !canRetry) return null;
    const busy = jobActionId === job.id;
    const cancellationPending = job.status === 'running' && Boolean(job.cancel_requested_at);

    return (
      <div className="flex shrink-0 items-center gap-1">
        {active && (
          <button
            type="button"
            onClick={() => void handleCancelJob(job)}
            disabled={Boolean(jobActionId || cancellationPending)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-black text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/10"
            title={locale === 'ar' ? 'إيقاف المهمة الخلفية' : 'Stop background task'}
          >
            {busy ? <LoaderCircle size={11} className="animate-spin" /> : <Square size={10} fill="currentColor" />}
            <span>{cancellationPending ? (locale === 'ar' ? 'جار الإيقاف' : 'Stopping') : (locale === 'ar' ? 'إيقاف' : 'Stop')}</span>
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={() => void handleRetryJob(job)}
            disabled={Boolean(jobActionId)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#f2d675]"
            title={locale === 'ar' ? 'إنشاء محاولة جديدة' : 'Queue a new attempt'}
          >
            {busy ? <LoaderCircle size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            <span>{locale === 'ar' ? 'إعادة التشغيل' : 'Retry'}</span>
          </button>
        )}
      </div>
    );
  };

  if (!articleId) {
    return <div className="py-10 text-center text-sm text-gray-500">{locale === 'ar' ? 'احفظ المقالة أولًا لعرض التحليل الخارجي.' : 'Save the article first to view external analysis.'}</div>;
  }

  return (
    <div className="space-y-4" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 pb-3 dark:border-[#3C3C3C]">
        <div className="text-sm font-black text-gray-800 dark:text-gray-100">{locale === 'ar' ? 'نتائج التحليل الخارجي' : 'External analysis results'}</div>
        <button type="button" onClick={() => void refreshJobs(true)} disabled={loading} className="rounded p-1.5 text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] disabled:opacity-50" title={locale === 'ar' ? 'تحديث' : 'Refresh'}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {controlNotice && (
        <div className={`border-s-2 px-2.5 py-1.5 text-[10px] font-bold leading-5 ${controlNotice.tone === 'error' ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-900/10 dark:text-red-300' : 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/10 dark:text-emerald-300'}`}>
          {controlNotice.message}
        </div>
      )}

      {latestSemanticJob && (
        <section className="border-b border-gray-200 pb-3 dark:border-[#3C3C3C]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs font-black text-gray-700 dark:text-gray-200"><Tags size={14} className="text-[#d4af37]" /> {locale === 'ar' ? 'الصيغ البديلة وكلمات LSI' : 'Alternative forms and LSI'}</div>
            <div className="flex items-center gap-1">
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${statusClassName(latestSemanticJob.status)}`}>{STATUS_LABELS[latestSemanticJob.status][locale]}</span>
              {renderJobControls(latestSemanticJob)}
            </div>
          </div>
          <div className="mt-1.5 text-[10px] text-gray-500 dark:text-gray-400">{progressText(latestSemanticJob) || formatDate(latestSemanticJob.updated_at)}</div>
          {latestSemanticGenerated && (
            <div className="mt-2 space-y-1.5 text-[10px]">
              {Array.isArray(latestSemanticGenerated.secondaries) && latestSemanticGenerated.secondaries.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-black text-gray-600 dark:text-gray-300">{locale === 'ar' ? 'الصيغ:' : 'Alternatives:'}</span>
                  {latestSemanticGenerated.secondaries.map((item: unknown, index: number) => (
                    <span key={`secondary-${index}`} className="rounded bg-[#d4af37]/10 px-1.5 py-0.5 font-bold text-[#8a6f1d] dark:text-[#f2d675]">{String(item)}</span>
                  ))}
                </div>
              )}
              {Array.isArray(latestSemanticGenerated.lsi) && latestSemanticGenerated.lsi.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-black text-gray-600 dark:text-gray-300">LSI:</span>
                  {latestSemanticGenerated.lsi.map((item: unknown, index: number) => (
                    <span key={`lsi-${index}`} className="rounded bg-blue-50 px-1.5 py-0.5 font-bold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">{String(item)}</span>
                  ))}
                </div>
              )}
            </div>
          )}
          {latestSemanticJob.last_error && <div className="mt-1 text-[10px] font-semibold text-red-600 dark:text-red-300">{latestSemanticJob.last_error}</div>}
        </section>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-black text-gray-700 dark:text-gray-200">{locale === 'ar' ? `الأوامر الهندسية (${jobs.filter(job => job.job_type === 'engineering_command').length})` : `Engineering commands (${jobs.filter(job => job.job_type === 'engineering_command').length})`}</div>
        <select value={filter} onChange={event => setFilter(event.target.value as ResultFilter)} className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-bold text-gray-600 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300">
          <option value="all">{locale === 'ar' ? 'الكل' : 'All'}</option>
          <option value="active">{locale === 'ar' ? 'الجارية' : 'Active'}</option>
          <option value="completed">{locale === 'ar' ? 'المكتملة' : 'Completed'}</option>
        </select>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#d4af37]"><LoaderCircle size={16} className="animate-spin" /> {locale === 'ar' ? 'جار تحميل النتائج...' : 'Loading results...'}</div>
      ) : error ? (
        <div className="border-s-2 border-red-500 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/10 dark:text-red-300">{error}</div>
      ) : batches.length === 0 ? (
        <div className="py-10 text-center text-xs text-gray-400">{locale === 'ar' ? 'لا توجد مهام مطابقة حتى الآن.' : 'No matching tasks yet.'}</div>
      ) : batches.map((batch, batchIndex) => {
        const completedCount = batch.jobs.filter(job => job.status === 'completed').length;
        const isManual = batch.jobs.some(job => job.origin === 'manual');
        return (
          <section key={batch.key} className="border-t border-gray-200 pt-3 first:border-t-0 first:pt-0 dark:border-[#3C3C3C]">
            <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-gray-500 dark:text-gray-400">
              <span className="font-bold">{locale === 'ar' ? `دفعة ${batches.length - batchIndex} | ${isManual ? 'يدوية' : 'تلقائية'}` : `Batch ${batches.length - batchIndex} | ${isManual ? 'Manual' : 'Automatic'}`}</span>
              <span>{completedCount}/{batch.jobs.length} | {formatDate(batch.createdAt)}</span>
            </div>

            {batch.jobs.map(job => {
              const expanded = expandedJobIds.has(job.id);
              const patches = getPatches(job);
              const analysis = getExternalJobAnalysisMarkdown(job);
              const commandLabel = job.command_id
                ? getExternalReadyCommandLabel(job.command_id, locale)
                : job.command_label || '-';
              const hasResult = Boolean(analysis || patches.length > 0);
              return (
                <div key={job.id} className="border-b border-gray-100 py-2 last:border-b-0 dark:border-[#333]">
                  <button
                    type="button"
                    onClick={() => setExpandedJobIds(current => {
                      const next = new Set(current);
                      if (next.has(job.id)) next.delete(job.id); else next.add(job.id);
                      return next;
                    })}
                    className="flex w-full items-start justify-between gap-2 text-start"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-black leading-5 text-gray-800 dark:text-gray-100">{job.sequence_number}. {commandLabel}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9px] text-gray-500 dark:text-gray-400">
                        <span className={`rounded px-1.5 py-0.5 font-black ${statusClassName(job.status)}`}>{STATUS_LABELS[job.status][locale]}</span>
                        <span>{formatDate(job.updated_at)}</span>
                        {job.retry_count > 0 && <span>{locale === 'ar' ? `إعادات: ${job.retry_count}` : `Retries: ${job.retry_count}`}</span>}
                      </div>
                    </div>
                    <ChevronDown size={14} className={`mt-1 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>

                  {expanded && (
                    <div className="mt-2 border-s border-gray-200 ps-2.5 dark:border-[#444]">
                      {EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status) && (
                        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold text-blue-600 dark:text-blue-300">
                          {job.status === 'running' ? <LoaderCircle size={12} className="animate-spin" /> : <Clock3 size={12} />}
                          <span>{progressText(job) || STATUS_LABELS[job.status][locale]}</span>
                        </div>
                      )}
                      {job.next_attempt_at && job.status === 'retry_scheduled' && (
                        <div className="mb-2 text-[10px] text-amber-700 dark:text-amber-300">{locale === 'ar' ? 'المحاولة التالية' : 'Next attempt'}: {formatDate(job.next_attempt_at)}</div>
                      )}
                      {job.last_error && <div className="mb-2 border-s-2 border-red-500 bg-red-50 px-2 py-1.5 text-[10px] leading-5 text-red-700 dark:bg-red-900/10 dark:text-red-300">{job.last_error}</div>}
                      <div className="mb-2 flex justify-end">{renderJobControls(job)}</div>
                      {hasResult ? (
                        <>
                          <div className="mb-1 flex justify-end">
                            <button type="button" onClick={() => handleCopy(`report-${job.id}`, analysis)} disabled={!analysis} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-bold text-gray-600 hover:bg-[#d4af37]/10 disabled:opacity-40 dark:text-gray-300">
                              <Copy size={12} /> {copiedId === `report-${job.id}` ? (locale === 'ar' ? 'تم النسخ' : 'Copied') : (locale === 'ar' ? 'نسخ التقرير' : 'Copy report')}
                            </button>
                          </div>
                          {renderAnalysis(job, patches)}
                        </>
                      ) : (
                        <div className="py-3 text-[10px] text-gray-400">{locale === 'ar' ? 'لا توجد نتيجة محفوظة لهذه المهمة بعد.' : 'No saved result for this task yet.'}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
};

export default ExternalAnalysisResultsTab;
