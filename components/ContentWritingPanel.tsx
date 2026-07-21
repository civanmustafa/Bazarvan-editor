import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BadgeDollarSign,
  Check,
  CheckCircle2,
  CircleStop,
  Clock3,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wand2,
  XCircle,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { useEditorSelector } from '../contexts/EditorContext';
import {
  GEMINI_FREE_MODEL_OPTIONS,
  GEMINI_PAID_MODEL_OPTIONS,
} from '../constants/aiModels';
import { copyMarkdownToClipboard } from '../utils/editorUtils';
import {
  ContentWritingRequestError,
  cancelContentWritingSession,
  createContentWritingIdempotencyKey,
  getContentWritingSessionDetail,
  isContentWritingSessionActive,
  listContentWritingSessions,
  resumeContentWritingSession,
  startContentWritingSession,
  type ContentWritingProvider,
  type ContentWritingSession,
  type ContentWritingSessionDetail,
  type ContentWritingSessionStatus,
  type ContentWritingStep,
  type ContentWritingStepStatus,
} from '../utils/contentWritingSessions';

type ActionState = 'idle' | 'starting' | 'cancelling' | 'resuming';

type PendingStartRequest = {
  signature: string;
  idempotencyKey: string;
};

type ErrorPresentation = {
  message: string;
  details: string[];
};

const ACTIVE_POLL_MS = 2_500;
const LIST_POLL_MS = 6_000;

