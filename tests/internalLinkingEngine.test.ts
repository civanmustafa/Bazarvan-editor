import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createInternalLinkArticleSignature,
  createInternalLinkInventorySignature,
  generateInternalLinkSuggestions,
  normalizeInternalLinkUrl,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine.ts';
import { buildClientPageSemanticProfile } from '../utils/clientSemanticIndex.ts';
import {
  calculateInternalLinkSuggestionBudget,
  normalizeInternalLinkQualityPolicy,
} from '../utils/internalLinkQualityPolicy.ts';

const root = process.cwd();
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

const articleText = [
  'تساعد خدمات التحول الرقمي الشركات على تطوير الأعمال ورفع كفاءة العمليات.',
  'ويبدأ تحسين تجربة العملاء بفهم الرحلة الرقمية وتبسيط نقاط التواصل.',
].join('\n');

const readyPage = (overrides: Partial<InternalLinkTargetPage> = {}): InternalLinkTargetPage => ({
  id: '11111111-1111-4111-8111-111111111111',
  inputUrl: 'https://example.com/digital-transformation',
  finalUrl: 'https://example.com/digital-transformation',
  canonicalUrl: 'https://example.com/digital-transformation',
  crawlStatus: 'ready',
  pageTitle: 'خدمات التحول الرقمي للشركات',
  metaDescription: 'حلول عملية لتطوير الأعمال وتحسين العمليات وتجربة العملاء.',
  h1: 'التحول الرقمي للشركات',
  h2: ['فوائد التحول الرقمي', 'تحسين تجربة العملاء'],
  h3: ['رفع كفاءة العمليات'],
  slug: 'digital-transformation',
  pageLanguage: 'ar',
  robotsIndex: true,
  extractedTerms: ['التحول الرقمي', 'الشركات', 'تطوير الأعمال', 'كفاءة العمليات'],
  extractedPhrases: ['خدمات التحول الرقمي', 'تحسين تجربة العملاء'],
  isEnabled: true,
  ...overrides,
});

test('deterministic engine proposes a real body anchor with transparent evidence', () => {
  const input = {
    articleTitle: 'دليل التحول الرقمي',
    articleText,
    keywords: ['التحول الرقمي', 'تجربة العملاء'],
    pages: [readyPage()],
  };
  const first = generateInternalLinkSuggestions(input);
  const second = generateInternalLinkSuggestions(input);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.ok(articleText.includes(first[0].anchorText), 'The anchor must exist in the editor body.');
  assert.equal(first[0].targetUrl, 'https://example.com/digital-transformation');
  assert.ok(first[0].score >= 50);
  assert.ok(first[0].matchedTerms.length >= 2);
  assert.ok(first[0].reasons.some(reason => reason.includes('عنوان')));
  assert.ok(first[0].bm25Score > 0);
  assert.equal(first[0].algorithmVersion, 'bm25-quality-v3');
  const anchorWordCount = first[0].anchorText.match(/[A-Za-z0-9\u0600-\u06FF]+/g)?.length || 0;
  assert.ok(anchorWordCount >= 2 && anchorWordCount <= 5);
  assert.equal(first[0].paragraphNumber, 1);
  assert.ok(first[0].alternativeAnchors.includes(first[0].anchorText));
  assert.ok(first[0].alternativeAnchors.every(anchor => articleText.split('\n')[0].includes(anchor)));
  assert.notEqual(first[0].anchorText, input.articleTitle);
});

test('semantic index expands client synonyms and enforces article-page language compatibility', () => {
  const target = readyPage({
    clientId: '22222222-2222-4222-8222-222222222222',
    contentHash: 'content-1',
  });
  target.semanticProfile = buildClientPageSemanticProfile({
    ...target,
    clientId: target.clientId || '',
  }, [{
    id: '33333333-3333-4333-8333-333333333333',
    clientId: target.clientId || '',
    dictionaryType: 'synonym',
    label: 'التحول الرقمي',
    terms: ['التحول الرقمي', 'الرقمنة المؤسسية'],
    isActive: true,
    createdAt: '',
    updatedAt: '',
  }]);

  const synonymText = 'تساعد الرقمنة المؤسسية الشركات على تطوير إجراءاتها وتحسين تجربة العملاء.';
  const suggestions = generateInternalLinkSuggestions({
    articleTitle: 'دليل الرقمنة',
    articleText: synonymText,
    articleLanguage: 'ar',
    pages: [target],
  });
  assert.equal(suggestions.length, 1);
  assert.ok(synonymText.includes(suggestions[0].anchorText));
  assert.ok(suggestions[0].reasons.includes('مطابقة عبر قاموس المرادفات'));
  assert.ok(suggestions[0].completenessScore > 0);

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'Enterprise digitization',
    articleText: 'Enterprise digitization improves customer operations and business services.',
    articleLanguage: 'en',
    pages: [target],
  }), []);
});

