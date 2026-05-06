import React from 'react';
import { UserProvider, useUser } from './UserContext';
import { EditorProvider } from './EditorContext';
import { InteractionProvider } from './InteractionContext';
import { AIProvider } from './AIContext';
import { ModalProvider } from './ModalContext';

/*
 * Provider dependency order:
 * - UserProvider exposes login, theme, language, API keys, and preferences.
 * - EditorProvider depends on the current user/preferences for drafts and language.
 * - ModalProvider is intentionally outside AI/Interaction so both can open modals.
 * - AIProvider depends on editor state and modal controls.
 * - InteractionProvider depends on editor analysis plus AI fix actions.
 *
 * If a context starts using another context, verify this nesting first.
 */
const AuthenticatedProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentView } = useUser();

  if (currentView === 'login') {
    return <>{children}</>;
  }

  return (
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
};

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <UserProvider>
      <AuthenticatedProviders>
        {children}
      </AuthenticatedProviders>
    </UserProvider>
  );
};
