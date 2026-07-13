import React from 'react';
import { AIProvider } from './AIContext';
import { EditorProvider } from './EditorContext';
import { InteractionProvider } from './InteractionContext';
import { ModalProvider } from './ModalContext';

// These providers own editor-only state and must never mount on dashboard/admin routes.
export const EditorProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <EditorProvider>
    <ModalProvider>
      <AIProvider>
        <InteractionProvider>
          {children}
        </InteractionProvider>
      </AIProvider>
    </ModalProvider>
  </EditorProvider>
);
