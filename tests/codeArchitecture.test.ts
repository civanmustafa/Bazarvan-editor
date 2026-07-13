import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { readRequestBody, toWebResponse } from '../api/http.ts';

const workspaceUrl = (relativePath: string): URL => new URL(`../${relativePath}`, import.meta.url);
const readWorkspaceFile = (relativePath: string): Promise<string> => readFile(workspaceUrl(relativePath), 'utf8');

const assertFileMissing = async (relativePath: string): Promise<void> => {
  await assert.rejects(
    access(workspaceUrl(relativePath)),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    `${relativePath} should remain deleted`,
  );
};

test('development and production use one API route registry', async () => {
  const [registry, viteConfig, productionServer] = await Promise.all([
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('vite.config.ts'),
    readWorkspaceFile('server/server.ts'),
  ]);
  const expectedPaths = [
    '/api/gemini/progress/:progressId/cancel',
    '/api/gemini/progress/:progressId',
    '/api/gemini',
    '/api/chatgpt',
    '/api/n8n/articles',
    '/api/articles/save',
    '/api/external-analysis',
    '/api/articles/assigned-automation',
    '/api/system/settings',
    '/api/admin/users',
  ];

  expectedPaths.forEach(path => assert.ok(registry.includes(`path: '${path}'`), `Missing route ${path}`));
  assert.match(viteConfig, /findApiRoute\(url\.pathname/);
  assert.match(productionServer, /API_ROUTES\.forEach/);
  assert.doesNotMatch(viteConfig, /new Map<string, ApiHandler>/);
  assert.doesNotMatch(productionServer, /app\.all\('\/api\//);
});

test('API handlers share the same HTTP request and response adapters', async () => {
  const handlerFiles = [
    'api/adminUsers.ts',
    'api/articlesSave.ts',
    'api/assignedArticleAutomation.ts',
    'api/chatgpt.ts',
    'api/externalAnalysis.ts',
    'api/n8nArticles.ts',
    'api/systemSettings.ts',
  ];
  const handlers = await Promise.all(handlerFiles.map(readWorkspaceFile));

  handlers.forEach((source, index) => {
    assert.match(source, /from ['"]\.\/http\.ts['"]/, `${handlerFiles[index]} must import api/http`);
    assert.doesNotMatch(source, /const readNodeBody\s*=/);
    assert.doesNotMatch(source, /const toWebResponse\s*=/);
    assert.doesNotMatch(source, /const sendNodeResponse\s*=/);
  });
});

test('shared HTTP adapters preserve Web and Node request semantics', async () => {
  const webRequest = new Request('https://editor.example.com/api/example', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'web' }),
  });
  const nodeRequest = {
    body: Buffer.from(JSON.stringify({ source: 'node' })),
  };

  assert.deepEqual(await readRequestBody(webRequest), { source: 'web' });
  assert.deepEqual(await readRequestBody(nodeRequest), { source: 'node' });

  const response = toWebResponse({
    status: 201,
    body: { ok: true },
    headers: { 'X-Test-Header': 'shared' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-test-header'), 'shared');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await toWebResponse({ status: 204 }).text(), '');
});

test('legacy browser API key and unreachable settings paths stay removed', async () => {
  const [userContext, aiContext, userActivity, adminApp] = await Promise.all([
    readWorkspaceFile('contexts/UserContext.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('hooks/useUserActivity.ts'),
    readWorkspaceFile('components/AdminApp.tsx'),
  ]);

  assert.doesNotMatch(userContext, /\bapiKeys\b|handleSaveApiKeys|saveUserApiKeys/);
  assert.doesNotMatch(aiContext, /\bapiKeys\b|normalizeGeminiKeys|normalizeChatGptKeys/);
  assert.doesNotMatch(userActivity, /geminiKeyUsage|recordGeminiKeyUsage/);
  assert.doesNotMatch(adminApp, /AdminSettingsPage|AdminSettingsSection/);

  await Promise.all([
    assertFileMissing('components/ApiKeysModal.tsx'),
    assertFileMissing('contexts/AppContext.tsx'),
    assertFileMissing('utils/api.ts'),
    assertFileMissing('utils/analysis/rules/checkTableListOpportunities.ts'),
  ]);
});

test('repository quality gate covers types, tests, build, and security checks', async () => {
  const [packageSource, tsconfigSource, workflow] = await Promise.all([
    readWorkspaceFile('package.json'),
    readWorkspaceFile('tsconfig.json'),
    readWorkspaceFile('.github/workflows/quality-gates.yml'),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts?: Record<string, string>;
  };
  const tsconfig = JSON.parse(tsconfigSource) as {
    compilerOptions?: Record<string, unknown>;
  };
  const scripts = packageJson.scripts || {};
  const compilerOptions = tsconfig.compilerOptions || {};

  ['check:secrets', 'check:dependencies', 'typecheck', 'test', 'build', 'check:bundle']
    .forEach(scriptName => assert.match(scripts.verify || '', new RegExp(`npm run ${scriptName.replace(':', '\\:')}`)));
  assert.match(scripts['check:dependencies'] || '', /npm audit/);
  assert.equal(compilerOptions.noImplicitAny, true);
  assert.equal(compilerOptions.strictBindCallApply, true);
  assert.equal(compilerOptions.strictFunctionTypes, true);
  assert.equal(compilerOptions.noImplicitThis, true);
  assert.equal(compilerOptions.useUnknownInCatchVariables, true);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
});
