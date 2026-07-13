import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Search,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  MAX_ARTICLE_COMPETITORS,
  type CompetitorSearchMode,
} from '../constants/competitors';
import {
  cancelArticleCompetitorExtraction,
  CompetitorDiscoveryRequestError,
  enqueueArticleCompetitorExtraction,
  listArticleCompetitors,
  removeArticleCompetitor,
  searchArticleCompetitors,
  type CompetitorDiscoveryRow,
  type CompetitorDiscoveryState,
  type CompetitorSearchResult,
} from '../utils/competitorDiscovery';

type CompetitorDiscoveryPanelProps = {
  articleId: string | null;
  articleTitle: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  locale: 'ar' | 'en';
  onCompetitorsChange: (rows: CompetitorDiscoveryRow[]) => void;
};

const EMPTY_STATE: CompetitorDiscoveryState = {
  providerConfigured: true,
  competitors: [],
  activeJob: null,
  latestJob: null,
};

const ACTIVE_JOB_STATUSES = new Set(['waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused']);

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
      firecrawl_not_configured: 'مفتاح Firecrawl غير مضاف إلى بيئة السيرفر.',
      firecrawl_quota_exceeded: 'تم استنفاد حصة Firecrawl الحالية. راجع الرصيد أو أعد المحاولة لاحقًا.',
      competitor_extraction_already_active: 'توجد مهمة سحب منافسين نشطة لهذه المقالة بالفعل.',
      competitor_selection_limit: `يمكن اختيار ${MAX_ARTICLE_COMPETITORS} مواقع كحد أقصى.`,
      invalid_competitor_query: 'عبارة البحث غير صالحة أو قصيرة جدًا.',
      article_access_denied: 'لا تملك صلاحية تعديل منافسي هذه المقالة.',
    };
    if (labels[error.code]) return labels[error.code];
  }
  return error instanceof Error ? error.message : fallback;
};

