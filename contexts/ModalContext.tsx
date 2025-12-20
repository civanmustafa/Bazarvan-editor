import React, { useState, useCallback, createContext, useContext } from 'react';

export type ModalType = 'suggestion' | 'headingsAnalysis' | 'apiKeys';

interface ModalContextState {
  modalType: ModalType | null;
  openModal: (type: ModalType) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextState | null>(null);

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider');
  }
  return context;
};

export const ModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [modalType, setModalType] = useState<ModalType | null>(null);

  const openModal = useCallback((type: ModalType) => {
    setModalType(type);
  }, []);

  const closeModal = useCallback(() => {
    setModalType(null);
  }, []);

  const value = {
    modalType,
    openModal,
    closeModal,
  };

  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
};
