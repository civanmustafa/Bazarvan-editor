import React from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { GoalContext } from '../types';
import { useUser } from '../contexts/UserContext';
import { getGoalContextFields, getGoalContextPresetOptions, isGoalContextFieldVisible } from '../utils/goalContext';

type GoalContextFieldsProps = {
  goalContext: GoalContext;
  onChange: (key: keyof GoalContext, value: string) => void;
  className?: string;
};

const fieldClass = 'w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]';
const presetInputClass = 'w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] py-1.5 pe-8 ps-8 text-xs text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]';

const GoalContextFields: React.FC<GoalContextFieldsProps> = ({
  goalContext,
  onChange,
  className = 'grid grid-cols-1 gap-3',
}) => {
  const { t } = useUser();
  const fields = getGoalContextFields(t.goalTab);
  const presetOptions = getGoalContextPresetOptions(t.goalTab);
  const [presetSearch, setPresetSearch] = React.useState('');
  const [isPresetOpen, setIsPresetOpen] = React.useState(false);
  const selectedPresetOption = presetOptions.find(option => (
    option.context.pageType === goalContext.pageType &&
    option.context.objective === goalContext.objective &&
    option.context.audienceScope === goalContext.audienceScope &&
    option.context.searchIntent === goalContext.searchIntent
  ));
  const normalizeSearch = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedPresetSearch = normalizeSearch(presetSearch);
  const filteredPresetOptions = React.useMemo(() => {
    if (!normalizedPresetSearch) return presetOptions;
    return presetOptions.filter(option => (
      normalizeSearch(option.searchText).includes(normalizedPresetSearch)
    ));
  }, [normalizedPresetSearch, presetOptions]);

  React.useEffect(() => {
    setPresetSearch(selectedPresetOption?.label || '');
  }, [selectedPresetOption?.value, selectedPresetOption?.label]);

  const handlePresetSelect = (preset: (typeof presetOptions)[number]) => {
    (['pageType', 'objective', 'audienceScope', 'searchIntent'] as const).forEach(key => {
      onChange(key, preset.context[key]);
    });
    setPresetSearch(preset.label);
    setIsPresetOpen(false);
  };

  return (
    <div className={className}>
      <label
        className="relative block"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsPresetOpen(false);
          }
        }}
      >
        <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{t.goalTab.readyContext}</span>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={presetSearch}
            onChange={(event) => {
              setPresetSearch(event.target.value);
              setIsPresetOpen(true);
            }}
            onFocus={() => setIsPresetOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && filteredPresetOptions[0]) {
                event.preventDefault();
                handlePresetSelect(filteredPresetOptions[0]);
              }
              if (event.key === 'Escape') {
                setIsPresetOpen(false);
              }
            }}
            className={presetInputClass}
            placeholder={t.goalTab.chooseReadyContext}
            role="combobox"
            aria-expanded={isPresetOpen}
          />
          <ChevronDown size={14} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
        {isPresetOpen && (
          <div className="absolute z-30 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-[11px] shadow-lg dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            {filteredPresetOptions.length > 0 ? filteredPresetOptions.map(option => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handlePresetSelect(option)}
                className="block w-full px-2 py-1.5 text-start text-[#333333] transition-colors hover:bg-[#d4af37]/10 focus:bg-[#d4af37]/10 focus:outline-none dark:text-[#e0e0e0] dark:hover:bg-[#d4af37]/20 dark:focus:bg-[#d4af37]/20"
              >
                {option.label}
              </button>
            )) : (
              <span className="block px-2 py-1.5 text-gray-400 dark:text-gray-500">{t.goalTab.noReadyContextResults}</span>
            )}
          </div>
        )}
      </label>

      {fields.filter(field => isGoalContextFieldVisible(field, goalContext)).map(field => (
        <label key={field.key} className="block">
          <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{field.label}</span>
          {field.kind === 'select' ? (
            <select
              value={goalContext[field.key]}
              onChange={(event) => onChange(field.key, event.target.value)}
              className={fieldClass}
            >
              {field.options.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              value={goalContext[field.key]}
              onChange={(event) => onChange(field.key, event.target.value)}
              className={fieldClass}
              placeholder={field.placeholder}
            />
          )}
        </label>
      ))}
    </div>
  );
};

export default GoalContextFields;
