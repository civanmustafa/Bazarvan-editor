import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  buildClientPageSemanticProfile,
  createClientDictionarySignature,
  isClientSemanticProfileCurrent,
  lightStemArabicToken,
  normalizeSemanticText,
  type ClientLinkDictionaryEntry,
  type ClientSemanticPageInput,
} from '../utils/clientSemanticIndex.ts';
import {
  CLIENT_SEMANTIC_STOP_WORDS,
  CORE_ARABIC_ENGLISH_STOP_WORDS,
  normalizeArabicEnglishText,
} from '../utils/arabicEnglishText.ts';

const root = process.cwd();
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

const page: ClientSemanticPageInput = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  inputUrl: 'https://example.com/services/digital-transformation',
  finalUrl: 'https://example.com/services/digital-transformation',
  canonicalUrl: 'https://example.com/services/digital-transformation',
  pageTitle: 'خدمات التحول الرقمي للشركات',
  metaDescription: 'حلول رقمية لتطوير الأعمال ورفع كفاءة العمليات.',
  h1: 'التحول الرقمي وتطوير الأعمال',
  h2: ['تحسين العمليات الرقمية', 'تجربة العملاء'],
  h3: ['رفع الكفاءة التشغيلية'],
  slug: 'digital-transformation',
  pageLanguage: 'ar',
  contentHash: 'abc123',
  extractedTerms: ['التحول الرقمي', 'تطوير الأعمال', 'الكفاءة التشغيلية'],
  extractedPhrases: ['خدمات التحول الرقمي', 'تحسين تجربة العملاء'],
};

const dictionary = (
  overrides: Partial<ClientLinkDictionaryEntry> = {},
): ClientLinkDictionaryEntry => ({
  id: '33333333-3333-4333-8333-333333333333',
  clientId: page.clientId,
  dictionaryType: 'synonym',
  label: 'التحول الرقمي',
  terms: ['الرقمنة', 'التحول الرقمي'],
  isActive: true,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

test('phase 6 normalizes Arabic and creates light stems deterministically', () => {
  assert.equal(normalizeSemanticText('إدارةُ العَمَلِيَّات'), 'اداره العمليات');
  assert.equal(normalizeSemanticText, normalizeArabicEnglishText);
  assert.equal(CORE_ARABIC_ENGLISH_STOP_WORDS.has(normalizeSemanticText('في')), true);
  assert.equal(CLIENT_SEMANTIC_STOP_WORDS.has(normalizeSemanticText('بعد')), true);
  assert.equal(CORE_ARABIC_ENGLISH_STOP_WORDS.has(normalizeSemanticText('بعد')), false);
  assert.equal(lightStemArabicToken('والعمليات'), lightStemArabicToken('العمليات'));
  assert.equal(
    createClientDictionarySignature([dictionary()]),
    createClientDictionarySignature([dictionary()]),
  );
});

test('phase 6 builds weighted terms, 2-5 word phrases, dictionaries, paths, and completeness', () => {
  const profile = buildClientPageSemanticProfile(page, [
    dictionary(),
    dictionary({
      id: '44444444-4444-4444-8444-444444444444',
      dictionaryType: 'topic',
      label: 'الكفاءة المؤسسية',
      terms: ['العمليات', 'الكفاءة', 'تطوير الأعمال'],
    }),
    dictionary({
      id: '55555555-5555-4555-8555-555555555555',
      dictionaryType: 'excluded_term',
      label: 'كلمات عامة',
      terms: ['حلول'],
    }),
  ], '2026-07-24T00:00:00.000Z');

  assert.equal(profile.profileVersion, 1);
  assert.equal(profile.pageLanguage, 'ar');
  assert.ok(profile.pathSegments.includes('services'));
  assert.ok(profile.weightedTerms.some(term => term.term === 'التحول' && term.weight === 10));
  assert.equal(profile.weightedTerms.some(term => term.term === 'حلول'), false);
  assert.ok(profile.phrases.some(item => item.phrase === 'خدمات التحول الرقمي'));
  assert.ok(profile.phrases.every(item => item.size >= 2 && item.size <= 5));
  assert.ok(profile.lightStems.length > 0);
  assert.ok(profile.dictionaryMatches.some(item => item.type === 'synonym'));
  assert.ok(profile.dictionaryMatches.some(item => item.type === 'topic'));
  assert.ok(profile.completenessScore >= 90);
  assert.ok(profile.documentLength > 0);
});

test('phase 6 current-profile check detects page and dictionary changes', () => {
  const dictionaries = [dictionary()];
  const profile = buildClientPageSemanticProfile(page, dictionaries);
  assert.equal(isClientSemanticProfileCurrent(profile, page, dictionaries), true);
  assert.equal(isClientSemanticProfileCurrent(profile, {
    ...page,
    contentHash: 'changed',
  }, dictionaries), false);
  assert.equal(isClientSemanticProfileCurrent(profile, page, [
    dictionary({ terms: ['الأتمتة', 'الرقمنة'] }),
  ]), false);
});

test('phase 6 migration, UI, crawler, and release gate are wired without AI or Search Console', async () => {
  const [migration, component, utility, worker, store, registry, guide] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260724040000_client_semantic_index.sql'),
    readWorkspaceFile('components/ClientCenterSettings.tsx'),
    readWorkspaceFile('utils/clientCenter.ts'),
    readWorkspaceFile('server/clientPageCrawlWorker.ts'),
    readWorkspaceFile('server/clientSemanticIndexStore.ts'),
    readWorkspaceFile('constants/clientCenter.ts'),
    readWorkspaceFile('deploy/HOSTINGER_CANONICAL_DEPLOY.md'),
  ]);

  for (const table of ['client_link_dictionaries', 'client_page_semantic_profiles']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /dictionary_type in \('synonym', 'topic', 'excluded_term'\)/);
  assert.match(migration, /completeness_score/);
  assert.match(component, /الفهرس والقواميس/);
  assert.match(component, /إعادة بناء الفهرس/);
  assert.match(component, /كلمات مستبعدة من المطابقة/);
  assert.match(utility, /rebuildClientSemanticProfiles/);
  assert.match(worker, /indexCompletedClientPage/);
  assert.match(store, /buildClientPageSemanticProfile/);
  assert.match(registry, /20260724040000_client_semantic_index\.sql/);
  assert.match(guide, /20260724040000_client_semantic_index\.sql/);
  assert.doesNotMatch(
    [migration, component, utility, worker, store].join('\n'),
    /search_console|orphan_page|openai|gemini/i,
  );
});
