import AppSelect from './AppSelect';
import React from 'react';
import { Bot, Clock3, ShieldCheck } from 'lucide-react';
import {
  GEMINI_FREE_MODEL_OPTIONS,
  GEMINI_PAID_MODEL_OPTIONS,
  MODEL_REGISTRY,
} from '../constants/modelRegistry';

export type ContentWritingAutomationSettingField =
  | 'contentWritingAutomationEnabled'
  | 'contentWritingAutomationIntervalMinutes'
  | 'contentWritingAutomationProvider'
  | 'contentWritingAutomationModel'
  | 'contentWritingAutomationMinimumCompetitors'
  | 'contentWritingAutomationRequireCompetitorTerminalState'
  | 'contentWritingAutomationMaxAttempts'
  | 'contentWritingAutomationRetryMinutes';

type Props = {
  values: Record<string, unknown>;
  onChange: (field: ContentWritingAutomationSettingField, value: string | number | boolean) => void;
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const ContentWritingAutomationSettings: React.FC<Props> = ({ values, onChange }) => {
  const enabled = values.contentWritingAutomationEnabled === true;
  const provider = values.contentWritingAutomationProvider === 'geminiPaid'
    || values.contentWritingAutomationProvider === 'openai'
    ? String(values.contentWritingAutomationProvider)
    : 'gemini';
  const model = typeof values.contentWritingAutomationModel === 'string'
    ? values.contentWritingAutomationModel
    : '';
  const registryOptions = provider === 'geminiPaid'
    ? GEMINI_PAID_MODEL_OPTIONS
    : provider === 'openai'
      ? MODEL_REGISTRY.openai.models.map(item => ({ value: item.id, label: item.label }))
      : GEMINI_FREE_MODEL_OPTIONS;
  const modelOptions = model && !registryOptions.some(option => option.value === model)
    ? [{ value: model, label: model }, ...registryOptions]
    : registryOptions;

  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900/50 dark:bg-blue-950/10">
      <div className="flex items-start gap-3">
        <Bot size={20} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-black text-gray-800 dark:text-gray-100">
                الكتابة التلقائية للمقالات الجاهزة
              </h4>
              <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
                يكتشف الخادم المقالات المكتملة المدخلات، ويكتب مقالة واحدة فقط في كل مرة. الطلب اليدوي والإنشاء الشامل النشط لهما الأولوية، وتُحفظ النتيجة للمراجعة دون إدراج تلقائي.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-black text-blue-700 dark:border-blue-900/60 dark:bg-[#202020] dark:text-blue-200">
              <input
                type="checkbox"
                checked={enabled}
                onChange={event => onChange('contentWritingAutomationEnabled', event.target.checked)}
                className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              {enabled ? 'مفعّلة' : 'متوقفة'}
            </label>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">الفاصل بين المقالات بالدقائق</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={Number(values.contentWritingAutomationIntervalMinutes || 15)}
                onChange={event => onChange('contentWritingAutomationIntervalMinutes', Number(event.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">مزود الكتابة التلقائية</span>
              <AppSelect
                value={provider}
                onChange={event => {
                  onChange('contentWritingAutomationProvider', event.target.value);
                  onChange('contentWritingAutomationModel', '');
                }}
                className={inputClass}
              >
                <option value="gemini">Gemini المجاني</option>
                <option value="geminiPaid">Gemini Pro</option>
                <option value="openai">OpenAI</option>
              </AppSelect>
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">موديل الكتابة التلقائية</span>
              <AppSelect
                value={model}
                onChange={event => onChange('contentWritingAutomationModel', event.target.value)}
                className={inputClass}
              >
                <option value="">الموديل الافتراضي للمزود</option>
                {modelOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </AppSelect>
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">الحد الأدنى للمنافسين الصالحين</span>
              <input
                type="number"
                min={1}
                max={5}
                value={Number(values.contentWritingAutomationMinimumCompetitors || 1)}
                onChange={event => onChange('contentWritingAutomationMinimumCompetitors', Number(event.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">أقصى محاولات للمقالة</span>
              <input
                type="number"
                min={1}
                max={10}
                value={Number(values.contentWritingAutomationMaxAttempts || 3)}
                onChange={event => onChange('contentWritingAutomationMaxAttempts', Number(event.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-black text-gray-600 dark:text-gray-300">إعادة المحاولة بعد الفشل بالدقائق</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={Number(values.contentWritingAutomationRetryMinutes || 30)}
                onChange={event => onChange('contentWritingAutomationRetryMinutes', Number(event.target.value))}
                className={inputClass}
              />
            </label>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-blue-100 bg-white/80 p-3 dark:border-blue-900/40 dark:bg-[#202020]/80">
            <input
              type="checkbox"
              checked={values.contentWritingAutomationRequireCompetitorTerminalState !== false}
              onChange={event => onChange('contentWritingAutomationRequireCompetitorTerminalState', event.target.checked)}
              className="mt-1 size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="block text-xs font-black text-gray-700 dark:text-gray-200">انتظار انتهاء معالجة جميع المنافسين المحددين</span>
              <span className="mt-1 block text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                لا يشترط نجاحهم جميعًا؛ يكفي انتهاء كل منافس بنجاح أو فشل نهائي، مع توفر الحد الأدنى من النصوص الصالحة. تُرسل جميع النصوص الناجحة من 1 إلى 5.
              </span>
            </span>
          </label>

          <div className="mt-3 grid gap-2 text-[11px] font-semibold leading-5 text-gray-600 dark:text-gray-300 sm:grid-cols-2">
            <div className="flex items-start gap-2 rounded-md bg-blue-100/60 p-2 dark:bg-blue-900/20">
              <Clock3 size={14} className="mt-0.5 shrink-0" />
              يبدأ الفاصل بعد نهاية الجلسة فعليًا، ويظل انتظار توفر مفاتيح Gemini نافذًا إذا كان أطول.
            </div>
            <div className="flex items-start gap-2 rounded-md bg-emerald-100/60 p-2 dark:bg-emerald-900/20">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              لا تعيد الأتمتة كتابة مقالة لها جلسة مكتملة؛ إعادة الكتابة تبقى قرارًا يدويًا صريحًا.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ContentWritingAutomationSettings;
