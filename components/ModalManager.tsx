
import React from 'react';
import { useModal } from '../contexts/ModalContext';
import SuggestionModal from './SuggestionModal';
import HeadingsAnalysisModal from './HeadingsAnalysisModal';
import ApiKeysModal from './ApiKeysModal';

const MODALS = {
  suggestion: SuggestionModal,
  headingsAnalysis: HeadingsAnalysisModal,
  apiKeys: ApiKeysModal,
};

const ModalManager: React.FC = () => {
  const { modalType } = useModal();

  if (!modalType) {
    return null;
  }

  const SpecificModal = MODALS[modalType as keyof typeof MODALS];

  return <SpecificModal />;
};

export default ModalManager;
