import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createInternalLinkArticleSignature,
  generateInternalLinkSuggestions,
  normalizeInternalLinkUrl,
  type InternalLinkTargetPage,
} from '../utils/internalLinkingEngine.ts';
import { buildClientPageSemanticProfile } from '../utils/clientSemanticIndex.ts';

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
  assert.equal(first[0].algorithmVersion, 'bm25-semantic-v1');
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

  assert.deepEqual(generateInternalLinkSuggestions({
    articleTitle: 'التحول الرقمي',
    articleText,
    pages: [eligible, noIndex, disabled, failed],
    existingUrls: ['https://EXAMPLE.com/digital-transformation/#section'],
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

test('article signature is stable and changes when the article body changes', () => {
  const first = createInternalLinkArticleSignature('العنوان', articleText);
  assert.equal(first, createInternalLinkArticleSignature('العنوان', articleText));
  assert.notEqual(first, createInternalLinkArticleSignature('العنوان', `${articleText} إضافة`));
  assert.match(first, /^article_[a-z0-9]+_[a-z0-9]+$/);
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
  const [panel, sidebar, editorContext, registry, releaseScript, guide] = await Promise.all([
    readWorkspaceFile('components/InternalLinkingPanel.tsx'),
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
  assert.doesNotMatch(panel, /handleAiAnalyze|runGemini|openai/i);
  assert.match(sidebar, /InternalLinkingPanel/);
  assert.match(sidebar, /'links'/);
  assert.match(editorContext, /@tiptap\/extension-link/);
  assert.match(editorContext, /Link\.configure/);
  assert.match(registry, /20260724030000_internal_linking_engine\.sql/);
  assert.match(registry, /article_client_contexts/);
  assert.match(registry, /internal_link_actions/);
  assert.match(releaseScript, /CLIENT_CENTER_CRAWLING_MIGRATION/);
  assert.match(guide, /20260724030000_internal_linking_engine\.sql/);
  assert.match(guide, /لا يحتاج الترحيل الرابع إلى مفتاح ذكاء اصطناعي أو Search Console أو عملية PM2 جديدة/);
});
