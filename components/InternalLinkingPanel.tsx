import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Check,
  Clipboard,
  Database,
  ExternalLink,
  Flag,
  Link2,
  Loader2,
  MousePointer2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorSelector } from '../contexts/EditorContext';
import { useAISelector } from '../contexts/AIContext';
import { useUser } from '../contexts/UserContext';
import type { AiPatchProvider } from '../types';
import {
  listInternalLinkingClients,
  INTERNAL_LINK_ACTIONS_CHANGED_EVENT,
  loadArticleClientContext,
  loadInternalLinkActions,
  loadInternalLinkQualityPolicy,
  loadInternalLinkTargetPages,
  recordInternalLinkAction,
  recordInternalLinkSuggestionRun,
  saveArticleClientContext,
  saveArticleClientSelection,
  saveArticleCurrentPageUrl,
  type EffectiveInternalLinkQualityPolicy,
  type InternalLinkAction,
} from '../utils/internalLinking';
import {
  createInternalLinkArticleSignature,
  createInternalLinkInventorySignature,
  countExistingInventoryLinks,
  generateInternalLinkSuggestions,
  type InternalLinkSuggestion,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine';
import type { ClientCenterClient } from '../utils/clientCenter';
import {
  calculateInternalLinkSuggestionBudget,
  DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
} from '../utils/internalLinkQualityPolicy';
import {
  buildInternalLinkAiReviewPrompt,
  INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES,
  parseInternalLinkAiReviewResponse,
  type InternalLinkAiReview,
} from '../utils/internalLinkAiReview';
import { readExistingInternalLinks } from '../utils/internalLinkAutoApply';
import { buildUnifiedCompanyKeywords } from '../utils/clientCompanyIdentity';
import { getPromptTemplate, PROMPT_TEMPLATE_IDS } from '../constants/promptRegistry';

type AnchorRange = {
  from: number;
  to: number;
};

const DEFAULT_EFFECTIVE_QUALITY_POLICY: EffectiveInternalLinkQualityPolicy = {
  values: DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
  source: 'default',
  policyVersion: 1,
};

const findUnlinkedAnchorRange = (editor: Editor, anchorText: string): AnchorRange | null => {
  const documentText: string[] = [];
  const positions: number[] = [];
  let previousEnd = -1;

  editor.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    if (previousEnd >= 0 && position > previousEnd) {
      documentText.push('\n');
      positions.push(-1);
    }
    for (let index = 0; index < node.text.length; index += 1) {
      documentText.push(node.text[index]);
      positions.push(position + index);
    }
    previousEnd = position + node.text.length;
  });

  const source = documentText.join('').toLocaleLowerCase();
  const target = anchorText.toLocaleLowerCase();
  const linkMark = editor.schema.marks.link;
  let searchFrom = 0;
  while (target && searchFrom < source.length) {
    const index = source.indexOf(target, searchFrom);
    if (index < 0) return null;
    const mapped = positions.slice(index, index + target.length);
    if (mapped.length === target.length && mapped.every(position => position >= 0)) {
      const from = mapped[0];
      const to = mapped[mapped.length - 1] + 1;
      if (to > from && (!linkMark || !editor.state.doc.rangeHasMark(from, to, linkMark))) {
        return { from, to };
      }
    }
    searchFrom = index + Math.max(1, target.length);
  }
  return null;
};

const confidenceLabel: Record<InternalLinkSuggestion['confidence'], string> = {
  strong: 'قوي',
  good: 'جيد',
  review: 'يحتاج مراجعة',
};

const confidenceClass: Record<InternalLinkSuggestion['confidence'], string> = {
  strong: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  good: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  review: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
};

const aiReviewStatusLabel: Record<InternalLinkAiReview['status'], string> = {
  approved: 'مناسب',
  caution: 'يحتاج انتباه',
  rejected: 'غير موصى به',
};

const aiReviewStatusClass: Record<InternalLinkAiReview['status'], string> = {
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  caution: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  rejected: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
};

const AI_REVIEW_PROVIDERS: Array<{ id: AiPatchProvider; label: string }> = [
  { id: 'gemini', label: 'Gemini المجاني' },
  { id: 'geminiPaid', label: 'Gemini المدفوع' },
  { id: 'chatgpt', label: 'OpenAI' },
];

