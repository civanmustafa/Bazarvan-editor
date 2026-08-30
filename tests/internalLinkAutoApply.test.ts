import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  applyAutomaticInternalLinkInsertions,
  countExistingAutomaticInventoryLinks,
  findBoundedAnchorOccurrences,
  isAutomaticInternalLinkSuggestionEligible,
  planAutomaticInternalLinkInsertions,
} from '../utils/internalLinkAutoApply.ts';
import type {
  InternalLinkSuggestion,
  InternalLinkTargetPage,
} from '../utils/internalLinkingEngine.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const createPage = (overrides: Partial<InternalLinkTargetPage> = {}): InternalLinkTargetPage => ({
  id: 'page-target',
  clientId: 'client-1',
  inputUrl: 'https://example.com/digital-transformation',
  finalUrl: 'https://example.com/digital-transformation',
  canonicalUrl: 'https://example.com/digital-transformation',
  crawlStatus: 'ready',
  httpStatus: 200,
  pageTitle: 'دليل التحول الرقمي',
  h1: 'التحول الرقمي للشركات',
  robotsIndex: true,
  isEnabled: true,
  allowedDomains: [{ hostname: 'example.com', includeSubdomains: false }],
  ...overrides,
});

const createSuggestion = (
  overrides: Partial<InternalLinkSuggestion> = {},
): InternalLinkSuggestion => ({
  pageId: 'page-target',
  targetUrl: 'https://example.com/digital-transformation',
  targetTitle: 'دليل التحول الرقمي',
  anchorText: 'التحول الرقمي',
  score: 96,
  scoreMargin: 20,
  confidence: 'strong',
  matchedTerms: ['التحول', 'الرقمي', 'الشركات'],
  reasons: ['تطابق مع عنوان الصفحة', 'عبارة دلالية متطابقة'],
  sourceExcerpt: 'يساعد التحول الرقمي الشركات على تحسين عملياتها.',
  paragraphNumber: 1,
  alternativeAnchors: ['التحول الرقمي'],
  anchorMatchSources: ['title'],
  bm25Score: 4.2,
  completenessScore: 92,
  algorithmVersion: 'bm25-ai-phrases-v4',
  ...overrides,
});

const createEditor = async (content: Record<string, unknown>) => {
  const browser = parseHTML('<html><head></head><body></body></html>');
  const selectionStub: Selection = {
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    rangeCount: 0,
    isCollapsed: true,
    addRange: (): void => undefined,
    collapse: (): void => undefined,
    collapseToEnd: (): void => undefined,
    collapseToStart: (): void => undefined,
    containsNode: (): boolean => false,
    deleteFromDocument: (): void => undefined,
    empty: (): void => undefined,
    extend: (): void => undefined,
    getRangeAt: (): Range => browser.document.createRange() as unknown as Range,
    removeAllRanges: (): void => undefined,
    removeRange: (): void => undefined,
    selectAllChildren: (): void => undefined,
    setBaseAndExtent: (): void => undefined,
    setPosition: (): void => undefined,
    toString: (): string => '',
  } as unknown as Selection;
  Object.defineProperty(browser.window, 'getSelection', {
    configurable: true,
    value: () => selectionStub,
  });
  Object.defineProperty(browser.document, 'getSelection', {
    configurable: true,
    value: () => selectionStub,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: browser.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: browser.document,
  });
  const [{ Editor }, { default: StarterKit }, { default: Link }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-link'),
  ]);
  return new Editor({
    extensions: [StarterKit.configure({ link: false }), Link],
    content,
    injectCSS: false,
  });
};

const paragraphContent = (text: string) => ({
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [{ type: 'text', text }],
  }],
});

test('automatic anchors require Unicode word boundaries', () => {
  assert.deepEqual(
    findBoundedAnchorOccurrences('«التحول الرقمي»، مهم.', 'التحول الرقمي'),
    [{ from: 1, to: 14 }],
  );
  assert.deepEqual(
    findBoundedAnchorOccurrences('بالتحول الرقمي نبدأ.', 'التحول الرقمي'),
    [],
  );
  assert.deepEqual(
    findBoundedAnchorOccurrences('predigital marketing differs', 'digital marketing'),
    [],
  );
});

