import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { GoalContext } from '../types';
import type { CompetitorPreviewTarget } from './CompetitorPreviewModal';
import {
  COMPETITOR_DISCOVERY_QUEUE_STALL_MS,
  COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
  COMPETITOR_EXTRACTION_QUEUE_STALL_MS,
  MAX_ARTICLE_COMPETITORS,
  type CompetitorSearchMode,
} from '../constants/competitors';
import {
  cancelArticleCompetitorDiscovery,
  cancelArticleCompetitorExtraction,
  CompetitorDiscoveryRequestError,
  enqueueArticleCompetitorExtraction,
  getPersistedCompetitorDiscovery,
  listArticleCompetitors,
  loadArticleCompetitorPreview,
  removeArticleCompetitor,
  searchArticleCompetitors,
  type CompetitorDiscoveryRow,
  type CompetitorDiscoveryState,
  type CompetitorPreview,
  type CompetitorSearchResult,
  type CompetitorSelectionSummary,
} from '../utils/competitorDiscovery';

const CompetitorPreviewModal = React.lazy(() => import('./CompetitorPreviewModal'));

type CompetitorDiscoveryPanelProps = {
  articleId: string | null;
  articleTitle: string;
  primaryKeyword: string;
  alternativeKeywords?: string[];
  articleLanguage: 'ar' | 'en';
  goalContext: GoalContext;
  companyName: string;
  locale: 'ar' | 'en';
  onCompetitorsChange: (rows: CompetitorDiscoveryRow[]) => void;
};

const EMPTY_STATE: CompetitorDiscoveryState = {
  providerConfigured: true,
  competitors: [],
  activeJob: null,
  latestJob: null,
  discoveryJob: null,
  discoveryReadiness: null,
};

const ACTIVE_JOB_STATUSES = new Set(['waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused']);

const intentLabels: Record<CompetitorSearchResult['inferredIntent'], { ar: string; en: string }> = {
  informational: { ar: 'معلوماتية', en: 'Informational' },
  commercial: { ar: 'تجارية', en: 'Commercial' },
  transactional: { ar: 'شرائية', en: 'Transactional' },
  navigational: { ar: 'وصول مباشر', en: 'Navigational' },
  local: { ar: 'محلية', en: 'Local' },
  support: { ar: 'دعم وحل مشكلة', en: 'Support' },
  unknown: { ar: 'غير محددة', en: 'Unknown' },
};

const pageTypeLabels: Record<CompetitorSearchResult['inferredPageType'], { ar: string; en: string }> = {
  article: { ar: 'مقالة', en: 'Article' },
  guide: { ar: 'دليل', en: 'Guide' },
  comparison: { ar: 'مقارنة', en: 'Comparison' },
  service: { ar: 'خدمة', en: 'Service' },
  product: { ar: 'منتج', en: 'Product' },
  category: { ar: 'تصنيف', en: 'Category' },
  landing: { ar: 'صفحة هبوط', en: 'Landing page' },
  news: { ar: 'خبر', en: 'News' },
  forum: { ar: 'نقاش', en: 'Forum' },
  video: { ar: 'فيديو', en: 'Video' },
  homepage: { ar: 'صفحة رئيسية', en: 'Homepage' },
  unknown: { ar: 'غير محدد', en: 'Unknown' },
};

const selectionReasonLabels: Record<string, { ar: string; en: string }> = {
  'auto-selected': { ar: 'مختار تلقائيًا', en: 'Auto-selected' },
  'content-keyword-qualified': { ar: 'مؤهل من نص الصفحة', en: 'Content-qualified' },
  'primary-keyword-in-content': { ar: 'استهدف الكلمة الأساسية', en: 'Primary keyword targeted' },
  'alternative-keyword-in-content': { ar: 'استهدف صيغة بديلة', en: 'Alternative keyword targeted' },
  'keyword-in-heading': { ar: 'الكلمة في العناوين', en: 'Keyword in headings' },
  'keyword-in-introduction': { ar: 'الكلمة في المقدمة', en: 'Keyword in introduction' },
  'direct-intent-match': { ar: 'مطابق لنية البحث', en: 'Intent match' },
  'page-type-match': { ar: 'نوع صفحة مناسب', en: 'Page type match' },
  'high-query-relevance': { ar: 'صلة قوية بالموضوع', en: 'Highly relevant' },
  'strong-search-position': { ar: 'ترتيب بحث قوي', en: 'Strong search position' },
  'target-location-match': { ar: 'مطابق للسوق المستهدف', en: 'Target market match' },
  'complete-search-metadata': { ar: 'بيانات نتيجة مكتملة', en: 'Complete metadata' },
  'diverse-source': { ar: 'مصدر متنوع', en: 'Diverse source' },
};

const selectionWarningLabels: Record<string, { ar: string; en: string }> = {
  'intent-mismatch': { ar: 'نية مختلفة جزئيًا', en: 'Intent differs' },
  'page-type-mismatch': { ar: 'نوع صفحة مختلف', en: 'Different page type' },
  'language-mismatch': { ar: 'لغة مختلفة', en: 'Different language' },
  'low-query-relevance': { ar: 'صلة محدودة', en: 'Limited relevance' },
  'homepage-result': { ar: 'صفحة رئيسية', en: 'Homepage result' },
  'forum-or-video-result': { ar: 'ليس صفحة منافس مباشرة', en: 'Not a direct page competitor' },
  'keyword-not-found-in-content': { ar: 'الكلمة غير موجودة في النص', en: 'Keyword not found in content' },
  'content-qualification-unavailable': { ar: 'تعذر فحص النص برمجيًا', en: 'Content check unavailable' },
};

type PreviewLocation = {
  source: 'search' | 'saved';
  index: number;
};