const InternalLinkingPanel: React.FC = () => {
  const { engineeringPrompts, isAiProviderAvailable } = useUser();
  const editor = useEditorSelector(context => context.editor);
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const articleTitle = useEditorSelector(context => context.title);
  const articleText = useEditorSelector(context => context.text);
  const articleLanguage = useEditorSelector(context => context.articleLanguage);
  const keywords = useEditorSelector(context => context.keywords);
  const setKeywords = useEditorSelector(context => context.setKeywords);
  const quickAiProvider = useAISelector(context => context.quickAiProvider);
  const setQuickAiProvider = useAISelector(context => context.setQuickAiProvider);
  const runPlainAiAnalysis = useAISelector(context => context.runPlainAiAnalysis);
  const [clients, setClients] = useState<ClientCenterClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [pages, setPages] = useState<InternalLinkTargetPage[]>([]);
  const [actions, setActions] = useState<InternalLinkAction[]>([]);
  const [qualityPolicy, setQualityPolicy] = useState<EffectiveInternalLinkQualityPolicy>(
    DEFAULT_EFFECTIVE_QUALITY_POLICY,
  );
  const [currentPageUrl, setCurrentPageUrl] = useState('');
  const [selectedAnchors, setSelectedAnchors] = useState<Record<string, string>>({});
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [isLoadingPages, setIsLoadingPages] = useState(false);
  const [isSavingClient, setIsSavingClient] = useState(false);
  const [isSavingCurrentPage, setIsSavingCurrentPage] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyPageId, setBusyPageId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editorRevision, setEditorRevision] = useState(0);
  const [isAiReviewEnabled, setIsAiReviewEnabled] = useState(false);
  const [isAiReviewing, setIsAiReviewing] = useState(false);
  const [aiReviews, setAiReviews] = useState<Record<string, InternalLinkAiReview>>({});
  const [aiReviewSignature, setAiReviewSignature] = useState('');

  const articleSignature = useMemo(
    () => createInternalLinkArticleSignature(articleTitle, articleText),
    [articleText, articleTitle],
  );

  const keywordValues = useMemo(() => [
    keywords.primary,
    keywords.company,
    ...keywords.secondaries,
    ...keywords.lsi,
  ].filter(Boolean), [keywords]);

  const existingLinks = useMemo(
    () => editor ? readExistingInternalLinks(editor) : { urls: [], anchors: [] },
    [articleText, editor, editorRevision],
  );

  const dismissedPageIds = useMemo(() => {
    const latestByPage = new Map<string, InternalLinkAction>();
    for (const action of actions) {
      if (action.articleSignature !== articleSignature || latestByPage.has(action.pageId)) continue;
      latestByPage.set(action.pageId, action);
    }
    return [...latestByPage.values()]
      .filter(action => action.action === 'dismissed' || action.action === 'reported')
      .map(action => action.pageId);
  }, [actions, articleSignature]);

  const blockedPageIds = useMemo(() => (
    [...new Set(actions
      .filter(action => action.action === 'blocked')
      .map(action => action.pageId))]
  ), [actions]);

  const suggestions = useMemo(() => generateInternalLinkSuggestions({
    articleTitle,
    articleText,
    articleLanguage,
    keywords: keywordValues,
    pages,
    existingUrls: existingLinks.urls,
    existingAnchors: existingLinks.anchors,
    dismissedPageIds,
    blockedPageIds,
    currentArticleUrl: currentPageUrl,
    maximumSuggestions: 20,
    qualityPolicy: qualityPolicy.values,
  }), [
    articleText,
    articleLanguage,
    articleTitle,
    blockedPageIds,
    currentPageUrl,
    dismissedPageIds,
    existingLinks.anchors,
    existingLinks.urls,
    keywordValues,
    pages,
    qualityPolicy.values,
  ]);

  const suggestionBudget = useMemo(() => calculateInternalLinkSuggestionBudget(
    articleText,
    countExistingInventoryLinks(existingLinks.urls, pages),
    qualityPolicy.values,
    20,
  ), [articleText, existingLinks.urls, pages, qualityPolicy.values]);

  const aiReviewInputSignature = useMemo(() => JSON.stringify({
    articleSignature,
    clientId: selectedClientId,
    policy: qualityPolicy.values,
    candidates: suggestions
      .slice(0, INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES)
      .map(suggestion => ({
        pageId: suggestion.pageId,
        score: suggestion.score,
        allowedAnchors: suggestion.alternativeAnchors,
      })),
  }), [
    articleSignature,
    qualityPolicy.values,
    selectedClientId,
    suggestions,
  ]);

  useEffect(() => {
    if (!activeArticleId || !selectedClientId) return;
    const handleActionsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        articleId?: string;
        clientId?: string;
      }>).detail;
      if (detail?.articleId !== activeArticleId || detail?.clientId !== selectedClientId) return;
      setEditorRevision(value => value + 1);
      void loadInternalLinkActions(activeArticleId, selectedClientId)
        .then(setActions)
        .catch(loadError => console.warn('Could not refresh internal-link actions:', loadError));
    };
    window.addEventListener(INTERNAL_LINK_ACTIONS_CHANGED_EVENT, handleActionsChanged);
    return () => window.removeEventListener(INTERNAL_LINK_ACTIONS_CHANGED_EVENT, handleActionsChanged);
  }, [activeArticleId, selectedClientId]);

  useEffect(() => {
    setAiReviews({});
    setAiReviewSignature('');
  }, [aiReviewInputSignature]);

  const currentPageOptions = useMemo(() => {
    const seen = new Set<string>();
    return pages.flatMap(page => {
      const url = page.canonicalUrl?.trim() || page.finalUrl?.trim() || page.inputUrl.trim();
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{
        url,
        label: page.pageTitle?.trim() || page.h1?.trim() || url,
      }];
    });
  }, [pages]);

  const refreshInventory = useCallback(async (
    articleId: string,
    clientId: string,
    showSpinner = true,
  ): Promise<{
    pages: InternalLinkTargetPage[];
    actions: InternalLinkAction[];
    qualityPolicy: EffectiveInternalLinkQualityPolicy;
  } | null> => {
    if (showSpinner) setIsLoadingPages(true);
    setError('');
    try {
      const [nextPages, nextActions, nextQualityPolicy] = await Promise.all([
        loadInternalLinkTargetPages(clientId),
        loadInternalLinkActions(articleId, clientId),
        loadInternalLinkQualityPolicy(clientId),
      ]);
      setPages(nextPages);
      setActions(nextActions);
      setQualityPolicy(nextQualityPolicy);
      return {
        pages: nextPages,
        actions: nextActions,
        qualityPolicy: nextQualityPolicy,
      };
    } catch (loadError) {
      setPages([]);
      setActions([]);
      setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل صفحات العميل.');
      return null;
    } finally {
      if (showSpinner) setIsLoadingPages(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setClients([]);
    setSelectedClientId('');
    setPages([]);
    setActions([]);
    setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
    setCurrentPageUrl('');
    setSelectedAnchors({});
    setError('');
    setNotice('');
    if (!activeArticleId) return () => { cancelled = true; };

    setIsLoadingContext(true);
    void Promise.all([
      listInternalLinkingClients(),
      loadArticleClientContext(activeArticleId),
    ]).then(([nextClients, context]) => {
      if (cancelled) return;
      setClients(nextClients);
      const contextClientExists = nextClients.some(client => client.id === context?.clientId);
      setSelectedClientId(contextClientExists ? context?.clientId || '' : '');
      setCurrentPageUrl(contextClientExists ? context?.currentPageUrl || '' : '');
      const contextClient = contextClientExists
        ? nextClients.find(client => client.id === context?.clientId) || null
        : null;
      if (contextClient) {
        setKeywords(current => buildUnifiedCompanyKeywords(current, contextClient));
      }
    }).catch(loadError => {
      if (!cancelled) {
        setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل عملاء المقالة.');
      }
    }).finally(() => {
      if (!cancelled) setIsLoadingContext(false);
    });
    return () => { cancelled = true; };
  }, [activeArticleId, setKeywords]);

  useEffect(() => {
    if (!activeArticleId || !selectedClientId) {
      setPages([]);
      setActions([]);
      setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
      setSelectedAnchors({});
      return;
    }
    void refreshInventory(activeArticleId, selectedClientId);
  }, [activeArticleId, refreshInventory, selectedClientId]);

  useEffect(() => {
    const keywordClientId = keywords.clientId?.trim() || '';
    if (
      isLoadingContext
      || !activeArticleId
      || !keywordClientId
      || keywordClientId === selectedClientId
      || !clients.some(client => client.id === keywordClientId)
    ) return;

    setSelectedClientId(keywordClientId);
    setCurrentPageUrl('');
    setSelectedAnchors({});
    void saveArticleClientSelection(activeArticleId, keywordClientId).catch(saveError => {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'تعذر توحيد العميل المحدد مع الربط الداخلي.',
      );
    });
  }, [
    activeArticleId,
    clients,
    isLoadingContext,
    keywords.clientId,
    selectedClientId,
  ]);

  const handleClientChange = async (clientId: string) => {
    if (!activeArticleId || clientId === selectedClientId) return;
    const previousClientId = selectedClientId;
    const previousCurrentPageUrl = currentPageUrl;
    setSelectedClientId(clientId);
    setCurrentPageUrl('');
    setSelectedAnchors({});
    setPages([]);
    setActions([]);
    setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
    setError('');
    setNotice('');
    if (!clientId) return;

    setIsSavingClient(true);
    try {
      await saveArticleClientContext(activeArticleId, clientId, '');
      const selectedClient = clients.find(client => client.id === clientId);
      if (selectedClient) {
        setKeywords(current => buildUnifiedCompanyKeywords(current, selectedClient));
      }
      setNotice('تم ربط المقالة بمخزون صفحات العميل.');
    } catch (saveError) {
      setSelectedClientId(previousClientId);
      setCurrentPageUrl(previousCurrentPageUrl);
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ العميل المحدد.');
    } finally {
      setIsSavingClient(false);
    }
  };

  const handleRefresh = async () => {
    if (!activeArticleId || !selectedClientId) return;
    setIsRefreshing(true);
    setNotice('');
    try {
      const refreshed = await refreshInventory(activeArticleId, selectedClientId, false);
      if (refreshed) {
        const nextSuggestions = generateInternalLinkSuggestions({
          articleTitle,
          articleText,
          articleLanguage,
          keywords: keywordValues,
          pages: refreshed.pages,
          existingUrls: existingLinks.urls,
          existingAnchors: existingLinks.anchors,
          dismissedPageIds,
          blockedPageIds,
          currentArticleUrl: currentPageUrl,
          maximumSuggestions: 20,
          qualityPolicy: refreshed.qualityPolicy.values,
        });
        await recordInternalLinkSuggestionRun({
          articleId: activeArticleId,
          clientId: selectedClientId,
          articleSignature,
          inventorySignature: createInternalLinkInventorySignature(
            refreshed.pages,
            currentPageUrl,
            refreshed.qualityPolicy.values,
          ),
          currentPageUrl,
          pageCount: refreshed.pages.length,
          suggestions: nextSuggestions,
          qualityPolicy: refreshed.qualityPolicy,
          suggestionBudget: calculateInternalLinkSuggestionBudget(
            articleText,
            countExistingInventoryLinks(existingLinks.urls, refreshed.pages),
            refreshed.qualityPolicy.values,
            20,
          ),
        });
        setNotice('تم تحديث الاقتراحات وتسجيل ملخص الفحص.');
      }
      setEditorRevision(value => value + 1);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'تعذر تسجيل فحص الاقتراحات.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCurrentPageChange = async (value: string) => {
    if (!activeArticleId || !selectedClientId || isSavingCurrentPage) return;
    const previous = currentPageUrl;
    setCurrentPageUrl(value);
    setIsSavingCurrentPage(true);
    setError('');
    setNotice('');
    try {
      await saveArticleCurrentPageUrl(activeArticleId, selectedClientId, value);
      setNotice(value
        ? 'تم حفظ رابط المقالة الحالية، ولن يقترح النظام ربطها بنفسها.'
        : 'تم اعتبار المقالة جديدة أو غير منشورة.');
    } catch (saveError) {
      setCurrentPageUrl(previous);
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ رابط المقالة الحالية.');
    } finally {
      setIsSavingCurrentPage(false);
    }
  };

  const withSelectedAnchor = (suggestion: InternalLinkSuggestion): InternalLinkSuggestion => ({
    ...suggestion,
    anchorText: suggestion.alternativeAnchors.includes(selectedAnchors[suggestion.pageId])
      ? selectedAnchors[suggestion.pageId]
      : suggestion.anchorText,
  });

  const handleAiReview = async () => {
    if (
      !isAiReviewEnabled
      || isAiReviewing
      || suggestions.length === 0
      || !isAiProviderAvailable(quickAiProvider)
    ) return;
    const requestSignature = aiReviewInputSignature;
    setIsAiReviewing(true);
    setAiReviews({});
    setAiReviewSignature('');
    setError('');
    setNotice('');
    try {
      const reviewRequest = buildInternalLinkAiReviewPrompt({
        articleTitle,
        articleLanguage,
        articleText,
        suggestions: suggestions.map(withSelectedAnchor),
        pages,
        qualityPolicy: qualityPolicy.values,
        promptTemplate: getPromptTemplate(
          engineeringPrompts as unknown as Record<string, string>,
          PROMPT_TEMPLATE_IDS.internalLinkReview,
        ),
      });
      const rawResponse = await runPlainAiAnalysis(reviewRequest.prompt, {
        provider: quickAiProvider,
        source: 'internal_link_review',
        commandId: PROMPT_TEMPLATE_IDS.internalLinkReview,
        commandLabel: 'مراجعة اقتراحات الربط الداخلي',
        action: 'review_algorithmic_internal_link_suggestions',
      });
      const reviews = parseInternalLinkAiReviewResponse(rawResponse, reviewRequest.candidates);
      setAiReviews(Object.fromEntries(reviews.map(review => [review.pageId, review])));
      setAiReviewSignature(requestSignature);
      setNotice(
        `اكتملت مراجعة ${reviews.length.toLocaleString('ar')} اقتراحات بالذكاء الاصطناعي. المراجعة استشارية ولا تطبق رابطًا بذاتها.`,
      );
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : 'تعذر إكمال مراجعة اقتراحات الربط الداخلي بالذكاء الاصطناعي.',
      );
    } finally {
      setIsAiReviewing(false);
    }
  };

  const selectAnchor = (suggestion: InternalLinkSuggestion): AnchorRange | null => {
    if (!editor) return null;
    const range = findUnlinkedAnchorRange(editor, suggestion.anchorText);
    if (!range) {
      setError('تعذر العثور على نص الربط غير المرتبط. ربما تغيّر النص بعد إنشاء الاقتراح.');
      return null;
    }
    editor.commands.focus();
    editor.commands.setTextSelection(range);
    setError('');
    return range;
  };

  const handleApply = async (suggestion: InternalLinkSuggestion) => {
    if (!activeArticleId || !selectedClientId || !editor) return;
    const resolvedSuggestion = withSelectedAnchor(suggestion);
    const range = selectAnchor(resolvedSuggestion);
    if (!range) return;
    setBusyPageId(suggestion.pageId);
    setNotice('');
    try {
      const applied = editor
        .chain()
        .focus()
        .setTextSelection(range)
        .setLink({
          href: resolvedSuggestion.targetUrl,
          target: '_self',
          rel: 'noopener',
        })
        .run();
      if (!applied) throw new Error('لم يتمكن المحرر من تطبيق الرابط على النص المحدد.');

      const action = await recordInternalLinkAction({
        articleId: activeArticleId,
        clientId: selectedClientId,
        suggestion: resolvedSuggestion,
        action: 'applied',
        articleSignature,
      });
      setActions(current => [action, ...current]);
      setEditorRevision(value => value + 1);
      setNotice('تم تطبيق الرابط داخل المقالة، وسيُحفظ مع الحفظ التلقائي أو اليدوي.');
      setError('');
    } catch (applyError) {
      setEditorRevision(value => value + 1);
      setError(applyError instanceof Error ? applyError.message : 'تعذر تطبيق الرابط.');
    } finally {
      setBusyPageId('');
    }
  };

  const handleDismiss = async (suggestion: InternalLinkSuggestion) => {
    if (!activeArticleId || !selectedClientId) return;
    setBusyPageId(suggestion.pageId);
    setNotice('');
    try {
      const action = await recordInternalLinkAction({
        articleId: activeArticleId,
        clientId: selectedClientId,
        suggestion: withSelectedAnchor(suggestion),
        action: 'dismissed',
        articleSignature,
      });
      setActions(current => [action, ...current]);
      setNotice('تم تجاهل الاقتراح لهذه النسخة من المقالة.');
      setError('');
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : 'تعذر تجاهل الاقتراح.');
    } finally {
      setBusyPageId('');
    }
  };

  const handleBlock = async (suggestion: InternalLinkSuggestion) => {
    if (!activeArticleId || !selectedClientId) return;
    if (!window.confirm('لن يظهر هذا الرابط مرة أخرى لهذه المقالة حتى لو تغيّر نصها. هل تريد المتابعة؟')) return;
    setBusyPageId(suggestion.pageId);
    setNotice('');
    try {
      const action = await recordInternalLinkAction({
        articleId: activeArticleId,
        clientId: selectedClientId,
        suggestion: withSelectedAnchor(suggestion),
        action: 'blocked',
        articleSignature,
      });
      setActions(current => [action, ...current]);
      setNotice('تم منع اقتراح هذا الرابط لهذه المقالة.');
      setError('');
    } catch (blockError) {
      setError(blockError instanceof Error ? blockError.message : 'تعذر منع الرابط.');
    } finally {
      setBusyPageId('');
    }
  };

  const handleReport = async (suggestion: InternalLinkSuggestion) => {
    if (!activeArticleId || !selectedClientId) return;
    const feedbackNote = window.prompt('اشرح باختصار لماذا الاقتراح غير مناسب:')?.trim();
    if (!feedbackNote) return;
    setBusyPageId(suggestion.pageId);
    setNotice('');
    try {
      const action = await recordInternalLinkAction({
        articleId: activeArticleId,
        clientId: selectedClientId,
        suggestion: withSelectedAnchor(suggestion),
        action: 'reported',
        articleSignature,
        feedbackNote,
      });
      setActions(current => [action, ...current]);
      setNotice('تم تسجيل البلاغ وإخفاء الاقتراح لهذه النسخة من المقالة.');
      setError('');
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'تعذر تسجيل البلاغ.');
    } finally {
      setBusyPageId('');
    }
  };

  const handleCopyUrl = async (suggestion: InternalLinkSuggestion) => {
    try {
      await navigator.clipboard.writeText(suggestion.targetUrl);
      setNotice('تم نسخ الرابط.');
      setError('');
    } catch {
      setError('تعذر نسخ الرابط تلقائيًا. يمكنك نسخه من الرابط الظاهر.');
    }
  };

  if (!activeArticleId) {
    return (
      <div dir="rtl" className="space-y-[0.25rem] p-[0.25rem] text-right">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-[0.25rem] text-sm leading-7 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="mb-2 flex items-center gap-2 font-black">
            <Link2 size={18} />
            الربط الداخلي
          </div>
          احفظ المقالة أولًا ليصبح لها سجل ثابت، ثم اختر العميل الذي ستُستخدم صفحات موقعه في الاقتراحات.
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" className="space-y-[0.25rem] p-[0.1875rem] text-right">
      <div className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-[0.1875rem]">
        <div className="flex items-center gap-2 text-sm font-black text-gray-800 dark:text-gray-100">
          <Link2 size={18} className="text-[#d4af37]" />
          محرك الربط الداخلي
        </div>
        <p className="mt-2 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
          يطابق نص المقالة برمجيًا مع عناوين وأوصاف وعناوين H1–H3 وعبارات صفحات موقع العميل.
          لا يستخدم الذكاء الاصطناعي أو Search Console أو مقالات المحرر كمصدر للروابط.
        </p>
      </div>

      <label className="block space-y-1.5">
        <span className="flex items-center gap-1.5 text-xs font-black text-gray-700 dark:text-gray-200">
          <Database size={14} />
          العميل ومخزون روابط الموقع
        </span>
        <select
          value={selectedClientId}
          onChange={event => void handleClientChange(event.target.value)}
          disabled={isLoadingContext || isSavingClient}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 outline-none focus:border-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#272727] dark:text-gray-100"
        >
          <option value="" disabled>اختر العميل...</option>
          {clients.map(client => (
            <option key={client.id} value={client.id}>{client.name}</option>
          ))}
        </select>
        {isSavingClient && (
          <span className="flex items-center gap-1 text-[10px] font-bold text-gray-400">
            <Loader2 size={11} className="animate-spin" />
            جارٍ حفظ اختيار العميل...
          </span>
        )}
      </label>

      {selectedClientId && (
        <label className="block space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-black text-gray-700 dark:text-gray-200">
            <Link2 size={14} />
            رابط المقالة الحالية
          </span>
          <select
            value={currentPageUrl}
            onChange={event => void handleCurrentPageChange(event.target.value)}
            disabled={isLoadingPages || isSavingCurrentPage}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 outline-none focus:border-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#272727] dark:text-gray-100"
          >
            <option value="">مقالة جديدة أو الرابط غير معروف</option>
            {currentPageUrl && !currentPageOptions.some(option => option.url === currentPageUrl) && (
              <option value={currentPageUrl}>{currentPageUrl}</option>
            )}
            {currentPageOptions.map(option => (
              <option key={option.url} value={option.url}>{option.label}</option>
            ))}
          </select>
          <span className="block text-[10px] font-semibold leading-5 text-gray-400">
            اختياري للاقتراحات اليدوية، وإلزامي للإدراج التلقائي. تحديد الصفحة المنشورة يمنع ربط المقالة بنفسها.
          </span>
        </label>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold leading-5 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {selectedClientId && (
        <>
	          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-gray-200 bg-white p-2 text-center dark:border-[#3C3C3C] dark:bg-[#272727]">
              <div className="text-base font-black text-[#d4af37]">{pages.length}</div>
              <div className="text-[9px] font-bold text-gray-400">صفحة جاهزة</div>
	          </div>

            <div className="rounded-lg border border-gray-200 bg-white p-2 text-center dark:border-[#3C3C3C] dark:bg-[#272727]">
              <div className="text-base font-black text-[#d4af37]">{suggestions.length}</div>
              <div className="text-[9px] font-bold text-gray-400">اقتراح صالح</div>
            </div>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || isLoadingPages}
              className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white p-2 text-[9px] font-bold text-gray-500 hover:border-[#d4af37] hover:text-[#9b7d20] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#272727] dark:text-gray-300"
            >
              <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
              تحديث الفحص
            </button>
          </div>

          <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900/60 dark:bg-violet-950/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-black text-violet-800 dark:text-violet-200">
                  <Sparkles size={15} />
                  مراجعة اختيارية بالذكاء الاصطناعي
                </div>
                <p className="mt-1 text-[10px] font-semibold leading-5 text-violet-700/80 dark:text-violet-300/80">
                  معطلة افتراضيًا ولا تعمل تلقائيًا. تراجع أفضل {INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES.toLocaleString('ar')} نتائج خوارزمية فقط،
                  ولا يمكنها إضافة صفحة أو رابط أو Anchor Text من خارج البيانات المعروضة.
                </p>
              </div>
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[10px] font-black text-violet-700 dark:text-violet-200">
                <input
                  type="checkbox"
                  checked={isAiReviewEnabled}
                  onChange={event => {
                    setIsAiReviewEnabled(event.target.checked);
                    if (!event.target.checked) {
                      setAiReviews({});
                      setAiReviewSignature('');
                    }
                  }}
                  className="h-4 w-4 accent-violet-600"
                />
                {isAiReviewEnabled ? 'مفعلة' : 'معطلة'}
              </label>
            </div>

            {isAiReviewEnabled && (
              <div className="mt-3 space-y-2">
                <label className="block space-y-1">
                  <span className="text-[10px] font-black text-violet-700 dark:text-violet-200">
                    المزود المختار أولًا
                  </span>
                  <select
                    value={quickAiProvider}
                    onChange={event => setQuickAiProvider(event.target.value as AiPatchProvider)}
                    disabled={isAiReviewing}
                    className="w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-[10px] font-bold text-gray-700 outline-none focus:border-violet-500 disabled:opacity-60 dark:border-violet-900/70 dark:bg-[#272727] dark:text-gray-100"
                  >
                    {AI_REVIEW_PROVIDERS.map(provider => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        disabled={!isAiProviderAvailable(provider.id)}
                      >
                        {provider.label}{isAiProviderAvailable(provider.id) ? '' : ' — غير متاح'}
                      </option>
                    ))}
                  </select>
                  <span className="block text-[9px] font-semibold leading-4 text-violet-600/80 dark:text-violet-300/80">
                    يبدأ النظام بالمزود والموديل المختارين، وتبقى آلية تدوير المفاتيح والموديلات الحالية فعالة عند الفشل.
                  </span>
                </label>

                <button
                  type="button"
                  onClick={() => void handleAiReview()}
                  disabled={
                    isAiReviewing
                    || suggestions.length === 0
                    || !isAiProviderAvailable(quickAiProvider)
                  }
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-[10px] font-black text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isAiReviewing
                    ? <Loader2 size={13} className="animate-spin" />
                    : <Sparkles size={13} />}
                  مراجعة الاقتراحات بالذكاء الاصطناعي
                </button>

              </div>
            )}
          </div>

          {(isLoadingPages || isLoadingContext) && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs font-bold text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              جارٍ تحليل مخزون الصفحات...
            </div>
          )}

          {!isLoadingPages && pages.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 p-4 text-center text-xs font-bold leading-6 text-gray-400 dark:border-[#454545]">
              لا توجد صفحات جاهزة للربط. أضف روابط العميل من مركز العملاء وشغّل الزحف حتى تصبح حالتها «جاهزة».
            </div>
          )}

          {!isLoadingPages && pages.length > 0 && suggestions.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 p-4 text-center text-xs font-bold leading-6 text-gray-400 dark:border-[#454545]">
              لا توجد مطابقة آمنة حاليًا. قد تكون الروابط المناسبة مطبقة بالفعل، أو لا يوجد تطابق دلالي كافٍ مع نص المقالة.
            </div>
          )}

          <div className="space-y-3">
            {suggestions.map(suggestion => {
              const isBusy = busyPageId === suggestion.pageId;
              const selectedAnchor = suggestion.alternativeAnchors.includes(selectedAnchors[suggestion.pageId])
                ? selectedAnchors[suggestion.pageId]
                : suggestion.anchorText;
              const aiReview = aiReviewSignature === aiReviewInputSignature
                ? aiReviews[suggestion.pageId]
                : undefined;
              return (
                <article
                  key={suggestion.pageId}
                  className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#272727]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] font-black text-gray-400">نص الرابط المقترح</div>
                      <div className="rounded-md bg-[#d4af37]/10 px-2 py-1 text-xs font-black text-[#8a6f1d] dark:text-[#f2d675]">
                        {selectedAnchor}
                      </div>
                    </div>
                    <div className="shrink-0 text-center">
                      <div className="text-lg font-black text-[#d4af37]">{suggestion.score}</div>
                      <div className={`rounded-full px-2 py-0.5 text-[9px] font-black ${confidenceClass[suggestion.confidence]}`}>
                        {confidenceLabel[suggestion.confidence]}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-2 text-[10px] font-semibold leading-5 text-gray-600 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300">
                    <div className="mb-1 font-black text-[#9b7d20]">الفقرة {suggestion.paragraphNumber}</div>
                    {suggestion.sourceExcerpt}
                  </div>

                  {suggestion.alternativeAnchors.length > 1 && (
                    <label className="mt-3 block space-y-1">
                      <span className="text-[10px] font-black text-gray-500 dark:text-gray-300">اختيار نص ربط بديل من الفقرة</span>
                      <select
                        value={selectedAnchor}
                        onChange={event => setSelectedAnchors(current => ({
                          ...current,
                          [suggestion.pageId]: event.target.value,
                        }))}
                        className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[10px] font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#454545] dark:bg-[#272727] dark:text-gray-100"
                      >
                        {suggestion.alternativeAnchors.map(anchor => (
                          <option key={anchor} value={anchor}>{anchor}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div className="mt-3 text-xs font-black leading-5 text-gray-800 dark:text-gray-100">
                    {suggestion.targetTitle}
                  </div>
                  <a
                    href={suggestion.targetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 flex items-center gap-1 break-all text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  >
                    <ExternalLink size={10} className="shrink-0" />
                    {suggestion.targetUrl}
                  </a>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {suggestion.reasons.map(reason => (
                      <span key={reason} className="rounded-full bg-gray-100 px-2 py-0.5 text-[9px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                        {reason}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[9px] font-bold text-gray-400">
                    <span>BM25: {suggestion.bm25Score}</span>
                    <span>اكتمال بيانات الصفحة: {suggestion.completenessScore}%</span>
                    <span>فارق أقرب هدف: {suggestion.scoreMargin}</span>
                  </div>
                  {suggestion.matchedTerms.length > 0 && (
                    <div className="mt-2 text-[10px] font-semibold leading-5 text-gray-400">
                      الكلمات المتطابقة: {suggestion.matchedTerms.join('، ')}
                    </div>
                  )}

                  {aiReview && (
                    <div className={`mt-3 rounded-lg border p-2.5 text-[10px] font-semibold leading-5 ${aiReviewStatusClass[aiReview.status]}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 font-black">
                          <Sparkles size={12} />
                          رأي المراجعة: {aiReviewStatusLabel[aiReview.status]}
                        </span>
                        {aiReview.anchorWasAdjusted && (
                          <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[8px] font-black">
                            رُفض نص مخترع
                          </span>
                        )}
                      </div>
                      <div className="mt-1">{aiReview.reason}</div>
                      {aiReview.selectedAnchorText !== selectedAnchor && (
                        <button
                          type="button"
                          onClick={() => setSelectedAnchors(current => ({
                            ...current,
                            [suggestion.pageId]: aiReview.selectedAnchorText,
                          }))}
                          className="mt-2 rounded-md border border-current/30 px-2 py-1 text-[9px] font-black hover:bg-white/40 dark:hover:bg-black/10"
                        >
                          اختيار النص المراجع: {aiReview.selectedAnchorText}
                        </button>
                      )}
                      <div className="mt-1.5 text-[9px] opacity-75">
                        هذه المراجعة استشارية فقط؛ لا تنفذ رابطًا بذاتها.
                      </div>
                    </div>
                  )}

                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectAnchor(withSelectedAnchor(suggestion))}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-[10px] font-black text-gray-600 hover:border-[#d4af37] dark:border-[#454545] dark:text-gray-200"
                    >
                      <MousePointer2 size={12} />
                      تحديد النص
                    </button>
                    <a
                      href={suggestion.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-[10px] font-black text-gray-600 hover:border-[#d4af37] dark:border-[#454545] dark:text-gray-200"
                    >
                      <ExternalLink size={12} />
                      فتح الصفحة
                    </a>
                    <button
                      type="button"
                      onClick={() => void handleCopyUrl(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-[10px] font-black text-gray-600 hover:border-[#d4af37] dark:border-[#454545] dark:text-gray-200"
                    >
                      <Clipboard size={12} />
                      نسخ الرابط
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleApply(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 text-[10px] font-black text-white hover:bg-[#b8922e] disabled:opacity-60"
                    >
                      {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      تطبيق الرابط
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDismiss(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-red-200 px-2 py-1.5 text-[10px] font-black text-red-500 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:hover:bg-red-950/30"
                    >
                      <X size={12} />
                      تجاهل
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBlock(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-amber-200 px-2 py-1.5 text-[10px] font-black text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-900/60 dark:text-amber-300 dark:hover:bg-amber-950/30"
                    >
                      <Ban size={12} />
                      منع للمقالة
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleReport(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-orange-200 px-2 py-1.5 text-[10px] font-black text-orange-600 hover:bg-orange-50 disabled:opacity-60 dark:border-orange-900/60 dark:text-orange-300 dark:hover:bg-orange-950/30"
                    >
                      <Flag size={12} />
                      إبلاغ
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-2.5 text-[10px] font-semibold leading-5 text-gray-500 dark:border-[#3C3C3C] dark:bg-[#272727] dark:text-gray-400">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-500" />
            عند تفعيل المسؤول، يضيف المحرك تلقائيًا فقط الرابط المؤكد بدرجة 90 فأعلى، وبفارق 12 نقطة عن أقرب هدف منافس، وفي ظهور وحيد داخل الفقرة المقصودة، وبعد تحديد رابط المقالة الحالية. تبقى جميع النتائج الأخرى للتطبيق اليدوي، مع استبعاد الروابط الموجودة والمعطلة وNoindex وغير الجاهزة.
          </div>
        </>
      )}
    </div>
  );
};

export default InternalLinkingPanel;