test('automatic eligibility is fail-closed behind strict certainty gates', () => {
  const page = createPage();
  const base = {
    suggestion: createSuggestion(),
    page,
    currentPageUrl: 'https://example.com/current-article',
  };
  assert.equal(isAutomaticInternalLinkSuggestionEligible(base), true);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    suggestion: createSuggestion({ score: 89 }),
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    suggestion: createSuggestion({ scoreMargin: 11 }),
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({ ...base, currentPageUrl: '' }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    suggestion: createSuggestion({
      reasons: ['تطابق مع عنوان الصفحة'],
      anchorMatchSources: ['description'],
    }),
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    currentPageUrl: 'http://example.com/digital-transformation?preview=1',
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    page: createPage({ isEnabled: false }),
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    page: createPage({ robotsIndex: false }),
  }), false);
  assert.equal(isAutomaticInternalLinkSuggestionEligible({
    ...base,
    suggestion: createSuggestion({
      reasons: ['تطابق مع العبارة الأساسية المعتمدة للصفحة'],
      anchorMatchSources: ['ai_primary'],
    }),
    page: createPage({
      aiLinkProfile: {
        pageId: 'page-target',
        clientId: 'client-1',
        profileVersion: 1,
        sourceSignature: 'source',
        generationStatus: 'ready',
        reviewStatus: 'pending',
        primaryPhrase: 'التحول الرقمي',
        alternativePhrases: [],
        longTailPhrases: [],
        relatedEntities: [],
        negativePhrases: [],
        pageIntent: 'informational',
        confidence: 100,
        provider: 'gemini',
        model: 'model',
        errorCode: '',
        errorMessage: '',
        generatedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: '',
        updatedAt: '',
      },
    }),
  }), false);
});

test('TipTap applies one certain contextual link without moving the selection or duplicating it', async () => {
  const editor = await createEditor(paragraphContent(
    'يساعد التحول الرقمي الشركات على تحسين عملياتها.',
  ));
  try {
    const selectionBefore = editor.state.selection;
    const input = {
      editor,
      suggestions: [createSuggestion()],
      pages: [createPage()],
      currentPageUrl: 'https://example.com/current-article',
    };
    const insertions = planAutomaticInternalLinkInsertions(input);
    assert.equal(insertions.length, 1);
    assert.equal(applyAutomaticInternalLinkInsertions(editor, insertions), true);
    assert.equal(editor.state.selection.from, selectionBefore.from);
    assert.equal(editor.state.selection.to, selectionBefore.to);

    const linkedText = (editor.getJSON().content?.[0] as any)?.content
      ?.find((node: any) => node.marks?.some((mark: any) => mark.type === 'link'));
    assert.equal(linkedText?.text, 'التحول الرقمي');
    assert.equal(
      linkedText?.marks?.find((mark: any) => mark.type === 'link')?.attrs?.href,
      'https://example.com/digital-transformation',
    );
    assert.equal(planAutomaticInternalLinkInsertions(input).length, 0);
  } finally {
    editor.destroy();
  }
});

