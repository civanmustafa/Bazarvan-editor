import React from 'react';
import { AIProvider } from './AIContext';
import { EditorProvider } from './EditorContext';
import { InteractionProvider } from './InteractionContext';
import { ModalProvider } from './ModalContext';
const DuplicateCleanupProvider = React.lazy(() => import('./DuplicateCleanupProvider'));

// These providers own editor-only state and must never mount on dashboard/admin routes.
export const EditorProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <EditorProvider>
    <ModalProvider>
      <AIProvider>
        <InteractionProvider>
          <React.Suspense fallback={null}>
            <DuplicateCleanupProvider>{children}</DuplicateCleanupProvider>
          </React.Suspense>
        </InteractionProvider>
      </AIProvider>
    </ModalProvider>
  </EditorProvider>
);
