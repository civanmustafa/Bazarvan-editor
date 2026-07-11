import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ListChecks,
  LoaderCircle,
  Play,
  Square,
  Tags,
  XCircle,
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

type RequirementStatus = 'met' | 'missing' | 'checking';

type RequirementItem = {
  field: string;
  status: RequirementStatus;
};

const SEMANTIC_REQUIREMENT_FIELDS = [
  'draft_status',
  'article_title',
  'editor_text',
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

const AUTO_GENERATED_ENGINEERING_FIELDS = new Set(['alternative_keywords', 'lsi_keywords']);

interface ExternalAnalysisCardControlsProps {
  articleId: string;
  hasAlternativeKeywords: boolean;
  hasLsiKeywords: boolean;
  summary?: ExternalAnalysisDashboardSummary;
  onRefresh: () => Promise<void> | void;
}

const ExternalAnalysisCardControls: React.FC<ExternalAnalysisCardControlsProps> = ({
  articleId,
  hasAlternativeKeywords,
  hasLsiKeywords,
  summary,
  onRefresh,
}) => {
  const { t } = useUser();
  const locale = t.locale === 'en' ? 'en' : 'ar';
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCommandIds, setSelectedCommandIds] = useState<string[]>([]);
  const [requirementsOpen, setRequirementsOpen] = useState<'semantic' | 'engineering' | null>(null);
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
  const semanticTermsReady = hasAlternativeKeywords && hasLsiKeywords;
  const readinessState = summary?.state || null;
  const semanticMissingFields = new Set(readinessState?.semantic_missing_fields || []);
  const engineeringMissingFields = new Set(readinessState?.external_analysis_missing_fields || []);
  if (semanticMissingFields.has('editor_text')) engineeringMissingFields.add('editor_text');
  if (!hasAlternativeKeywords) engineeringMissingFields.add('alternative_keywords');
  if (!hasLsiKeywords) engineeringMissingFields.add('lsi_keywords');

  const semanticRequirements: RequirementItem[] = SEMANTIC_REQUIREMENT_FIELDS.map(field => ({
    field,
    status: readinessState
      ? (semanticMissingFields.has(field) ? 'missing' : 'met')
      : 'checking',
  }));
  const engineeringRequirements: RequirementItem[] = ENGINEERING_REQUIREMENT_FIELDS.map(field => ({
    field,
    status: field === 'alternative_keywords'
      ? (hasAlternativeKeywords ? 'met' : 'missing')
      : field === 'lsi_keywords'
        ? (hasLsiKeywords ? 'met' : 'missing')
        : readinessState
          ? (engineeringMissingFields.has(field) ? 'missing' : 'met')
          : 'checking',
  }));
  const semanticCanStart = !readinessState
    || semanticRequirements.every(requirement => requirement.status === 'met');
  const engineeringCanQueue = !readinessState
    || engineeringRequirements.every(requirement => (
      requirement.status === 'met' || AUTO_GENERATED_ENGINEERING_FIELDS.has(requirement.field)
    ));

  const requirementCounter = (requirements: RequirementItem[]): string => (
    requirements.some(requirement => requirement.status === 'checking')
      ? `…/${requirements.length}`
      : `${requirements.filter(requirement => requirement.status === 'met').length}/${requirements.length}`
  );

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
    if (busyAction || semanticTermsReady || semanticJobActive || !semanticCanStart) return;
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
              ? `تم تعيين توليد الصيغ وLSI أولاً، ثم ${orderedCommandIds.length} أمر بالتتابع.`
              : `Alternatives and LSI were queued first, followed by ${orderedCommandIds.length} command(s).`)
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

  const activeRequirements = requirementsOpen === 'semantic'
    ? semanticRequirements
    : requirementsOpen === 'engineering'
      ? engineeringRequirements
      : [];
  const activeMetCount = activeRequirements.filter(requirement => requirement.status === 'met').length;
  const activeMissingCount = activeRequirements.filter(requirement => requirement.status === 'missing').length;
  const activeCheckingCount = activeRequirements.filter(requirement => requirement.status === 'checking').length;

  const toggleRequirements = (type: 'semantic' | 'engineering') => {
    setRequirementsOpen(current => current === type ? null : type);
  };

  return (
    <div
      className="relative mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3a3a3a]"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={handleSemantic}
            disabled={Boolean(busyAction || semanticTermsReady || semanticJobActive || !semanticCanStart)}
            className="inline-flex min-h-7 items-center gap-1 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 px-2 py-1 text-[10px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-[#f2d675]"
            title={locale === 'ar' ? 'توليد الصيغ البديلة وكلمات LSI في الخلفية' : 'Generate alternatives and LSI in the background'}
          >
            {busyAction === 'semantic' || semanticJobActive
              ? <LoaderCircle size={12} className="animate-spin" />
              : semanticTermsReady
                ? <CheckCircle2 size={12} />
                : <Tags size={12} />}
            <span>{semanticTermsReady
              ? (locale === 'ar' ? 'الصيغ جاهزة' : 'Terms ready')
              : semanticJobActive
                ? (locale === 'ar' ? 'جاري توليد الصيغ' : 'Generating terms')
                : (locale === 'ar' ? 'توليد الصيغ وLSI' : 'Generate alternatives + LSI')}</span>
          </button>
          <button
            type="button"
            onClick={() => toggleRequirements('semantic')}
            aria-expanded={requirementsOpen === 'semantic'}
            className={`inline-flex min-h-7 items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-black ${semanticRequirements.some(requirement => requirement.status === 'missing') ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-500/10' : readinessState && semanticCanStart ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-500/10' : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-400 dark:hover:bg-[#333]'}`}
            title={locale === 'ar' ? 'عرض شروط توليد الصيغ المحققة والناقصة' : 'Show met and missing generation requirements'}
          >
            <CircleHelp size={12} />
            <span>{requirementCounter(semanticRequirements)}</span>
          </button>
        </div>

        <div className="inline-flex items-center gap-1">
          <div ref={menuRef} className="relative">
            <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            disabled={busyAction === 'engineering'}
            className="inline-flex min-h-7 items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-black text-gray-600 hover:border-[#d4af37]/40 hover:bg-[#d4af37]/10 disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300"
            title={locale === 'ar' ? 'اختيار أوامر جاهزة لتشغيلها بالتتابع' : 'Choose ready commands to run sequentially'}
          >
            {busyAction === 'engineering' ? <LoaderCircle size={12} className="animate-spin" /> : <ListChecks size={12} />}
            <span>{locale === 'ar' ? 'الأوامر اليدوية الجاهزة' : 'Ready manual commands'}</span>
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
                {!engineeringCanQueue && (
                  <div className="mt-1.5 border-t border-red-100 pt-1.5 text-[10px] font-bold text-red-600 dark:border-red-900/40 dark:text-red-300">
                    {locale === 'ar' ? 'توجد شروط أساسية ناقصة. افتح مؤشر الشروط لمعرفة التفاصيل.' : 'Core requirements are missing. Open the requirements indicator for details.'}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleEngineering}
                  disabled={selectedCommandIds.length === 0 || Boolean(busyAction) || !engineeringCanQueue}
                  className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 text-[11px] font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play size={12} />
                  {locale === 'ar' ? `تشغيل المحدد (${selectedCommandIds.length})` : `Run selected (${selectedCommandIds.length})`}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => toggleRequirements('engineering')}
            aria-expanded={requirementsOpen === 'engineering'}
            className={`inline-flex min-h-7 items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-black ${engineeringRequirements.some(requirement => requirement.status === 'missing') ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-500/10' : readinessState && engineeringCanQueue ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-500/10' : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-400 dark:hover:bg-[#333]'}`}
            title={locale === 'ar' ? 'عرض شروط الأوامر اليدوية المحققة والناقصة' : 'Show met and missing command requirements'}
          >
            <CircleHelp size={12} />
            <span>{requirementCounter(engineeringRequirements)}</span>
          </button>
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

      {requirementsOpen && (
        <div className="mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3C3C3C]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-black text-gray-700 dark:text-gray-200">
              {requirementsOpen === 'semantic'
                ? (locale === 'ar' ? 'شروط توليد الصيغ وLSI' : 'Alternatives and LSI requirements')
                : (locale === 'ar' ? 'شروط الأوامر اليدوية الجاهزة' : 'Ready command requirements')}
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
    </div>
  );
};

export default ExternalAnalysisCardControls;
