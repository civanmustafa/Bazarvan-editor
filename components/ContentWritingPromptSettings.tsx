import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, RotateCcw } from 'lucide-react';
import {
  CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_MAX_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_MIN_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_TEMPLATE_FIELDS,
  CONTENT_WRITING_VARIABLES,
  DEFAULT_CONTENT_WRITING_TEMPLATES,
  inspectContentWritingTemplate,
  type ContentWritingTemplateField,
  type ContentWritingTemplateStage,
} from '../constants/contentWriting';
import { buildContentWritingPromptBundle } from '../utils/contentWritingContext';
import {
  CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION,
  CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES,
  CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE,
  CONTENT_WRITING_MAX_REPAIR_PASSES,
  CONTENT_WRITING_QUALITY_POLICY_VERSIONS,
} from '../constants/contentWritingQuality';

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

const TEMPLATE_DEFINITIONS: Array<{
  stage: ContentWritingTemplateStage;
  label: string;
  rows: number;
}> = [
  { stage: 'instructions', label: '1. تعليمات وضوابط كتابة المحتوى', rows: 9 },
  { stage: 'articleContext', label: '2. بيانات المقالة ومحتوى المنافسين', rows: 15 },
  { stage: 'generationRequest', label: '3. طلب كتابة المقالة', rows: 7 },
];

const SAMPLE_ARTICLE = {
  articleId: 'preview-article',
  title: 'دليل اختيار الخدمة المناسبة',
  language: 'ar' as const,
  articleText: 'نص المقالة الحالي للمعاينة.',
  keywords: {
    primary: 'اختيار الخدمة المناسبة',
    secondaries: ['أفضل خدمة', 'مقارنة الخدمات'],
    company: 'الشركة التجريبية',
    lsi: ['جودة الخدمة', 'تكلفة الخدمة'],
  },
  goalContext: {
    pageType: 'guide',
    objective: 'compare',
    audienceScope: 'country',
    targetCountry: 'السعودية',
    targetAudience: 'الأشخاص الذين يقارنون بين الخدمات',
    searchIntent: 'commercial',
  },
  competitors: [1, 2, 3].map(position => ({
    position,
    title: `المنافس ${position}`,
    url: `https://example.com/competitor-${position}`,
    content: `المحتوى الكامل التجريبي للمنافس ${position}.`,
  })),
};

