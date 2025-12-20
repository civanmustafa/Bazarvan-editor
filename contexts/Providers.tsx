import React from 'react';
import { UserProvider } from './UserContext';
import { EditorProvider } from './EditorContext';
import { InteractionProvider } from './InteractionContext';
import { AIProvider } from './AIContext';
import { ModalProvider } from './ModalContext';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <UserProvider>
      <EditorProvider>
        <ModalProvider>
          <AIProvider>
            <InteractionProvider>
              {children}
            </InteractionProvider>
          </AIProvider>
        </ModalProvider>
      </EditorProvider>
    </UserProvider>
  );
};
