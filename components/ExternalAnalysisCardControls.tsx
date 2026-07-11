import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  ListChecks,
  LoaderCircle,
  Play,
  Square,
  Tags,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  EXTERNAL_READY_COMMAND_DEFINITIONS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';
import {
  cancelAllExternalAnalysisJobs,
  ExternalAnalysisRequestError,
  enqueueExternalEngineeringAnalysis,
  enqueueExternalSemanticAnalysis,
  externalJobHasActiveStatus,
  getExternalMissingFieldLabels,
  type ExternalAnalysisDashboardSummary,
} from '../utils/externalAnalysis';

type NoticeState = {
  tone: 'success' | 'error' | 'info';
  message: string;
};

interface ExternalAnalysisCardControlsProps {
  articleId: string;
  semanticTermsReady: boolean;
  summary?: ExternalAnalysisDashboardSummary;
  onRefresh: () => Promise<void> | void;
}

const ExternalAnalysisCardControls: React.FC<ExternalAnalysisCardControlsProps> = ({
  articleId,
  semanticTermsReady,
  summary,
  onRefresh,
}) => {
  const { t } = useUser();
  const locale = t.locale === 'en' ? 'en' : 'ar';
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCommandIds, setSelectedCommandIds] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<'semantic' | 'engineering' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => EXTERNAL_READY_COMMAND_DEFINITIONS.map(definition => ({
    id: definition.id,
    label: (t.rightSidebar as any)?.[definition.labelKey]
      || getExternalReadyCommandLabel(definition.id, locale),
  })), [locale, t.rightSidebar]);

  const semanticJobActive = externalJobHasActiveStatus(summary?.latestSemanticJob);
  const engineeringActive = (summary?.activeEngineeringCount || 0) > 0;

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
    setNotice(null);
  }, [articleId]);

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
    window.setTimeout(() => void onRefresh(), 800);
  };

  const handleSemantic = async () => {
    if (busyAction || semanticTermsReady || semanticJobActive) return;
    setBusyAction('semantic');
    setNotice(null);
    try {
      const result = await enqueueExternalSemanticAnalysis(articleId);
      const message = result.alreadyReady
        ? (locale === 'ar' ? 'الصيغ البديلة وLSI جاهزة بالفعل.' : 'Alternative forms and LSI are already ready.')
        : result.alreadyActive
          ? (locale === 'ar' ? 'مهمة التوليد موجودة وتعمل في الخلفية.' : 'The generation task is already running in the background.')
          : (locale === 'ar' ? 'تم تعيين مهمة الصيغ البديلة وLSI.' : 'Alternative forms and LSI task queued.');
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
    if (busyAction || selectedCommandIds.length === 0) return;
    const orderedCommandIds = commands
      .filter(command => selectedCommandIds.includes(command.id))
      .map(command => command.id);
    setBusyAction('engineering');
    setNotice(null);
    try {
      await enqueueExternalEngineeringAnalysis(articleId, orderedCommandIds);
      setNotice({
        tone: 'success',
        message: locale === 'ar'
          ? `تم تعيين ${orderedCommandIds.length} أمر بالتتابع في الخلفية.`
          : `${orderedCommandIds.length} command(s) queued sequentially in the background.`,
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

  const handleCancelAll = async () => {
    if (busyAction || (!semanticJobActive && !engineeringActive)) return;
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

  return (
    <div
      className="relative mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3a3a3a]"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={handleSemantic}
          disabled={Boolean(busyAction || semanticTermsReady || semanticJobActive)}
          className="inline-flex min-h-7 items-center gap-1 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 px-2 py-1 text-[10px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-[#f2d675]"
          title={locale === 'ar' ? 'توليد الصيغ البديلة وكلمات LSI في الخلفية' : 'Generate alternatives and LSI in the background'}
        >
          {busyAction === 'semantic' || semanticJobActive
            ? <LoaderCircle size={12} className="animate-spin" />
            : semanticTermsReady
              ? <CheckCircle2 size={12} />
              : <Tags size={12} />}
          <span>{semanticTermsReady ? (locale === 'ar' ? 'الصيغ جاهزة' : 'Terms ready') : (locale === 'ar' ? 'الصيغ وLSI' : 'Alternatives + LSI')}</span>
        </button>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            disabled={busyAction === 'engineering'}
            className="inline-flex min-h-7 items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-black text-gray-600 hover:border-[#d4af37]/40 hover:bg-[#d4af37]/10 disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300"
            title={locale === 'ar' ? 'اختيار أوامر جاهزة لتشغيلها بالتتابع' : 'Choose ready commands to run sequentially'}
          >
            {busyAction === 'engineering' ? <LoaderCircle size={12} className="animate-spin" /> : <ListChecks size={12} />}
            <span>{locale === 'ar' ? 'التحليل الخارجي' : 'External analysis'}</span>
            {selectedCommandIds.length > 0 && (
              <span className="rounded bg-[#d4af37] px-1 text-[9px] text-white">{selectedCommandIds.length}</span>
            )}
            <ChevronDown size={11} className={menuOpen ? 'rotate-180' : ''} />
          </button>

          {menuOpen && (
            <div className="absolute end-0 top-full z-40 mt-1 w-[min(19rem,calc(100vw-2rem))] rounded-md border border-gray-200 bg-white p-1.5 shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
              <div className="max-h-56 overflow-y-auto custom-scrollbar">
                {commands.map(command => {
                  const selected = selectedCommandIds.includes(command.id);
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onClick={() => toggleCommand(command.id)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-[11px] font-semibold ${selected ? 'bg-[#d4af37]/15 text-[#8a6f1d] dark:text-[#f2d675]' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-[#333]'}`}
                    >
                      <input type="checkbox" checked={selected} readOnly tabIndex={-1} className="rounded text-[#d4af37] focus:ring-[#d4af37]" />
                      <span className="min-w-0 flex-1 leading-5">{command.label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={handleEngineering}
                disabled={selectedCommandIds.length === 0 || Boolean(busyAction)}
                className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 text-[11px] font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={12} />
                {locale === 'ar' ? `تشغيل المحدد (${selectedCommandIds.length})` : `Run selected (${selectedCommandIds.length})`}
              </button>
            </div>
          )}
        </div>

        {(semanticJobActive || engineeringActive) && (
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

        {engineeringActive && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-300">
            <LoaderCircle size={11} className="animate-spin" />
            {summary?.activeEngineeringCount} {locale === 'ar' ? 'قيد التنفيذ' : 'active'}
          </span>
        )}
        {!engineeringActive && (summary?.completedEngineeringCount || 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
            <CheckCircle2 size={11} />
            {summary?.completedEngineeringCount} {locale === 'ar' ? 'نتيجة' : 'results'}
          </span>
        )}
        {(summary?.retryingEngineeringCount || 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-300">
            <Clock3 size={11} />
            {locale === 'ar' ? 'إعادة لاحقًا' : 'Retry scheduled'}
          </span>
        )}
      </div>

      {notice && (
        <div
          role="status"
          className={`mt-1 text-[10px] font-bold leading-5 ${notice.tone === 'error' ? 'text-red-600 dark:text-red-300' : notice.tone === 'success' ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
};

export default ExternalAnalysisCardControls;
