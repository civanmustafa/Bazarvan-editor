import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  EDITOR_WORKSPACE_LAYOUT,
  getExpandedSidebarFlexBasis,
} from '../utils/editorWorkspaceLayout.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('an expanded sidebar receives 5% of the width released by its collapsed peer', () => {
  assert.equal(EDITOR_WORKSPACE_LAYOUT.visiblePeerShare, 0.05);
  assert.equal(getExpandedSidebarFlexBasis({
    basePercent: EDITOR_WORKSPACE_LAYOUT.rightSidebarExpandedPercent,
    peerExpandedPercent: EDITOR_WORKSPACE_LAYOUT.leftSidebarExpandedPercent,
    peerCollapsed: true,
  }), 'calc(19.7285% - 0.15rem)');
  assert.equal(getExpandedSidebarFlexBasis({
    basePercent: EDITOR_WORKSPACE_LAYOUT.leftSidebarExpandedPercent,
    peerExpandedPercent: EDITOR_WORKSPACE_LAYOUT.rightSidebarExpandedPercent,
    peerCollapsed: true,
  }), 'calc(21.505% - 0.15rem)');
  assert.equal(getExpandedSidebarFlexBasis({
    basePercent: EDITOR_WORKSPACE_LAYOUT.leftSidebarExpandedPercent,
    peerExpandedPercent: EDITOR_WORKSPACE_LAYOUT.rightSidebarExpandedPercent,
    peerCollapsed: false,
  }), '20.57%');
});

test('editor sidebars consume the calculated basis while the editor remains the flexible column', async () => {
  const [editorApp, leftSidebar, rightSidebar] = await Promise.all([
    readWorkspaceFile('components/EditorApp.tsx'),
    readWorkspaceFile('components/LeftSidebar.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
  ]);

  assert.match(editorApp, /expandedFlexBasis=\{leftSidebarFlexBasis\}/);
  assert.match(editorApp, /expandedFlexBasis=\{rightSidebarFlexBasis\}/);
  assert.match(editorApp, /flex-1 basis-\[60\.73%\]/);
  assert.match(leftSidebar, /style=\{collapsed \|\| !expandedFlexBasis \? undefined : \{ flexBasis: expandedFlexBasis \}\}/);
  assert.match(rightSidebar, /style=\{collapsed \|\| !expandedFlexBasis \? undefined : \{ flexBasis: expandedFlexBasis \}\}/);
});
