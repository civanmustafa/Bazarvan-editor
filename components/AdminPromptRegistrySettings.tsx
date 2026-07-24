import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Database,
  Paperclip,
  RotateCcw,
  Search,
  TerminalSquare,
} from 'lucide-react';
import { translations } from './translations';
import {
  DEFAULT_PROMPT_TEMPLATES,
  inspectPromptTemplate,
  PROMPT_GROUP_IDS,
  PROMPT_REGISTRY_DEFINITIONS,
  PROMPT_REGISTRY_VERSION,
  type PromptGroupId,
  type PromptRegistryDefinition,
} from '../constants/promptRegistry';

type AdminPromptRegistrySettingsProps = {
  values: Record<string, unknown>;
  onChange: (field: 'registryVersion' | 'templates', value: number | Record<string, string>) => void;
};

const GROUPS: Array<{
  id: PromptGroupId;
  label: string;
  description: string;
}> = [
  {
    id: PROMPT_GROUP_IDS.toolbar,
    label: 'الأوامر الهندسية السريعة في شريط المحرر',
    description: 'تعمل على النص المحدد، ويضيف المحرر تلقائيًا السياق القريب والكلمات والهدف وقيود المعايير.',
  },
  {
    id: PROMPT_GROUP_IDS.readyCommands,
    label: 'الأوامر اليدوية الجاهزة',
    description: 'أوامر التحليل الذكي الجاهزة. أصبحت إدارتها هنا للمسؤول فقط، لذلك لم تعد بحاجة إلى كلمة مرور منفصلة داخل إعدادات المستخدم.',
  },
  {
    id: PROMPT_GROUP_IDS.repair,
    label: 'أوامر الإصلاح',
    description: 'أوامر إصلاح مخالفة واحدة أو عدة مخالفات في فقرة أو عنوان أو قسم، مع إنشاء اقتراحات قبل التطبيق.',
  },
  {
    id: PROMPT_GROUP_IDS.writing,
    label: 'أوامر إنشاء وكتابة المقالة',
    description: 'التعليمات العامة والسياق والمخطط وكتابة الأقسام والمقدمة والأسئلة الشائعة والخاتمة.',
  },
  {
    id: PROMPT_GROUP_IDS.coverage,
    label: 'أوامر تغطية الأفكار',
    description: 'تدقيق أفكار المنافسين بعد اكتمال المسودة ثم إصلاح الأقسام التي تحتوي نقصًا مهمًا.',
  },
  {
    id: PROMPT_GROUP_IDS.finalReview,
    label: 'أوامر المراجعة النهائية',
    description: 'مراجعة المقالة كاملة بعد تجميعها وإصلاح تغطية أفكارها.',
  },
  {
    id: PROMPT_GROUP_IDS.qualityGate,
    label: 'أوامر بوابة الجودة',
    description: 'إصلاح المقالة كاملة وفق الدرجة وتقرير المخالفات البرمجي وعقد الجودة الحالي.',
  },
];

const inputClass = 'w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm leading-7 text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const resolveDefinitionLabel = (definition: PromptRegistryDefinition): string => {
  if (!definition.legacyLabelKey || !definition.legacySource) return definition.label;
  const source = definition.legacySource === 'toolbar'
    ? translations.ar.aiMenu
    : translations.ar.rightSidebar;
  return String((source as Record<string, unknown>)[definition.legacyLabelKey] || definition.label);
};

