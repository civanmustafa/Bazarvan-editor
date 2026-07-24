import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Database,
  ExternalLink,
  Link2,
  Loader2,
  MousePointer2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorSelector } from '../contexts/EditorContext';
import {
  listInternalLinkingClients,
  loadArticleClientContext,
  loadInternalLinkActions,
  loadInternalLinkTargetPages,
  recordInternalLinkAction,
  saveArticleClientContext,
  type InternalLinkAction,
} from '../utils/internalLinking';
import {
  createInternalLinkArticleSignature,
  generateInternalLinkSuggestions,
  type InternalLinkSuggestion,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine';
import type { ClientCenterClient } from '../utils/clientCenter';

type ExistingLinkState = {
  urls: string[];
  anchors: string[];
};

type AnchorRange = {
  from: number;
  to: number;
};

const readExistingLinks = (html: string): ExistingLinkState => {
  if (!html || typeof DOMParser === 'undefined') return { urls: [], anchors: [] };
  const document = new DOMParser().parseFromString(html, 'text/html');
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  return {
    urls: links.map(link => link.href || link.getAttribute('href') || '').filter(Boolean),
    anchors: links.map(link => link.textContent?.trim() || '').filter(Boolean),
  };
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

const InternalLinkingPanel: React.FC = () => {
  const editor = useEditorSelector(context => context.editor);
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const articleTitle = useEditorSelector(context => context.title);
  const articleText = useEditorSelector(context => context.text);
  const keywords = useEditorSelector(context => context.keywords);
  const [clients, setClients] = useState<ClientCenterClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [pages, setPages] = useState<InternalLinkTargetPage[]>([]);
  const [actions, setActions] = useState<InternalLinkAction[]>([]);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [isLoadingPages, setIsLoadingPages] = useState(false);
  const [isSavingClient, setIsSavingClient] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyPageId, setBusyPageId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editorRevision, setEditorRevision] = useState(0);

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
    () => readExistingLinks(editor?.getHTML() || ''),
    [articleText, editor, editorRevision],
  );

  const dismissedPageIds = useMemo(() => {
    const latestByPage = new Map<string, InternalLinkAction>();
    for (const action of actions) {
      if (action.articleSignature !== articleSignature || latestByPage.has(action.pageId)) continue;
      latestByPage.set(action.pageId, action);
    }
    return [...latestByPage.values()]
      .filter(action => action.action === 'dismissed')
      .map(action => action.pageId);
  }, [actions, articleSignature]);

  const suggestions = useMemo(() => generateInternalLinkSuggestions({
    articleTitle,
    articleText,
    keywords: keywordValues,
    pages,
    existingUrls: existingLinks.urls,
    existingAnchors: existingLinks.anchors,
    dismissedPageIds,
    maximumSuggestions: 20,
  }), [
    articleText,
    articleTitle,
    dismissedPageIds,
    existingLinks.anchors,
    existingLinks.urls,
    keywordValues,
    pages,
  ]);

  const refreshInventory = useCallback(async (
    articleId: string,
    clientId: string,
    showSpinner = true,
  ) => {
    if (showSpinner) setIsLoadingPages(true);
    setError('');
    try {
      const [nextPages, nextActions] = await Promise.all([
        loadInternalLinkTargetPages(clientId),
        loadInternalLinkActions(articleId, clientId),
      ]);
      setPages(nextPages);
      setActions(nextActions);
    } catch (loadError) {
      setPages([]);
      setActions([]);
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل صفحات العميل.');
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
    }).catch(loadError => {
      if (!cancelled) {
        setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل عملاء المقالة.');
      }
    }).finally(() => {
      if (!cancelled) setIsLoadingContext(false);
    });
    return () => { cancelled = true; };
  }, [activeArticleId]);

  useEffect(() => {
    if (!activeArticleId || !selectedClientId) {
      setPages([]);
      setActions([]);
      return;
    }
    void refreshInventory(activeArticleId, selectedClientId);
  }, [activeArticleId, refreshInventory, selectedClientId]);

  const handleClientChange = async (clientId: string) => {
    if (!activeArticleId || clientId === selectedClientId) return;
    const previousClientId = selectedClientId;
    setSelectedClientId(clientId);
    setPages([]);
    setActions([]);
    setError('');
    setNotice('');
    if (!clientId) return;

    setIsSavingClient(true);
    try {
      await saveArticleClientContext(activeArticleId, clientId);
      setNotice('تم ربط المقالة بمخزون صفحات العميل.');
    } catch (saveError) {
      setSelectedClientId(previousClientId);
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ العميل المحدد.');
    } finally {
      setIsSavingClient(false);
    }
  };

  const handleRefresh = async () => {
    if (!activeArticleId || !selectedClientId) return;
    setIsRefreshing(true);
    setNotice('');
    await refreshInventory(activeArticleId, selectedClientId, false);
    setEditorRevision(value => value + 1);
    setIsRefreshing(false);
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
    const range = selectAnchor(suggestion);
    if (!range) return;
    setBusyPageId(suggestion.pageId);
    setNotice('');
    try {
      const applied = editor
        .chain()
        .focus()
        .setTextSelection(range)
        .setLink({
          href: suggestion.targetUrl,
          target: '_self',
          rel: 'noopener',
        })
        .run();
      if (!applied) throw new Error('لم يتمكن المحرر من تطبيق الرابط على النص المحدد.');

      const action = await recordInternalLinkAction({
        articleId: activeArticleId,
        clientId: selectedClientId,
        suggestion,
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
        suggestion,
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

  if (!activeArticleId) {
    return (
      <div dir="rtl" className="space-y-4 p-4 text-right">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
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
    <div dir="rtl" className="space-y-4 p-3 text-right">
      <div className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3">
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
              return (
                <article
                  key={suggestion.pageId}
                  className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#272727]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] font-black text-gray-400">نص الرابط المقترح</div>
                      <div className="rounded-md bg-[#d4af37]/10 px-2 py-1 text-xs font-black text-[#8a6f1d] dark:text-[#f2d675]">
                        {suggestion.anchorText}
                      </div>
                    </div>
                    <div className="shrink-0 text-center">
                      <div className="text-lg font-black text-[#d4af37]">{suggestion.score}</div>
                      <div className={`rounded-full px-2 py-0.5 text-[9px] font-black ${confidenceClass[suggestion.confidence]}`}>
                        {confidenceLabel[suggestion.confidence]}
                      </div>
                    </div>
                  </div>

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
                  {suggestion.matchedTerms.length > 0 && (
                    <div className="mt-2 text-[10px] font-semibold leading-5 text-gray-400">
                      الكلمات المتطابقة: {suggestion.matchedTerms.join('، ')}
                    </div>
                  )}

                  <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectAnchor(suggestion)}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-[10px] font-black text-gray-600 hover:border-[#d4af37] dark:border-[#454545] dark:text-gray-200"
                    >
                      <MousePointer2 size={12} />
                      تحديد النص
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
                  </div>
                </article>
              );
            })}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-2.5 text-[10px] font-semibold leading-5 text-gray-500 dark:border-[#3C3C3C] dark:bg-[#272727] dark:text-gray-400">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-500" />
            يمنع المحرك تكرار الصفحة الهدف أو نص رابط مستخدم، ويستبعد الصفحات المعطلة وNoindex وغير الجاهزة. القرار النهائي يبقى للمحرر.
          </div>
        </>
      )}
    </div>
  );
};

export default InternalLinkingPanel;
