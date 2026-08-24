import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Save, Target, Trash2, Upload } from 'lucide-react';
import { INITIAL_GOAL_CONTEXT } from '../constants';
import { useUser } from '../contexts/UserContext';
import type { GoalContext } from '../types';
import {
  getClientGoalContext,
  mapNamedGoalContextsToClients,
} from '../utils/clientCompanyIdentity';
import type { ClientCenterClient } from '../utils/clientCenter';
import GoalContextFields from './GoalContextFields';
import {
  formatGoalContextForCopy,
  normalizeGoalContext,
  parseClientGoalContextBulk,
  updateGoalContextField,
} from '../utils/goalContext';

const inputClass = 'w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500';

type ClientGoalSettingsProps = {
  clients: ClientCenterClient[];
  selectedClientId: string;
};

const ClientGoalSettings: React.FC<ClientGoalSettingsProps> = ({
  clients,
  selectedClientId,
}) => {
  const {
    clientGoalContexts,
    handleSaveClientGoalContext,
    handleDeleteClientGoalContext,
    handleMergeClientGoalContexts,
    t,
  } = useUser();
  const orderedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name)),
    [clients],
  );
  const [draftContext, setDraftContext] = useState<GoalContext>(() => normalizeGoalContext());
  const [bulkText, setBulkText] = useState('');
  const [statusText, setStatusText] = useState('');
  const [statusTone, setStatusTone] = useState<'success' | 'error'>('success');

  const selectedClient = orderedClients.find(client => client.id === selectedClientId) ?? null;
  const selectedSavedContext = selectedClient
    ? getClientGoalContext(clientGoalContexts, selectedClient)
    : undefined;

  useEffect(() => {
    setDraftContext(normalizeGoalContext(
      selectedSavedContext || INITIAL_GOAL_CONTEXT,
    ));
  }, [selectedClientId, selectedSavedContext]);

  useEffect(() => {
    setStatusText('');
  }, [selectedClientId]);

  const setStatus = (message: string, tone: 'success' | 'error' = 'success') => {
    setStatusText(message);
    setStatusTone(tone);
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
    const importedSelectedContext = selectedClient
      ? unifiedPresets[selectedClient.id]
      : undefined;
    if (importedSelectedContext) {
      setDraftContext(normalizeGoalContext(importedSelectedContext));
    }
    setBulkText('');
    setStatus(t.clientBulkImported.replace('{count}', String(importedCount)));
  };

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-[#d4af37]/30 bg-gradient-to-l from-[#d4af37]/15 via-[#d4af37]/5 to-transparent">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#d4af37] text-white shadow-sm">
              <Target size={20} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-base font-black text-gray-900 dark:text-gray-100">
                  سياق هدف الصفحة الحالي
                </h4>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black ${
                  selectedSavedContext
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                }`}>
                  {selectedSavedContext && <CheckCircle2 size={11} />}
                  {selectedSavedContext ? 'سياق محفوظ' : 'لم يُحفظ بعد'}
                </span>
              </div>
              <p className="mt-1 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
                يُطبّق هذا السياق على العميل <span className="font-black">{selectedClient?.name}</span> عند
                بدء المقالات الجديدة، ويظل مرتبطًا بمعرّف العميل حتى عند تغيير اسمه.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCopySelectedContext}
            disabled={!selectedSavedContext}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[#d4af37]/30 bg-white/80 px-3 py-2 text-sm font-bold text-[#8a6f1d] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2A2A2A]/80 dark:text-[#f2d675] dark:hover:bg-[#2A2A2A]"
            title={t.goalTab.copyClientContext}
          >
            <Copy size={16} />
            <span>{t.goalTab.copyClientContext}</span>
          </button>
        </div>
      </div>

      {selectedClient && (
        <>
          <section className="rounded-xl border border-gray-200 bg-gray-50/70 p-4 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]/60">
            <div className="mb-4">
              <h5 className="text-sm font-black text-gray-800 dark:text-gray-100">اختيارات الهدف والجمهور</h5>
              <p className="mt-1 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                الحقول الأساسية تحدد نوع الصفحة وهدفها ونية البحث، وبقية الحقول تضيف توجيهًا أدق عند الحاجة.
              </p>
            </div>
            <GoalContextFields
              goalContext={draftContext}
              onChange={handleDraftChange}
              className="grid grid-cols-1 gap-3 lg:grid-cols-2"
            />
          </section>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleSave}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#d4af37] px-4 py-2.5 font-bold text-white shadow-sm transition-colors hover:bg-[#b8922e]"
            >
              <Save size={16} />
              <span>حفظ سياق {selectedClient.name}</span>
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!selectedSavedContext}
              className="flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 font-bold text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30"
              title={t.deleteClientPreset}
            >
              <Trash2 size={16} />
              <span>حذف السياق المحفوظ</span>
            </button>
          </div>
        </>
      )}

      <details className="group rounded-xl border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-black text-gray-700 marker:content-none dark:text-gray-200">
          <span className="flex items-center gap-2"><Upload size={16} className="text-[#d4af37]" /> أدوات الاستيراد المتقدمة</span>
          <span className="text-[11px] font-bold text-gray-400 group-open:hidden">إظهار</span>
          <span className="hidden text-[11px] font-bold text-gray-400 group-open:inline">إخفاء</span>
        </summary>
        <div className="space-y-3 border-t border-gray-100 p-4 dark:border-[#3C3C3C]">
          <label className="block text-sm font-bold text-gray-600 dark:text-gray-300" htmlFor="bulk-client-goals">
            {t.bulkClientImport}
          </label>
          <p className="text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            تُقبل فقط أسماء العملاء الموجودة مسبقًا في مركز العملاء، ويُربط كل سياق تلقائيًا بمعرّف العميل المطابق.
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
            type="button"
            onClick={handleBulkImport}
            disabled={!bulkText.trim() || orderedClients.length === 0}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#d4af37]/10 p-2 font-bold text-[#9b7d20] transition-colors hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#d4af37]/20 dark:text-[#f2d675]"
          >
            <Upload size={16} />
            <span>{t.importClients}</span>
          </button>
        </div>
      </details>

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