const searchResultToPreviewTarget = (result: CompetitorSearchResult): CompetitorPreviewTarget => ({
  url: result.url,
  canonicalUrl: result.canonicalUrl,
  domain: result.domain,
  title: result.title,
  description: result.description,
  position: result.position,
});

const discoveryRowToPreviewTarget = (row: CompetitorDiscoveryRow): CompetitorPreviewTarget => ({
  url: row.sourceUrl,
  canonicalUrl: row.canonicalUrl,
  domain: row.domain,
  title: row.title,
  description: row.description,
  position: row.position,
});

const discoveryRowToPreview = (row: CompetitorDiscoveryRow): CompetitorPreview | null => {
  if (row.status !== 'completed' || !row.contentText.trim()) return null;
  return {
    url: row.sourceUrl || row.canonicalUrl,
    canonicalUrl: row.canonicalUrl || row.sourceUrl,
    fetchedUrl: row.canonicalUrl || row.sourceUrl,
    domain: row.domain,
    title: row.title,
    description: row.description,
    headings: row.headings,
    text: row.contentText,
    wordCount: row.wordCount,
    provider: row.extractionProvider || 'firecrawl',
    cacheHit: false,
    persisted: true,
    fetchedAt: row.fetchedAt || row.updatedAt,
    expiresAt: '',
  };
};

const progressNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
);

const statusTone = (status: CompetitorDiscoveryRow['status']): string => {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300';
  if (status === 'failed' || status === 'cancelled') return 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300';
  return 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300';
};

const requestErrorMessage = (error: unknown, isArabic: boolean, fallback: string): string => {
  if (isArabic && error instanceof CompetitorDiscoveryRequestError) {
    const labels: Record<string, string> = {
      firecrawl_not_configured: 'أضف مفتاح Firecrawl من الإعدادات ← الذكاء الاصطناعي ← مركز المزودات، ثم عيّنه للمستخدم أو للجميع.',
      firecrawl_quota_exceeded: 'تم استنفاد حصة خدمة السحب الحالية. راجع الرصيد أو أعد المحاولة لاحقًا.',
      competitor_extraction_already_active: 'توجد مهمة سحب منافسين نشطة لهذه المقالة بالفعل.',
      competitor_selection_limit: `يمكن اختيار ${MAX_ARTICLE_COMPETITORS} مواقع كحد أقصى.`,
      invalid_competitor_query: 'عبارة البحث غير صالحة أو قصيرة جدًا.',
      article_access_denied: 'لا تملك صلاحية تعديل منافسي هذه المقالة.',
    };
    if (labels[error.code]) return labels[error.code];
  }
  return error instanceof Error ? error.message : fallback;
};

const resolveExternalSourceUrl = (...candidates: Array<string | null | undefined>): string => {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
      // Ignore invalid source URLs instead of allowing them to navigate the editor.
    }
  }
  return '';
};

