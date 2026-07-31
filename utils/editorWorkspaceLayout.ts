export const EDITOR_WORKSPACE_LAYOUT = {
  leftSidebarExpandedPercent: 20.57,
  editorBasePercent: 60.73,
  rightSidebarExpandedPercent: 18.7,
  collapsedSidebarWidthRem: 3,
  visiblePeerShare: 0.05,
} as const;

type ExpandedSidebarFlexBasisInput = {
  basePercent: number;
  peerExpandedPercent: number;
  peerCollapsed: boolean;
};

/**
 * Gives the still-expanded sidebar 5% of the width released by its collapsed
 * peer. The editor's flexible column receives the remaining 95% automatically.
 */
export const getExpandedSidebarFlexBasis = ({
  basePercent,
  peerExpandedPercent,
  peerCollapsed,
}: ExpandedSidebarFlexBasisInput): string => {
  if (!peerCollapsed) return `${basePercent}%`;

  const transferredPercent = Number((
    peerExpandedPercent * EDITOR_WORKSPACE_LAYOUT.visiblePeerShare
  ).toFixed(4));
  const transferredRailRem = Number((
    EDITOR_WORKSPACE_LAYOUT.collapsedSidebarWidthRem * EDITOR_WORKSPACE_LAYOUT.visiblePeerShare
  ).toFixed(4));
  const nextBasePercent = Number((basePercent + transferredPercent).toFixed(4));

  return `calc(${nextBasePercent}% - ${transferredRailRem}rem)`;
};