test('automatic planning rejects ambiguous, substring, heading, and unsafe targets', async () => {
  const ambiguousEditor = await createEditor(paragraphContent(
    'التحول الرقمي مهم، ويستمر التحول الرقمي في التطور.',
  ));
  const substringEditor = await createEditor(paragraphContent(
    'بالتحول الرقمي تبدأ الخطة.',
  ));
  const headingEditor = await createEditor({
    type: 'doc',
    content: [{
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'التحول الرقمي' }],
    }],
  });
  const inlineCodeEditor = await createEditor({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'يساعد ' },
        { type: 'text', text: 'التحول الرقمي', marks: [{ type: 'code' }] },
        { type: 'text', text: ' الشركات على تحسين عملياتها.' },
      ],
    }],
  });
  const trackedExistingLinkEditor = await createEditor({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'صفحة سابقة',
          marks: [{
            type: 'link',
            attrs: { href: '/legacy-digital?utm_source=old' },
          }],
        },
        { type: 'text', text: '، ويساعد التحول الرقمي الشركات على تحسين عملياتها.' },
      ],
    }],
  });
  try {
    const common = {
      suggestions: [createSuggestion()],
      pages: [createPage()],
      currentPageUrl: 'https://example.com/current-article',
    };
    assert.equal(planAutomaticInternalLinkInsertions({ editor: ambiguousEditor, ...common }).length, 0);
    assert.equal(planAutomaticInternalLinkInsertions({
      editor: substringEditor,
      ...common,
      suggestions: [createSuggestion({ sourceExcerpt: 'بالتحول الرقمي تبدأ الخطة.' })],
    }).length, 0);
    assert.equal(planAutomaticInternalLinkInsertions({
      editor: headingEditor,
      ...common,
      suggestions: [createSuggestion({ sourceExcerpt: 'التحول الرقمي' })],
    }).length, 0);
    assert.equal(planAutomaticInternalLinkInsertions({ editor: inlineCodeEditor, ...common }).length, 0);
    assert.equal(planAutomaticInternalLinkInsertions({
      editor: trackedExistingLinkEditor,
      ...common,
      pages: [createPage({ finalUrl: 'https://example.com/legacy-digital' })],
      suggestions: [createSuggestion({ paragraphNumber: 1 })],
    }).length, 0);
    assert.equal(countExistingAutomaticInventoryLinks(
      ['/legacy-digital?utm_source=old'],
      [createPage({ finalUrl: 'https://example.com/legacy-digital' })],
      'https://example.com/current-article',
    ), 1);
    ambiguousEditor.commands.setTextSelection(8);
    assert.equal(planAutomaticInternalLinkInsertions({
      editor: ambiguousEditor,
      ...common,
      suggestions: [createSuggestion({
        sourceExcerpt: 'التحول الرقمي مهم، ويستمر التحول الرقمي في التطور.',
        anchorText: 'التحول الرقمي مهم',
      })],
    }).length, 0);
    assert.equal(isAutomaticInternalLinkSuggestionEligible({
      suggestion: createSuggestion({ targetUrl: 'javascript:alert(1)' }),
      page: createPage({
        canonicalUrl: 'javascript:alert(1)',
        finalUrl: 'javascript:alert(1)',
        inputUrl: 'javascript:alert(1)',
      }),
      currentPageUrl: 'https://example.com/current-article',
    }), false);
  } finally {
    ambiguousEditor.destroy();
    substringEditor.destroy();
    headingEditor.destroy();
    inlineCodeEditor.destroy();
    trackedExistingLinkEditor.destroy();
  }
});

test('administrator setting, narrow authenticated API, toolbar placement, and migration are wired', async () => {
  const [
    settingsPage,
    utilityActions,
    api,
    serverSettings,
    routeRegistry,
    migration,
    automation,
    editorContext,
    sidebar,
    engine,
  ] = await Promise.all([
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('components/toolbar/UtilityActions.tsx'),
    readWorkspaceFile('api/internalLinkingSettings.ts'),
    readWorkspaceFile('server/internalLinkingSettings.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('supabase/migrations/20260830020000_automatic_internal_link_insertion.sql'),
    readWorkspaceFile('components/InternalLinkAutomation.tsx'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('utils/internalLinkingEngine.ts'),
  ]);
  assert.match(settingsPage, /autoApplyStrongInternalLinkSuggestions/);
  assert.match(settingsPage, /تفضيلات المنشئ/);
  assert.match(serverSettings, /readArticleAutomationPolicy\(input.articleId\)/);
  assert.match(utilityActions, /onToggleToc[\s\S]*openInternalLinking/);
  assert.match(api, /authenticateApiRequest/);
  assert.match(api, /articleId/);
  assert.doesNotMatch(api, /assertAdmin/);
  assert.match(serverSettings, /article_access_level_for_user/);
  assert.match(serverSettings, /canApplyToArticle/);
  assert.match(routeRegistry, /\/api\/internal-linking\/settings/);
  assert.match(migration, /jsonb_typeof[\s\S]*autoApplyStrongInternalLinkSuggestions/);
  assert.match(migration, /else true/);
  assert.doesNotMatch(migration, /create policy|grant select[^;]*app_settings/i);
  assert.match(automation, /applicationMode: 'automatic'/);
  assert.match(automation, /editor\.state\.doc !== expectedDocument/);
  assert.match(automation, /isArticleContentSettledForAutomation/);
  assert.match(automation, /loadInternalLinkTargetPages\(clientId\)/);
  assert.match(automation, /document\.visibilityState === 'visible'/);
  assert.match(editorContext, /await refreshArticleFromRemoteInBackground/);
  assert.match(sidebar, /lastHandledRequestedTabNonceRef/);
  assert.match(engine, /anchorMatchSources/);
});
