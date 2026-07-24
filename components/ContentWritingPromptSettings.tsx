import React from 'react';
import { RotateCcw, TerminalSquare } from 'lucide-react';
import {
  CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_MAX_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_MIN_INPUT_TOKEN_BUDGET,
  type ContentWritingTemplateField,
} from '../constants/contentWriting';
import {
  CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION,
  CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES,
  CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE,
  CONTENT_WRITING_MAX_REPAIR_PASSES,
  CONTENT_WRITING_QUALITY_POLICY_VERSIONS,
} from '../constants/contentWritingQuality';
import { navigateToAppPath } from '../utils/appRoutes';

type ContentWritingPromptSettingsProps = {
  values: Record<string, unknown>;
  onChange: (
    field: ContentWritingTemplateField
      | 'contentWritingMaxInputTokens'
      | 'contentWritingQualityPolicyVersion'
      | 'contentWritingMinimumQualityScore'
      | 'contentWritingMaxRepairPasses',
    value: string | number,
  ) => void;
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const ContentWritingPromptSettings: React.FC<ContentWritingPromptSettingsProps> = ({ values, onChange }) => {
  const inputBudget = Number(values.contentWritingMaxInputTokens || CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
  const qualityPolicyVersion = Number(values.contentWritingQualityPolicyVersion || CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
  const minimumQualityScore = Number(values.contentWritingMinimumQualityScore || CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
  const maxRepairPasses = Number(values.contentWritingMaxRepairPasses ?? CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);

  const resetDefaults = () => {
    onChange('contentWritingMaxInputTokens', CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
    onChange('contentWritingQualityPolicyVersion', CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
    onChange('contentWritingMinimumQualityScore', CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
    onChange('contentWritingMaxRepairPasses', CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#d4af37]/25 bg-[#d4af37]/5 p-3 dark:bg-[#d4af37]/10">
        <div className="flex min-w-0 items-start gap-2">
          <TerminalSquare size={18} className="mt-0.5 shrink-0 text-[#d4af37]" />
          <p className="text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
            نُقلت نصوص أوامر الكتابة والمراجعة والإصلاح إلى تبويب <strong>الأوامر الهندسية</strong>. تبقى هنا حدود التشغيل وسياسة الجودة فقط.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigateToAppPath('/settings/prompts')}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-[#d4af37] px-3 text-xs font-black text-white hover:bg-[#b8922e]"
        >
          فتح الأوامر الهندسية
        </button>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={resetDefaults}
          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:border-[#d4af37] hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-200"
        >
          <RotateCcw size={15} />
          استعادة حدود التشغيل الافتراضية
        </button>
      </div>

      <label className="block max-w-sm">
        <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">حد الإدخال الآمن لطلب كتابة المحتوى (وحدة تقديرية)</span>
        <input
          type="number"
          min={CONTENT_WRITING_MIN_INPUT_TOKEN_BUDGET}
          max={CONTENT_WRITING_MAX_INPUT_TOKEN_BUDGET}
          step={5_000}
          value={Number.isFinite(inputBudget) ? inputBudget : CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET}
          onChange={event => onChange('contentWritingMaxInputTokens', Number(event.target.value))}
          className={inputClass}
        />
      </label>

      <div className="grid gap-4 border-t border-gray-200 pt-5 dark:border-[#3C3C3C] md:grid-cols-3">
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">إصدار سياسة جودة المقالة</span>
          <select
            value={qualityPolicyVersion}
            onChange={event => onChange('contentWritingQualityPolicyVersion', Number(event.target.value))}
            className={inputClass}
          >
            {CONTENT_WRITING_QUALITY_POLICY_VERSIONS.map(version => (
              <option key={version} value={version}>الإصدار {version}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">الحد الأدنى لدرجة الجودة</span>
          <input
            type="number"
            min={50}
            max={100}
            value={minimumQualityScore}
            onChange={event => onChange('contentWritingMinimumQualityScore', Number(event.target.value))}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">أقصى دورات إصلاح تلقائي</span>
          <input
            type="number"
            min={0}
            max={CONTENT_WRITING_MAX_REPAIR_PASSES}
            value={maxRepairPasses}
            onChange={event => onChange('contentWritingMaxRepairPasses', Number(event.target.value))}
            className={inputClass}
          />
        </label>
      </div>

      <p className="text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        تُثبَّت نسخة السياسة والأوامر داخل كل جلسة. يؤثر تعديلها في الجلسات الجديدة فقط، حتى لا تتغير شروط جلسة أثناء الاستئناف.
      </p>
    </div>
  );
};

export default ContentWritingPromptSettings;