test('engine excludes duplicate targets, unsafe page states, and dismissed suggestions', () => {
  const eligible = readyPage();
  const noIndex = readyPage({
    id: '22222222-2222-4222-8222-222222222222',
    inputUrl: 'https://example.com/noindex',
    canonicalUrl: 'https://example.com/noindex',
    robotsIndex: false,
  });
  const disabled = readyPage({
    id: '33333333-3333-4333-8333-333333333333',
    inputUrl: 'https://example.com/disabled',
    canonicalUrl: 'https://example.com/disabled',
    isEnabled: false,
  });
  const failed = readyPage({
    id: '44444444-4444-4444-8444-444444444444',
    inputUrl: 'https://example.com/failed',
    canonicalUrl: 'https://example.com/failed',
    crawlStatus: 'failed',
  });
  const broken = readyPage({
    id: '55555555-5555-4555-8555-555555555555',
    inputUrl: 'https://example.com/broken',
    canonicalUrl: 'https://example.com/broken',
    httpStatus: 404,
  });

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [eligible, noIndex, disabled, failed, broken],
    existingUrls: ['https://EXAMPLE.com/digital-transformation/#section'],
  }), []);

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [eligible],
    currentArticleUrl: eligible.canonicalUrl,
  }), []);

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [eligible],
    blockedPageIds: [eligible.id],
  }), []);

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [eligible],
    dismissedPageIds: [eligible.id],
  }), []);

  assert.equal(
    normalizeInternalLinkUrl('https://EXAMPLE.com/digital-transformation/#section'),
    normalizeInternalLinkUrl('https://example.com/digital-transformation'),
  );
});

test('quality policy rejects generic anchors, shallow relevance, and scores below its threshold', () => {
  const genericPage = readyPage({
    pageTitle: 'اضغط هنا',
    h1: 'اضغط هنا',
    h2: [],
    h3: [],
    metaDescription: '',
    extractedTerms: ['اضغط', 'هنا'],
    extractedPhrases: ['اضغط هنا'],
  });
  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'مقالة تجريبية',
    articleText: 'للوصول إلى التفاصيل يمكنك اضغط هنا ومتابعة المعلومات المنشورة.',
    pages: [genericPage],
  }), []);

  const shallowPage = readyPage({
    pageTitle: 'موضوع بعيد تمامًا',
    h1: 'عنوان آخر',
    h2: [],
    h3: [],
    metaDescription: 'تطوير الأعمال',
    extractedTerms: [],
    extractedPhrases: [],
  });
  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول المؤسسي',
    articleText: 'يساعد تطوير الأعمال الفرق على التخطيط.',
    pages: [shallowPage],
  }), []);

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [readyPage()],
    qualityPolicy: { minimumScore: 100 },
  }), []);
});

test('quality policy derives the remaining link budget and permits a bounded repeated target', () => {
  const longArticle = Array.from({ length: 8 }, () => articleText).join('\n');
  assert.equal(calculateInternalLinkSuggestionBudget(longArticle, 0, {
    maxLinksPer1000Words: 5,
    absoluteMaximumLinks: 20,
  }), 1);
  assert.equal(calculateInternalLinkSuggestionBudget(longArticle, 1, {
    maxLinksPer1000Words: 20,
    absoluteMaximumLinks: 20,
  }), 3);

  const target = readyPage();
  assert.equal(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [target],
    existingUrls: ['https://external.example/reference'],
  }).length, 1, 'External references must not consume the internal-link budget.');

  assert.equal(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText: longArticle,
    pages: [target],
    existingUrls: [target.canonicalUrl || ''],
    qualityPolicy: {
      maximumLinksPerTarget: 2,
      maxLinksPer1000Words: 20,
    },
  }).length, 1);
});

test('article signature is stable and changes when the article body changes', () => {
  const first = createInternalLinkArticleSignature('العنوان', articleText);
  assert.equal(first, createInternalLinkArticleSignature('العنوان', articleText));
  assert.notEqual(first, createInternalLinkArticleSignature('العنوان', `${articleText} إضافة`));
  assert.match(first, /^article_[a-z0-9]+_[a-z0-9]+$/);
});

test('inventory signature is deterministic and changes with the indexed website inventory', () => {
  const page = readyPage();
  const first = createInternalLinkInventorySignature([page]);
  assert.equal(first, createInternalLinkInventorySignature([page]));
  assert.notEqual(first, createInternalLinkInventorySignature([{
    ...page,
    contentHash: 'changed-content',
  }]));
  assert.notEqual(
    first,
    createInternalLinkInventorySignature([page], 'https://example.com/current-article'),
  );
  assert.match(first, /^inventory_[a-z0-9]+_[a-z0-9]+$/);
});