const AdminPromptRegistrySettings: React.FC<AdminPromptRegistrySettingsProps> = ({
  values,
  onChange,
}) => {
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<PromptGroupId>>(
    () => new Set([PROMPT_GROUP_IDS.toolbar]),
  );
  const storedTemplates = values.templates && typeof values.templates === 'object' && !Array.isArray(values.templates)
    ? values.templates as Record<string, string>
    : {};
  const templates = useMemo(() => ({
    ...DEFAULT_PROMPT_TEMPLATES,
    ...storedTemplates,
  }), [storedTemplates]);
  const normalizedQuery = query.trim().toLocaleLowerCase('ar');

  const definitionsByGroup = useMemo(() => Object.fromEntries(
    GROUPS.map(group => [
      group.id,
      PROMPT_REGISTRY_DEFINITIONS.filter(definition => {
        if (definition.group !== group.id) return false;
        if (!normalizedQuery) return true;
        const haystack = [
          resolveDefinitionLabel(definition),
          definition.id,
          definition.description,
          definition.usage,
          ...definition.attachments.map(item => `${item.label} ${item.description}`),
        ].join(' ').toLocaleLowerCase('ar');
        return haystack.includes(normalizedQuery);
      }),
    ]),
  ) as Record<PromptGroupId, PromptRegistryDefinition[]>, [normalizedQuery]);

  const updateTemplate = (id: string, value: string) => {
    onChange('templates', {
      ...templates,
      [id]: value,
    });
    onChange('registryVersion', PROMPT_REGISTRY_VERSION);
  };

  const resetDefinition = (id: string) => updateTemplate(id, DEFAULT_PROMPT_TEMPLATES[id] || '');

  const resetGroup = (groupId: PromptGroupId) => {
    const next = { ...templates };
    PROMPT_REGISTRY_DEFINITIONS
      .filter(definition => definition.group === groupId)
      .forEach(definition => {
        next[definition.id] = DEFAULT_PROMPT_TEMPLATES[definition.id] || '';
      });
    onChange('templates', next);
    onChange('registryVersion', PROMPT_REGISTRY_VERSION);
  };

  const resetAll = () => {
    onChange('templates', { ...DEFAULT_PROMPT_TEMPLATES });
    onChange('registryVersion', PROMPT_REGISTRY_VERSION);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#d4af37]/30 bg-[#d4af37]/5 p-4 dark:bg-[#d4af37]/10">
        <div className="flex items-start gap-3">
          <TerminalSquare size={22} className="mt-0.5 shrink-0 text-[#d4af37]" />
          <div>
            <h3 className="font-black text-gray-900 dark:text-gray-100">السجل المركزي للأوامر الهندسية</h3>
            <p className="mt-1 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
              النص الذي تحفظه هنا يصبح المصدر العام الذي تسحبه واجهة المحرر ومحرك كتابة المقالة. المرفقات لا تُكتب داخل الأمر يدويًا؛ يبنيها النظام في وقت التنفيذ من المقالة النشطة ثم يستبدل المتغيرات المعروضة أدناه.
            </p>
            <p className="mt-1 text-xs font-bold leading-6 text-amber-700 dark:text-amber-300">
              لا تحذف متغيرًا إلزاميًا من نص الأمر. إذا كان متغير إلزامي مفقودًا فلن يعتمد النظام النسخة المعدلة، وسيستخدم النص الافتراضي الآمن.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="ابحث باسم الأمر أو المرفق أو المعرّف..."
            className="h-11 w-full rounded-lg border border-gray-300 bg-white ps-10 pe-3 text-sm font-semibold outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
          />
        </label>
        <button
          type="button"
          onClick={resetAll}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 text-sm font-bold text-gray-600 hover:border-[#d4af37] hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-200"
        >
          <RotateCcw size={16} />
          استعادة جميع الأوامر
        </button>
      </div>

      {GROUPS.map(group => {
        const definitions = definitionsByGroup[group.id];
        if (normalizedQuery && definitions.length === 0) return null;
        return (
          <details
            key={group.id}
            open={Boolean(normalizedQuery) || openGroups.has(group.id)}
            onToggle={event => {
              if (normalizedQuery) return;
              const isOpen = event.currentTarget.open;
              setOpenGroups(current => {
                const next = new Set(current);
                if (isOpen) next.add(group.id);
                else next.delete(group.id);
                return next;
              });
            }}
            className="group overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-gray-50 px-4 py-3 dark:bg-[#242424]">
              <span className="min-w-0">
                <span className="block font-black text-gray-800 dark:text-gray-100">{group.label}</span>
                <span className="mt-1 block text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">{group.description}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-[#d4af37]/15 px-2 py-1 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                  {definitions.length}
                </span>
                <ChevronDown size={18} className="text-gray-400 transition-transform group-open:rotate-180" />
              </span>
            </summary>

            <div className="space-y-4 p-4">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => resetGroup(group.id)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#8a6f1d] dark:text-gray-300"
                >
                  <RotateCcw size={13} />
                  استعادة أوامر هذا القسم
                </button>
              </div>

              {definitions.map(definition => {
                const template = templates[definition.id] || '';
                const inspection = inspectPromptTemplate(definition, template);
                return (
                  <article key={definition.id} className="rounded-xl border border-gray-200 p-4 dark:border-[#3C3C3C]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="font-black text-gray-900 dark:text-gray-100">{resolveDefinitionLabel(definition)}</h4>
                        <code dir="ltr" className="mt-1 block break-all text-[10px] font-bold text-gray-400">{definition.id}</code>
                      </div>
                      <button
                        type="button"
                        onClick={() => resetDefinition(definition.id)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#8a6f1d] dark:text-gray-300"
                      >
                        <RotateCcw size={13} />
                        الافتراضي
                      </button>
                    </div>

                    <p className="mt-3 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">{definition.description}</p>
                    <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold leading-6 text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                      <span className="font-black">طريقة الاستخدام: </span>{definition.usage}
                    </div>

                    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                      <div className="mb-2 flex items-center gap-2 text-xs font-black text-gray-700 dark:text-gray-200">
                        <Paperclip size={14} className="text-[#d4af37]" />
                        المرفقات التي يبنيها النظام تلقائيًا
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        {definition.attachments.map(item => (
                          <div key={item.id} className="rounded-md bg-white px-2.5 py-2 dark:bg-[#2A2A2A]">
                            <div className="flex items-center gap-1.5 text-[11px] font-black text-gray-700 dark:text-gray-200">
                              <Database size={12} className="text-[#d4af37]" />
                              {item.label}
                            </div>
                            <p className="mt-1 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">{item.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {definition.variables.length > 0 && (
                      <div className="mt-3">
                        <div className="mb-2 text-xs font-black text-gray-600 dark:text-gray-300">المتغيرات المتاحة داخل النص</div>
                        <div className="flex flex-wrap gap-1.5" dir="ltr">
                          {definition.variables.map(variable => {
                            const normalized = variable.replace(/^\{\{|\}\}$/g, '');
                            const required = definition.requiredVariables?.includes(normalized);
                            return (
                              <code
                                key={variable}
                                className={`rounded px-1.5 py-1 text-[10px] font-bold ${
                                  required
                                    ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                    : 'bg-gray-100 text-[#8a6f1d] dark:bg-[#1F1F1F] dark:text-[#f2d675]'
                                }`}
                                title={required ? 'متغير إلزامي' : 'متغير متاح'}
                              >
                                {variable}
                              </code>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <textarea
                      value={template}
                      onChange={event => updateTemplate(definition.id, event.target.value)}
                      rows={Math.min(18, Math.max(7, template.split('\n').length + 1))}
                      dir="rtl"
                      spellCheck
                      className={`${inputClass} mt-3 custom-scrollbar`}
                    />

                    {!inspection.valid && (
                      <div className="mt-2 flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-700 dark:bg-red-950/30 dark:text-red-300">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                        <span>
                          {inspection.empty && 'نص الأمر فارغ. '}
                          {inspection.tooLong && 'نص الأمر يتجاوز الحد المسموح. '}
                          {inspection.missingVariables.length > 0
                            ? `المتغيرات الإلزامية الناقصة: ${inspection.missingVariables.map(item => `{{${item}}}`).join('، ')}.`
                            : ''}
                        </span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
};

export default AdminPromptRegistrySettings;
