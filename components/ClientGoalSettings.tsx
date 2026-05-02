import React, { useMemo, useState } from 'react';
import { Save, Trash2, Upload, Users } from 'lucide-react';
import { INITIAL_GOAL_CONTEXT } from '../constants';
import { useUser } from '../contexts/UserContext';
import type { GoalContext } from '../types';
import GoalContextFields from './GoalContextFields';
import { normalizeGoalContext, parseClientGoalContextBulk } from '../utils/goalContext';

const inputClass = 'w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500';

const ClientGoalSettings: React.FC = () => {
  const {
    clientGoalContexts,
    handleSaveClientGoalContext,
    handleDeleteClientGoalContext,
    handleMergeClientGoalContexts,
    t,
  } = useUser();

  const clientNames = useMemo(() => Object.keys(clientGoalContexts).sort((a, b) => a.localeCompare(b)), [clientGoalContexts]);
  const [companyName, setCompanyName] = useState('');
  const [draftContext, setDraftContext] = useState<GoalContext>(() => normalizeGoalContext());
  const [bulkText, setBulkText] = useState('');
  const [statusText, setStatusText] = useState('');

  const handleSelectClient = (selectedCompany: string) => {
    setCompanyName(selectedCompany);
    setDraftContext(normalizeGoalContext(clientGoalContexts[selectedCompany] || INITIAL_GOAL_CONTEXT));
    setStatusText('');
  };

  const handleDraftChange = (key: keyof GoalContext, value: string) => {
    setDraftContext(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    const normalizedCompany = companyName.trim();
    if (!normalizedCompany) return;
    handleSaveClientGoalContext(normalizedCompany, draftContext);
    setCompanyName(normalizedCompany);
    setStatusText(t.clientPresetSaved.replace('{company}', normalizedCompany));
  };

  const handleDelete = () => {
    const normalizedCompany = companyName.trim();
    if (!normalizedCompany) return;
    handleDeleteClientGoalContext(normalizedCompany);
    setCompanyName('');
    setDraftContext(normalizeGoalContext());
    setStatusText(t.clientPresetDeleted.replace('{company}', normalizedCompany));
  };

  const handleBulkImport = () => {
    const { presets } = parseClientGoalContextBulk(bulkText, t.goalTab);
    const importedCount = Object.keys(presets).length;
    if (importedCount === 0) return;

    handleMergeClientGoalContexts(presets);
    setBulkText('');
    setStatusText(t.clientBulkImported.replace('{count}', String(importedCount)));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-[#d4af37]" />
        <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300">{t.clientGoalSettings}</h4>
      </div>

      {clientNames.length > 0 && (
        <select
          value={clientGoalContexts[companyName.trim()] ? companyName.trim() : ''}
          onChange={(event) => handleSelectClient(event.target.value)}
          className={inputClass}
        >
          <option value="">{t.selectSavedClient}</option>
          {clientNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      )}

      <input
        value={companyName}
        onChange={(event) => {
          setCompanyName(event.target.value);
          setStatusText('');
        }}
        className={inputClass}
        placeholder={t.clientName}
      />

      <GoalContextFields
        goalContext={draftContext}
        onChange={handleDraftChange}
        className="grid grid-cols-1 gap-3"
      />

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!companyName.trim()}
          className="flex-1 flex items-center justify-center gap-2 p-2 bg-[#d4af37] text-white font-bold rounded-lg hover:bg-[#b8922e] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={16} />
          <span>{t.save}</span>
        </button>
        <button
          onClick={handleDelete}
          disabled={!clientGoalContexts[companyName.trim()]}
          className="flex items-center justify-center gap-2 p-2 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 font-bold rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
          title={t.deleteClientPreset}
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="space-y-2 pt-4 border-t border-gray-200 dark:border-[#3C3C3C]">
        <label className="block text-sm font-bold text-gray-600 dark:text-gray-300" htmlFor="bulk-client-goals">
          {t.bulkClientImport}
        </label>
        <textarea
          id="bulk-client-goals"
          rows={4}
          value={bulkText}
          onChange={(event) => {
            setBulkText(event.target.value);
            setStatusText('');
          }}
          className={`${inputClass} custom-scrollbar`}
          placeholder={t.bulkClientPlaceholder}
        />
        <button
          onClick={handleBulkImport}
          disabled={!bulkText.trim()}
          className="w-full flex items-center justify-center gap-2 p-2 bg-[#d4af37]/10 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675] font-bold rounded-lg hover:bg-[#d4af37]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Upload size={16} />
          <span>{t.importClients}</span>
        </button>
      </div>

      {statusText && (
        <p className="text-xs font-bold text-green-600 dark:text-green-400" aria-live="polite">
          {statusText}
        </p>
      )}
    </div>
  );
};

export default ClientGoalSettings;