const CompetitorDiscoveryPanel: React.FC<CompetitorDiscoveryPanelProps> = ({
  articleId,
  articleTitle,
  primaryKeyword,
  articleLanguage,
  locale,
  onCompetitorsChange,
}) => {
  const isArabic = locale === 'ar';
  const [mode, setMode] = useState<CompetitorSearchMode>('title');
  const [query, setQuery] = useState(articleTitle);
  const [searchResults, setSearchResults] = useState<CompetitorSearchResult[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<CompetitorDiscoveryState>(EMPTY_STATE);
  const [isLoadingState, setIsLoadingState] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [actionId, setActionId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeJob = state.activeJob && ACTIVE_JOB_STATUSES.has(state.activeJob.status)
    ? state.activeJob
    : null;
  const selectedResults = useMemo(() => (
    searchResults.filter(result => selectedUrls.has(result.canonicalUrl))
  ), [searchResults, selectedUrls]);

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
      if (compact && !nextState.activeJob) {
        nextState = await listArticleCompetitors(articleId, { includeContent: true });
      }
      setState(nextState);
      if ((!compact || !nextState.activeJob) && (nextState.competitors.length > 0 || nextState.latestJob)) {
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
    setSearchResults([]);
    setSelectedUrls(new Set<string>());
    setNotice('');
    void refresh(true);
  }, [articleId, refresh]);

  useEffect(() => {
    if (!activeJob) return undefined;
    const timer = window.setInterval((): void => {
      void refresh(false, true);
    }, activeJob.status === 'retry_scheduled' ? 30_000 : 2_500);
    return () => window.clearInterval(timer);
  }, [activeJob, refresh]);

  const handleSearch = async () => {
    if (!articleId || !query.trim()) {
      setError(isArabic ? 'اختر مقالة وأدخل عنوانًا أو كلمة مفتاحية للبحث.' : 'Choose an article and enter a search query.');
      return;
    }
    setIsSearching(true);
    setError('');
    setNotice('');
    try {
      const rows = await searchArticleCompetitors({
        articleId,
        query: query.trim(),
        queryType: mode,
        language: articleLanguage,
      });
      setSearchResults(rows);
      setSelectedUrls(new Set());
      if (rows.length === 0) {
        setNotice(isArabic ? 'لم يعثر محرك البحث على نتائج مناسبة.' : 'No suitable search results were found.');
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

  const handleStart = async () => {
    if (!articleId || selectedResults.length === 0) return;
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

  return (
    <section className="space-y-3 border-b border-gray-200 pb-4 dark:border-[#3C3C3C]">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">
            {isArabic ? 'البحث وسحب المنافسين' : 'Find and import competitors'}
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'ابحث، اختر حتى 5 مواقع، ثم سيُحفظ المحتوى في المقالة تلقائيًا.'
              : 'Search, select up to 5 sites, and their content will be saved to the article.'}
          </p>
        </div>
        {isLoadingState && <LoaderCircle size={16} className="shrink-0 animate-spin text-[#d4af37]" />}
      </div>

      {!state.providerConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-bold text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{isArabic ? 'يجب إضافة FIRECRAWL_API_KEY إلى بيئة السيرفر أولًا.' : 'FIRECRAWL_API_KEY must be configured on the server.'}</span>
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
          disabled={!articleId || !query.trim() || isSearching || !state.providerConfigured}
          title={isArabic ? 'بحث عن المنافسين' : 'Search competitors'}
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSearching ? <LoaderCircle size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>

      {searchResults.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-500 dark:text-gray-400">
            <span>{isArabic ? 'نتائج البحث' : 'Search results'}: {searchResults.length}</span>
            <span>{isArabic ? 'المحدد' : 'Selected'}: {selectedResults.length}/{MAX_ARTICLE_COMPETITORS}</span>
          </div>
          <div className="max-h-80 space-y-1.5 overflow-y-auto pe-1 custom-scrollbar">
            {searchResults.map(result => {
              const selected = selectedUrls.has(result.canonicalUrl);
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
                      <span className="line-clamp-2 block text-xs font-black text-gray-800 dark:text-gray-100">{result.title || result.domain}</span>
                      <span className="mt-0.5 block truncate text-[10px] font-bold text-[#8a6f1d] dark:text-[#f2d675]" dir="ltr">{result.domain}</span>
                      {result.description && <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-gray-500 dark:text-gray-400">{result.description}</span>}
                    </span>
                  </button>
                  <a
                    href={result.canonicalUrl || result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={isArabic ? 'فتح الموقع قبل اختياره' : 'Open website before selecting'}
                    className="m-1 flex size-7 shrink-0 items-center justify-center self-start rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={selectedResults.length === 0 || isStarting || Boolean(activeJob)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? <LoaderCircle size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            <span>{isArabic ? `سحب ${selectedResults.length} موقع` : `Import ${selectedResults.length} site(s)`}</span>
          </button>
        </div>
      )}

      {activeJob && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-2.5 text-xs dark:border-blue-900/40 dark:bg-blue-500/10">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-2 font-black text-blue-800 dark:text-blue-300">
              <LoaderCircle size={14} className="shrink-0 animate-spin" />
              <span className="truncate">
                {isArabic ? `سحب المنافس ${Math.min(current || 1, total || 1)}/${total || 1}` : `Importing competitor ${Math.min(current || 1, total || 1)}/${total || 1}`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={actionId === 'cancel'}
              title={isArabic ? 'إيقاف السحب' : 'Stop extraction'}
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-blue-200 text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-500/10"
            >
              {actionId === 'cancel' ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
            </button>
          </div>
          {progressTitle && <div className="mt-1 truncate text-[11px] text-blue-700 dark:text-blue-300">{progressTitle}</div>}
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
          {state.competitors.map(row => (
            <div key={row.id} className="flex items-start gap-2 rounded-md border border-gray-200 bg-white px-2 py-2 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
              <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${statusTone(row.status)}`}>
                {row.status === 'completed' ? <Check size={11} /> : row.status === 'failed' || row.status === 'cancelled' ? <XCircle size={11} /> : <LoaderCircle size={11} className={row.status === 'extracting' ? 'animate-spin' : ''} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-1 text-[11px] font-black text-gray-800 dark:text-gray-100">{row.position}. {row.title || row.domain}</div>
                <div className="mt-0.5 truncate text-[10px] text-gray-500" dir="ltr">{row.domain}</div>
                {row.status === 'completed' && <div className="mt-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">{row.wordCount} {isArabic ? 'كلمة' : 'words'}</div>}
                {row.errorMessage && <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-red-600 dark:text-red-300">{row.errorMessage}</div>}
              </div>
              <a
                href={row.canonicalUrl || row.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={isArabic ? 'فتح الموقع' : 'Open website'}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-[#8a6f1d] dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
              >
                <ExternalLink size={13} />
              </a>
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
          ))}
        </div>
      )}

      {notice && <div className="rounded-md bg-emerald-50 px-2.5 py-2 text-[11px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{notice}</div>}
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
};

export default CompetitorDiscoveryPanel;
