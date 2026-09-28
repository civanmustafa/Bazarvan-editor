import { createContext, useContext } from 'react';
import type { CleanupSession } from '../utils/duplicateCleanupSession';
import type { UnifiedCleanupControls } from '../hooks/useUnifiedDuplicateCleanup';
export type { CleanupSession } from '../utils/duplicateCleanupSession';

export type CleanupContextValue = {
  sessions: Record<number, CleanupSession>;
  busy: boolean;
  unified?: UnifiedCleanupControls;
  generate: (category: number) => Promise<void>;
  apply: (category: number, ids: string[]) => void;
  skip: (category: number, id: string) => void;
  locate: (category: number, id: string, occurrence?: boolean) => void;
  undo: (category: number) => void;
  stop: () => void;
};
export const CleanupContext = createContext<CleanupContextValue | null>(null);
export const useDuplicateCleanup = () => {
  const value = useContext(CleanupContext);
  if (!value) throw new Error('DuplicateCleanupProvider is missing.');
  return value;
};