const ContentWritingPromptSettings: React.FC<ContentWritingPromptSettingsProps> = ({ values, onChange }) => {
  const [showPreview, setShowPreview] = useState(false);
  const templates = useMemo(() => ({
    instructions: String(values[CONTENT_WRITING_TEMPLATE_FIELDS.instructions] ?? ''),
    articleContext: String(values[CONTENT_WRITING_TEMPLATE_FIELDS.articleContext] ?? ''),
    generationRequest: String(values[CONTENT_WRITING_TEMPLATE_FIELDS.generationRequest] ?? ''),
  }), [values]);
  const inputBudget = Number(values.contentWritingMaxInputTokens || CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
  const qualityPolicyVersion = Number(values.contentWritingQualityPolicyVersion || CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
  const minimumQualityScore = Number(values.contentWritingMinimumQualityScore || CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
  const maxRepairPasses = Number(values.contentWritingMaxRepairPasses ?? CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);
  const inspections = useMemo(() => Object.fromEntries(
    TEMPLATE_DEFINITIONS.map(definition => [
      definition.stage,
      inspectContentWritingTemplate(definition.stage, templates[definition.stage]),
    ]),
  ) as Record<ContentWritingTemplateStage, ReturnType<typeof inspectContentWritingTemplate>>, [templates]);
  const preview = useMemo(() => buildContentWritingPromptBundle(SAMPLE_ARTICLE, {
    templates,
    maxInputTokens: inputBudget,
  }), [inputBudget, templates]);
  const allTemplatesValid = TEMPLATE_DEFINITIONS.every(definition => inspections[definition.stage].isValid);

  const resetDefaults = () => {
    TEMPLATE_DEFINITIONS.forEach(({ stage }) => {
      onChange(CONTENT_WRITING_TEMPLATE_FIELDS[stage], DEFAULT_CONTENT_WRITING_TEMPLATES[stage]);
    });
    onChange('contentWritingMaxInputTokens', CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
    onChange('contentWritingQualityPolicyVersion', CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
    onChange('contentWritingMinimumQualityScore', CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
    onChange('contentWritingMaxRepairPasses', CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          {allTemplatesValid ? (
            <CheckCircle2 size={17} className="text-emerald-600" />
          ) : (
            <AlertTriangle size={17} className="text-red-600" />
          )}
          <span className={allTemplatesValid ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
            {allTemplatesValid ? 'القوالب صالحة' : 'توجد متغيرات ناقصة أو غير معروفة'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowPreview(current => !current)}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:border-[#d4af37] hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:text-[#f2d675]"
          >
            <Eye size={15} />
            معاينة الرسائل
          </button>
          <button
            type="button"
            onClick={resetDefaults}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:border-[#d4af37] hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:text-[#f2d675]"
          >
            <RotateCcw size={15} />
            استعادة الافتراضي
          </button>
        </div>
      </div>

      <div className="border-y border-gray-200 py-3 dark:border-[#3C3C3C]">
        <div className="mb-2 text-xs font-bold text-gray-500 dark:text-gray-400">المتغيرات المتاحة</div>
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {CONTENT_WRITING_VARIABLES.map(variable => (
            <span key={variable.key} className="text-xs text-gray-600 dark:text-gray-300" title={variable.label}>
              <code dir="ltr" className="font-bold text-[#8a6f1d] dark:text-[#f2d675]">{`{{${variable.key}}}`}</code>
              <span className="ms-1">{variable.label}</span>
            </span>
          ))}
        </div>
      </div>

      {TEMPLATE_DEFINITIONS.map(({ stage, label, rows }) => {
        const field = CONTENT_WRITING_TEMPLATE_FIELDS[stage];
        const inspection = inspections[stage];
        return (
          <label key={stage} className="block border-b border-gray-200 pb-5 last:border-b-0 dark:border-[#3C3C3C]">
            <span className="mb-2 block text-sm font-black text-gray-700 dark:text-gray-200">{label}</span>
            <textarea
              value={templates[stage]}
              onChange={event => onChange(field, event.target.value)}
              rows={rows}
              dir="rtl"
              spellCheck
              className="w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm leading-7 text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
            />
            {!inspection.isValid && (
              <span className="mt-2 block text-xs font-bold leading-5 text-red-600 dark:text-red-400">
                {!templates[stage].trim() ? 'القالب فارغ. ' : ''}
                {inspection.unknownPlaceholders.length > 0
                  ? `متغيرات غير معروفة: ${inspection.unknownPlaceholders.join('، ')}. `
                  : ''}
                {inspection.missingRequiredPlaceholders.length > 0
                  ? `متغيرات مطلوبة ناقصة: ${inspection.missingRequiredPlaceholders.join('، ')}.`
                  : ''}
              </span>
            )}
          </label>
        );
      })}

      <label className="block max-w-sm">
        <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">حد الإدخال الآمن لطلب كتابة المحتوى (وحدة تقديرية)</span>
        <input
          type="number"
          min={CONTENT_WRITING_MIN_INPUT_TOKEN_BUDGET}
          max={CONTENT_WRITING_MAX_INPUT_TOKEN_BUDGET}
          step={5_000}
          value={Number.isFinite(inputBudget) ? inputBudget : CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET}
          onChange={event => onChange('contentWritingMaxInputTokens', Number(event.target.value))}
          className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
        />
      </label>

      <div className="grid gap-4 border-t border-gray-200 pt-5 dark:border-[#3C3C3C] md:grid-cols-3">
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">إصدار سياسة جودة المقالة</span>
          <select
            value={qualityPolicyVersion}
            onChange={event => onChange('contentWritingQualityPolicyVersion', Number(event.target.value))}
            className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
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
            className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
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
            className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
          />
        </label>
      </div>
      <p className="text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        تُثبَّت نسخة السياسة داخل كل جلسة. تغيير هذه القيم يؤثر في الجلسات الجديدة فقط، ويمكن إضافة إصدارات جديدة أو الرجوع إلى إصدار سابق دون تغيير الجلسات التاريخية.
      </p>

      {showPreview && (
        <div className="border-t border-gray-200 pt-4 dark:border-[#3C3C3C]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-gray-500 dark:text-gray-400">
            <span>المعاينة: {preview.estimatedInputTokens.toLocaleString('ar')} وحدة تقديرية من {preview.maxInputTokens.toLocaleString('ar')}</span>
            <span className={preview.ready ? 'text-emerald-600' : 'text-red-600'}>
              {preview.ready ? 'جاهزة للإرسال' : 'غير جاهزة للإرسال'}
            </span>
          </div>
          <div className="space-y-4">
            {preview.messages.map((message, index) => (
              <div key={message.stage}>
                <div className="mb-1 text-xs font-black text-gray-700 dark:text-gray-200">الرسالة {index + 1}</div>
                <pre dir="rtl" className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
                  {message.content}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ContentWritingPromptSettings;