const STATUS_STYLES: Record<ContentWritingSessionStatus, string> = {
  queued: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  retry_scheduled: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  failed: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-[#333] dark:text-gray-300',
};

const STEP_STATUS_STYLES: Record<ContentWritingStepStatus, string> = {
  pending: 'text-gray-400',
  running: 'text-blue-600 dark:text-blue-300',
  completed: 'text-emerald-600 dark:text-emerald-300',
  failed: 'text-red-600 dark:text-red-300',
};

const getStatusLabel = (status: ContentWritingSessionStatus, isArabic: boolean): string => {
  const labels: Record<ContentWritingSessionStatus, [string, string]> = {
    queued: ['قيد الانتظار', 'Queued'],
    running: ['جاري التنفيذ', 'Running'],
    retry_scheduled: ['إعادة محاولة', 'Retry scheduled'],
    completed: ['مكتمل', 'Completed'],
    failed: ['فشل', 'Failed'],
    cancelled: ['ملغى', 'Cancelled'],
  };
  return labels[status][isArabic ? 0 : 1];
};

const getProviderLabel = (provider: ContentWritingProvider): string => {
  if (provider === 'geminiPaid') return 'Gemini Pro';
  if (provider === 'openai') return 'OpenAI';
  return 'Gemini';
};

const getErrorPresentation = (error: unknown, isArabic: boolean): ErrorPresentation => {
  const fallback = isArabic ? 'تعذر تنفيذ طلب كتابة المحتوى.' : 'Could not run the content writing request.';
  if (!(error instanceof ContentWritingRequestError)) {
    return { message: error instanceof Error ? error.message : fallback, details: [] };
  }
  const knownMessages: Record<string, [string, string]> = {
    content_writing_prerequisites_missing: ['بيانات المقالة المطلوبة غير مكتملة.', 'Required article data is incomplete.'],
    content_writing_templates_invalid: ['قوالب كتابة المحتوى غير صالحة.', 'Content writing templates are invalid.'],
    content_writing_input_too_large: ['حجم سياق المقالة يتجاوز الحد المحدد.', 'The article context exceeds the configured limit.'],
    AI_PROVIDER_DISABLED: ['قام الأدمن بتعطيل هذا المزود.', 'This provider is disabled by the administrator.'],
    AI_PROVIDER_NOT_CONFIGURED: ['المزود مفعّل ولكن مفتاحه غير مهيأ على الخادم.', 'The provider is enabled but not configured on the server.'],
    article_access_denied: ['لا تملك صلاحية كتابة هذه المقالة.', 'You cannot write this article.'],
  };
  const readinessIssues = Array.isArray(error.payload.readinessIssues)
    ? error.payload.readinessIssues.flatMap(issue => {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return [];
      const label = (issue as Record<string, unknown>).label;
      return typeof label === 'string' && label.trim() ? [label.trim()] : [];
    })
    : [];
  const tokenDetails = error.code === 'content_writing_input_too_large'
    ? [`${Number(error.payload.estimatedInputTokens) || 0} / ${Number(error.payload.maxInputTokens) || 0}`]
    : [];
  const known = knownMessages[error.code];
  return {
    message: known ? known[isArabic ? 0 : 1] : error.message || fallback,
    details: [...readinessIssues, ...tokenDetails],
  };
};

const formatDateTime = (value: string, isArabic: boolean): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(isArabic ? 'ar' : 'en', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
};

const StatusIcon: React.FC<{ status: ContentWritingSessionStatus; size?: number }> = ({ status, size = 15 }) => {
  if (status === 'completed') return <CheckCircle2 size={size} />;
  if (status === 'failed') return <XCircle size={size} />;
  if (status === 'cancelled') return <CircleStop size={size} />;
  if (status === 'running') return <Loader2 size={size} className="animate-spin" />;
  return <Clock3 size={size} />;
};

const StepStatusIcon: React.FC<{ status: ContentWritingStepStatus }> = ({ status }) => {
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <XCircle size={14} />;
  if (status === 'running') return <Loader2 size={14} className="animate-spin" />;
  return <Clock3 size={14} />;
};

const getStepLabel = (step: ContentWritingStep, isArabic: boolean): string => {
  const labels = {
    outline: isArabic ? 'مخطط المقالة' : 'Article outline',
    introduction: isArabic ? 'المقدمة' : 'Introduction',
    conclusion: isArabic ? 'الخاتمة' : 'Conclusion',
    faq: isArabic ? 'الأسئلة الشائعة' : 'FAQ',
    final_review: isArabic ? 'المراجعة النهائية' : 'Final review',
  };
  if (step.stepType !== 'section') return labels[step.stepType];
  const sectionIndex = Math.max(1, Number(step.metadata.sectionIndex) || step.ordinal - 1);
  return `${isArabic ? 'القسم' : 'Section'} ${sectionIndex}: ${step.title}`;
};

const ContentWritingPanel: React.FC = () => {
  const {
    t,
    aiProviderCapabilities,
    isAiProviderEnabled,
    isAiProviderAvailable,
  } = useUser();
  const articleId = useEditorSelector(context => context.activeArticleId);
  const handleSaveDraft = useEditorSelector(context => context.handleSaveDraft);
  const saveStatus = useEditorSelector(context => context.saveStatus);
  const isArabic = t.locale !== 'en';
  const [provider, setProvider] = useState<ContentWritingProvider>(aiProviderCapabilities.defaultProvider);
  const [modelByProvider, setModelByProvider] = useState<Record<ContentWritingProvider, string>>(() => ({
    gemini: aiProviderCapabilities.providers.gemini.model,
    geminiPaid: aiProviderCapabilities.providers.geminiPaid.model,
    openai: aiProviderCapabilities.providers.openai.model,
  }));
  const [sessions, setSessions] = useState<ContentWritingSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<ContentWritingSessionDetail | null>(null);
  const [isListLoading, setIsListLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [errorPresentation, setErrorPresentation] = useState<ErrorPresentation | null>(null);
  const [copied, setCopied] = useState(false);
  const activeArticleRef = useRef(articleId);
  const detailRequestRef = useRef(0);
  const startInFlightRef = useRef(false);
  const pendingStartRef = useRef<PendingStartRequest | null>(null);
  const providerTouchedRef = useRef(false);
  const touchedModelsRef = useRef<Set<ContentWritingProvider>>(new Set());

  useEffect(() => {
    activeArticleRef.current = articleId;
  }, [articleId]);

  const providerConfigs = useMemo(() => ([
    {
      id: 'gemini' as const,
      enabled: isAiProviderEnabled('gemini'),
      available: isAiProviderAvailable('gemini'),
      label: 'Gemini',
      icon: Sparkles,
    },
    {
      id: 'geminiPaid' as const,
      enabled: isAiProviderEnabled('geminiPaid'),
      available: isAiProviderAvailable('geminiPaid'),
      label: 'Gemini Pro',
      icon: BadgeDollarSign,
    },
    {
      id: 'openai' as const,
      enabled: isAiProviderEnabled('chatgpt'),
      available: isAiProviderAvailable('chatgpt'),
      label: 'OpenAI',
      icon: Wand2,
    },
  ]), [isAiProviderAvailable, isAiProviderEnabled]);

  const visibleProviders = useMemo(
    () => providerConfigs.filter(item => item.enabled),
    [providerConfigs],
  );
  const selectedProviderConfig = providerConfigs.find(item => item.id === provider);
  const hasActiveSession = sessions.some(isContentWritingSessionActive);
  const selectedSession = selectedDetail?.session || sessions.find(session => session.id === selectedSessionId) || null;
  const selectedSessionProviderAvailable = selectedSession
    ? providerConfigs.find(item => item.id === selectedSession.provider)?.available === true
    : false;
  const selectedModel = modelByProvider[provider];
  const modelOptions = provider === 'gemini'
    ? GEMINI_FREE_MODEL_OPTIONS
    : provider === 'geminiPaid'
      ? GEMINI_PAID_MODEL_OPTIONS
      : [];

  useEffect(() => {
    setModelByProvider(current => Object.fromEntries(
      (['gemini', 'geminiPaid', 'openai'] as const).map(providerId => [
        providerId,
        touchedModelsRef.current.has(providerId)
          ? current[providerId]
          : aiProviderCapabilities.providers[providerId].model,
      ]),
    ) as Record<ContentWritingProvider, string>);
    if (!providerTouchedRef.current) {
      setProvider(aiProviderCapabilities.defaultProvider);
    }
  }, [aiProviderCapabilities]);

  useEffect(() => {
    if (selectedProviderConfig?.enabled && selectedProviderConfig.available) return;
    const next = providerConfigs.find(item => item.enabled && item.available)
      || providerConfigs.find(item => item.enabled);
    if (next) setProvider(next.id);
  }, [providerConfigs, selectedProviderConfig]);

  const mergeSession = useCallback((incoming: ContentWritingSession) => {
    setSessions(current => {
      const next = current.map(session => session.id === incoming.id ? { ...session, ...incoming } : session);
      return next.some(session => session.id === incoming.id) ? next : [incoming, ...next];
    });
  }, []);

  const loadDetail = useCallback(async (sessionId: string, options: { silent?: boolean } = {}) => {
    const requestId = ++detailRequestRef.current;
    if (!options.silent) setIsDetailLoading(true);
    try {
      const detail = await getContentWritingSessionDetail(sessionId);
      if (requestId !== detailRequestRef.current) return;
      setSelectedDetail(detail);
      mergeSession(detail.session);
    } catch (error) {
      if (requestId === detailRequestRef.current && !options.silent) {
        setErrorPresentation(getErrorPresentation(error, isArabic));
      }
    } finally {
      if (requestId === detailRequestRef.current && !options.silent) setIsDetailLoading(false);
    }
  }, [isArabic, mergeSession]);

  const refreshSessions = useCallback(async (options: { silent?: boolean; selectNewest?: boolean } = {}) => {
    const targetArticleId = articleId;
    if (!targetArticleId) return;
    if (!options.silent) setIsListLoading(true);
    try {
      const rows = await listContentWritingSessions(targetArticleId);
      if (activeArticleRef.current !== targetArticleId) return;
      setSessions(rows);
      const preferredId = options.selectNewest
        ? rows[0]?.id
        : selectedSessionId && rows.some(session => session.id === selectedSessionId)
          ? selectedSessionId
          : rows.find(isContentWritingSessionActive)?.id || rows[0]?.id;
      if (preferredId) setSelectedSessionId(preferredId);
      else {
        setSelectedSessionId('');
        setSelectedDetail(null);
      }
    } catch (error) {
      if (!options.silent) setErrorPresentation(getErrorPresentation(error, isArabic));
    } finally {
      if (!options.silent && activeArticleRef.current === targetArticleId) setIsListLoading(false);
    }
  }, [articleId, isArabic, selectedSessionId]);

  useEffect(() => {
    detailRequestRef.current += 1;
    setSessions([]);
    setSelectedSessionId('');
    setSelectedDetail(null);
    setErrorPresentation(null);
    setCopied(false);
    if (articleId) void refreshSessions();
  }, [articleId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadDetail(selectedSessionId);
  }, [loadDetail, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !isContentWritingSessionActive(selectedSession)) return;
    const timer = window.setInterval(() => {
      void loadDetail(selectedSessionId, { silent: true });
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadDetail, selectedSession, selectedSessionId]);

  useEffect(() => {
    if (!articleId || !sessions.some(isContentWritingSessionActive)) return;
    const timer = window.setInterval(() => {
      void refreshSessions({ silent: true });
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [articleId, refreshSessions, sessions]);

  const startSession = async () => {
    if (!articleId || !selectedProviderConfig?.available || hasActiveSession || startInFlightRef.current) return;
    const requestSignature = `${articleId}:${provider}:${selectedModel || 'default'}`;
    const pendingStart = pendingStartRef.current?.signature === requestSignature
      ? pendingStartRef.current
      : {
          signature: requestSignature,
          idempotencyKey: createContentWritingIdempotencyKey(articleId),
        };
    pendingStartRef.current = pendingStart;
    startInFlightRef.current = true;
    setActionState('starting');
    setErrorPresentation(null);
    try {
      await handleSaveDraft();
      const started = await startContentWritingSession({
        articleId,
        provider,
        model: selectedModel || undefined,
        idempotencyKey: pendingStart.idempotencyKey,
      });
      pendingStartRef.current = null;
      if (activeArticleRef.current !== articleId) return;
      mergeSession(started.session);
      setSelectedSessionId(started.session.id);
      await loadDetail(started.session.id, { silent: true });
    } catch (error) {
      if (error instanceof ContentWritingRequestError && error.status < 500) {
        pendingStartRef.current = null;
      }
      if (activeArticleRef.current === articleId) {
        setErrorPresentation(getErrorPresentation(error, isArabic));
      }
    } finally {
      startInFlightRef.current = false;
      setActionState('idle');
    }
  };

  const cancelSession = async () => {
    if (!selectedSession || !isContentWritingSessionActive(selectedSession)) return;
    setActionState('cancelling');
    setErrorPresentation(null);
    try {
      const cancelled = await cancelContentWritingSession(selectedSession.id);
      mergeSession(cancelled);
      setSelectedDetail(current => current ? { ...current, session: { ...current.session, ...cancelled } } : current);
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
    } finally {
      setActionState('idle');
    }
  };

  const resumeSession = async () => {
    if (!selectedSession || !['failed', 'cancelled'].includes(selectedSession.status) || hasActiveSession) return;
    setActionState('resuming');
    setErrorPresentation(null);
    try {
      const resumed = await resumeContentWritingSession(selectedSession.id);
      mergeSession(resumed);
      setSelectedDetail(current => current ? { ...current, session: { ...current.session, ...resumed } } : current);
      await loadDetail(resumed.id, { silent: true });
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
    } finally {
      setActionState('idle');
    }
  };

  const copyResult = async () => {
    const result = selectedDetail?.session.resultText;
    if (!result) return;
    try {
      await copyMarkdownToClipboard(result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
    }
  };

  const progress = selectedSession?.progress || {};
  const progressMessage = typeof progress.message === 'string' ? progress.message.trim() : '';
  const keyIndex = Number(progress.currentKeyIndex) || 0;
  const keyCount = Number(progress.keyCount) || 0;
  const modelIndex = Number(progress.currentModelIndex) || 0;
  const modelCount = Number(progress.modelCount) || 0;
  const workflowStepIndex = Number(progress.workflowStepIndex) || 0;
  const workflowStepCount = Number(progress.workflowStepCount) || 0;
  const workflowStepLabel = typeof progress.workflowStepLabel === 'string'
    ? progress.workflowStepLabel.trim()
    : '';
  const workflowStepKey = typeof progress.workflowStepKey === 'string'
    ? progress.workflowStepKey.trim()
    : '';
  const workflowSteps = selectedDetail?.steps || [];
  const completedWorkflowSteps = workflowSteps.filter(step => step.status === 'completed').length;
  const currentWorkflowStep = workflowSteps.find(step => step.stepKey === workflowStepKey);
  const displayedWorkflowStepLabel = currentWorkflowStep
    ? getStepLabel(currentWorkflowStep, isArabic)
    : workflowStepLabel;

  if (!articleId) {
    return (
      <div className="flex h-full items-center justify-center p-5 text-center text-xs font-bold text-gray-400">
        {isArabic ? 'افتح مقالة محفوظة لبدء كتابة المحتوى.' : 'Open a saved article to start content writing.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <div className="flex min-w-0 items-center gap-2">
          <FileText size={17} className="shrink-0 text-[#d4af37]" />
          <h3 className="truncate text-sm font-bold text-gray-800 dark:text-gray-100">
            {isArabic ? 'كتابة المحتوى' : 'Content writing'}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => void refreshSessions({ selectNewest: false })}
          disabled={isListLoading}
          title={isArabic ? 'تحديث الجلسات' : 'Refresh sessions'}
          aria-label={isArabic ? 'تحديث الجلسات' : 'Refresh sessions'}
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:border-[#d4af37]/50 hover:text-[#8a6f1d] disabled:opacity-50 dark:border-[#3C3C3C] dark:text-gray-300"
        >
          <RefreshCw size={15} className={isListLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto custom-scrollbar">
        <section className="space-y-3 border-b border-gray-200 p-3 dark:border-[#3C3C3C]">
          {visibleProviders.length > 0 ? (
            <div className={`grid gap-1.5 ${visibleProviders.length >= 3 ? 'grid-cols-3' : visibleProviders.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {visibleProviders.map(item => {
                const Icon = item.icon;
                const selected = provider === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      providerTouchedRef.current = true;
                      setProvider(item.id);
                    }}
                    disabled={!item.available}
                    title={!item.available
                      ? (isArabic ? `${item.label} غير مهيأ على الخادم` : `${item.label} is not configured`)
                      : item.label}
                    className={`flex h-9 min-w-0 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      selected
                        ? 'bg-[#d4af37] text-white'
                        : 'border border-[#d4af37]/30 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                    }`}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 p-2 text-xs font-semibold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertCircle size={14} className="shrink-0" />
              <span>{isArabic ? 'جميع مزودي الكتابة معطلون.' : 'All writing providers are disabled.'}</span>
            </div>
          )}

          {modelOptions.length > 0 ? (
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold text-gray-500 dark:text-gray-400">
                {isArabic ? 'الموديل' : 'Model'}
              </span>
              <select
                value={selectedModel}
                onChange={event => {
                  touchedModelsRef.current.add(provider);
                  setModelByProvider(current => ({ ...current, [provider]: event.target.value }));
                }}
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
              >
                {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          ) : selectedModel ? (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 text-xs dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
              <span className="text-gray-500 dark:text-gray-400">{isArabic ? 'الموديل' : 'Model'}</span>
              <span className="truncate font-mono font-bold text-gray-700 dark:text-gray-200" dir="ltr">{selectedModel}</span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void startSession()}
            disabled={!selectedProviderConfig?.available || hasActiveSession || actionState !== 'idle' || saveStatus === 'saving'}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 text-sm font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {actionState === 'starting' || saveStatus === 'saving'
              ? <Loader2 size={16} className="animate-spin" />
              : <Wand2 size={16} />}
            <span>{actionState === 'starting'
              ? (isArabic ? 'جار إنشاء الجلسة...' : 'Starting session...')
              : hasActiveSession
                ? (isArabic ? 'توجد جلسة قيد التنفيذ' : 'A session is already active')
                : (isArabic ? 'كتابة المقالة' : 'Write article')}</span>
          </button>

          {errorPresentation && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
              <div className="flex items-start gap-2 font-bold">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{errorPresentation.message}</span>
              </div>
              {errorPresentation.details.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {errorPresentation.details.map(detail => (
                    <span key={detail} className="rounded bg-white/80 px-1.5 py-1 text-[11px] dark:bg-black/20">{detail}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {selectedSession && (
          <section className="border-b border-gray-200 p-3 dark:border-[#3C3C3C]">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ${STATUS_STYLES[selectedSession.status]}`}>
                    <StatusIcon status={selectedSession.status} size={13} />
                    {getStatusLabel(selectedSession.status, isArabic)}
                  </span>
                  <span className="truncate text-[11px] font-bold text-gray-600 dark:text-gray-300">{getProviderLabel(selectedSession.provider)}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400" dir="ltr">{selectedSession.model}</div>
              </div>
              {isContentWritingSessionActive(selectedSession) && (
                <button
                  type="button"
                  onClick={() => void cancelSession()}
                  disabled={actionState !== 'idle' || Boolean(selectedSession.cancelRequestedAt)}
                  title={isArabic ? 'إيقاف الكتابة' : 'Stop writing'}
                  aria-label={isArabic ? 'إيقاف الكتابة' : 'Stop writing'}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-45 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-900/20"
                >
                  {actionState === 'cancelling' ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={15} />}
                </button>
              )}
            </div>

            {isContentWritingSessionActive(selectedSession) && (
              <div className="mt-3 space-y-2 rounded-md bg-gray-50 p-2 text-[11px] dark:bg-[#1F1F1F]">
                <div className="flex items-center gap-2 font-bold text-gray-700 dark:text-gray-200">
                  <Loader2 size={13} className="shrink-0 animate-spin text-[#d4af37]" />
                  <span className="min-w-0 truncate">{progressMessage || (isArabic ? 'جار تجهيز المحادثة...' : 'Preparing conversation...')}</span>
                </div>
                {(workflowStepCount > 0 || keyCount > 0 || modelCount > 0) && (
                  <div className="flex flex-wrap gap-1 text-[10px] font-bold text-gray-500 dark:text-gray-400">
                    {workflowStepCount > 0 && (
                      <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">
                        {displayedWorkflowStepLabel || (isArabic ? 'مرحلة التوليد' : 'Writing step')} {workflowStepIndex || 1}/{workflowStepCount}
                      </span>
                    )}
                    {modelCount > 0 && <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">{isArabic ? 'الموديل' : 'Model'} {modelIndex || 1}/{modelCount}</span>}
                    {keyCount > 0 && <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">{isArabic ? 'المفتاح' : 'Key'} {keyIndex || 1}/{keyCount}</span>}
                  </div>
                )}
              </div>
            )}

            {workflowSteps.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-bold text-gray-600 dark:text-gray-300">
                  <span>{isArabic ? 'مراحل التوليد المنظم' : 'Structured writing steps'}</span>
                  <span className="tabular-nums text-gray-400">{completedWorkflowSteps}/{workflowSteps.length}</span>
                </div>
                <div className="divide-y divide-gray-100 border-y border-gray-200 dark:divide-[#333] dark:border-[#3C3C3C]">
                  {workflowSteps.map(step => (
                    <div key={step.id} className="flex min-h-9 items-center justify-between gap-2 py-2 text-[11px]">
                      <div className={`flex min-w-0 items-center gap-2 font-bold ${STEP_STATUS_STYLES[step.status]}`}>
                        <span className="shrink-0"><StepStatusIcon status={step.status} /></span>
                        <span className="truncate text-gray-700 dark:text-gray-200">{getStepLabel(step, isArabic)}</span>
                      </div>
                      {step.attemptCount > 1 && (
                        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-1 text-[10px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                          {isArabic ? 'محاولة' : 'Attempt'} {step.attemptCount}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {['failed', 'cancelled'].includes(selectedSession.status) && (
              <div className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
                <div className="font-bold">{selectedSession.lastError || (selectedSession.status === 'cancelled'
                  ? (isArabic ? 'تم إيقاف جلسة الكتابة.' : 'The writing session was stopped.')
                  : (isArabic ? 'فشلت جلسة الكتابة.' : 'The writing session failed.'))}</div>
                <button
                  type="button"
                  onClick={() => void resumeSession()}
                  disabled={hasActiveSession || actionState !== 'idle' || !selectedSessionProviderAvailable}
                  className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-red-200 bg-white px-2 text-[11px] font-bold hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:bg-[#2A2A2A]"
                >
                  {actionState === 'resuming' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {isArabic ? 'استئناف من آخر مرحلة ناجحة' : 'Resume from the last completed step'}
                </button>
              </div>
            )}

            {selectedSession.status === 'completed' && selectedDetail?.session.resultText && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{isArabic ? 'المقالة الناتجة' : 'Generated article'}</span>
                  <button
                    type="button"
                    onClick={() => void copyResult()}
                    title={isArabic ? 'نسخ المقالة' : 'Copy article'}
                    aria-label={isArabic ? 'نسخ المقالة' : 'Copy article'}
                    className="flex size-8 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:border-[#d4af37]/50 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-300"
                  >
                    {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                  </button>
                </div>
                <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-white p-3 font-sans text-xs leading-6 text-gray-800 custom-scrollbar dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" dir="auto">
                  {selectedDetail.session.resultText}
                </pre>
              </div>
            )}

            {isDetailLoading && (
              <div className="mt-3 flex items-center justify-center gap-2 py-3 text-xs font-bold text-gray-400">
                <Loader2 size={14} className="animate-spin" />
                {isArabic ? 'جار تحميل الجلسة...' : 'Loading session...'}
              </div>
            )}
          </section>
        )}

        <section className="p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{isArabic ? 'سجل الكتابة' : 'Writing history'}</span>
            <span className="text-[10px] font-bold tabular-nums text-gray-400">{sessions.length}</span>
          </div>
          {sessions.length === 0 && !isListLoading ? (
            <div className="py-5 text-center text-xs font-semibold text-gray-400">
              {isArabic ? 'لا توجد جلسات كتابة بعد.' : 'No writing sessions yet.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-200 bg-white dark:divide-[#333] dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
              {sessions.map(session => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => setSelectedSessionId(session.id)}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-2 text-start transition-colors ${
                    session.id === selectedSessionId
                      ? 'bg-[#d4af37]/10'
                      : 'hover:bg-gray-50 dark:hover:bg-[#333]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-700 dark:text-gray-200">
                      <StatusIcon status={session.status} size={13} />
                      <span>{getProviderLabel(session.provider)}</span>
                      <span className="truncate font-mono text-[10px] font-normal text-gray-400" dir="ltr">{session.model}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-gray-400">{formatDateTime(session.createdAt, isArabic)}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[10px] font-bold ${STATUS_STYLES[session.status]}`}>
                    {getStatusLabel(session.status, isArabic)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default ContentWritingPanel;
