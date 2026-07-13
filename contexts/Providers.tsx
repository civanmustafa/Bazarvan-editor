import React from 'react';
import { UserProvider } from './UserContext';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <UserProvider>
      {children}
    </UserProvider>
  );
};
