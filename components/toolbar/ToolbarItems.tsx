import React from 'react';

export const ToolbarButton: React.FC<{ onClick: () => void; title: string; isActive?: boolean; disabled?: boolean; children: React.ReactNode }> = ({ onClick, title, isActive = false, disabled = false, children }) => {
  const baseClasses = "p-1.5 rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[#1F1F1F] focus:ring-[#d4af37]";
  const stateClasses = isActive
    ? 'bg-[#d4af37]/10 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]'
    : disabled
    ? 'text-gray-400 dark:text-gray-600 bg-transparent cursor-not-allowed'
    : 'text-gray-600 dark:text-gray-300 bg-transparent hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20';

  return (
    <button onClick={onClick} title={title} disabled={disabled} className={`${baseClasses} ${stateClasses}`}>
      {children}
    </button>
  );
};

export const Separator: React.FC = () => <div className="border-s border-gray-300 dark:border-[#3C3C3C] h-5 mx-1"></div>;
