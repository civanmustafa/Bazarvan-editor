import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const preferencesModule = build({
  entryPoints: [fileURLToPath(new URL('../constants/userAutomation.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
}).then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));

test('personal automation treats false and an empty command selection as explicit choices', async () => {
  const { normalizeUserAutomationPreferences, USER_AUTOMATION_BOOLEAN_KEYS } = await preferencesModule;
  const preferences = normalizeUserAutomationPreferences({
    ...Object.fromEntries(USER_AUTOMATION_BOOLEAN_KEYS.map((key: string) => [key, false])),
    externalAnalysisCommandIds: [],
  });
  for (const key of USER_AUTOMATION_BOOLEAN_KEYS) assert.equal(preferences[key], false);
  assert.deepEqual(preferences.externalAnalysisCommandIds, []);
});

test('an enabled later stage cannot re-enable disabled prerequisites', async () => {
  const { normalizeUserAutomationPreferences } = await preferencesModule;
  const preferences = normalizeUserAutomationPreferences({
    enabled: true,
    autoGenerateAlternativeKeywords: false,
    autoGenerateLsiKeywords: false,
    autoGenerateGoogleMetadata: false,
    autoDiscoverCompetitors: true,
    autoExtractCompetitorContent: false,
    autoRunReadyEngineeringCommands: true,
    contentWritingAutomationEnabled: true,
  });
  assert.equal(preferences.autoDiscoverCompetitors, true);
  assert.equal(preferences.contentWritingAutomationEnabled, true);
  for (const key of ['autoGenerateAlternativeKeywords', 'autoGenerateLsiKeywords', 'autoGenerateGoogleMetadata', 'autoExtractCompetitorContent']) {
    assert.equal(preferences[key], false);
  }
});

test('turning off the master preserves chosen stages and command order for later use', async () => {
  const { normalizeUserAutomationPreferences, USER_AUTOMATION_DEFAULTS } = await preferencesModule;
  const commands = [...USER_AUTOMATION_DEFAULTS.externalAnalysisCommandIds].reverse();
  const preferences = normalizeUserAutomationPreferences({
    enabled: false,
    autoDiscoverCompetitors: true,
    contentWritingAutomationEnabled: true,
    externalAnalysisCommandIds: commands,
  });
  assert.equal(preferences.enabled, false);
  assert.equal(preferences.autoDiscoverCompetitors, true);
  assert.equal(preferences.contentWritingAutomationEnabled, true);
  assert.deepEqual(preferences.externalAnalysisCommandIds, commands);
});

test('command IDs are allowlisted and deduplicated without changing user order', async () => {
  const { normalizeUserAutomationCommandIds, USER_AUTOMATION_DEFAULTS } = await preferencesModule;
  const [first, second] = USER_AUTOMATION_DEFAULTS.externalAnalysisCommandIds;
  assert.deepEqual(normalizeUserAutomationCommandIds([
    ` ${second} `,
    null,
    first,
    second,
    '__proto__',
    'smartAnalysis.competitorGapAnalysis',
    'smartAnalysis.combinedCommands',
    'not-an-engineering-command',
  ]), [second, first]);
  assert.deepEqual(normalizeUserAutomationCommandIds(['invalid-only']), []);
});

test('personal automation accepts only known fields and real booleans', async () => {
  const { normalizeUserAutomationPreferences, USER_AUTOMATION_DEFAULTS, USER_AUTOMATION_SCHEMA_VERSION } = await preferencesModule;
  const preferences = normalizeUserAutomationPreferences({
    enabled: 'false',
    autoDiscoverCompetitors: 0,
    contentWritingAutomationEnabled: 'true',
    schemaVersion: 999,
    userId: 'another-user',
    createdBy: 'another-user',
    quotaUnlimited: true,
    providerAccess: { all: true },
  });
  assert.equal(preferences.enabled, USER_AUTOMATION_DEFAULTS.enabled);
  assert.equal(preferences.autoDiscoverCompetitors, USER_AUTOMATION_DEFAULTS.autoDiscoverCompetitors);
  assert.equal(preferences.contentWritingAutomationEnabled, false);
  assert.equal(preferences.schemaVersion, USER_AUTOMATION_SCHEMA_VERSION);
  for (const key of ['userId', 'createdBy', 'quotaUnlimited', 'providerAccess']) {
    assert.equal(Object.hasOwn(preferences, key), false);
  }
});

test('initializing from configured defaults copies only missing preferences and preserves saved choices', async () => {
  const { normalizeUserAutomationPreferences } = await preferencesModule;
  const defaults = normalizeUserAutomationPreferences({
    enabled: false,
    autoDiscoverCompetitors: false,
    autoGenerateLsiKeywords: false,
    externalAnalysisCommandIds: [],
  });
  const initialized = normalizeUserAutomationPreferences(undefined, defaults);
  assert.deepEqual(initialized, defaults);
  const existing = normalizeUserAutomationPreferences({
    enabled: true,
    autoDiscoverCompetitors: true,
    externalAnalysisCommandIds: [],
  }, defaults);
  assert.equal(existing.enabled, true);
  assert.equal(existing.autoDiscoverCompetitors, true);
  assert.equal(existing.autoGenerateLsiKeywords, false);
  assert.deepEqual(existing.externalAnalysisCommandIds, []);
});

test('normalization cannot mutate shared defaults or a saved fallback snapshot', async () => {
  const { normalizeUserAutomationPreferences, USER_AUTOMATION_DEFAULTS } = await preferencesModule;
  const initialDefaults = structuredClone(USER_AUTOMATION_DEFAULTS);
  const snapshot = normalizeUserAutomationPreferences();
  const snapshotBefore = structuredClone(snapshot);
  const first = normalizeUserAutomationPreferences(undefined, snapshot);
  first.externalAnalysisCommandIds.length = 0;
  first.enabled = false;
  assert.deepEqual(snapshot, snapshotBefore);
  assert.deepEqual(USER_AUTOMATION_DEFAULTS, initialDefaults);
  assert.deepEqual(normalizeUserAutomationPreferences(), initialDefaults);
});
