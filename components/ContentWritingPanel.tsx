import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BadgeDollarSign,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock3,
  Copy,
  Eye,
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
  collectAiKeyUsageEntries,
  formatAiKeySuffix,
} from '../utils/aiKeyUsageFeedback';
import {
  AI_EXECUTION_ACTIVITY_EVENT,
  beginAiExecutionActivity,
  finishAiExecutionActivity,
  getAiExecutionActivities,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity';
import {
  getContentWritingActivityId,
  monitorContentWritingSessionActivity,
  syncContentWritingSessionActivity,
} from '../utils/contentWritingActivityMonitor';
import {
  evaluateContentWritingQuality,
  normalizeContentWritingQualityReport,
  type ContentWritingQualityReport,
} from '../utils/contentWritingQuality';
import { recoverContentWritingDraft } from '../utils/contentWritingWorkflow';
import { normalizeContentWritingQualityConfiguration } from '../constants/contentWritingQuality';
import type { ExternalAiBridgeProvider } from '../types';
import ContentWritingExternalBridgePanel from './ContentWritingExternalBridgePanel';
import ContentWritingReviewModal from './ContentWritingReviewModal';
import ContentWritingStepResult, {
  getContentWritingStepDescription,
} from './ContentWritingStepResult';
import ContentWritingStageAuditPanel from './ContentWritingStageAuditPanel';
import FullArticlePipelineControl from './FullArticlePipelineControl';
import ContentWritingAutomationArticleStatus from './ContentWritingAutomationArticleStatus';
import {
  ContentWritingRequestError,
  cancelContentWritingSession,
  createContentWritingIdempotencyKey,
  getContentWritingSessionDetail,
  isContentWritingSessionActive,
  listContentWritingSessions,
  prepareExternalContentWritingConversation,
  recordExternalContentWritingResult,
  recordContentWritingSessionApplication,
  resumeContentWritingSession,
  startContentWritingSession,
  type ContentWritingProvider,
  type ContentWritingSession,
  type ContentWritingSessionDetail,
  type ContentWritingSessionStatus,
  type ContentWritingStep,
  type ContentWritingStepStatus,
  type ExternalContentWritingConversation,
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

type ReviewSnapshot = {
  sessionId?: string;
  articleId: string;
  markdown: string;
  isPartial: boolean;
  currentHtml: string;
  currentText: string;
  qualityReport: ContentWritingQualityReport;
};

type ApplicationNotice = {
  tone: 'success' | 'warning' | 'error';
  message: string;
};

const ACTIVE_POLL_MS = 2_500;
const LIST_POLL_MS = 6_000;

const isRecordValue = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

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

const hasUnpassedCompletedQuality = (session: ContentWritingSession): boolean => (
  session.status === 'completed'
  && (
    session.qualityReport?.passed === false
    || session.progress.qualityGatePassed === false
  )
);

const getSessionStatusLabel = (session: ContentWritingSession, isArabic: boolean): string => (
  hasUnpassedCompletedQuality(session)
    ? (isArabic ? 'تم الإنشاء — الجودة غير مجتازة' : 'Generated — quality not passed')
    : getStatusLabel(session.status, isArabic)
);

const getSessionStatusStyle = (session: ContentWritingSession): string => (
  hasUnpassedCompletedQuality(session)
    ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
    : STATUS_STYLES[session.status]
);

const getProviderLabel = (
  provider: ContentWritingProvider,
  executionMode: 'api' | 'external' = 'api',
): string => {
  if (executionMode === 'external') return provider === 'openai' ? 'ChatGPT خارجي' : 'Gemini خارجي';
  if (provider === 'geminiPaid') return 'Gemini Pro';
  if (provider === 'openai') return 'OpenAI';
  return 'Gemini';
};

const getSessionTriggerLabel = (
  session: ContentWritingSession,
  isArabic: boolean,
): string => {
  const storedSource = typeof session.contextSnapshot.triggerSource === 'string'
    ? session.contextSnapshot.triggerSource
    : '';
  const source = storedSource
    || (session.idempotencyKey.startsWith('auto-ready:')
      ? 'automatic_ready'
      : session.idempotencyKey.startsWith('full-pipeline:')
        ? 'full_pipeline'
        : session.executionMode === 'external'
          ? 'external'
          : 'manual');
  if (source === 'automatic_ready') return isArabic ? 'تلقائي — مقالة جاهزة' : 'Automatic — ready article';
  if (source === 'full_pipeline') return isArabic ? 'الإنشاء الشامل' : 'Full workflow';
  if (source === 'external') return isArabic ? 'استيراد خارجي' : 'External import';
  return isArabic ? 'بدء يدوي' : 'Manual start';
};

const getModelPreferenceHint = (
  provider: ContentWritingProvider,
  isArabic: boolean,
): string => {
  if (provider === 'gemini') {
    return isArabic
      ? 'هذا هو الموديل المفضّل ويُجرّب أولًا في كل مرحلة. عند فشل مفتاح تُجرّب بقية المفاتيح، وبعد نفادها قد ينتقل النظام إلى موديل Gemini مجاني آخر حسب إعداد التبديل.'
      : 'This preferred model is tried first for every step. If a key fails, the remaining keys are tried; after they are exhausted, another free Gemini model may be used according to the fallback setting.';
  }
  if (provider === 'geminiPaid') {
    return isArabic
      ? 'يبدأ كل طلب بموديل Gemini Pro المحدد وتُجرّب مفاتيحه المدفوعة بالتتابع. إذا فشلت جميعها، قد ينتقل النظام إلى Gemini المجاني إذا كان مسموحًا ومهيأً.'
      : 'Every request starts with the selected Gemini Pro model and rotates through its paid keys. If all fail, the system may fall back to free Gemini when allowed and configured.';
  }
  return isArabic
    ? 'يبدأ كل طلب بموديل OpenAI المحدد في الإعدادات وتُجرّب مفاتيحه بالتتابع. إذا فشلت جميعها، قد ينتقل النظام إلى Gemini Pro ثم Gemini المجاني.'
    : 'Every request starts with the OpenAI model selected in settings and rotates through its keys. If all fail, the system may fall back to Gemini Pro and then free Gemini.';
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
    content_writing_editor_source_coverage_incomplete: ['لم تكتمل تغطية جميع المعلومات والأفكار والتوصيات الموجودة في نص المحرر. راجع سجل نص المحرر والإصلاحات المستهدفة.', 'Not every information item, idea, or recommendation from the editor text was covered. Review the editor-source ledger and targeted repairs.'],
    content_writing_editor_source_coverage_lost: ['أوقفت الحماية اعتماد مراجعة لاحقة لأنها أسقطت عنصرًا إلزاميًا من نص المحرر.', 'A later revision was blocked because it dropped a mandatory editor-source item.'],
    AI_PROVIDER_DISABLED: ['قام الأدمن بتعطيل هذا المزود.', 'This provider is disabled by the administrator.'],
    AI_PROVIDER_NOT_CONFIGURED: ['المزود مفعّل ولكن مفتاحه غير مهيأ على الخادم.', 'The provider is enabled but not configured on the server.'],
    article_access_denied: ['لا تملك صلاحية كتابة هذه المقالة.', 'You cannot write this article.'],
    content_writing_external_context_changed: ['تغيرت بيانات المقالة بعد تجهيز المحادثة. افتح المزود من جديد وأعد إرسال الرسائل الثلاث.', 'The article changed after the conversation was prepared. Reopen the provider and resend the three messages.'],
    content_writing_external_result_empty: ['نتيجة الكتابة الخارجية فارغة.', 'The external writing result is empty.'],
    content_writing_external_result_too_large: ['نتيجة الكتابة الخارجية تتجاوز الحد المسموح.', 'The external writing result exceeds the allowed size.'],
    content_writing_idempotency_conflict: ['تعارض سجل الكتابة مع طلب سابق. أعد تجهيز المحادثة.', 'The writing record conflicts with an earlier request. Prepare the conversation again.'],
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
    competitor_index: isArabic
      ? 'بناء مصفوفة المنافسين وسجل المصادر والادعاءات'
      : 'Competitor coverage and claim ledger',
    coverage_audit: isArabic ? 'تدقيق اكتمال التغطية' : 'Coverage audit',
    section_repair: isArabic ? 'إصلاح قسم مستهدف' : 'Targeted section repair',
    outline: isArabic ? 'مخطط المقالة' : 'Article outline',
    introduction: isArabic ? 'المقدمة' : 'Introduction',
    conclusion: isArabic ? 'الخاتمة' : 'Conclusion',
    call_to_action: isArabic ? 'دعوة اتخاذ الإجراء' : 'Call to action',
    faq: isArabic ? 'الأسئلة الشائعة' : 'FAQ',
    final_review: isArabic ? 'المراجعة النهائية' : 'Final review',
    quality_repair: isArabic ? 'إصلاح معايير الجودة' : 'Quality repair',
  };
  const revisionPhase = String(step.metadata.revisionPhase || '');
  if (step.stepType === 'final_review' && revisionPhase) {
    if (revisionPhase === 'plan') {
      return isArabic ? 'خطة المراجعة النهائية' : 'Final review plan';
    }
    return isArabic ? 'تطبيق تعديلات المراجعة النهائية' : 'Apply final review edits';
  }
  if (step.stepType === 'quality_repair' && revisionPhase) {
    const pass = Math.max(1, Number(step.metadata.repairPass) || 1)
      .toLocaleString(isArabic ? 'ar' : 'en');
    return revisionPhase === 'plan'
      ? `${isArabic ? 'خطة إصلاح الجودة' : 'Quality repair plan'} ${pass}`
      : `${isArabic ? 'تطبيق إصلاح الجودة' : 'Apply quality repair'} ${pass}`;
  }
  if (step.stepType === 'quality_repair' || step.stepType === 'section_repair') {
    const sequence = Number(step.stepKey.match(/(\d+)$/)?.[1]) || 1;
    return `${labels[step.stepType]} ${sequence.toLocaleString(isArabic ? 'ar' : 'en')}`;
  }
  if (step.stepType !== 'section') return labels[step.stepType];
  const sectionIndex = Math.max(1, Number(step.metadata.sectionIndex) || step.ordinal - 1);
  return `${isArabic ? 'القسم' : 'Section'} ${sectionIndex}: ${step.title}`;
};

const getStepStatusLabel = (status: ContentWritingStepStatus, isArabic: boolean): string => {
  const labels: Record<ContentWritingStepStatus, [string, string]> = {
    pending: ['لم تبدأ', 'Pending'],
    running: ['جارية الآن', 'Running now'],
    completed: ['مكتملة', 'Completed'],
    failed: ['فشلت', 'Failed'],
  };
  return labels[status][isArabic ? 0 : 1];
};

const ContentWritingPanel: React.FC = () => {
  const {
    t,
    aiProviderCapabilities,
    chatGptOpenMode,
    isAiProviderEnabled,
    isAiProviderAvailable,
  } = useUser();
  const articleId = useEditorSelector(context => context.activeArticleId);
  const articleTitle = useEditorSelector(context => context.title);
  const articleLanguage = useEditorSelector(context => context.articleLanguage);
  const keywords = useEditorSelector(context => context.keywords);
  const goalContext = useEditorSelector(context => context.goalContext);
  const editor = useEditorSelector(context => context.editor);
  const handleSaveDraft = useEditorSelector(context => context.handleSaveDraft);
  const applyGeneratedArticleContent = useEditorSelector(context => context.applyGeneratedArticleContent);
  const reloadActiveArticleFromRemote = useEditorSelector(context => context.reloadActiveArticleFromRemote);
  const reloadActiveGoalContextFromRemote = useEditorSelector(context => context.reloadActiveGoalContextFromRemote);
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
  const [competitorPreparationStage, setCompetitorPreparationStage] = useState('');
  const [errorPresentation, setErrorPresentation] = useState<ErrorPresentation | null>(null);
  const [listLoadError, setListLoadError] = useState('');
  const [hasRunningWritingActivity, setHasRunningWritingActivity] = useState(false);
  const [hasActiveAutomaticWriting, setHasActiveAutomaticWriting] = useState(false);
  const [hasActiveFullPipeline, setHasActiveFullPipeline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applicationNotice, setApplicationNotice] = useState<ApplicationNotice | null>(null);
  const [expandedWorkflowStepKey, setExpandedWorkflowStepKey] = useState('');
  const workflowStepSelectionLockedRef = useRef(false);
  const activeArticleRef = useRef(articleId);
  const detailRequestRef = useRef(0);
  const startInFlightRef = useRef(false);
  const pendingStartRef = useRef<PendingStartRequest | null>(null);
  const providerTouchedRef = useRef(false);
  const touchedModelsRef = useRef<Set<ContentWritingProvider>>(new Set());
  const resumeSelectionSessionRef = useRef('');
  const trackedKeyFeedbackSessionsRef = useRef<Set<string>>(new Set());
  const contentWritingActivityIdsRef = useRef<Map<string, string>>(new Map());

  const getReviewQualityReport = useCallback((
    session: ContentWritingSession,
    markdown: string,
    configurationOverride?: unknown,
  ): ContentWritingQualityReport => {
    const persisted = session.qualityReport
      || normalizeContentWritingQualityReport(session.responseMetadata.qualityReport);
    if (persisted) return persisted;
    const configurationSource = configurationOverride
      || session.contextSnapshot.qualityConfiguration;
    return evaluateContentWritingQuality({
      markdown,
      articleTitle,
      keywords,
      goalContext,
      articleLanguage,
      configuration: normalizeContentWritingQualityConfiguration(
        configurationSource && typeof configurationSource === 'object'
          ? configurationSource as Record<string, unknown>
          : {},
      ),
    }).report;
  }, [articleLanguage, articleTitle, goalContext, keywords]);

  useEffect(() => {
    activeArticleRef.current = articleId;
    setHasActiveAutomaticWriting(false);
    setHasActiveFullPipeline(false);
  }, [articleId]);

  useEffect(() => {
    const synchronizeActivity = () => {
      setHasRunningWritingActivity(getAiExecutionActivities().some(activity => (
        activity.state === 'running'
        && activity.surface === 'content_writing'
        && activity.articleId === articleId
      )));
    };
    synchronizeActivity();
    window.addEventListener(AI_EXECUTION_ACTIVITY_EVENT, synchronizeActivity);
    return () => window.removeEventListener(AI_EXECUTION_ACTIVITY_EVENT, synchronizeActivity);
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
  const activeDetail = selectedDetail?.session.id === selectedSessionId ? selectedDetail : null;
  const selectedSession = activeDetail?.session || sessions.find(session => session.id === selectedSessionId) || null;
  const selectedLengthTarget = useMemo(() => {
    if (!selectedSession) return null;
    const source = isRecordValue(selectedSession.contextSnapshot.lengthTarget)
      ? selectedSession.contextSnapshot.lengthTarget
      : null;
    const targetWords = isRecordValue(source?.targetWords) ? source.targetWords : null;
    const outlineSections = isRecordValue(source?.outlineSections) ? source.outlineSections : null;
    const baselineCompetitor = isRecordValue(source?.baselineCompetitor)
      ? source.baselineCompetitor
      : null;
    const minWords = Number(targetWords?.min);
    const maxWords = Number(targetWords?.max);
    const minSections = Number(outlineSections?.min);
    const maxSections = Number(outlineSections?.max);
    if (
      !Number.isFinite(minWords)
      || !Number.isFinite(maxWords)
      || !Number.isFinite(minSections)
      || !Number.isFinite(maxSections)
    ) {
      return null;
    }
    return {
      mode: source?.mode === 'manual' ? 'manual' as const : 'automatic' as const,
      minWords,
      maxWords,
      minSections,
      maxSections,
      baselineWords: Number(baselineCompetitor?.wordCount) || 0,
    };
  }, [selectedSession]);
  const allWorkflowSteps = useMemo(() => activeDetail?.steps || [], [activeDetail?.steps]);
  const workflowSteps = useMemo(
    () => allWorkflowSteps.filter(step => !step.metadata.candidatePhase),
    [allWorkflowSteps],
  );
  const recoverableDraft = useMemo(() => {
    if (!selectedSession || !activeDetail) return null;
    const qualityInput = isRecordValue(activeDetail.session.contextSnapshot.qualityInput)
      ? activeDetail.session.contextSnapshot.qualityInput
      : {};
    const sessionGoalContext = isRecordValue(qualityInput.goalContext)
      ? qualityInput.goalContext
      : goalContext;
    const sessionKeywords = isRecordValue(qualityInput.keywords)
      ? qualityInput.keywords
      : {};
    return recoverContentWritingDraft({
      articleTitle,
      language: articleLanguage,
      sessionResultText: activeDetail.session.resultText,
      steps: workflowSteps,
      goalContext: sessionGoalContext,
      primaryKeyword: typeof sessionKeywords.primary === 'string'
        ? sessionKeywords.primary
        : keywords.primary,
    });
  }, [activeDetail, articleLanguage, articleTitle, goalContext, keywords.primary, selectedSession, workflowSteps]);
  const isRecoverableDraftPartial = Boolean(
    recoverableDraft
    && (selectedSession?.status !== 'completed' || !activeDetail?.session.resultText),
  );
  const selectedModel = modelByProvider[provider];
  const modelPreferenceHint = getModelPreferenceHint(provider, isArabic);
  const resumeSelectionChanged = Boolean(
    selectedSession
    && (selectedSession.provider !== provider || selectedSession.model !== selectedModel),
  );
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

  useEffect(() => {
    const resumeModel = aiProviderCapabilities.contentWriting.resumeModel;
    if (
      !selectedSession
      || selectedSession.executionMode !== 'api'
      || !['failed', 'cancelled'].includes(selectedSession.status)
      || resumeSelectionSessionRef.current === selectedSession.id
      || providerTouchedRef.current
      || touchedModelsRef.current.size > 0
      || !resumeModel
    ) {
      return;
    }
    const resumeProvider = providerConfigs.find(item => item.id === resumeModel.provider);
    if (!resumeProvider?.enabled || !resumeProvider.available) return;
    resumeSelectionSessionRef.current = selectedSession.id;
    setProvider(resumeModel.provider);
    setModelByProvider(current => ({
      ...current,
      [resumeModel.provider]: resumeModel.model,
    }));
  }, [aiProviderCapabilities.contentWriting.resumeModel, providerConfigs, selectedSession]);

  const mergeSession = useCallback((incoming: ContentWritingSession) => {
    setSessions(current => {
      const next = current.map(session => session.id === incoming.id ? { ...session, ...incoming } : session);
      return next.some(session => session.id === incoming.id) ? next : [incoming, ...next];
    });
  }, []);

  const loadDetail = useCallback(async (
    sessionId: string,
    options: { silent?: boolean; includeStepOutput?: boolean } = {},
  ) => {
    const requestId = ++detailRequestRef.current;
    if (!options.silent) setIsDetailLoading(true);
    try {
      // Load persisted output and compact evidence metadata, while keeping the
      // much larger raw prompt text server-side so active polling stays bounded.
      const detail = await getContentWritingSessionDetail(sessionId, {
        includeStepOutput: options.includeStepOutput === true,
        includeStepMetadata: true,
      });
      if (requestId !== detailRequestRef.current) return;
      setSelectedDetail(current => {
        if (!current || current.session.id !== detail.session.id) return detail;
        const previousSteps = new Map(current.steps.map(step => [step.id, step]));
        return {
          ...detail,
          steps: detail.steps.map(step => {
            if ('outputText' in step) return step;
            const previous = previousSteps.get(step.id);
            return previous && 'outputText' in previous
              ? { ...step, outputText: previous.outputText }
              : step;
          }),
        };
      });
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
      setListLoadError('');
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
      return rows;
    } catch (error) {
      if (activeArticleRef.current === targetArticleId) {
        const presentation = getErrorPresentation(error, isArabic);
        setListLoadError(presentation.message);
        if (!options.silent) setErrorPresentation(presentation);
      }
    } finally {
      if (!options.silent && activeArticleRef.current === targetArticleId) setIsListLoading(false);
    }
  }, [articleId, isArabic, selectedSessionId]);

  const handleAutomaticSessionDiscovered = useCallback((sessionId: string, sourceArticleId: string) => {
    if (
      !sessionId
      || sourceArticleId !== articleId
      || activeArticleRef.current !== sourceArticleId
      || sessions.some(session => session.id === sessionId && session.articleId === sourceArticleId)
    ) return;
    void (async () => {
      const rows = await refreshSessions({ silent: true, selectNewest: false });
      if (
        activeArticleRef.current === sourceArticleId
        && rows?.some(session => session.id === sessionId && session.articleId === sourceArticleId)
      ) setSelectedSessionId(sessionId);
    })();
  }, [articleId, refreshSessions, sessions]);

  useEffect(() => {
    detailRequestRef.current += 1;
    setSessions([]);
    setSelectedSessionId('');
    setSelectedDetail(null);
    setErrorPresentation(null);
    setListLoadError('');
    setCopied(false);
    setReviewSnapshot(null);
    setApplicationNotice(null);
    setCompetitorPreparationStage('');
    setExpandedWorkflowStepKey('');
    trackedKeyFeedbackSessionsRef.current.clear();
    contentWritingActivityIdsRef.current.clear();
    if (articleId) void refreshSessions();
  }, [articleId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadDetail(selectedSessionId, {
      includeStepOutput: selectedSession?.status === 'failed' || selectedSession?.status === 'cancelled',
    });
  }, [loadDetail, selectedSession?.status, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !isContentWritingSessionActive(selectedSession)) return;
    const timer = window.setInterval(() => {
      void loadDetail(selectedSessionId, { silent: true, includeStepOutput: false });
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadDetail, selectedSession, selectedSessionId]);

  useEffect(() => {
    if (!articleId || (!sessions.some(isContentWritingSessionActive) && !hasRunningWritingActivity)) return;
    const timer = window.setInterval(() => {
      void refreshSessions({ silent: true });
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [articleId, hasRunningWritingActivity, refreshSessions, sessions]);

  const startSession = async () => {
    if (
      !articleId
      || !selectedProviderConfig?.available
      || hasActiveSession
      || hasActiveAutomaticWriting
      || hasActiveFullPipeline
      || startInFlightRef.current
    ) return;
    const requestSignature = `${articleId}:${provider}:${selectedModel || 'default'}`;
    const pendingStart = pendingStartRef.current?.signature === requestSignature
      ? pendingStartRef.current
      : {
          signature: requestSignature,
          idempotencyKey: createContentWritingIdempotencyKey(articleId),
        };
    pendingStartRef.current = pendingStart;
    const activityId = `content-writing:${pendingStart.idempotencyKey}`;
    beginAiExecutionActivity({
      id: activityId,
      articleId,
      articleTitle,
      provider,
      requestedProvider: provider,
      model: selectedModel,
      requestedModel: selectedModel,
      surface: 'content_writing',
      action: 'كتابة المقالة',
      stage: 'preparing',
      message: isArabic ? 'جار حفظ المقالة وبدء جلسة الكتابة...' : 'Saving the article and starting the writing session...',
    });
    startInFlightRef.current = true;
    setActionState('starting');
    setErrorPresentation(null);
    try {
      const saved = await handleSaveDraft({ reason: 'manual', force: true });
      if (!saved) {
        throw new Error(isArabic
          ? 'تعذر حفظ بيانات المقالة قبل بدء جلسة الكتابة.'
          : 'The article could not be saved before starting the writing session.');
      }
      const started = await startContentWritingSession({
        articleId,
        provider,
        model: selectedModel || undefined,
        idempotencyKey: pendingStart.idempotencyKey,
        onPreparationProgress: progress => {
          if (activeArticleRef.current !== articleId) return;
          setCompetitorPreparationStage(progress.stage);
          const searching = progress.stage === 'competitor_discovery'
            || progress.stage === 'searching_competitors';
          const extracting = progress.stage === 'competitor_extraction'
            || progress.stage === 'extracting_competitor'
            || progress.stage === 'programmatic_fallback';
          updateAiExecutionActivity(activityId, {
            stage: progress.stage,
            message: isArabic
              ? searching
                ? 'جار البحث عن أفضل المنافسين تلقائيًا...'
                : extracting
                  ? 'جار سحب نصوص المنافسين تلقائيًا قبل الكتابة...'
                  : 'جار تجهيز نصوص المنافسين قبل بدء الكتابة...'
              : searching
                ? 'Automatically finding the strongest competitors...'
                : extracting
                  ? 'Automatically importing competitor texts before writing...'
                  : 'Preparing competitor texts before writing...',
          });
        },
      });
      setCompetitorPreparationStage('');
      pendingStartRef.current = null;
      if (activeArticleRef.current !== articleId) return;
      mergeSession(started.session);
      setSelectedSessionId(started.session.id);
      trackedKeyFeedbackSessionsRef.current.add(started.session.id);
      contentWritingActivityIdsRef.current.set(started.session.id, activityId);
      const activityOptions = {
        activityId,
        action: isArabic ? 'كتابة المقالة' : 'Article writing',
        articleId,
        articleTitle,
      };
      syncContentWritingSessionActivity(started.session, [], activityOptions);
      monitorContentWritingSessionActivity(started.session.id, activityOptions);
      if (started.reusedActive) {
        setApplicationNotice({
          tone: 'success',
          message: isArabic
            ? 'توجد جلسة كتابة نشطة بالفعل؛ تم فتحها بدل إنشاء طلب مكرر.'
            : 'An active writing session already exists; it was opened instead of creating a duplicate.',
        });
      }
      await loadDetail(started.session.id, { silent: true });
    } catch (error) {
      if (error instanceof ContentWritingRequestError && error.status < 500) {
        pendingStartRef.current = null;
      }
      if (activeArticleRef.current === articleId) {
        setErrorPresentation(getErrorPresentation(error, isArabic));
      }
      finishAiExecutionActivity(activityId, {
        articleId,
        articleTitle,
        provider,
        requestedProvider: provider,
        model: selectedModel,
        requestedModel: selectedModel,
        surface: 'content_writing',
        action: 'كتابة المقالة',
        outcome: 'failed',
        stage: 'failed',
        message: error instanceof Error ? error.message : (isArabic ? 'تعذر بدء جلسة الكتابة.' : 'Could not start the writing session.'),
      });
    } finally {
      startInFlightRef.current = false;
      setCompetitorPreparationStage('');
      setActionState('idle');
    }
  };

  const prepareExternalConversation = useCallback(async () => {
    if (!articleId) throw new Error(isArabic ? 'احفظ المقالة أولًا.' : 'Save the article first.');
    const targetArticleId = articleId;
    const saved = await handleSaveDraft({ reason: 'manual', force: true });
    if (!saved) {
      throw new Error(isArabic
        ? 'تعذر حفظ بيانات المقالة قبل تجهيز المحادثة الخارجية.'
        : 'The article could not be saved before preparing the external conversation.');
    }
    if (activeArticleRef.current !== targetArticleId) {
      throw new Error(isArabic ? 'تغيرت المقالة النشطة.' : 'The active article changed.');
    }
    return prepareExternalContentWritingConversation(targetArticleId);
  }, [articleId, handleSaveDraft, isArabic]);

  const importExternalResult = useCallback(async (
    externalProvider: ExternalAiBridgeProvider,
    response: string,
    conversation: ExternalContentWritingConversation,
    idempotencyKey: string,
  ) => {
    if (!articleId || !editor || editor.isDestroyed) {
      throw new Error(isArabic ? 'المحرر غير متاح لاستيراد المقالة.' : 'The editor is unavailable for article import.');
    }
    const recorded = await recordExternalContentWritingResult({
      articleId,
      externalProvider,
      idempotencyKey,
      preparedInputHash: conversation.inputHash,
      resultText: response,
    });
    if (activeArticleRef.current !== articleId) {
      throw new Error(isArabic ? 'تغيرت المقالة النشطة.' : 'The active article changed.');
    }
    mergeSession(recorded.session);
    setSelectedSessionId(recorded.session.id);
    setErrorPresentation(null);
    setApplicationNotice(null);
    setReviewSnapshot({
      sessionId: recorded.session.id,
      articleId,
      markdown: response,
      isPartial: false,
      currentHtml: editor.getHTML(),
      currentText: editor.getText(),
      qualityReport: getReviewQualityReport(recorded.session, response, conversation.qualityConfiguration),
    });
  }, [articleId, editor, getReviewQualityReport, isArabic, mergeSession]);

  const cancelSession = async () => {
    if (!selectedSession || !isContentWritingSessionActive(selectedSession)) return;
    setActionState('cancelling');
    setErrorPresentation(null);
    try {
      const cancelled = await cancelContentWritingSession(selectedSession.id);
      mergeSession(cancelled);
      setSelectedDetail(current => current ? { ...current, session: { ...current.session, ...cancelled } } : current);
      // Reload the persisted steps once cancellation is acknowledged so every
      // completed prose stage is immediately available to the recovery draft.
      await loadDetail(cancelled.id, { silent: true });
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
    } finally {
      setActionState('idle');
    }
  };

  const resumeSession = async () => {
    if (
      !selectedSession
      || !['failed', 'cancelled'].includes(selectedSession.status)
      || hasActiveSession
      || hasActiveAutomaticWriting
      || hasActiveFullPipeline
      || !selectedProviderConfig?.available
    ) {
      return;
    }
    setActionState('resuming');
    setErrorPresentation(null);
    const activityId = `content-writing:${selectedSession.id}:resume:${Date.now()}`;
    contentWritingActivityIdsRef.current.set(selectedSession.id, activityId);
    beginAiExecutionActivity({
      id: activityId,
      articleId,
      articleTitle,
      provider,
      requestedProvider: provider,
      model: selectedModel,
      requestedModel: selectedModel,
      surface: 'content_writing',
      action: 'استئناف كتابة المقالة',
      stage: 'resuming',
      message: isArabic ? 'جار استئناف الجلسة من آخر مرحلة ناجحة...' : 'Resuming from the last successful step...',
    });
    try {
      const resumed = await resumeContentWritingSession({
        sessionId: selectedSession.id,
        provider,
        model: selectedModel,
      });
      trackedKeyFeedbackSessionsRef.current.add(resumed.id);
      mergeSession(resumed);
      setSelectedDetail(current => current ? { ...current, session: { ...current.session, ...resumed } } : current);
      const activityOptions = {
        activityId,
        action: isArabic ? 'استئناف كتابة المقالة' : 'Resume article writing',
        articleId,
        articleTitle,
      };
      syncContentWritingSessionActivity(resumed, [], activityOptions);
      monitorContentWritingSessionActivity(resumed.id, activityOptions);
      await loadDetail(resumed.id, { silent: true });
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
      finishAiExecutionActivity(activityId, {
        articleId,
        articleTitle,
        provider,
        requestedProvider: provider,
        model: selectedModel,
        requestedModel: selectedModel,
        surface: 'content_writing',
        action: 'استئناف كتابة المقالة',
        outcome: 'failed',
        stage: 'failed',
        message: error instanceof Error ? error.message : (isArabic ? 'تعذر استئناف جلسة الكتابة.' : 'Could not resume the writing session.'),
      });
    } finally {
      setActionState('idle');
    }
  };

  const copyResult = async () => {
    const result = recoverableDraft?.markdown;
    if (!result) return;
    try {
      await copyMarkdownToClipboard(result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      setErrorPresentation(getErrorPresentation(error, isArabic));
    }
  };

  const openReview = () => {
    const session = activeDetail?.session;
    const markdown = recoverableDraft?.markdown;
    if (!session || !markdown || !editor || editor.isDestroyed || session.articleId !== articleId) {
      setApplicationNotice({
        tone: 'error',
        message: isArabic
          ? 'تعذر فتح المراجعة لأن المقالة النشطة أو نتيجة الجلسة لم تعد متطابقة.'
          : 'Review could not open because the active article or session result no longer matches.',
      });
      return;
    }
    if (hasActiveAutomaticWriting || hasActiveFullPipeline) {
      setApplicationNotice({
        tone: 'warning',
        message: hasActiveFullPipeline
          ? (isArabic
            ? 'لا يمكن اعتماد نتيجة أخرى أثناء الإنشاء الشامل، لأن هذا المسار قد يستبدل محتوى المحرر تلقائيًا.'
            : 'Another result cannot be applied while the full workflow is active because it may replace the editor content automatically.')
          : (isArabic
            ? 'انتظر اكتمال جلسة الكتابة التلقائية الحالية قبل مراجعة نتيجة أخرى وإدراجها.'
            : 'Wait for the current automatic writing session to finish before reviewing and inserting another result.'),
      });
      return;
    }
    setApplicationNotice(null);
    setReviewSnapshot({
      sessionId: session.id,
      articleId: session.articleId,
      markdown,
      isPartial: isRecoverableDraftPartial,
      currentHtml: editor.getHTML(),
      currentText: editor.getText(),
      qualityReport: getReviewQualityReport(session, markdown),
    });
  };

  const closeReview = useCallback(() => {
    if (!isApplying) setReviewSnapshot(null);
  }, [isApplying]);

  useEffect(() => {
    if (!reviewSnapshot || isApplying || (!hasActiveAutomaticWriting && !hasActiveFullPipeline)) return;
    setReviewSnapshot(null);
    setApplicationNotice({
      tone: 'warning',
      message: hasActiveFullPipeline
        ? (isArabic
          ? 'أُغلقت المراجعة دون إدراج لأن الإنشاء الشامل بدأ العمل على المقالة.'
          : 'The review was closed without insertion because the full workflow started working on the article.')
        : (isArabic
          ? 'أُغلقت المراجعة دون إدراج لأن الكتابة التلقائية بدأت العمل على المقالة.'
          : 'The review was closed without insertion because automatic writing started working on the article.'),
    });
  }, [hasActiveAutomaticWriting, hasActiveFullPipeline, isApplying, isArabic, reviewSnapshot]);

  const confirmApplication = async (qualityOverrideReason?: string) => {
    const snapshot = reviewSnapshot;
    if (!snapshot || isApplying) return;
    if (hasActiveAutomaticWriting || hasActiveFullPipeline) {
      setReviewSnapshot(null);
      setApplicationNotice({
        tone: 'warning',
        message: hasActiveFullPipeline
          ? (isArabic
            ? 'أُغلقت المراجعة دون إدراج لأن الإنشاء الشامل أصبح نشطًا.'
            : 'The review was closed without insertion because the full workflow became active.')
          : (isArabic
            ? 'أُغلقت المراجعة دون إدراج لأن جلسة كتابة تلقائية أصبحت نشطة.'
            : 'The review was closed without insertion because an automatic writing session became active.'),
      });
      return;
    }
    setIsApplying(true);
    setApplicationNotice(null);
    try {
      const applied = await applyGeneratedArticleContent({
        expectedArticleId: snapshot.articleId,
        markdown: snapshot.markdown,
      });
      if (!applied.ok) {
        const messages = {
          article_changed: isArabic
            ? 'تغيّرت المقالة النشطة قبل الاعتماد. أغلِق المعاينة وافتح النتيجة من المقالة الصحيحة.'
            : 'The active article changed before approval. Close the review and reopen it from the correct article.',
          editor_unavailable: isArabic ? 'المحرر غير متاح حاليًا.' : 'The editor is currently unavailable.',
          empty_result: isArabic ? 'نتيجة الكتابة لا تحتوي نصًا صالحًا للإدراج.' : 'The writing result has no valid body to insert.',
          backup_failed: isArabic
            ? 'تعذر حفظ النص الحالي، لذلك لم يتم استبداله.'
            : 'The current article could not be saved, so it was not replaced.',
          save_failed: isArabic
            ? 'أُدرج النص محليًا، لكن تعذر حفظه في قاعدة بيانات الخادم. أبقِ المقالة مفتوحة وأعد الضغط على الحفظ.'
            : 'The text was inserted locally but could not be saved to the server database. Keep the article open and retry saving.',
        };
        setApplicationNotice({
          tone: 'error',
          message: applied.errorCode ? messages[applied.errorCode] : (applied.error || (isArabic ? 'تعذر اعتماد النتيجة.' : 'The result could not be applied.')),
        });
        return;
      }

      try {
        if (snapshot.sessionId && !snapshot.isPartial) {
          const recorded = await recordContentWritingSessionApplication(
            snapshot.sessionId,
            qualityOverrideReason,
          );
          mergeSession(recorded);
          setSelectedDetail(current => current && current.session.id === recorded.id
            ? { ...current, session: { ...current.session, ...recorded } }
            : current);
        }
        setApplicationNotice({
          tone: 'success',
          message: snapshot.isPartial
            ? (isArabic
              ? `تم استيراد المسودة الجزئية وحفظها (${applied.nextWordCount.toLocaleString('ar')} كلمة). بقيت جلسة الكتابة غير مكتملة ويمكن استئنافها لاحقًا.`
              : `The partial draft was imported and saved (${applied.nextWordCount.toLocaleString('en')} words). The writing session remains incomplete and can be resumed later.`)
            : (isArabic
              ? `تم اعتماد المقالة وحفظها بنجاح (${applied.nextWordCount.toLocaleString('ar')} كلمة).`
              : `The article was approved and saved (${applied.nextWordCount.toLocaleString('en')} words).`),
        });
      } catch (recordError) {
        console.error('The generated article was saved but its application audit could not be recorded:', recordError);
        setApplicationNotice({
          tone: 'warning',
          message: isArabic
            ? 'تم إدراج المقالة وحفظها، لكن تعذر تسجيل عملية الاعتماد في السجل.'
            : 'The article was inserted and saved, but its approval audit could not be recorded.',
        });
      }
      setReviewSnapshot(null);
    } finally {
      setIsApplying(false);
    }
  };

  const progress = selectedSession?.progress || {};
  const progressMessage = typeof progress.message === 'string' ? progress.message.trim() : '';
  const keyIndex = Number(progress.currentKeyIndex) || 0;
  const keyCount = Number(progress.keyCount) || 0;
  const modelIndex = Number(progress.currentModelIndex) || 0;
  const modelCount = Number(progress.modelCount) || 0;
  const currentProgressModel = typeof progress.model === 'string' ? progress.model.trim() : '';
  const requestedProgressModel = typeof progress.requestedModel === 'string'
    ? progress.requestedModel.trim()
    : '';
  const isModelFallbackActive = Boolean(
    currentProgressModel
    && requestedProgressModel
    && currentProgressModel !== requestedProgressModel,
  );
  const workflowStepIndex = Number(progress.workflowStepIndex) || 0;
  const workflowStepCount = Number(progress.workflowStepCount) || 0;
  const workflowStepLabel = typeof progress.workflowStepLabel === 'string'
    ? progress.workflowStepLabel.trim()
    : '';
  const workflowStepKey = typeof progress.workflowStepKey === 'string'
    ? progress.workflowStepKey.trim()
    : '';
  const completedWorkflowSteps = workflowSteps.filter(step => step.status === 'completed').length;
  const qualityRepairStepCount = new Set(
    workflowSteps
      .filter(step => step.stepType === 'quality_repair')
      .map(step => Math.max(1, Number(step.metadata.repairPass) || (
        Number(step.stepKey.match(/quality-repair-(\d+)/)?.[1]) || 1
      ))),
  ).size;
  const automaticWorkflowStepKey = (
    (workflowStepKey && workflowSteps.some(step => step.stepKey === workflowStepKey)
      ? workflowStepKey
      : '')
    || workflowSteps.find(step => step.status === 'running')?.stepKey
    || [...workflowSteps].reverse().find(step => step.status === 'completed')?.stepKey
    || workflowSteps[0]?.stepKey
    || ''
  );
  const currentWorkflowStep = workflowSteps.find(step => step.stepKey === automaticWorkflowStepKey);
  const currentCandidateSteps = allWorkflowSteps.filter(step => (
    step.metadata.parentStepKey === automaticWorkflowStepKey
    && Boolean(step.metadata.candidatePhase)
  ));
  const completedCandidateSteps = currentCandidateSteps.filter(step => step.status === 'completed').length;
  const runningCandidateSteps = currentCandidateSteps.filter(step => step.status === 'running').length;
  const currentKeySuffix = typeof progress.keySuffix === 'string' ? progress.keySuffix.trim() : '';
  const sessionKeyUsageEntries = useMemo(() => {
    if (!selectedSession) return [];
    const terminalStatus = selectedSession.status === 'completed'
      ? 200
      : selectedSession.status === 'failed'
        ? 500
        : undefined;
    return collectAiKeyUsageEntries({
      status: terminalStatus,
      keySuffix: selectedSession.keySuffix,
      responseMetadata: selectedSession.responseMetadata,
      result: workflowSteps.map(step => step.metadata),
    });
  }, [selectedSession, workflowSteps]);

  useEffect(() => {
    workflowStepSelectionLockedRef.current = false;
    setExpandedWorkflowStepKey('');
  }, [selectedSessionId]);

  useEffect(() => {
    if (workflowStepSelectionLockedRef.current) return;
    setExpandedWorkflowStepKey(automaticWorkflowStepKey);
  }, [automaticWorkflowStepKey, selectedSessionId]);

  useEffect(() => {
    if (!selectedSession || selectedSession.executionMode !== 'api') return;
    if (isContentWritingSessionActive(selectedSession)) {
      trackedKeyFeedbackSessionsRef.current.add(selectedSession.id);
    }
    if (
      !isContentWritingSessionActive(selectedSession)
      && !trackedKeyFeedbackSessionsRef.current.has(selectedSession.id)
    ) return;
    const activityId = getContentWritingActivityId(
      selectedSession.id,
      contentWritingActivityIdsRef.current.get(selectedSession.id)
        || `content-writing:${selectedSession.id}`,
    );
    contentWritingActivityIdsRef.current.set(selectedSession.id, activityId);
    const activityOptions = {
      activityId,
      action: isArabic ? 'كتابة المقالة' : 'Article writing',
      articleId,
      articleTitle,
    };
    syncContentWritingSessionActivity(selectedSession, workflowSteps, activityOptions);
    if (isContentWritingSessionActive(selectedSession)) {
      monitorContentWritingSessionActivity(selectedSession.id, activityOptions);
    }
  }, [articleId, articleTitle, isArabic, selectedSession, sessionKeyUsageEntries, workflowSteps]);
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
      <div className="flex items-center justify-between gap-[0.125rem] border-b border-gray-200 bg-white px-[0.1875rem] py-[0.1875rem] dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <div className="flex min-w-0 items-center gap-[0.125rem]">
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
        <section className="space-y-[0.1875rem] border-b border-gray-200 p-[0.1875rem] dark:border-[#3C3C3C]">
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
                title={modelPreferenceHint}
                onChange={event => {
                  touchedModelsRef.current.add(provider);
                  setModelByProvider(current => ({ ...current, [provider]: event.target.value }));
                }}
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
              >
                {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="mt-1.5 block text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                {modelPreferenceHint}
              </span>
            </label>
          ) : selectedModel ? (
            <div>
              <div
                className="flex h-9 items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 text-xs dark:border-[#3C3C3C] dark:bg-[#1F1F1F]"
                title={modelPreferenceHint}
              >
                <span className="text-gray-500 dark:text-gray-400">{isArabic ? 'الموديل المفضّل' : 'Preferred model'}</span>
                <span className="truncate font-mono font-bold text-gray-700 dark:text-gray-200" dir="ltr">{selectedModel}</span>
              </div>
              <p className="mt-1.5 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                {modelPreferenceHint}
              </p>
            </div>
          ) : null}

          <ContentWritingAutomationArticleStatus
            articleId={articleId}
            isArabic={isArabic}
            onSessionDiscovered={handleAutomaticSessionDiscovered}
            onAutomaticActivityChange={setHasActiveAutomaticWriting}
            onFullPipelineActivityChange={setHasActiveFullPipeline}
          />

          <FullArticlePipelineControl
            articleId={articleId}
            articleTitle={articleTitle}
            provider={provider}
            model={selectedModel}
            isArabic={isArabic}
            disabled={
              !selectedProviderConfig?.available
              || hasActiveSession
              || hasActiveAutomaticWriting
              || actionState !== 'idle'
              || saveStatus === 'saving'
              || isApplying
            }
            onBeforeStart={() => handleSaveDraft({ reason: 'manual', force: true })}
            onReloadArticle={reloadActiveArticleFromRemote}
            onReloadGoalContext={reloadActiveGoalContextFromRemote}
            onActivityChange={setHasActiveFullPipeline}
          />

          <button
            type="button"
            onClick={() => void startSession()}
            disabled={
              !selectedProviderConfig?.available
              || hasActiveSession
              || hasActiveAutomaticWriting
              || hasActiveFullPipeline
              || actionState !== 'idle'
              || saveStatus === 'saving'
            }
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 text-sm font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {actionState === 'starting' || saveStatus === 'saving'
              ? <Loader2 size={16} className="animate-spin" />
              : <Wand2 size={16} />}
            <span>{actionState === 'starting'
              ? competitorPreparationStage
                ? (isArabic ? 'جار سحب نصوص المنافسين...' : 'Importing competitor texts...')
                : (isArabic ? 'جار إنشاء الجلسة...' : 'Starting session...')
              : hasActiveSession || hasActiveAutomaticWriting
                ? (isArabic ? 'توجد جلسة قيد التنفيذ' : 'A session is already active')
                : hasActiveFullPipeline
                  ? (isArabic ? 'الإنشاء الشامل قيد التنفيذ' : 'Full workflow is active')
                : (isArabic ? 'كتابة المقالة' : 'Write article')}</span>
          </button>

          <ContentWritingExternalBridgePanel
            articleId={articleId}
            isArabic={isArabic}
            openMode={chatGptOpenMode}
            disabled={
              hasActiveSession
              || hasActiveAutomaticWriting
              || hasActiveFullPipeline
              || actionState !== 'idle'
              || saveStatus === 'saving'
              || isApplying
            }
            prepareConversation={prepareExternalConversation}
            onImportResponse={importExternalResult}
            onError={error => setErrorPresentation(getErrorPresentation(error, isArabic))}
          />

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
                  <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ${getSessionStatusStyle(selectedSession)}`}>
                    <StatusIcon status={selectedSession.status} size={13} />
                    {getSessionStatusLabel(selectedSession, isArabic)}
                  </span>
                  <span className="truncate text-[11px] font-bold text-gray-600 dark:text-gray-300">{getProviderLabel(selectedSession.provider, selectedSession.executionMode)}</span>
                  <span className="rounded bg-gray-100 px-1.5 py-1 text-[9px] font-black text-gray-600 dark:bg-[#383838] dark:text-gray-300">
                    {getSessionTriggerLabel(selectedSession, isArabic)}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400" dir="ltr">{selectedSession.model}</div>
                {selectedSession.status === 'completed' && requestedProgressModel && requestedProgressModel !== selectedSession.model && (
                  <div className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300" dir="ltr">
                    {requestedProgressModel} → {selectedSession.model}
                  </div>
                )}
                {selectedSession.qualityScore !== null && (
                  <div className={`mt-1.5 inline-flex rounded px-2 py-1 text-[10px] font-black ${selectedSession.qualityReport?.passed
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
                    {isArabic ? 'الجودة' : 'Quality'} {selectedSession.qualityScore}/100 · v{selectedSession.qualityPolicyVersion}
                  </div>
                )}
                {selectedLengthTarget && (
                  <div className="mt-1.5 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/5 px-2 py-1.5 text-[10px] font-bold leading-5 text-gray-600 dark:bg-[#d4af37]/10 dark:text-gray-300">
                    <div>
                      {isArabic ? 'هدف الكلمات' : 'Word target'}:{' '}
                      {selectedLengthTarget.minWords.toLocaleString(isArabic ? 'ar' : 'en')}
                      {'–'}
                      {selectedLengthTarget.maxWords.toLocaleString(isArabic ? 'ar' : 'en')}
                      {' · '}
                      {isArabic ? 'أقسام المتن' : 'Body sections'}:{' '}
                      {selectedLengthTarget.minSections.toLocaleString(isArabic ? 'ar' : 'en')}
                      {'–'}
                      {selectedLengthTarget.maxSections.toLocaleString(isArabic ? 'ar' : 'en')}
                    </div>
                    <div className="text-[9px] text-gray-500 dark:text-gray-400">
                      {selectedLengthTarget.mode === 'manual'
                        ? (isArabic ? 'نطاق حدده المستخدم' : 'User-defined range')
                        : (isArabic
                            ? `تلقائي: أكبر منافس ${selectedLengthTarget.baselineWords.toLocaleString('ar')} كلمة × 1.20، بهامش ±10%`
                            : `Automatic: largest competitor ${selectedLengthTarget.baselineWords.toLocaleString('en')} words × 1.20, with ±10% tolerance`)}
                    </div>
                  </div>
                )}
                {sessionKeyUsageEntries.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {sessionKeyUsageEntries.map((entry, index) => (
                      <span
                        key={`${entry.outcome}-${entry.keySuffix}-${entry.status || 0}-${index}`}
                        className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-black ${entry.outcome === 'success'
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}
                        dir="ltr"
                        title={entry.outcome === 'success'
                          ? (isArabic ? 'نجح المفتاح' : 'Key succeeded')
                          : (isArabic ? 'فشل المفتاح' : 'Key failed')}
                      >
                        {entry.outcome === 'success' ? '✓' : '×'} {formatAiKeySuffix(entry.keySuffix)}{entry.status ? ` · ${entry.status}` : ''}
                      </span>
                    ))}
                  </div>
                )}
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
                    {currentCandidateSteps.length > 0 && (
                      <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">
                        {isArabic ? 'المرشحون' : 'Candidates'} {completedCandidateSteps}/{currentCandidateSteps.length}
                        {runningCandidateSteps > 0 ? ` · ${isArabic ? 'يعمل' : 'running'} ${runningCandidateSteps}` : ''}
                      </span>
                    )}
                    {modelCount > 0 && <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">{isArabic ? 'الموديل' : 'Model'} {modelIndex || 1}/{modelCount}</span>}
                    {currentProgressModel && (
                      <span
                        className={`rounded px-1.5 py-1 font-mono ${
                          isModelFallbackActive
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                            : 'bg-white dark:bg-[#2A2A2A]'
                        }`}
                        dir="ltr"
                        title={isModelFallbackActive
                          ? (isArabic ? `موديل بديل عن ${requestedProgressModel}` : `Fallback model for ${requestedProgressModel}`)
                          : (isArabic ? 'الموديل المستخدم حاليًا' : 'Current model')}
                      >
                        {currentProgressModel}
                      </span>
                    )}
                    {keyCount > 0 && <span className="rounded bg-white px-1.5 py-1 dark:bg-[#2A2A2A]">{isArabic ? 'المفتاح' : 'Key'} {keyIndex || 1}/{keyCount}</span>}
                    {currentKeySuffix && (
                      <span className="rounded bg-white px-1.5 py-1 font-mono font-black dark:bg-[#2A2A2A]" dir="ltr">
                        {formatAiKeySuffix(currentKeySuffix)}
                      </span>
                    )}
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
                {qualityRepairStepCount > 1 && (
                  <div className="mb-2 rounded-md border border-blue-100 bg-blue-50/60 p-2 text-[10px] font-bold leading-5 text-blue-700 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-300">
                    {isArabic
                      ? `يوجد ${qualityRepairStepCount.toLocaleString('ar')} محاولات مستقلة لإصلاح الجودة. ظهور علامة خضراء يعني أن المحاولة السابقة اكتملت، بينما تعمل المحاولة التالية على المخالفات المتبقية.`
                      : `There are ${qualityRepairStepCount.toLocaleString('en')} separate quality-repair passes. A green check means the previous pass completed while the next pass works on remaining failures.`}
                  </div>
                )}
                <div className="space-y-1.5">
                  {workflowSteps.map(step => {
                    const isExpanded = expandedWorkflowStepKey === step.stepKey;
                    const hasRunningCandidate = allWorkflowSteps.some(candidate => (
                      candidate.status === 'running'
                      && candidate.metadata.parentStepKey === step.stepKey
                    ));
                    const displayedStepStatus: ContentWritingStepStatus = hasRunningCandidate
                      ? 'running'
                      : step.status;
                    const outputText = typeof step.outputText === 'string' ? step.outputText.trim() : '';
                    const stepDescription = getContentWritingStepDescription(step, isArabic);
                    const resultPanelId = `content-writing-step-result-${step.id}`;
                    return (
                      <div
                        key={step.id}
                        className={`overflow-hidden rounded-md border ${
                          displayedStepStatus === 'running'
                            ? 'border-blue-300 bg-blue-50/40 dark:border-blue-800 dark:bg-blue-500/5'
                            : 'border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#252525]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            workflowStepSelectionLockedRef.current = true;
                            if (!isExpanded && !('outputText' in step) && selectedSessionId) {
                              void loadDetail(selectedSessionId, {
                                silent: true,
                                includeStepOutput: true,
                              });
                            }
                            setExpandedWorkflowStepKey(current => (
                              current === step.stepKey ? '' : step.stepKey
                            ));
                          }}
                          aria-expanded={isExpanded}
                          aria-controls={resultPanelId}
                          className="flex min-h-11 w-full items-center justify-between gap-2 px-2.5 py-2 text-start text-[11px] hover:bg-gray-50 dark:hover:bg-white/5"
                        >
                          <span className={`flex min-w-0 items-start gap-2 font-bold ${STEP_STATUS_STYLES[displayedStepStatus]}`}>
                            <span className="mt-0.5 shrink-0"><StepStatusIcon status={displayedStepStatus} /></span>
                            <span className="min-w-0 break-words leading-5 text-gray-700 dark:text-gray-200">
                              {getStepLabel(step, isArabic)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {step.attemptCount > 1 && (
                              <span className="rounded bg-gray-100 px-1.5 py-1 text-[9px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                                {isArabic ? 'محاولة' : 'Attempt'} {step.attemptCount}
                              </span>
                            )}
                            <span className={`rounded px-1.5 py-1 text-[9px] font-black ${STEP_STATUS_STYLES[displayedStepStatus]}`}>
                              {getStepStatusLabel(displayedStepStatus, isArabic)}
                            </span>
                            <ChevronDown
                              size={14}
                              className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            />
                          </span>
                        </button>

                        {isExpanded && (
                          <div
                            id={resultPanelId}
                            className="border-t border-gray-100 px-2.5 py-2.5 text-[11px] dark:border-[#333]"
                            aria-live={displayedStepStatus === 'running' ? 'polite' : undefined}
                          >
                            <div className="mb-2 font-black text-gray-600 dark:text-gray-300">
                              {isArabic ? 'نتيجة المرحلة' : 'Step result'}
                            </div>
                            {stepDescription && (
                              <div className="mb-2 rounded-md border border-blue-100 bg-blue-50/60 p-2.5 font-semibold leading-5 text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-200">
                                {stepDescription}
                              </div>
                            )}
                            <ContentWritingStageAuditPanel
                              step={step}
                              contextSnapshot={activeDetail?.session.contextSnapshot || {}}
                              isArabic={isArabic}
                            />
                            {outputText ? (
                              <ContentWritingStepResult
                                step={step}
                                workflowSteps={allWorkflowSteps}
                                contextSnapshot={activeDetail?.session.contextSnapshot || {}}
                                outputText={outputText}
                                isArabic={isArabic}
                              />
                            ) : displayedStepStatus === 'running' ? (
                              <div className="flex items-center gap-2 rounded-md bg-blue-50 p-2.5 font-bold leading-5 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                                <Loader2 size={13} className="shrink-0 animate-spin" />
                                <span>
                                  {isArabic
                                    ? 'جار توليد نتيجة هذه المرحلة، وستظهر هنا مباشرة فور اكتمالها.'
                                    : 'This step is generating now. Its result will appear here immediately when complete.'}
                                </span>
                              </div>
                            ) : step.status === 'failed' ? (
                              <div className="rounded-md bg-red-50 p-2.5 font-bold leading-5 text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                {step.lastError || (isArabic ? 'فشلت هذه المرحلة ولم تُحفظ نتيجة صالحة.' : 'This step failed without a valid saved result.')}
                              </div>
                            ) : step.status === 'pending' ? (
                              <div className="rounded-md bg-gray-50 p-2.5 font-semibold leading-5 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-400">
                                {isArabic ? 'لم تبدأ هذه المرحلة بعد.' : 'This step has not started yet.'}
                              </div>
                            ) : (
                              <div className="rounded-md bg-gray-50 p-2.5 font-semibold leading-5 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-400">
                                {isArabic ? 'اكتملت المرحلة دون نتيجة نصية قابلة للعرض.' : 'This step completed without a displayable text result.'}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {['failed', 'cancelled'].includes(selectedSession.status) && (
              <div className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
                <div className="font-bold">{selectedSession.lastError || (selectedSession.status === 'cancelled'
                  ? (isArabic ? 'تم إيقاف جلسة الكتابة.' : 'The writing session was stopped.')
                  : (isArabic ? 'فشلت جلسة الكتابة.' : 'The writing session failed.'))}</div>
                <div className="mt-2 rounded bg-white/80 p-2 text-[10px] font-semibold leading-5 text-gray-600 dark:bg-black/20 dark:text-gray-200">
                  {isArabic
                    ? `سيُستأنف تنفيذ المراحل المتبقية باستخدام ${getProviderLabel(provider)} والموديل ${selectedModel} كاختيار أول. تبقى المراحل المكتملة محفوظة، ويعمل تدوير المفاتيح والموديلات عند الفشل.`
                    : `The remaining steps will resume with ${getProviderLabel(provider)} and ${selectedModel} as the first choice. Completed steps stay saved, and key/model fallback remains active on failure.`}
                  {resumeSelectionChanged && (
                    <span className="mt-1 block font-black text-[#8a6f1d] dark:text-[#f2d675]">
                      {isArabic
                        ? 'تم تغيير اختيار الاستئناف عن مزود أو موديل الجلسة السابقة.'
                        : 'The resume selection differs from the previous session provider or model.'}
                    </span>
                  )}
                </div>
                {!recoverableDraft && (
                  <div className="mt-2 rounded bg-white/80 p-2 text-[10px] font-semibold leading-5 text-gray-600 dark:bg-black/20 dark:text-gray-200">
                    {isArabic
                      ? 'لم تكتمل بعد أي مرحلة تكتب نص المقالة، لذلك لا توجد مسودة قابلة للاستيراد. تبقى نتائج التحليل أو المخطط متاحة داخل المراحل أعلاه.'
                      : 'No article-writing prose step completed yet, so there is no draft to import. Analysis or outline results remain available in the steps above.'}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void resumeSession()}
                  disabled={
                    hasActiveSession
                    || hasActiveAutomaticWriting
                    || hasActiveFullPipeline
                    || actionState !== 'idle'
                    || !selectedProviderConfig?.available
                  }
                  title={isArabic
                    ? (hasActiveFullPipeline
                      ? 'لا يمكن الاستئناف أثناء الإنشاء الشامل.'
                      : hasActiveAutomaticWriting
                        ? 'لا يمكن الاستئناف أثناء الكتابة التلقائية.'
                        : `استئناف بالموديل ${selectedModel} أولًا مع الاحتفاظ بالمراحل المكتملة`)
                    : (hasActiveFullPipeline
                      ? 'Resume is unavailable while the full workflow is active.'
                      : hasActiveAutomaticWriting
                        ? 'Resume is unavailable while automatic writing is active.'
                        : `Resume with ${selectedModel} first while keeping completed steps`)}
                  className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-red-200 bg-white px-2 text-[11px] font-bold hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:bg-[#2A2A2A]"
                >
                  {actionState === 'resuming' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {isArabic ? 'استئناف من آخر مرحلة ناجحة' : 'Resume from the last completed step'}
                </button>
              </div>
            )}

            {recoverableDraft && !isContentWritingSessionActive(selectedSession) && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-200">
                    {isRecoverableDraftPartial
                      ? (isArabic ? 'المسودة الجزئية المستردة' : 'Recovered partial draft')
                      : (isArabic ? 'المقالة الناتجة' : 'Generated article')}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={openReview}
                      disabled={
                        isApplying
                        || hasActiveAutomaticWriting
                        || hasActiveFullPipeline
                        || selectedSession.articleId !== articleId
                      }
                      title={hasActiveFullPipeline
                        ? (isArabic ? 'انتظر انتهاء الإنشاء الشامل قبل الإدراج.' : 'Wait for the full workflow to finish before insertion.')
                        : hasActiveAutomaticWriting
                          ? (isArabic ? 'انتظر انتهاء الكتابة التلقائية قبل الإدراج.' : 'Wait for automatic writing to finish before insertion.')
                          : undefined}
                      className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#d4af37]/40 bg-[#d4af37]/10 px-2 text-[11px] font-bold text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:opacity-45 dark:text-[#f2d675]"
                    >
                      <Eye size={14} />
                      {isRecoverableDraftPartial
                        ? (isArabic ? 'مراجعة واستيراد المسودة' : 'Review and import draft')
                        : (isArabic ? 'مراجعة وإدراج' : 'Review and insert')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyResult()}
                      title={isArabic ? 'نسخ النص المعروض' : 'Copy displayed text'}
                      aria-label={isArabic ? 'نسخ النص المعروض' : 'Copy displayed text'}
                      className="flex size-8 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:border-[#d4af37]/50 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-300"
                    >
                      {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                    </button>
                  </div>
                </div>
                {isRecoverableDraftPartial && (
                  <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[10px] font-bold leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
                    {isArabic
                      ? `جُمعت هذه المسودة من ${recoverableDraft.includedStepCount.toLocaleString('ar')} من مراحل كتابة النص المكتملة فقط. لا تتضمن نتائج التحليل الخام، ولا تُعد الجلسة مكتملة، ويمكن مراجعتها واستيرادها أو استئناف الجلسة لاحقًا.`
                      : `This draft was assembled from ${recoverableDraft.includedStepCount.toLocaleString('en')} completed prose steps only. It excludes raw analysis, does not mark the session complete, and can be reviewed/imported or resumed later.`}
                  </div>
                )}
                {!isRecoverableDraftPartial && selectedSession.appliedAt && (
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
                    <CheckCircle2 size={13} />
                    <span>
                      {isArabic ? 'تم الإدراج' : 'Inserted'} {formatDateTime(selectedSession.appliedAt, isArabic)}
                      {selectedSession.applicationCount > 1 ? ` · ${selectedSession.applicationCount}` : ''}
                    </span>
                  </div>
                )}
                <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-white p-3 font-sans text-xs leading-6 text-gray-800 custom-scrollbar dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" dir="auto">
                  {recoverableDraft.markdown}
                </pre>
              </div>
            )}

            {applicationNotice && (
              <div className={`mt-3 rounded-md border p-2 text-xs font-bold ${
                applicationNotice.tone === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-900/20 dark:text-emerald-300'
                  : applicationNotice.tone === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300'
              }`}>
                {applicationNotice.message}
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
          {listLoadError && (
            <div className="mb-2 flex items-start justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[10px] font-bold leading-5 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
              <span>{isArabic ? `تعذر تحديث سجل الكتابة: ${listLoadError}` : `Could not refresh writing history: ${listLoadError}`}</span>
              <button
                type="button"
                onClick={() => void refreshSessions()}
                className="shrink-0 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/30"
                title={isArabic ? 'إعادة المحاولة' : 'Retry'}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          )}
          {sessions.length === 0 && !isListLoading ? (
            <div className={`py-5 text-center text-xs font-semibold ${hasRunningWritingActivity ? 'text-amber-600 dark:text-amber-300' : 'text-gray-400'}`}>
              {hasRunningWritingActivity
                ? (isArabic
                    ? 'توجد عملية كتابة نشطة؛ جار مزامنة سجلها من الخادم...'
                    : 'A writing operation is active; its server record is being synchronized...')
                : (isArabic ? 'لا توجد جلسات كتابة بعد.' : 'No writing sessions yet.')}
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
                      <span>{getProviderLabel(session.provider, session.executionMode)}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] dark:bg-[#383838]">
                        {getSessionTriggerLabel(session, isArabic)}
                      </span>
                      <span className="truncate font-mono text-[10px] font-normal text-gray-400" dir="ltr">{session.model}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-gray-400">{formatDateTime(session.createdAt, isArabic)}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[10px] font-bold ${getSessionStatusStyle(session)}`}>
                    {getSessionStatusLabel(session, isArabic)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {reviewSnapshot && (
        <ContentWritingReviewModal
          articleTitle={articleTitle}
          articleLanguage={articleLanguage}
          locale={isArabic ? 'ar' : 'en'}
          currentHtml={reviewSnapshot.currentHtml}
          currentText={reviewSnapshot.currentText}
          resultMarkdown={reviewSnapshot.markdown}
          isPartial={reviewSnapshot.isPartial}
          qualityReport={reviewSnapshot.qualityReport}
          allowQualityOverride
          qualityOverrideReasonRequired={
            aiProviderCapabilities.contentWriting.qualityOverrideReasonRequired
          }
          isApplying={isApplying}
          onConfirm={qualityOverrideReason => void confirmApplication(qualityOverrideReason)}
          onClose={closeReview}
        />
      )}
    </div>
  );
};

export default ContentWritingPanel;
