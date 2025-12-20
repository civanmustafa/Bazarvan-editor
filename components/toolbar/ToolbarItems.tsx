import React from 'react';

export const ToolbarButton: React.FC<{ onClick: () => void; title: string; isActive?: boolean; disabled?: boolean; children: React.ReactNode }> = ({ onClick, title, isActive = false, disabled = false, children }) => {
  const baseClasses = "p-1.5 rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[#1F1F1F] focus:ring-[#00778e]";
  const stateClasses = isActive
    ? 'bg-[#00778e]/10 text-[#00778e] dark:bg-[#0078d4]/20 dark:text-[#94d2bd]'
    : disabled
    ? 'text-gray-400 dark:text-gray-600 bg-transparent cursor-not-allowed'
    : 'text-gray-600 dark:text-gray-300 bg-transparent hover:bg-gray-200 dark:hover:bg-[#3C3C3C]';

  return (
    <button onClick={onClick} title={title} disabled={disabled} className={`${baseClasses} ${stateClasses}`}>
      {children}
    </button>
  );
};

export const Separator: React.FC = () => <div className="border-s border-gray-300 dark:border-[#3C3C3C] h-5 mx-1"></div>;
