import React from 'react';

type TooltipPlacement = 'top' | 'bottom';

const tooltipPositionClasses: Record<TooltipPlacement, { label: string; arrow: string }> = {
  top: {
    label: 'bottom-full mb-2',
    arrow: 'top-full border-x-[5px] border-t-[5px] border-x-transparent border-t-gray-900',
  },
  bottom: {
    label: 'top-full mt-2',
    arrow: 'bottom-full border-x-[5px] border-b-[5px] border-x-transparent border-b-gray-900',
  },
};

export const IconTooltip: React.FC<{ label: string; placement?: TooltipPlacement }> = ({ label, placement = 'bottom' }) => {
  const position = tooltipPositionClasses[placement];

  return (
    <span
      className={`pointer-events-none absolute left-1/2 ${position.label} z-[1000] -translate-x-1/2 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold leading-none text-white opacity-0 shadow-xl transition-opacity delay-150 duration-150 whitespace-nowrap group-hover:opacity-100 group-focus-visible:opacity-100`}
      role="tooltip"
    >
      {label}
      <span className={`absolute left-1/2 ${position.arrow} -translate-x-1/2`} />
    </span>
  );
};

export const ToolbarButton: React.FC<{ onClick: () => void; title: string; isActive?: boolean; disabled?: boolean; children: React.ReactNode }> = ({ onClick, title, isActive = false, disabled = false, children }) => {
  const baseClasses = 'p-1.5 rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[#1F1F1F] focus:ring-[#d4af37]';
  const stateClasses = isActive
    ? 'bg-[#d4af37]/10 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]'
    : disabled
    ? 'text-gray-400 dark:text-gray-600 bg-transparent cursor-not-allowed'
    : 'text-gray-600 dark:text-gray-300 bg-transparent hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20';

  return (
    <button onClick={onClick} aria-label={title} disabled={disabled} className={`group relative ${baseClasses} ${stateClasses}`}>
      {children}
      <IconTooltip label={title} />
    </button>
  );
};

export const Separator: React.FC = () => <div className="border-s border-gray-300 dark:border-[#3C3C3C] h-5 mx-1"></div>;
