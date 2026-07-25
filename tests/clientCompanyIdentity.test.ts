import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildUnifiedCompanyKeywords,
  getClientGoalContext,
  mapNamedGoalContextsToClients,
  resolveCompanyClient,
} from '../utils/clientCompanyIdentity.ts';
import type { ClientCenterClient } from '../utils/clientCenter.ts';
import type { GoalContext } from '../types.ts';

const createClient = (id: string, name: string): ClientCenterClient => ({
  id,
  name,
  legalName: '',
  country: '',
  defaultLanguage: 'ar',
  industry: '',
  companySummary: '',
  isActive: true,
  createdAt: '',
  updatedAt: '',
});

const goalContext = {
  pageType: 'service',
  objective: 'convert',
  targetAudience: 'أصحاب الشركات',
} as GoalContext;

test('client id is the canonical company identity and survives client renaming', () => {
  const client = createClient('client-1', 'الاسم الجديد للشركة');
  const resolved = resolveCompanyClient([client], {
    clientId: 'client-1',
    company: 'الاسم القديم',
  });

  assert.equal(resolved, client);
  assert.deepEqual(
    buildUnifiedCompanyKeywords({
      primary: 'خدمة',
      secondaries: [],
      company: 'الاسم القديم',
      clientId: 'client-1',
      lsi: [],
    }, client),
    {
      primary: 'خدمة',
      secondaries: [],
      company: 'الاسم الجديد للشركة',
      clientId: 'client-1',
      lsi: [],
    },
  );
});

test('legacy company names resolve to the matching Client Center record', () => {
  const client = createClient('client-2', 'شركة بازارفان');

  assert.equal(resolveCompanyClient([client], {
    company: '  شركة بازارفان  ',
  }), client);
});

test('existing article-client links migrate legacy articles to the shared identity', () => {
  const client = createClient('client-linked', 'الاسم المركزي');

  assert.equal(resolveCompanyClient(
    [client],
    { company: 'اسم قديم غير مطابق' },
    'client-linked',
  ), client);
});

test('goal presets prefer client ids and retain legacy name compatibility', () => {
  const client = createClient('client-3', 'شركة قديمة');

  assert.equal(getClientGoalContext({ 'client-3': goalContext }, client), goalContext);
  assert.equal(getClientGoalContext({ 'شركة قديمة': goalContext }, client), goalContext);
  assert.deepEqual(
    mapNamedGoalContextsToClients({ ' شركة قديمة ': goalContext }, [client]),
    { 'client-3': goalContext },
  );
});

test('editor and settings use Client Center as the shared company source', async () => {
  const [
    leftSidebar,
    clientGoals,
    clientCenter,
    goalTab,
    internalLinkingPanel,
    editorContext,
    settingsPage,
    userActivity,
  ] = await Promise.all([
    readFile(new URL('../components/LeftSidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/ClientGoalSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/ClientCenterSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/GoalTab.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/InternalLinkingPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../contexts/EditorContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/SettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../hooks/useUserActivity.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(leftSidebar, /useClientDirectory\(\)/);
  assert.match(leftSidebar, /buildUnifiedCompanyKeywords/);
  assert.match(clientGoals, /handleSaveClientGoalContext\(selectedClient\.id/);
  assert.doesNotMatch(clientGoals, /setCompanyName/);
  assert.match(clientCenter, /اسم العميل \/ الشركة/);
  assert.match(clientCenter, /label="الدومين"/);
  assert.doesNotMatch(clientCenter, /دومينات العميل/);
  assert.match(goalTab, /keywords\.clientId/);
  assert.match(internalLinkingPanel, /buildUnifiedCompanyKeywords/);
  assert.match(editorContext, /saveArticleClientSelection\(savedArticle\.id, keywords\.clientId\)/);
  assert.doesNotMatch(settingsPage, /مستقلة عن سجل العميل/);
  assert.match(userActivity, /clientId\s*=\s*typeof source\.clientId/);
  assert.match(userActivity, /\.\.\.\(clientId \? \{ clientId \} : \{\}\)/);
});
