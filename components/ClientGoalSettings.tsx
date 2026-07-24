import React, { useMemo, useState } from 'react';
import { Copy, Edit3, Loader2, Save, Trash2, Upload, Users } from 'lucide-react';
import { INITIAL_GOAL_CONTEXT } from '../constants';
import { useUser } from '../contexts/UserContext';
import { useClientDirectory } from '../hooks/useClientDirectory';
import type { GoalContext } from '../types';
import {
  getClientGoalContext,
  mapNamedGoalContextsToClients,
} from '../utils/clientCompanyIdentity';
import GoalContextFields from './GoalContextFields';
import {
  formatGoalContextForCopy,
  getGoalContextFields,
  isGoalContextFieldVisible,
  normalizeGoalContext,
  parseClientGoalContextBulk,
  parseGoalContextMultiValue,
  updateGoalContextField,
} from '../utils/goalContext';

const inputClass = 'w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500';

const ClientGoalSettings: React.FC = () => {
  const {
    clientGoalContexts,
    handleSaveClientGoalContext,
    handleDeleteClientGoalContext,
    handleMergeClientGoalContexts,
    t,
  } = useUser();
  const {
    clients,
    isLoadingClients,
    clientDirectoryError,
  } = useClientDirectory();

  const orderedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name)),
    [clients],
  );
  const contextFields = useMemo(() => getGoalContextFields(t.goalTab), [t.goalTab]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [draftContext, setDraftContext] = useState<GoalContext>(() => normalizeGoalContext());
  const [bulkText, setBulkText] = useState('');
  const [statusText, setStatusText] = useState('');
  const [statusTone, setStatusTone] = useState<'success' | 'error'>('success');

  const selectedClient = orderedClients.find(client => client.id === selectedClientId) ?? null;
  const selectedSavedContext = selectedClient
    ? getClientGoalContext(clientGoalContexts, selectedClient)
    : undefined;

  const setStatus = (message: string, tone: 'success' | 'error' = 'success') => {
    setStatusText(message);
    setStatusTone(tone);
  };

  const handleSelectClient = (clientId: string) => {
    const client = orderedClients.find(candidate => candidate.id === clientId) ?? null;
    setSelectedClientId(client?.id ?? '');
    setDraftContext(normalizeGoalContext(
      client ? getClientGoalContext(clientGoalContexts, client) || INITIAL_GOAL_CONTEXT : undefined,
    ));
    setStatusText('');
  };

  const handleDraftChange = (key: keyof GoalContext, value: string) => {
    setDraftContext(prev => updateGoalContextField(prev, key, value));
  };

  const handleSave = () => {
    if (!selectedClient) return;
    handleSaveClientGoalContext(selectedClient.id, draftContext, selectedClient.name);
    setStatus(t.clientPresetSaved.replace('{company}', selectedClient.name));
  };

  const handleCopySelectedContext = async () => {
    if (!selectedClient || !selectedSavedContext) return;
    await navigator.clipboard.writeText(
      formatGoalContextForCopy(selectedClient.name, draftContext, t.goalTab),
    );
    setStatus(t.goalTab.clientContextCopied);
  };

  const handleDelete = () => {
    if (!selectedClient || !selectedSavedContext) return;
    handleDeleteClientGoalContext(selectedClient.id, selectedClient.name);
    setDraftContext(normalizeGoalContext());
    setStatus(t.clientPresetDeleted.replace('{company}', selectedClient.name));
  };

  const handleBulkImport = () => {
    const { presets } = parseClientGoalContextBulk(bulkText, t.goalTab);
    const unifiedPresets = mapNamedGoalContextsToClients(presets, clients);
    const importedCount = Object.keys(unifiedPresets).length;
    if (importedCount === 0) {
      setStatus('لم يطابق الإدخال أي عميل موجود في مركز العملاء.', 'error');
      return;
    }

    handleMergeClientGoalContexts(unifiedPresets);
    setBulkText('');
    setStatus(t.clientBulkImported.replace('{count}', String(importedCount)));
  };

  const formatFieldValue = (field: (typeof contextFields)[number], context: GoalContext) => {
    const value = context[field.key];
    if (!value) return '-';
    if (field.kind === 'multi-choice') {
      return parseGoalContextMultiValue(value)
        .map(item => field.options.find(option => option.value === item)?.label || item)
        .join('، ');
    }
    if (field.kind !== 'select') return value;
    return field.options.find(option => option.value === value)?.label || value;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-[#d4af37]" />
        <h4 className="text-sm font-bold text-gray-600 dark:text-gray-300">
          سياق العملاء الموحد
        </h4>
      </div>

      <p className="text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        اختر العميل من مركز العملاء. اسم العميل نفسه سيُستخدم بوصفه اسم الشركة في
        الكلمات والأهداف، بينما يُحفظ سياق الأهداف تحت معرّف العميل حتى لا يضيع عند
        تغيير اسمه.
      </p>

      {isLoadingClients && (
        <div className="flex items-center gap-2 text-xs font-bold text-gray-500">
          <Loader2 size={14} className="animate-spin" />
          <span>جاري تحميل العملاء...</span>
        </div>
      )}

      {clientDirectoryError && (
        <p className="text-xs font-bold text-red-600 dark:text-red-400">
          {clientDirectoryError}
        </p>
      )}

      {!isLoadingClients && !clientDirectoryError && orderedClients.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-300 p-3 text-center text-xs font-bold text-gray-500 dark:border-[#3C3C3C] dark:text-gray-400">
          أضف العميل أولًا في مركز العملاء، ثم عد إلى هذا القسم لحفظ سياق أهدافه.
        </p>
      )}

      {orderedClients.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400">
            العملاء المسجلون في مركز العملاء
          </h5>
          <div className="custom-scrollbar max-h-64 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-200 dark:divide-[#3C3C3C] dark:border-[#3C3C3C]">
            {orderedClients.map(client => {
              const savedContext = getClientGoalContext(clientGoalContexts, client);
              const context = normalizeGoalContext(savedContext);
              return (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => handleSelectClient(client.id)}
                  className="w-full bg-white p-3 text-start transition-colors hover:bg-[#d4af37]/10 dark:bg-[#1F1F1F] dark:hover:bg-[#d4af37]/20"
                  title={t.editClientPreset}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-bold text-[#333333] dark:text-gray-100">
                      {client.name}
                    </span>
                    <Edit3 size={14} className="flex-shrink-0 text-[#d4af37]" />
                  </div>
                  {!savedContext ? (
                    <div className="mt-2 text-[11px] font-semibold text-gray-400">
                      لا يوجد سياق أهداف محفوظ لهذا العميل بعد.
                    </div>
                  ) : (
                    <div className="mt-2 grid grid-cols-1 gap-1">
                      {contextFields
                        .filter(field => isGoalContextFieldVisible(field, context))
                        .map(field => (
                          <div
                            key={field.key}
                            className="flex items-start gap-2 text-[11px] text-gray-500 dark:text-gray-400"
                          >
                            <span className="flex-shrink-0 font-bold text-gray-600 dark:text-gray-300">
                              {field.label}:
                            </span>
                            <span className="truncate">{formatFieldValue(field, context)}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {orderedClients.length > 0 && (
        <div className="flex gap-2">
          <select
            value={selectedClientId}
            onChange={event => handleSelectClient(event.target.value)}
            className={inputClass}
          >
            <option value="">اختر العميل / الشركة</option>
            {orderedClients.map(client => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCopySelectedContext}
            disabled={!selectedSavedContext}
            className="flex flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-bold text-gray-700 transition-colors hover:bg-[#d4af37]/15 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#d4af37]/25"
            title={t.goalTab.copyClientContext}
          >
            <Copy size={16} />
            <span className="hidden sm:inline">{t.goalTab.copyClientContext}</span>
          </button>
        </div>
      )}

      {selectedClient && (
        <>
          <GoalContextFields
            goalContext={draftContext}
            onChange={handleDraftChange}
            className="grid grid-cols-1 gap-3"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#d4af37] p-2 font-bold text-white hover:bg-[#b8922e]"
            >
              <Save size={16} />
              <span>{t.save}</span>
            </button>
            <button
              onClick={handleDelete}
              disabled={!selectedSavedContext}
              className="flex items-center justify-center gap-2 rounded-lg bg-red-50 p-2 font-bold text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30"
              title={t.deleteClientPreset}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </>
      )}

      <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-[#3C3C3C]">
        <label className="block text-sm font-bold text-gray-600 dark:text-gray-300" htmlFor="bulk-client-goals">
          {t.bulkClientImport}
        </label>
        <p className="text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
          تُقبل فقط أسماء العملاء الموجودة مسبقًا في مركز العملاء، ويُربط كل سياق
          تلقائيًا بمعرّف العميل المطابق.
        </p>
        <textarea
          id="bulk-client-goals"
          rows={4}
          value={bulkText}
          onChange={event => {
            setBulkText(event.target.value);
            setStatusText('');
          }}
          className={`${inputClass} custom-scrollbar`}
          placeholder={t.bulkClientPlaceholder}
        />
        <button
          onClick={handleBulkImport}
          disabled={!bulkText.trim() || orderedClients.length === 0}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#d4af37]/10 p-2 font-bold text-[#d4af37] transition-colors hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#d4af37]/20 dark:text-[#f2d675]"
        >
          <Upload size={16} />
          <span>{t.importClients}</span>
        </button>
      </div>

      {statusText && (
        <p
          className={`text-xs font-bold ${
            statusTone === 'error'
              ? 'text-red-600 dark:text-red-400'
              : 'text-green-600 dark:text-green-400'
          }`}
          aria-live="polite"
        >
          {statusText}
        </p>
      )}
    </div>
  );
};

export default ClientGoalSettings;
