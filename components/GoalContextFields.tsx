import React from 'react';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import type { GoalContext } from '../types';
import { useUser } from '../contexts/UserContext';
import {
  getGoalContextFields,
  getGoalContextPresetOptions,
  isGoalContextFieldVisible,
  parseGoalContextMultiValue,
  serializeGoalContextMultiValue,
  SMART_CONTENT_BRIEF_REQUIRED_KEYS,
  type GoalContextFieldConfig,
} from '../utils/goalContext';

type GoalContextFieldsProps = {
  goalContext: GoalContext;
  onChange: (key: keyof GoalContext, value: string) => void;
  className?: string;
};

const fieldClass = 'w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]';
const presetInputClass = 'w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] py-2 pe-8 ps-8 text-sm leading-5 text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]';

type MultiChoiceFieldConfig = Extract<GoalContextFieldConfig, { kind: 'multi-choice' }>;

const GoalContextMultiChoice: React.FC<{
  field: MultiChoiceFieldConfig;
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
  chooseLabel: string;
  selectedLabel: string;
  addLabel: string;
  removeLabel: string;
}> = ({
  field,
  value,
  onChange,
  labelledBy,
  chooseLabel,
  selectedLabel,
  addLabel,
  removeLabel,
}) => {
  const selectedValues = React.useMemo(() => parseGoalContextMultiValue(value), [value]);
  const [customValue, setCustomValue] = React.useState('');
  const selectedSet = React.useMemo(
    () => new Set(selectedValues.map(item => item.toLocaleLowerCase())),
    [selectedValues],
  );

  const updateValues = (values: string[]) => {
    onChange(serializeGoalContextMultiValue(values));
  };

  const toggleOption = (optionValue: string) => {
    const normalizedOption = optionValue.toLocaleLowerCase();
    updateValues(selectedSet.has(normalizedOption)
      ? selectedValues.filter(item => item.toLocaleLowerCase() !== normalizedOption)
      : [...selectedValues, optionValue]);
  };

  const addCustomValue = () => {
    const normalizedCustomValue = customValue.trim();
    if (!normalizedCustomValue) return;
    updateValues([...selectedValues, normalizedCustomValue]);
    setCustomValue('');
  };

  return (
    <div className="space-y-2">
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedValues.map(selectedValue => {
            const option = field.options.find(item => item.value === selectedValue);
            return (
              <span
                key={selectedValue}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-[#d4af37]/30 bg-[#d4af37]/10 px-2 py-1 text-[11px] font-bold text-[#9b7b20] dark:bg-[#d4af37]/20 dark:text-[#f2d675]"
              >
                <span className="truncate">{option?.label || selectedValue}</span>
                <button
                  type="button"
                  onClick={() => toggleOption(selectedValue)}
                  className="flex-shrink-0 rounded-full p-0.5 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40"
                  aria-label={`${removeLabel} ${option?.label || selectedValue}`}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <details
        className="group rounded-md border border-gray-300 bg-white dark:border-[#3C3C3C] dark:bg-[#1F1F1F]"
        aria-labelledby={labelledBy}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-2 text-sm font-semibold text-[#333333] marker:content-none dark:text-[#e0e0e0]">
          <span>
            {selectedValues.length > 0
              ? selectedLabel.replace('{count}', String(selectedValues.length))
              : chooseLabel}
          </span>
          <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-2 border-t border-gray-200 p-2 dark:border-[#3C3C3C]">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {field.options.map(option => {
              const checked = selectedSet.has(option.value.toLocaleLowerCase());
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-2 text-xs font-semibold transition-colors ${
                    checked
                      ? 'border-[#d4af37]/50 bg-[#d4af37]/10 text-[#8b6e1d] dark:bg-[#d4af37]/20 dark:text-[#f2d675]'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#2A2A2A]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOption(option.value)}
                    className="mt-0.5 accent-[#d4af37]"
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
          <div className="flex gap-2 border-t border-gray-200 pt-2 dark:border-[#3C3C3C]">
            <input
              value={customValue}
              onChange={event => setCustomValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustomValue();
                }
              }}
              className={fieldClass}
              placeholder={field.customPlaceholder}
            />
            <button
              type="button"
              onClick={addCustomValue}
              disabled={!customValue.trim()}
              className="inline-flex flex-shrink-0 items-center justify-center rounded-md bg-[#d4af37] px-3 text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={addLabel}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
      </details>
    </div>
  );
};

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
          <div className="absolute z-30 mt-1 max-h-52 w-full min-w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm leading-5 shadow-lg dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            {filteredPresetOptions.length > 0 ? filteredPresetOptions.map(option => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handlePresetSelect(option)}
                className="block w-full whitespace-normal break-words px-3 py-2 text-start text-[#333333] transition-colors hover:bg-[#d4af37]/10 focus:bg-[#d4af37]/10 focus:outline-none dark:text-[#e0e0e0] dark:hover:bg-[#d4af37]/20 dark:focus:bg-[#d4af37]/20"
              >
                {option.label}
              </button>
            )) : (
              <span className="block w-full px-3 py-2 text-gray-400 dark:text-gray-500">{t.goalTab.noReadyContextResults}</span>
            )}
          </div>
        )}
      </label>

      {fields.filter(field => isGoalContextFieldVisible(field, goalContext)).map(field => {
        const fieldId = `goal-context-${field.key}`;
        const fieldLabelId = `${fieldId}-label`;
        return (
          <div key={field.key} className="block">
            <label
              id={fieldLabelId}
              htmlFor={field.kind === 'multi-choice' ? undefined : fieldId}
              className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1"
            >
              {field.label}
              {SMART_CONTENT_BRIEF_REQUIRED_KEYS.includes(field.key) && (
                <span className="ms-1 text-red-500" aria-hidden="true">*</span>
              )}
            </label>
            {field.kind === 'select' ? (
              <select
                id={fieldId}
                value={goalContext[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={fieldClass}
                required={SMART_CONTENT_BRIEF_REQUIRED_KEYS.includes(field.key)}
              >
                <option value="" disabled>{t.goalTab.selectPlaceholder}</option>
                {field.options.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : field.kind === 'multi-choice' ? (
              <GoalContextMultiChoice
                field={field}
                value={goalContext[field.key]}
                onChange={value => onChange(field.key, value)}
                labelledBy={fieldLabelId}
                chooseLabel={t.goalTab.multiChoiceSelect}
                selectedLabel={t.goalTab.multiChoiceSelected}
                addLabel={t.goalTab.multiChoiceAdd}
                removeLabel={t.goalTab.multiChoiceRemove}
              />
            ) : field.kind === 'textarea' ? (
              <textarea
                id={fieldId}
                value={goalContext[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={`${fieldClass} min-h-20 resize-y`}
                placeholder={field.placeholder}
                rows={3}
                required={SMART_CONTENT_BRIEF_REQUIRED_KEYS.includes(field.key)}
              />
            ) : (
              <input
                id={fieldId}
                value={goalContext[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={fieldClass}
                placeholder={field.placeholder}
                required={SMART_CONTENT_BRIEF_REQUIRED_KEYS.includes(field.key)}
              />
            )}
            {field.helpText && (
              <p className="mt-1 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                {field.helpText}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default GoalContextFields;