test('phase 7 migration persists the current page, aggregate runs, block, and report actions securely', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724050000_editor_internal_link_suggestions.sql',
  );
  assert.match(migration, /add column if not exists current_page_url/);
  assert.match(migration, /action in \('applied', 'dismissed', 'blocked', 'reported'\)/);
  assert.match(migration, /create table if not exists public\.client_link_suggestion_runs/);
  assert.match(migration, /alter table public\.client_link_suggestion_runs enable row level security/);
  assert.match(migration, /public\.can_write_article\(article_id\)/);
  assert.match(migration, /public\.can_read_client\(client_id\)/);
  assert.match(migration, /grant select, insert on public\.client_link_suggestion_runs to authenticated/);
  assert.doesNotMatch(migration, /grant (?:update|delete)[^;]*client_link_suggestion_runs/i);
  assert.doesNotMatch(migration, /openai|gemini|search_console|orphan_page/i);
});

test('phase 8 stores one global policy and a client override with scoped RLS', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724060000_internal_link_quality_policies.sql',
  );
  assert.match(migration, /create table if not exists public\.internal_link_quality_policies/);
  assert.match(migration, /scope in \('global', 'client'\)/);
  assert.match(migration, /internal_link_quality_policies_one_global_idx/);
  assert.match(migration, /unique \(client_id\)/);
  assert.match(migration, /alter table public\.internal_link_quality_policies enable row level security/);
  assert.match(migration, /public\.can_read_client\(client_id\)/);
  assert.match(migration, /public\.can_edit_client\(client_id\)/);
  assert.match(migration, /scope = 'global' and client_id is null and public\.is_admin\(\)/);
  assert.doesNotMatch(migration, /openai|gemini|search_console|orphan_page/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);

  const normalized = normalizeInternalLinkQualityPolicy({
    minimumScore: 500,
    maxLinksPer1000Words: 0,
    forbiddenAnchors: [],
  });
  assert.equal(normalized.minimumScore, 100);
  assert.equal(normalized.maxLinksPer1000Words, 0.5);
  assert.ok(normalized.forbiddenAnchors.includes('اضغط هنا'));
});

test('phase 4/5 migration stores article-client scope and append-only link actions securely', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724030000_internal_linking_engine.sql',
  );
  for (const table of ['article_client_contexts', 'internal_link_actions']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /public\.can_write_article\(article_id\)/);
  assert.match(migration, /public\.can_read_client\(client_id\)/);
  assert.match(migration, /actor_id = auth\.uid\(\)/);
  assert.match(migration, /action in \('applied', 'dismissed'\)/);
  assert.match(migration, /grant select, insert on public\.internal_link_actions to authenticated/);
  assert.doesNotMatch(migration, /grant (?:update|delete)[^;]*internal_link_actions/i);
  assert.doesNotMatch(migration, /openai|gemini|search_console|orphan_page/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
});

test('editor integration applies native links and does not call an AI provider', async () => {
  const [panel, clientCenter, sidebar, editorContext, registry, releaseScript, guide] = await Promise.all([
    readWorkspaceFile('components/InternalLinkingPanel.tsx'),
    readWorkspaceFile('components/ClientCenterSettings.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('constants/clientCenter.ts'),
    readWorkspaceFile('scripts/checkClientCenterRelease.ts'),
    readWorkspaceFile('deploy/HOSTINGER_CANONICAL_DEPLOY.md'),
  ]);

  assert.match(panel, /generateInternalLinkSuggestions/);
  assert.match(panel, /\.setLink\(/);
  assert.match(panel, /recordInternalLinkAction/);
  assert.match(panel, /findUnlinkedAnchorRange/);
  assert.match(panel, /رابط المقالة الحالية/);
  assert.match(panel, /اختيار نص ربط بديل من الفقرة/);
  assert.match(panel, /نسخ الرابط/);
  assert.match(panel, /منع للمقالة/);
  assert.match(panel, /إبلاغ/);
  assert.match(panel, /recordInternalLinkSuggestionRun/);
  assert.match(panel, /قواعد الجودة المطبقة/);
  assert.match(panel, /loadInternalLinkQualityPolicy/);
  assert.doesNotMatch(panel, /handleAiAnalyze|runGemini|openai/i);
  assert.match(clientCenter, /قواعد جودة الربط الداخلي/);
  assert.match(clientCenter, /حفظ السياسة العامة/);
  assert.match(clientCenter, /استخدام قواعد مخصصة لهذا العميل/);
  assert.match(clientCenter, /saveInternalLinkQualityPolicy/);
  assert.match(sidebar, /InternalLinkingPanel/);
  assert.match(sidebar, /'links'/);
  assert.match(editorContext, /@tiptap\/extension-link/);
  assert.match(editorContext, /Link\.configure/);
  assert.match(registry, /20260724030000_internal_linking_engine\.sql/);
  assert.match(registry, /20260724050000_editor_internal_link_suggestions\.sql/);
  assert.match(registry, /20260724060000_internal_link_quality_policies\.sql/);
  assert.match(registry, /article_client_contexts/);
  assert.match(registry, /internal_link_actions/);
  assert.match(releaseScript, /CLIENT_CENTER_CRAWLING_MIGRATION/);
  assert.match(guide, /20260724030000_internal_linking_engine\.sql/);
  assert.match(guide, /لا يحتاج الترحيل السادس إلى مفتاح ذكاء اصطناعي أو Search Console أو عملية PM2 جديدة/);
});
