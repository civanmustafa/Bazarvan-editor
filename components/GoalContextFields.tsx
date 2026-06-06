import React from 'react';
import type { GoalContext } from '../types';
import { useUser } from '../contexts/UserContext';
import { getGoalContextFields, getGoalContextPresetOptions, isGoalContextFieldVisible } from '../utils/goalContext';

type GoalContextFieldsProps = {
  goalContext: GoalContext;
  onChange: (key: keyof GoalContext, value: string) => void;
  className?: string;
};

const fieldClass = 'w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]';

const GoalContextFields: React.FC<GoalContextFieldsProps> = ({
  goalContext,
  onChange,
  className = 'grid grid-cols-1 gap-3',
}) => {
  const { t } = useUser();
  const fields = getGoalContextFields(t.goalTab);
  const presetOptions = getGoalContextPresetOptions(t.goalTab);
  const selectedPreset = presetOptions.find(option => (
    option.context.pageType === goalContext.pageType &&
    option.context.objective === goalContext.objective &&
    option.context.audienceScope === goalContext.audienceScope &&
    option.context.searchIntent === goalContext.searchIntent
  ))?.value || '';

  const handlePresetChange = (presetId: string) => {
    const preset = presetOptions.find(option => option.value === presetId);
    if (!preset) return;

    (['pageType', 'objective', 'audienceScope', 'searchIntent'] as const).forEach(key => {
      onChange(key, preset.context[key]);
    });
  };

  return (
    <div className={className}>
      <label className="block">
        <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{t.goalTab.readyContext}</span>
        <select
          value={selectedPreset}
          onChange={(event) => handlePresetChange(event.target.value)}
          className={fieldClass}
        >
          <option value="">{t.goalTab.chooseReadyContext}</option>
          {presetOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
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
