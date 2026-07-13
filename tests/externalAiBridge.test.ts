import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildExternalAiPopupFeatures,
  EXTERNAL_AI_BRIDGES,
  EXTERNAL_AI_BRIDGE_PROVIDERS,
} from '../utils/externalAiBridge.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('external AI bridge registry owns ChatGPT and Gemini destinations', () => {
  assert.deepEqual([...EXTERNAL_AI_BRIDGE_PROVIDERS], ['chatgpt', 'gemini']);
  assert.equal(EXTERNAL_AI_BRIDGES.chatgpt.url, 'https://chatgpt.com/');
  assert.equal(EXTERNAL_AI_BRIDGES.gemini.url, 'https://gemini.google.com/app');
  assert.notEqual(EXTERNAL_AI_BRIDGES.chatgpt.windowName, EXTERNAL_AI_BRIDGES.gemini.windowName);
});

test('external AI bridge popup stays inside the available screen', () => {
  const features = buildExternalAiPopupFeatures({
    anchorRect: { width: 380, top: 120 },
    editorRect: { top: 80 },
    availableLeft: 0,
    availableTop: 0,
    availableWidth: 1440,
    availableHeight: 900,
    browserTop: 20,
  });

  assert.match(features, /width=380/);
  assert.match(features, /height=800/);
  assert.match(features, /left=1060/);
  assert.match(features, /top=100/);
});

test('smart analysis uses one external bridge component and one generic importer', async () => {
  const [sidebar, panel, aiContext] = await Promise.all([
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/ExternalAiBridgePanel.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
  ]);

  assert.match(sidebar, /<ExternalAiBridgePanel/);
  assert.doesNotMatch(sidebar, /https:\/\/(?:chatgpt|gemini\.)/);
  assert.match(panel, /EXTERNAL_AI_BRIDGE_PROVIDERS\.map/);
  assert.match(aiContext, /const importManualAiResponse/);
  assert.doesNotMatch(aiContext, /importManualChatGptResponse/);
});
