
import React from 'react';
import { useModal } from '../contexts/ModalContext';

const SuggestionModal = React.lazy(() => import('./SuggestionModal'));
const HeadingsAnalysisModal = React.lazy(() => import('./HeadingsAnalysisModal'));

// Register every ModalContext modal type here so rendering stays centralized.
const MODALS = {
  suggestion: SuggestionModal,
  headingsAnalysis: HeadingsAnalysisModal,
};

const ModalManager: React.FC = () => {
  const { modalType } = useModal();

  if (!modalType) {
    return null;
  }

  const SpecificModal = MODALS[modalType as keyof typeof MODALS];

  return (
    <React.Suspense fallback={null}>
      <SpecificModal />
    </React.Suspense>
  );
};

export default ModalManager;
