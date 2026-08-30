import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Link2 } from 'lucide-react';
import { useEditorSelector } from '../contexts/EditorContext';
import {
  ARTICLE_CLIENT_CONTEXT_CHANGED_EVENT,
  loadArticleClientContext,
} from '../utils/articleClientContext';
import {
  INTERNAL_LINK_ACTIONS_CHANGED_EVENT,
  loadInternalLinkActions,
  loadInternalLinkQualityPolicy,
  loadInternalLinkTargetPages,
  recordInternalLinkAction,
  recordInternalLinkSuggestionRun,
  type EffectiveInternalLinkQualityPolicy,
  type InternalLinkAction,
} from '../utils/internalLinking';
import {
  createInternalLinkArticleSignature,
  createInternalLinkInventorySignature,
  generateInternalLinkSuggestions,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine';
import {
  applyAutomaticInternalLinkInsertions,
  AUTOMATIC_INTERNAL_LINK_GUARD_VERSION,
  countExistingAutomaticInventoryLinks,
  planAutomaticInternalLinkInsertions,
  readExistingInternalLinks,
} from '../utils/internalLinkAutoApply';
import {
  INTERNAL_LINK_AUTOMATION_SETTINGS_CHANGED_EVENT,
  loadInternalLinkAutomationSettings,
} from '../utils/internalLinkAutomationSettings';
import {
  calculateInternalLinkSuggestionBudget,
  DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
} from '../utils/internalLinkQualityPolicy';

const DEFAULT_EFFECTIVE_QUALITY_POLICY: EffectiveInternalLinkQualityPolicy = {
  values: DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
  source: 'default',
  policyVersion: 1,
};

const AUTOMATION_IDLE_DELAY_MS = 1_200;
const AUTOMATION_SETTINGS_REFRESH_MS = 30_000;

const isEditorDocumentActive = (): boolean => (
  typeof document !== 'undefined'
  && document.visibilityState === 'visible'
  && document.hasFocus()
);

const InternalLinkAutomation: React.FC = () => {
  const editor = useEditorSelector(context => context.editor);
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const isArticleContentSettledForAutomation = useEditorSelector(
    context => context.isArticleContentSettledForAutomation,
  );
  const articleTitle = useEditorSelector(context => context.title);
  const articleText = useEditorSelector(context => context.text);
  const articleLanguage = useEditorSelector(context => context.articleLanguage);
  const keywords = useEditorSelector(context => context.keywords);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [canApplyToArticle, setCanApplyToArticle] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [clientId, setClientId] = useState('');
  const [currentPageUrl, setCurrentPageUrl] = useState('');
  const [pages, setPages] = useState<InternalLinkTargetPage[]>([]);
  const [actions, setActions] = useState<InternalLinkAction[]>([]);
  const [qualityPolicy, setQualityPolicy] = useState<EffectiveInternalLinkQualityPolicy>(
    DEFAULT_EFFECTIVE_QUALITY_POLICY,
  );
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [contextRevision, setContextRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [editorActivityRevision, setEditorActivityRevision] = useState(0);
  const runningRef = useRef(false);
  const latestRunKeyRef = useRef('');
  const lastEditorActivityAtRef = useRef(0);
  const runtimeEligibilityRef = useRef(false);

  const keywordValues = useMemo(() => [
    keywords.primary,
    keywords.company,
    ...keywords.secondaries,
    ...keywords.lsi,
  ].filter(Boolean), [keywords]);

  useEffect(() => {
    if (!activeArticleId) {
      runtimeEligibilityRef.current = false;
      latestRunKeyRef.current = '';
      setAutomationEnabled(false);
      setCanApplyToArticle(false);
      setSettingsLoaded(true);
      return;
    }
    let cancelled = false;
    const loadSettings = async () => {
      setSettingsLoaded(false);
      try {
        const settings = await loadInternalLinkAutomationSettings(activeArticleId);
        if (!cancelled) {
          const nextEligibility = (
            settings.autoApplyStrongInternalLinkSuggestions
            && settings.canApplyToArticle
          );
          if (nextEligibility && !runtimeEligibilityRef.current) {
            latestRunKeyRef.current = '';
          }
          runtimeEligibilityRef.current = nextEligibility;
          setAutomationEnabled(settings.autoApplyStrongInternalLinkSuggestions);
          setCanApplyToArticle(settings.canApplyToArticle);
          setSettingsLoaded(true);
        }
      } catch (error) {
        console.warn('Automatic internal linking is fail-closed because settings could not be loaded:', error);
        if (!cancelled) {
          runtimeEligibilityRef.current = false;
          setAutomationEnabled(false);
          setCanApplyToArticle(false);
          setSettingsLoaded(true);
        }
      }
    };
    const handleSettingsChanged = () => {
      latestRunKeyRef.current = '';
      void loadSettings();
    };
    void loadSettings();
    const refreshTimer = window.setInterval(() => {
      void loadSettings();
    }, AUTOMATION_SETTINGS_REFRESH_MS);
    window.addEventListener(
      INTERNAL_LINK_AUTOMATION_SETTINGS_CHANGED_EVENT,
      handleSettingsChanged,
    );
    return () => {
      cancelled = true;
      runtimeEligibilityRef.current = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener(
        INTERNAL_LINK_AUTOMATION_SETTINGS_CHANGED_EVENT,
        handleSettingsChanged,
      );
    };
  }, [activeArticleId]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    lastEditorActivityAtRef.current = Date.now();
    const handleTransaction = () => {
      lastEditorActivityAtRef.current = Date.now();
      setEditorActivityRevision(value => value + 1);
    };
    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
    };
  }, [editor]);

  useEffect(() => {
    const handleAttentionChanged = () => {
      lastEditorActivityAtRef.current = Date.now();
      setEditorActivityRevision(value => value + 1);
    };
    window.addEventListener('focus', handleAttentionChanged);
    document.addEventListener('visibilitychange', handleAttentionChanged);
    return () => {
      window.removeEventListener('focus', handleAttentionChanged);
      document.removeEventListener('visibilitychange', handleAttentionChanged);
    };
  }, []);

  useEffect(() => {
    const handleContextChanged = (event: Event) => {
      const changedArticleId = (event as CustomEvent<{ articleId?: string }>).detail?.articleId;
      if (!changedArticleId || changedArticleId === activeArticleId) {
        latestRunKeyRef.current = '';
        setContextRevision(value => value + 1);
      }
    };
    window.addEventListener(ARTICLE_CLIENT_CONTEXT_CHANGED_EVENT, handleContextChanged);
    return () => window.removeEventListener(ARTICLE_CLIENT_CONTEXT_CHANGED_EVENT, handleContextChanged);
  }, [activeArticleId]);

  useEffect(() => {
    let cancelled = false;
    setClientId('');
    setCurrentPageUrl('');
    setPages([]);
    setActions([]);
    setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
    setInventoryLoaded(false);
    latestRunKeyRef.current = '';
    if (!activeArticleId) return () => { cancelled = true; };

    void loadArticleClientContext(activeArticleId)
      .then(context => {
        if (cancelled) return;
        setClientId(context?.clientId || '');
        setCurrentPageUrl(context?.currentPageUrl || '');
      })
      .catch(error => {
        console.warn('Could not load article client context for automatic internal linking:', error);
      });
    return () => { cancelled = true; };
  }, [activeArticleId, contextRevision]);

  useEffect(() => {
    let cancelled = false;
    setInventoryLoaded(false);
    setPages([]);
    setActions([]);
    setQualityPolicy(DEFAULT_EFFECTIVE_QUALITY_POLICY);
    latestRunKeyRef.current = '';
    if (!activeArticleId || !clientId) return () => { cancelled = true; };

    void Promise.all([
      loadInternalLinkTargetPages(clientId),
      loadInternalLinkActions(activeArticleId, clientId),
      loadInternalLinkQualityPolicy(clientId),
    ]).then(([nextPages, nextActions, nextPolicy]) => {
      if (cancelled) return;
      setPages(nextPages);
      setActions(nextActions);
      setQualityPolicy(nextPolicy);
      setInventoryLoaded(true);
    }).catch(error => {
      console.warn('Could not load automatic internal-link inventory:', error);
      if (!cancelled) setInventoryLoaded(false);
    });
    return () => { cancelled = true; };
  }, [activeArticleId, clientId]);

  useEffect(() => {
    if (!activeArticleId || !clientId) return;
    const handleActionsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        articleId?: string;
        clientId?: string;
        applicationMode?: string;
      }>).detail;
      if (
        runningRef.current
        || detail?.applicationMode === 'automatic'
        || detail?.articleId !== activeArticleId
        || detail?.clientId !== clientId
      ) return;
      void loadInternalLinkActions(activeArticleId, clientId)
        .then(nextActions => {
          latestRunKeyRef.current = '';
          setActions(nextActions);
        })
        .catch(error => console.warn('Could not refresh internal-link actions:', error));
    };
    window.addEventListener(INTERNAL_LINK_ACTIONS_CHANGED_EVENT, handleActionsChanged);
    return () => window.removeEventListener(INTERNAL_LINK_ACTIONS_CHANGED_EVENT, handleActionsChanged);
  }, [activeArticleId, clientId]);

  useEffect(() => {
    setNotice('');
  }, [activeArticleId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (
      !editor
      || editor.isDestroyed
      || !activeArticleId
      || !isArticleContentSettledForAutomation
      || !clientId
      || !currentPageUrl
      || !settingsLoaded
      || !automationEnabled
      || !canApplyToArticle
      || !inventoryLoaded
      || pages.length === 0
      || runningRef.current
    ) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
      if (
        cancelled
        || runningRef.current
        || editor.isDestroyed
        || editor.view.composing
        || !isEditorDocumentActive()
        || Date.now() - lastEditorActivityAtRef.current < AUTOMATION_IDLE_DELAY_MS
      ) return;
      const currentArticleText = editor.getText();
      if (currentArticleText !== articleText) return;
      const articleSignature = createInternalLinkArticleSignature(
        articleTitle,
        currentArticleText,
      );
      const inventorySignature = createInternalLinkInventorySignature(
        pages,
        currentPageUrl,
        qualityPolicy.values,
      );
      const runKey = [
        activeArticleId,
        clientId,
        articleSignature,
        inventorySignature,
        qualityPolicy.policyVersion,
        AUTOMATIC_INTERNAL_LINK_GUARD_VERSION,
      ].join('|');
      if (latestRunKeyRef.current === runKey) return;

      const existingLinks = readExistingInternalLinks(editor);
      const latestActionByPage = new Map<string, InternalLinkAction>();
      actions.forEach(action => {
        if (action.articleSignature === articleSignature && !latestActionByPage.has(action.pageId)) {
          latestActionByPage.set(action.pageId, action);
        }
      });
      const dismissedPageIds = [...latestActionByPage.values()]
        .filter(action => (
          action.action === 'applied'
          || action.action === 'dismissed'
          || action.action === 'reported'
        ))
        .map(action => action.pageId);
      const blockedPageIds = [...new Set(actions
        .filter(action => action.action === 'blocked')
        .map(action => action.pageId))];
      const suggestions = generateInternalLinkSuggestions({
        articleTitle,
        articleText: currentArticleText,
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
      });
      const suggestionBudget = calculateInternalLinkSuggestionBudget(
        currentArticleText,
        countExistingAutomaticInventoryLinks(existingLinks.urls, pages, currentPageUrl),
        qualityPolicy.values,
        20,
      );
      const expectedDocument = editor.state.doc;
      const insertions = planAutomaticInternalLinkInsertions({
        editor,
        suggestions,
        pages,
        currentPageUrl,
        qualityPolicy: qualityPolicy.values,
        maximumInsertions: suggestionBudget,
      });

      if (
        cancelled
        || editor.state.doc !== expectedDocument
        || editor.view.composing
        || !isEditorDocumentActive()
      ) return;
      if (insertions.length === 0) {
        latestRunKeyRef.current = runKey;
        return;
      }

      let livePages: InternalLinkTargetPage[];
      let liveActions: InternalLinkAction[];
      let livePolicy: EffectiveInternalLinkQualityPolicy;
      try {
        const [liveSettings, latestPages, latestActions, latestPolicy] = await Promise.all([
          loadInternalLinkAutomationSettings(activeArticleId),
          loadInternalLinkTargetPages(clientId),
          loadInternalLinkActions(activeArticleId, clientId),
          loadInternalLinkQualityPolicy(clientId),
        ]);
        if (cancelled) return;
        runtimeEligibilityRef.current = (
          liveSettings.autoApplyStrongInternalLinkSuggestions
          && liveSettings.canApplyToArticle
        );
        setAutomationEnabled(liveSettings.autoApplyStrongInternalLinkSuggestions);
        setCanApplyToArticle(liveSettings.canApplyToArticle);
        if (
          !liveSettings.autoApplyStrongInternalLinkSuggestions
          || !liveSettings.canApplyToArticle
        ) return;
        livePages = latestPages;
        liveActions = latestActions;
        livePolicy = latestPolicy;
      } catch (error) {
        console.warn('Automatic internal linking stopped because its live authorization check failed:', error);
        if (!cancelled) {
          runtimeEligibilityRef.current = false;
          setAutomationEnabled(false);
          setCanApplyToArticle(false);
        }
        return;
      }

      const liveExistingLinks = readExistingInternalLinks(editor);
      const liveLatestActionByPage = new Map<string, InternalLinkAction>();
      liveActions.forEach(action => {
        if (action.articleSignature === articleSignature && !liveLatestActionByPage.has(action.pageId)) {
          liveLatestActionByPage.set(action.pageId, action);
        }
      });
      const liveDismissedPageIds = [...liveLatestActionByPage.values()]
        .filter(action => (
          action.action === 'applied'
          || action.action === 'dismissed'
          || action.action === 'reported'
        ))
        .map(action => action.pageId);
      const liveBlockedPageIds = [...new Set(liveActions
        .filter(action => action.action === 'blocked')
        .map(action => action.pageId))];
      const liveSuggestions = generateInternalLinkSuggestions({
        articleTitle,
        articleText: currentArticleText,
        articleLanguage,
        keywords: keywordValues,
        pages: livePages,
        existingUrls: liveExistingLinks.urls,
        existingAnchors: liveExistingLinks.anchors,
        dismissedPageIds: liveDismissedPageIds,
        blockedPageIds: liveBlockedPageIds,
        currentArticleUrl: currentPageUrl,
        maximumSuggestions: 20,
        qualityPolicy: livePolicy.values,
      });
      const liveSuggestionBudget = calculateInternalLinkSuggestionBudget(
        currentArticleText,
        countExistingAutomaticInventoryLinks(liveExistingLinks.urls, livePages, currentPageUrl),
        livePolicy.values,
        20,
      );
      const liveInventorySignature = createInternalLinkInventorySignature(
        livePages,
        currentPageUrl,
        livePolicy.values,
      );
      const liveRunKey = [
        activeArticleId,
        clientId,
        articleSignature,
        liveInventorySignature,
        livePolicy.policyVersion,
        AUTOMATIC_INTERNAL_LINK_GUARD_VERSION,
      ].join('|');
      const liveInsertions = planAutomaticInternalLinkInsertions({
        editor,
        suggestions: liveSuggestions,
        pages: livePages,
        currentPageUrl,
        qualityPolicy: livePolicy.values,
        maximumInsertions: liveSuggestionBudget,
      });

      if (
        cancelled
        || editor.isDestroyed
        || editor.state.doc !== expectedDocument
        || editor.view.composing
        || !isEditorDocumentActive()
        || Date.now() - lastEditorActivityAtRef.current < AUTOMATION_IDLE_DELAY_MS
      ) return;
      if (liveInsertions.length === 0) {
        latestRunKeyRef.current = liveRunKey;
        return;
      }

      runningRef.current = true;
      const applied = applyAutomaticInternalLinkInsertions(editor, liveInsertions);
      runningRef.current = false;
      if (!applied) {
        return;
      }
      latestRunKeyRef.current = liveRunKey;
      setNotice(
        liveInsertions.length === 1
          ? 'تم إدراج رابط داخلي مؤكد تلقائيًا دون تحريك مؤشر الكتابة.'
          : `تم إدراج ${liveInsertions.length.toLocaleString('ar')} روابط داخلية مؤكدة تلقائيًا.`,
      );

      void recordInternalLinkSuggestionRun({
        articleId: activeArticleId,
        clientId,
        articleSignature,
        inventorySignature: liveInventorySignature,
        currentPageUrl,
        pageCount: livePages.length,
        suggestions: liveSuggestions,
        qualityPolicy: livePolicy,
        suggestionBudget: liveSuggestionBudget,
      }).catch(error => console.warn('Could not audit automatic internal-link scan:', error));

      void Promise.allSettled(liveInsertions.map(insertion => recordInternalLinkAction({
        articleId: activeArticleId,
        clientId,
        suggestion: insertion.suggestion,
        action: 'applied',
        articleSignature,
        applicationMode: 'automatic',
      }))).then(results => {
        if (cancelled) return;
        const recordedActions = results.flatMap(result => (
          result.status === 'fulfilled' ? [result.value] : []
        ));
        setActions(current => [...recordedActions, ...current]);
        const failedAudits = results.filter(result => result.status === 'rejected');
        failedAudits.forEach(result => {
          if (result.status === 'rejected') {
            console.warn('An automatic link was applied but its audit row could not be recorded:', result.reason);
          }
        });
      });
      })();
    }, AUTOMATION_IDLE_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    actions,
    activeArticleId,
    articleLanguage,
    articleText,
    articleTitle,
    automationEnabled,
    canApplyToArticle,
    clientId,
    currentPageUrl,
    editor,
    editorActivityRevision,
    inventoryLoaded,
    isArticleContentSettledForAutomation,
    keywordValues,
    pages,
    qualityPolicy,
    settingsLoaded,
  ]);

  if (!notice) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 z-[120] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-xs font-black text-emerald-700 shadow-xl dark:border-emerald-900/60 dark:bg-[#272727] dark:text-emerald-300"
    >
      <span className="relative inline-flex">
        <Link2 size={17} />
        <CheckCircle2 size={10} className="absolute -bottom-1 -end-1 fill-white dark:fill-[#272727]" />
      </span>
      {notice}
    </div>
  );
};

export default InternalLinkAutomation;