const CompetitorDiscoveryPanel: React.FC<CompetitorDiscoveryPanelProps> = ({
  articleId,
  articleTitle,
  primaryKeyword,
  alternativeKeywords = [],
  articleLanguage,
  goalContext,
  companyName,
  locale,
  onCompetitorsChange,
}) => {
  const isArabic = locale === 'ar';
  const [mode, setMode] = useState<CompetitorSearchMode>('title');
  const [query, setQuery] = useState(articleTitle);
  const [searchResults, setSearchResults] = useState<CompetitorSearchResult[]>([]);
  const [selectionSummary, setSelectionSummary] = useState<CompetitorSelectionSummary | null>(null);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<CompetitorDiscoveryState>(EMPTY_STATE);
  const [isLoadingState, setIsLoadingState] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [actionId, setActionId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewLocation, setPreviewLocation] = useState<PreviewLocation | null>(null);
  const [previewByUrl, setPreviewByUrl] = useState<Record<string, CompetitorPreview>>({});
  const [previewLoadingUrl, setPreviewLoadingUrl] = useState('');
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const hydratedDiscoveryJobRef = React.useRef('');
  const hydratedCompetitorsRef = React.useRef<Map<string, CompetitorDiscoveryRow>>(new Map());

  const activeJob = state.activeJob && ACTIVE_JOB_STATUSES.has(state.activeJob.status)
    ? state.activeJob
    : null;
  const activeDiscoveryJob = state.discoveryJob && ACTIVE_JOB_STATUSES.has(state.discoveryJob.status)
    ? state.discoveryJob
    : null;
  const discoveryCancelRequested = actionId === 'cancel-discovery'
    || activeDiscoveryJob?.progress?.stage === 'cancel_requested';
  const discoveryErrorMessage = typeof state.discoveryJob?.result?.errorMessage === 'string'
    ? state.discoveryJob.result.errorMessage
    : state.discoveryJob?.last_error || '';
  const activeDiscoveryJobAgeMs = activeDiscoveryJob?.created_at
    ? Math.max(0, Date.now() - Date.parse(activeDiscoveryJob.created_at))
    : 0;
  const discoveryQueueStalled = activeDiscoveryJob?.status === 'queued'
    && activeDiscoveryJobAgeMs >= COMPETITOR_DISCOVERY_QUEUE_STALL_MS;
  const discoveryWaitingForWorker = activeDiscoveryJob?.status === 'queued';
  const discoveryProgressStage = typeof activeDiscoveryJob?.progress?.stage === 'string'
    ? activeDiscoveryJob.progress.stage
    : '';
  const discoveryProgressCurrent = progressNumber(activeDiscoveryJob?.progress?.current);
  const discoveryProgressTotal = progressNumber(activeDiscoveryJob?.progress?.total);
  const selectedResults = useMemo(() => (
    searchResults.filter(result => selectedUrls.has(result.canonicalUrl))
  ), [searchResults, selectedUrls]);
  const previewCollection = previewLocation?.source === 'saved'
    ? state.competitors
    : searchResults;
  const previewSourceItem = previewLocation
    ? previewCollection[previewLocation.index] || null
    : null;
  const previewTarget = previewSourceItem
    ? previewLocation?.source === 'saved'
      ? discoveryRowToPreviewTarget(previewSourceItem as CompetitorDiscoveryRow)
      : searchResultToPreviewTarget(previewSourceItem as CompetitorSearchResult)
    : null;
  const persistedPreview = previewLocation?.source === 'saved' && previewSourceItem
    ? discoveryRowToPreview(previewSourceItem as CompetitorDiscoveryRow)
    : null;
  const activePreview = previewTarget
    ? persistedPreview || previewByUrl[previewTarget.canonicalUrl] || null
    : null;

  useEffect(() => {
    setQuery(mode === 'primary_keyword' ? primaryKeyword : articleTitle);
  }, [articleTitle, mode, primaryKeyword]);

  const refresh = useCallback(async (showLoading = false, compact = false) => {
    if (!articleId) {
      setState(EMPTY_STATE);
      onCompetitorsChange([]);
      return;
    }
    if (showLoading) setIsLoadingState(true);
    try {
      let nextState = await listArticleCompetitors(articleId, { includeContent: !compact });
      let loadedFullContent = !compact;
      if (compact) {
        const hasNewCompletedSource = nextState.competitors.some(row => (
          row.status === 'completed'
          && !hydratedCompetitorsRef.current.get(row.id)?.contentText
        ));
        const discoveryStillActive = Boolean(
          nextState.discoveryJob && ACTIVE_JOB_STATUSES.has(nextState.discoveryJob.status),
        );
        if (hasNewCompletedSource || (!nextState.activeJob && !discoveryStillActive)) {
          nextState = await listArticleCompetitors(articleId, { includeContent: true });
          loadedFullContent = true;
        } else {
          nextState = {
            ...nextState,
            competitors: nextState.competitors.map(row => {
              const hydrated = hydratedCompetitorsRef.current.get(row.id);
              return hydrated?.contentText
                ? { ...row, contentText: hydrated.contentText }
                : row;
            }),
          };
        }
      }
      if (loadedFullContent) {
        hydratedCompetitorsRef.current = new Map(
          nextState.competitors.map(row => [row.id, row]),
        );
      }
      setState(nextState);
      if (loadedFullContent && (nextState.competitors.length > 0 || nextState.latestJob)) {
        onCompetitorsChange(nextState.competitors);
      }
      setError('');
    } catch (loadError) {
      setError(requestErrorMessage(loadError, isArabic, 'Could not load competitor sources.'));
    } finally {
      if (showLoading) setIsLoadingState(false);
    }
  }, [articleId, isArabic, onCompetitorsChange]);

  useEffect(() => {
    hydratedDiscoveryJobRef.current = '';
    hydratedCompetitorsRef.current = new Map();
    setSearchResults([]);
    setSelectionSummary(null);
    setSelectedUrls(new Set<string>());
    setNotice('');
    setPreviewLocation(null);
    setPreviewByUrl({});
    setPreviewErrors({});
    void refresh(true);
  }, [articleId, refresh]);

  useEffect(() => {
    const persisted = getPersistedCompetitorDiscovery(state);
    const discoveryJobId = state.discoveryJob?.id || '';
    const hydrationKey = [
      discoveryJobId,
      state.discoveryJob?.updated_at || '',
      typeof state.discoveryJob?.result?.discoveredAt === 'string'
        ? state.discoveryJob.result.discoveredAt
        : '',
    ].join(':');
    if (!persisted || !discoveryJobId || hydratedDiscoveryJobRef.current === hydrationKey) return;
    hydratedDiscoveryJobRef.current = hydrationKey;
    const input = state.discoveryJob?.input_snapshot || {};
    const persistedMode = input.queryType === 'primary_keyword' ? 'primary_keyword' : 'title';
    const persistedQuery = typeof input.queryText === 'string' ? input.queryText.trim() : '';
    setMode(persistedMode);
    if (persistedQuery) setQuery(persistedQuery);
    setSearchResults(persisted.results);
    setSelectionSummary(persisted.selection);
    const acceptedUrls = Array.isArray(state.discoveryJob?.result?.selectedUrls)
      ? state.discoveryJob!.result!.selectedUrls.filter((value): value is string => typeof value === 'string')
      : [];
    setSelectedUrls(new Set(
      acceptedUrls.length > 0
        ? acceptedUrls
        : persisted.results.filter(result => result.autoSelected).map(result => result.canonicalUrl),
    ));
  }, [state]);

  useEffect(() => {
    if (previewLocation && !previewSourceItem) setPreviewLocation(null);
  }, [previewLocation, previewSourceItem]);

  useEffect(() => {
    if (!activeJob && !activeDiscoveryJob) return undefined;
    const timer = window.setInterval((): void => {
      void refresh(false, true);
    }, (activeJob?.status === 'retry_scheduled' || activeDiscoveryJob?.status === 'retry_scheduled') ? 30_000 : 2_500);
    return () => window.clearInterval(timer);
  }, [activeDiscoveryJob, activeJob, refresh]);

  const handleSearch = async () => {
    if (!articleId || !query.trim()) {
      setError(isArabic ? 'اختر مقالة وأدخل عنوانًا أو كلمة مفتاحية للبحث.' : 'Choose an article and enter a search query.');
      return;
    }
    setIsSearching(true);
    setError('');
    setNotice('');
    setPreviewLocation(null);
    try {
      const response = await searchArticleCompetitors({
        articleId,
        query: query.trim(),
        queryType: mode,
        language: articleLanguage,
        articleTitle,
        primaryKeyword,
        alternativeKeywords,
        pageType: goalContext.pageType,
        searchIntent: goalContext.searchIntent,
        audienceScope: goalContext.audienceScope,
        targetCountry: goalContext.targetCountry,
        companyName,
      });
      const rows = response.results;
      setSearchResults(rows);
      setSelectionSummary(response.selection);
      setSelectedUrls(new Set(rows.filter(row => row.autoSelected).map(row => row.canonicalUrl)));
      if (rows.length === 0) {
        setNotice(isArabic
          ? `لم يعثر محرك البحث على نتائج عربية مناسبة.${response.selection.languageFilteredCount > 0 ? ` استُبعدت ${response.selection.languageFilteredCount} نتيجة لاتينية لأنها لا تطابق لغة المقالة.` : ''}`
          : 'No suitable search results were found.');
      } else if (response.selection.autoSelectedCount > 0) {
        setNotice(isArabic
          ? `تم تحديد أفضل ${response.selection.autoSelectedCount} نتائج عربية تلقائيًا.${response.selection.languageFilteredCount > 0 ? ` استُبعدت ${response.selection.languageFilteredCount} نتيجة لاتينية.` : ''} راجعها وعدّل الاختيار قبل السحب.`
          : `The best ${response.selection.autoSelectedCount} results were selected automatically. Review them before importing.`);
      }
    } catch (searchError) {
      setError(requestErrorMessage(searchError, isArabic, 'Competitor search failed.'));
    } finally {
      setIsSearching(false);
    }
  };

  const toggleResult = (result: CompetitorSearchResult) => {
    setError('');
    setSelectedUrls(current => {
      const next = new Set(current);
      if (next.has(result.canonicalUrl)) {
        next.delete(result.canonicalUrl);
        return next;
      }
      if (next.size >= MAX_ARTICLE_COMPETITORS) {
        setError(isArabic
          ? `يمكن اختيار ${MAX_ARTICLE_COMPETITORS} مواقع كحد أقصى.`
          : `You can select up to ${MAX_ARTICLE_COMPETITORS} websites.`);
        return current;
      }
      next.add(result.canonicalUrl);
      return next;
    });
  };

  const closePreview = useCallback(() => {
    setPreviewLocation(null);
  }, []);

  const navigatePreview = (direction: -1 | 1) => {
    setPreviewLocation(current => {
      if (!current) return current;
      const total = current.source === 'saved' ? state.competitors.length : searchResults.length;
      if (total <= 1) return current;
      return {
        ...current,
        index: (current.index + direction + total) % total,
      };
    });
  };

  const handleLoadPreview = async () => {
    if (!articleId || !previewTarget || previewLoadingUrl) return;
    const previewUrl = previewTarget.canonicalUrl || previewTarget.url;
    setPreviewLoadingUrl(previewUrl);
    setPreviewErrors(current => ({ ...current, [previewUrl]: '' }));
    try {
      const loadedPreview = await loadArticleCompetitorPreview(articleId, previewUrl);
      setPreviewByUrl(current => ({
        ...current,
        [previewUrl]: loadedPreview,
        [loadedPreview.canonicalUrl]: loadedPreview,
      }));
    } catch (previewError) {
      setPreviewErrors(current => ({
        ...current,
        [previewUrl]: requestErrorMessage(previewError, isArabic, 'Could not load competitor preview.'),
      }));
    } finally {
      setPreviewLoadingUrl(current => current === previewUrl ? '' : current);
    }
  };

  const restoreAutomaticSelection = () => {
    setError('');
    setSelectedUrls(new Set(
      searchResults
        .filter(result => result.autoSelected)
        .map(result => result.canonicalUrl),
    ));
  };

  const handleStart = async () => {
    if (!articleId || selectedResults.length === 0 || previewLoadingUrl) return;
    setIsStarting(true);
    setError('');
    try {
      await enqueueArticleCompetitorExtraction({
        articleId,
        query: query.trim(),
        queryType: mode,
        results: selectedResults,
      });
      setNotice(isArabic
        ? 'تمت إضافة مهمة السحب. ستستمر حتى عند مغادرة المقالة.'
        : 'Extraction was queued and will continue after leaving the article.');
      await refresh(false);
    } catch (startError) {
      setError(requestErrorMessage(startError, isArabic, 'Could not start competitor extraction.'));
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!articleId) return;
    setActionId('cancel');
    setError('');
    try {
      await cancelArticleCompetitorExtraction(articleId);
      setNotice(isArabic ? 'تم إرسال طلب إيقاف السحب.' : 'Extraction cancellation was requested.');
      await refresh(false);
    } catch (cancelError) {
      setError(requestErrorMessage(cancelError, isArabic, 'Could not cancel extraction.'));
    } finally {
      setActionId('');
    }
  };

  const handleCancelDiscovery = async () => {
    if (!articleId || !activeDiscoveryJob || discoveryCancelRequested) return;
    setActionId('cancel-discovery');
    setError('');
    try {
      await cancelArticleCompetitorDiscovery(articleId);
      setState(current => current.discoveryJob ? {
        ...current,
        discoveryJob: {
          ...current.discoveryJob,
          progress: {
            ...current.discoveryJob.progress,
            stage: 'cancel_requested',
          },
        },
      } : current);
      setNotice(isArabic
        ? 'تم إرسال طلب إيقاف البحث. قد يستغرق الإيقاف عدة ثوانٍ إذا كان الاتصال الخارجي جاريًا.'
        : 'Search cancellation was requested. It can take a few seconds while an external request is active.');
      await refresh(false, true);
    } catch (cancelError) {
      setError(requestErrorMessage(cancelError, isArabic, 'Could not stop competitor discovery.'));
    } finally {
      setActionId('');
    }
  };

  const handleRemove = async (competitorId: string) => {
    if (!articleId) return;
    setActionId(competitorId);
    setError('');
    try {
      await removeArticleCompetitor(articleId, competitorId);
      await refresh(false);
    } catch (removeError) {
      setError(requestErrorMessage(removeError, isArabic, 'Could not remove competitor source.'));
    } finally {
      setActionId('');
    }
  };

  const progress = activeJob?.progress || {};
  const current = progressNumber(progress.current);
  const total = progressNumber(progress.total) || state.competitors.length;
  const progressTitle = typeof progress.title === 'string' ? progress.title : '';
  const progressStage = typeof progress.stage === 'string' ? progress.stage : '';
  const activeJobAgeMs = activeJob?.created_at
    ? Math.max(0, Date.now() - Date.parse(activeJob.created_at))
    : 0;
  const extractionQueueStalled = activeJob?.status === 'queued'
    && activeJobAgeMs >= COMPETITOR_EXTRACTION_QUEUE_STALL_MS;
  const extractionWaitingForWorker = activeJob?.status === 'queued';
  const extractionRetryScheduled = activeJob?.status === 'retry_scheduled';
  const extractionPreparing = activeJob?.status === 'running'
    && progressStage !== 'extracting_competitor'
    && progressStage !== 'programmatic_fallback'
    && progressStage !== 'competitor_processed';
  const displayedCurrent = Math.min(
    Math.max(0, current),
    Math.max(1, total),
  );
  const extractionStatusLabel = activeJob
    ? extractionQueueStalled
      ? isArabic
        ? `لم يبدأ عامل السحب 0/${total || 1}`
        : `Extraction worker did not start 0/${total || 1}`
      : extractionWaitingForWorker
        ? isArabic
          ? `بانتظار عامل السحب 0/${total || 1}`
          : `Waiting for extraction worker 0/${total || 1}`
        : extractionRetryScheduled
          ? isArabic
            ? `بانتظار إعادة المحاولة ${displayedCurrent}/${total || 1}`
            : `Waiting to retry ${displayedCurrent}/${total || 1}`
          : extractionPreparing
            ? isArabic
              ? `عامل السحب يجهّز المهمة 0/${total || 1}`
              : `Extraction worker is preparing 0/${total || 1}`
            : progressStage === 'programmatic_fallback'
              ? isArabic
                ? `فشلت خدمة السحب؛ جارٍ الاستخراج البرمجي ${Math.max(1, displayedCurrent)}/${total || 1}`
                : `Firecrawl failed; running programmatic extraction ${Math.max(1, displayedCurrent)}/${total || 1}`
            : isArabic
              ? `سحب محتوى المنافس ${Math.max(1, displayedCurrent)}/${total || 1}`
              : `Importing via Firecrawl ${Math.max(1, displayedCurrent)}/${total || 1}`
    : '';
  const activeJobError = activeJob?.last_error?.trim() || '';
  const activeJobWarning = extractionQueueStalled
    ? isArabic
      ? 'تم حفظ المهمة، لكن عامل المنافسين لم يستلمها خلال 90 ثانية. أوقف المهمة، وشغّل عامل المنافسين في هوستينجر، ثم أعد المحاولة.'
      : 'The job was saved, but bazarvan-competitor-worker did not claim it within 90 seconds. Stop it, start the competitor worker on Hostinger, then retry.'
    : extractionWaitingForWorker
      ? isArabic
        ? 'تم حفظ المهمة في الطابور، ولم تبدأ خدمة السحب بعد.'
        : 'The job is queued; no Firecrawl request has started yet.'
      : activeJob?.status === 'running' && progressStage === 'programmatic_fallback'
        ? isArabic
          ? 'فشلت خدمة السحب لهذا الرابط؛ بدأ الاستخراج البرمجي تلقائيًا دون إعادة محاولة الخدمة ودون استخدام الذكاء الاصطناعي.'
          : 'Firecrawl failed for this URL; programmatic extraction started automatically without retrying Firecrawl or using AI.'
      : activeJob?.status === 'running'
        ? isArabic
          ? 'خدمة السحب تعمل الآن. قد يستغرق الرابط الواحد حتى 75 ثانية قبل نجاحه أو ظهور خطئه.'
          : 'Firecrawl is running. One URL can take up to 75 seconds before it succeeds or reports an error.'
        : '';

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">
            {isArabic ? 'البحث وسحب المنافسين' : 'Find and import competitors'}
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'ابحث واختر حتى 5 مواقع. يحاول الخادم خدمة السحب مرة واحدة، ثم ينتقل تلقائيًا إلى الاستخراج البرمجي عند فشلها، دون استخدام نموذج ذكي.'
              : 'Search and select up to 5 sites. The server tries Firecrawl once, then automatically falls back to programmatic extraction without using Gemini.'}
          </p>
        </div>
        {isLoadingState && <LoaderCircle size={16} className="shrink-0 animate-spin text-[#d4af37]" />}
      </div>

      {!state.providerConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-bold text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{isArabic ? 'يجب حفظ مفتاح Firecrawl في مركز المزودات وتعيينه للمستخدم أو للجميع أولًا.' : 'Firecrawl must be saved in the provider center and explicitly assigned to this user or everyone.'}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1 rounded-md bg-gray-100 p-1 dark:bg-[#1F1F1F]">
        {([
          ['title', isArabic ? 'عنوان المقالة' : 'Article title'],
          ['primary_keyword', isArabic ? 'الكلمة الأساسية' : 'Primary keyword'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`min-w-0 rounded px-2 py-1.5 text-[11px] font-black transition-colors ${
              mode === value
                ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#333] dark:text-[#f2d675]'
                : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-stretch gap-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void handleSearch();
          }}
          placeholder={isArabic ? 'عبارة البحث' : 'Search query'}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-2 text-xs outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
          dir="auto"
        />
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={!articleId || !query.trim() || isSearching || Boolean(activeDiscoveryJob) || !state.providerConfigured}
          title={isArabic ? 'بحث عن المنافسين' : 'Search competitors'}
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSearching ? <LoaderCircle size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>

      {activeDiscoveryJob && (
        <div className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] font-bold ${
          discoveryQueueStalled
            ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300'
            : 'border-[#d4af37]/30 bg-[#d4af37]/10 text-[#8a6f1d] dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10 dark:text-[#f2d675]'
        }`}>
          {discoveryQueueStalled
            ? <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            : <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin" />}
          <span className="min-w-0 flex-1">
            {discoveryCancelRequested
              ? (isArabic ? 'جاري إيقاف البحث عن المنافسين بأمان.' : 'Stopping competitor discovery safely.')
              : discoveryQueueStalled
                ? (isArabic
                  ? 'تم حفظ مهمة بحث المنافسين، لكن عامل المنافسين لم يستلمها خلال 90 ثانية. أوقف المهمة، وشغّل عامل المنافسين في هوستينجر، ثم أعد المحاولة.'
                  : 'The competitor search job was saved, but bazarvan-competitor-worker did not claim it within 90 seconds. Stop it, start the competitor worker on Hostinger, then retry.')
              : discoveryWaitingForWorker
                ? (isArabic
                  ? 'بانتظار عامل بحث المنافسين؛ لم يبدأ البحث الخارجي بعد.'
                  : 'Waiting for the competitor discovery worker; external search has not started yet.')
              : activeDiscoveryJob.status === 'retry_scheduled'
                ? (isArabic ? 'تعذر البحث مؤقتًا، وستعاد محاولة المهمة نفسها تلقائيًا.' : 'Search is temporarily unavailable; the same task will retry automatically.')
                : discoveryProgressStage === 'qualifying_competitor_content'
                  ? (isArabic
                    ? `جاري فحص استهداف الكلمات داخل نصوص المرشحين ${discoveryProgressCurrent}/${discoveryProgressTotal || 1}.`
                    : `Checking keyword targeting in candidate content ${discoveryProgressCurrent}/${discoveryProgressTotal || 1}.`)
                  : discoveryProgressStage === 'expanding_competitor_search'
                    ? (isArabic ? 'لم يكتمل العدد؛ جارٍ توسيع البحث بالصيغ البديلة.' : 'Expanding search with alternative keywords.')
                    : (isArabic ? 'جاري البحث عن المنافسين وترتيبهم في الخلفية.' : 'Searching and ranking competitors in the background.')}
            {discoveryErrorMessage && (
              <span className="mt-1 block break-words text-red-700 dark:text-red-300">
                {discoveryErrorMessage}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void handleCancelDiscovery()}
            disabled={discoveryCancelRequested}
            title={isArabic ? 'إيقاف البحث عن المنافسين' : 'Stop competitor discovery'}
            aria-label={isArabic ? 'إيقاف البحث عن المنافسين' : 'Stop competitor discovery'}
            className={`flex size-6 shrink-0 items-center justify-center rounded-md border disabled:cursor-wait disabled:opacity-50 ${
              discoveryQueueStalled
                ? 'border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10'
                : 'border-[#d4af37]/35 text-[#8a6f1d] hover:bg-[#d4af37]/15 dark:border-[#d4af37]/25 dark:text-[#f2d675] dark:hover:bg-[#d4af37]/15'
            }`}
          >
            {discoveryCancelRequested
              ? <LoaderCircle size={12} className="animate-spin" />
              : <Square size={10} fill="currentColor" />}
          </button>
        </div>
      )}

      {!activeDiscoveryJob && searchResults.length === 0 && discoveryErrorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700 dark:border-red-900/40 dark:bg-red-500/10 dark:text-red-300">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{discoveryErrorMessage}</span>
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="space-y-2">
          {selectionSummary && (
            <div className="border-y border-[#d4af37]/35 bg-[#d4af37]/5 px-2 py-2 dark:bg-[#d4af37]/10">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                  <Sparkles size={13} className="shrink-0" />
                  <span>{isArabic ? 'اختيار تلقائي مع مراجعتك' : 'Automatic selection with review'}</span>
                </span>
                <button
                  type="button"
                  onClick={restoreAutomaticSelection}
                  title={isArabic ? 'استعادة أفضل النتائج المحددة تلقائيًا' : 'Restore automatic selection'}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-[#8a6f1d] hover:bg-[#d4af37]/15 dark:text-[#f2d675]"
                >
                  <RotateCcw size={13} />
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-bold text-gray-600 dark:text-gray-300">
                <span>{isArabic ? 'النية' : 'Intent'}: {intentLabels[selectionSummary.targetIntent]?.[locale] || intentLabels.unknown[locale]}</span>
                <span>{isArabic ? 'نوع الصفحة' : 'Page type'}: {pageTypeLabels[selectionSummary.targetPageType]?.[locale] || pageTypeLabels.unknown[locale]}</span>
                <span>{isArabic ? 'الثقة' : 'Confidence'}: {selectionSummary.confidence}%</span>
                <span>{isArabic ? 'فُحص' : 'Reviewed'}: {selectionSummary.reviewedCount}/{selectionSummary.candidateCount}</span>
                {selectionSummary.contentQualificationAttempted && (
                  <span className="text-emerald-700 dark:text-emerald-300">
                    {isArabic ? 'مؤهل بالنص' : 'Content-qualified'}: {selectionSummary.contentQualifiedCount}
                  </span>
                )}
                {selectionSummary.contentUnavailableCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {isArabic ? 'تعذر فحصه' : 'Unavailable'}: {selectionSummary.contentUnavailableCount}
                  </span>
                )}
                {articleLanguage === 'ar' && selectionSummary.languageFilteredCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {isArabic ? 'لاتيني مستبعد' : 'Latin excluded'}: {selectionSummary.languageFilteredCount}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-500 dark:text-gray-400">
            <span>{isArabic ? 'نتائج البحث' : 'Search results'}: {searchResults.length}</span>
            <span>{isArabic ? 'المحدد' : 'Selected'}: {selectedResults.length}/{MAX_ARTICLE_COMPETITORS}</span>
          </div>
          <div className="max-h-80 space-y-1.5 overflow-y-auto pe-1 custom-scrollbar">
            {searchResults.map((result, index) => {
              const selected = selectedUrls.has(result.canonicalUrl);
              const searchSourceUrl = resolveExternalSourceUrl(result.canonicalUrl, result.url);
              const visibleReasons = result.reasonCodes
                .filter(code => code !== 'auto-selected' && code !== 'diverse-source')
                .slice(0, 2);
              const visibleWarning = result.warningCodes[0] || '';
              const qualification = result.contentQualification;
              return (
                <div
                  key={result.canonicalUrl}
                  className={`flex w-full items-stretch rounded-md border transition-colors ${
                    selected
                      ? 'border-[#d4af37] bg-[#d4af37]/10'
                      : 'border-gray-200 bg-white hover:border-[#d4af37]/50 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleResult(result)}
                    className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-start"
                  >
                    <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                      selected ? 'border-[#d4af37] bg-[#d4af37] text-white' : 'border-gray-300 dark:border-gray-600'
                    }`}>
                      {selected && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-2">
                        <span className="line-clamp-2 min-w-0 flex-1 text-xs font-black text-gray-800 dark:text-gray-100">{result.title || result.domain}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-black ${result.selectionScore >= 75
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                            : result.selectionScore >= 55
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                          }`}
                          title={`${isArabic ? 'درجة الاختيار' : 'Selection score'}: ${result.selectionScore}/100`}
                        >
                          {result.selectionScore}
                        </span>
                      </span>
                      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold">
                        <span className="max-w-full truncate text-[#8a6f1d] dark:text-[#f2d675]" dir="ltr">{result.domain}</span>
                        <span className="text-gray-500 dark:text-gray-400">{intentLabels[result.inferredIntent]?.[locale] || intentLabels.unknown[locale]}</span>
                        <span className="text-gray-500 dark:text-gray-400">{pageTypeLabels[result.inferredPageType]?.[locale] || pageTypeLabels.unknown[locale]}</span>
                      </span>
                      {qualification && (
                        <span className={`mt-1 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-black ${
                          qualification.status === 'qualified'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                            : qualification.status === 'not_qualified'
                              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                        }`}>
                          {qualification.status === 'qualified'
                            ? <>
                                <span>{qualification.matchKind.includes('primary')
                                  ? (isArabic ? 'الأساسية' : 'Primary')
                                  : (isArabic ? 'صيغة بديلة' : 'Alternative')}:</span>
                                <span className="max-w-52 truncate" dir="auto">{qualification.matchedKeyword}</span>
                                <span>{qualification.score}/100</span>
                              </>
                            : qualification.status === 'not_qualified'
                              ? (isArabic ? 'غير مستهدف في نص الصفحة' : 'Not targeted in page content')
                              : (isArabic ? 'تعذر التحقق من نص الصفحة' : 'Page content could not be verified')}
                        </span>
                      )}
                      {result.description && <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-gray-500 dark:text-gray-400">{result.description}</span>}
                      {(visibleReasons.length > 0 || visibleWarning) && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {visibleReasons.map(code => (
                            <span key={code} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                              {selectionReasonLabels[code]?.[locale] || code}
                            </span>
                          ))}
                          {visibleWarning && (
                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                              {selectionWarningLabels[visibleWarning]?.[locale] || visibleWarning}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="m-1 flex shrink-0 items-start gap-0.5">
                    <button
                      type="button"
                      onClick={() => setPreviewLocation({ source: 'search', index })}
                      title={isArabic ? 'معاينة الموقع داخل المحرر' : 'Preview website inside the editor'}
                      className="flex size-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
                    >
                      <Eye size={14} />
                    </button>
                    {searchSourceUrl && (
                      <a
                        href={searchSourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={isArabic ? 'فتح المصدر في تبويب جديد' : 'Open source in a new tab'}
                        aria-label={isArabic ? 'فتح المصدر في تبويب جديد' : 'Open source in a new tab'}
                        className="flex size-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={selectedResults.length === 0 || isStarting || Boolean(activeJob) || Boolean(previewLoadingUrl)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? <LoaderCircle size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            <span>{isArabic
              ? `سحب ${selectedResults.length} موقع`
              : `Import ${selectedResults.length} site(s) via Firecrawl`}</span>
          </button>
        </div>
      )}

      {activeJob && (
        <div
          data-testid="competitor-extraction-status"
          className={`rounded-md border px-2.5 py-2.5 text-xs ${
            extractionQueueStalled || extractionRetryScheduled
              ? 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-500/10'
              : 'border-[#d4af37]/30 bg-[#d4af37]/10 dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={`inline-flex min-w-0 items-center gap-2 font-black ${
              extractionQueueStalled || extractionRetryScheduled
                ? 'text-amber-800 dark:text-amber-300'
                : 'text-[#8a6f1d] dark:text-[#f2d675]'
            }`}>
              {extractionQueueStalled
                ? <AlertTriangle size={14} className="shrink-0" />
                : <LoaderCircle size={14} className="shrink-0 animate-spin" />}
              <span className="truncate">{extractionStatusLabel}</span>
            </span>
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={actionId === 'cancel'}
              title={isArabic ? 'إيقاف السحب' : 'Stop extraction'}
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#d4af37]/35 text-[#8a6f1d] hover:bg-[#d4af37]/15 disabled:opacity-50 dark:border-[#d4af37]/25 dark:text-[#f2d675] dark:hover:bg-[#d4af37]/15"
            >
              {actionId === 'cancel' ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
            </button>
          </div>
          {progressTitle && !extractionWaitingForWorker && (
            <div className="mt-1 truncate text-[11px] text-[#8a6f1d] dark:text-[#f2d675]">{progressTitle}</div>
          )}
          {activeJobWarning && (
            <div className={`mt-1 text-[10px] font-bold leading-4 ${
              extractionQueueStalled
                ? 'text-amber-800 dark:text-amber-300'
                : 'text-[#8a6f1d] dark:text-[#f2d675]'
            }`}>
              {activeJobWarning}
            </div>
          )}
          {activeJobError && (
            <div className="mt-1 text-[10px] font-bold leading-4 text-red-700 dark:text-red-300">
              {activeJobError}
            </div>
          )}
          {(activeJob.attempt_count || 0) > 0 && (
            <div className="mt-1 text-[10px] font-bold text-gray-600 dark:text-gray-300">
              {isArabic ? 'المحاولة' : 'Attempt'} {Math.min(
                activeJob.attempt_count || 1,
                COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
              )}/{COMPETITOR_EXTRACTION_MAX_ATTEMPTS}
            </div>
          )}
          {activeJob.status === 'retry_scheduled' && activeJob.next_attempt_at && (
            <div className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">
              {isArabic ? 'إعادة المحاولة' : 'Retry'}: {new Date(activeJob.next_attempt_at).toLocaleString(isArabic ? 'ar' : 'en')}
            </div>
          )}
        </div>
      )}

      {state.competitors.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-black text-gray-600 dark:text-gray-300">
            {isArabic ? 'المصادر المحفوظة في المقالة' : 'Saved article sources'}
          </div>
          {state.competitors.map((row, index) => {
            const savedSourceUrl = resolveExternalSourceUrl(row.canonicalUrl, row.sourceUrl);
            return (
              <div key={row.id} className="flex items-start gap-2 rounded-md border border-gray-200 bg-white px-2 py-2 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${statusTone(row.status)}`}>
                  {row.status === 'completed' ? <Check size={11} /> : row.status === 'failed' || row.status === 'cancelled' ? <XCircle size={11} /> : <LoaderCircle size={11} className={row.status === 'extracting' ? 'animate-spin' : ''} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-[11px] font-black text-gray-800 dark:text-gray-100">{row.position}. {row.title || row.domain}</div>
                  <div className="mt-0.5 truncate text-[10px] text-gray-500" dir="ltr">{row.domain}</div>
                  {row.status === 'completed' && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
                      <span>{row.wordCount} {isArabic ? 'كلمة' : 'words'}</span>
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] dark:bg-emerald-500/10">
                        {row.extractionProvider.startsWith('firecrawl')
                          ? (isArabic ? 'خدمة السحب' : 'Firecrawl')
                          : isArabic
                            ? 'استخراج برمجي'
                            : row.extractionProvider || 'Unknown'}
                      </span>
                    </div>
                  )}
                  {row.errorMessage && <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-red-600 dark:text-red-300">{row.errorMessage}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewLocation({ source: 'saved', index })}
                  title={isArabic ? 'معاينة المصدر داخل المحرر' : 'Preview source inside the editor'}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
                >
                  <Eye size={14} />
                </button>
                {savedSourceUrl && (
                  <a
                    href={savedSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={isArabic ? 'فتح المصدر في تبويب جديد' : 'Open source in a new tab'}
                    aria-label={isArabic ? 'فتح المصدر في تبويب جديد' : 'Open source in a new tab'}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void handleRemove(row.id)}
                  disabled={Boolean(activeJob) || actionId === row.id}
                  title={isArabic ? 'حذف المصدر' : 'Remove source'}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-500/10"
                >
                  {actionId === row.id ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {notice && <div className="rounded-md bg-emerald-50 px-2.5 py-2 text-[11px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{notice}</div>}
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {previewLocation && previewTarget && (
        <React.Suspense fallback={(
          <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/65">
            <LoaderCircle size={28} className="animate-spin text-[#d4af37]" />
          </div>
        )}>
          <CompetitorPreviewModal
            target={previewTarget}
            preview={activePreview}
            isLoading={Boolean(previewLoadingUrl)}
            error={previewErrors[previewTarget.canonicalUrl || previewTarget.url] || ''}
            locale={locale}
            currentIndex={previewLocation.index}
            totalItems={previewCollection.length}
            canSelect={previewLocation.source === 'search'}
            isSelected={previewLocation.source === 'search'
              && selectedUrls.has(previewTarget.canonicalUrl)}
            onLoadPreview={() => void handleLoadPreview()}
            onToggleSelection={() => {
              if (previewLocation.source !== 'search') return;
              const result = searchResults[previewLocation.index];
              if (result) toggleResult(result);
            }}
            onPrevious={() => navigatePreview(-1)}
            onNext={() => navigatePreview(1)}
            onClose={closePreview}
          />
        </React.Suspense>
      )}
    </section>
  );
};

export default CompetitorDiscoveryPanel;
