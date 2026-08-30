import AppSelect from './AppSelect';
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
import ContentWritingResumeSettings from './ContentWritingResumeSettings';
import ContentWritingAutomationSettings from './ContentWritingAutomationSettings';

type ContentWritingPromptSettingsProps = {
  values: Record<string, unknown>;
  onChange: (
    field: ContentWritingTemplateField
      | 'contentWritingMaxInputTokens'
      | 'contentWritingQualityPolicyVersion'
      | 'contentWritingMinimumQualityScore'
      | 'contentWritingMaxRepairPasses'
      | 'contentWritingQualityOverrideReasonRequired'
      | 'contentWritingCompetitorPhraseIntelligenceEnabled'
      | 'contentWritingDualKnowledgeExtractionEnabled'
      | 'contentWritingMultiCandidateGenerationEnabled'
      | 'contentWritingResumeModel'
      | 'contentWritingAutomationEnabled'
      | 'contentWritingAutomationIntervalMinutes'
      | 'contentWritingAutomationProvider'
      | 'contentWritingAutomationModel'
      | 'contentWritingAutomationMinimumCompetitors'
      | 'contentWritingAutomationRequireCompetitorTerminalState'
      | 'contentWritingAutomationMaxAttempts'
      | 'contentWritingAutomationRetryMinutes',
    value: string | number | boolean,
  ) => void;
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const ContentWritingPromptSettings: React.FC<ContentWritingPromptSettingsProps> = ({ values, onChange }) => {
  const inputBudget = Number(values.contentWritingMaxInputTokens || CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
  const qualityPolicyVersion = Number(values.contentWritingQualityPolicyVersion || CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
  const minimumQualityScore = Number(values.contentWritingMinimumQualityScore || CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
  const maxRepairPasses = Number(values.contentWritingMaxRepairPasses ?? CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);
  const qualityOverrideReasonRequired = values.contentWritingQualityOverrideReasonRequired !== false;
  const competitorPhraseIntelligenceEnabled = values.contentWritingCompetitorPhraseIntelligenceEnabled !== false;
  const dualKnowledgeExtractionEnabled = values.contentWritingDualKnowledgeExtractionEnabled !== false;
  const multiCandidateGenerationEnabled = values.contentWritingMultiCandidateGenerationEnabled !== false;

  const resetDefaults = () => {
    onChange('contentWritingMaxInputTokens', CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET);
    onChange('contentWritingQualityPolicyVersion', CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION);
    onChange('contentWritingMinimumQualityScore', CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE);
    onChange('contentWritingMaxRepairPasses', CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES);
    onChange('contentWritingQualityOverrideReasonRequired', true);
    onChange('contentWritingCompetitorPhraseIntelligenceEnabled', true);
    onChange('contentWritingDualKnowledgeExtractionEnabled', true);
    onChange('contentWritingMultiCandidateGenerationEnabled', true);
    onChange('contentWritingResumeModel', '');
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

      <ContentWritingResumeSettings values={values} onChange={onChange} />

      <ContentWritingAutomationSettings values={values} onChange={onChange} />

      <div className="grid gap-4 border-t border-gray-200 pt-5 dark:border-[#3C3C3C] md:grid-cols-3">
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">إصدار سياسة جودة المقالة</span>
          <AppSelect
            value={qualityPolicyVersion}
            onChange={event => onChange('contentWritingQualityPolicyVersion', Number(event.target.value))}
            className={inputClass}
          >
            {CONTENT_WRITING_QUALITY_POLICY_VERSIONS.map(version => (
              <option key={version} value={version}>الإصدار {version}</option>
            ))}
          </AppSelect>
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

      <label className="flex max-w-2xl cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#242424]">
        <input
          type="checkbox"
          checked={qualityOverrideReasonRequired}
          onChange={event => onChange('contentWritingQualityOverrideReasonRequired', event.target.checked)}
          className="mt-1 size-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
        />
        <span className="min-w-0">
          <span className="block text-sm font-black text-gray-700 dark:text-gray-200">
            إلزام سبب عند تجاوز بوابة الجودة
          </span>
          <span className="mt-1 block text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            عند التفعيل يجب على المسؤول والموظف كتابة سبب من 8 أحرف على الأقل لاعتماد مقالة لم تجتز البوابة. عند التعطيل يمكنهما الاعتماد دون إدخال سبب.
          </span>
        </span>
      </label>

      <label className="flex max-w-2xl cursor-pointer items-start gap-3 rounded-lg border border-[#d4af37]/25 bg-[#d4af37]/5 p-3 dark:border-[#d4af37]/20 dark:bg-[#d4af37]/10">
        <input
          type="checkbox"
          checked={competitorPhraseIntelligenceEnabled}
          onChange={event => onChange('contentWritingCompetitorPhraseIntelligenceEnabled', event.target.checked)}
          className="mt-1 size-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
        />
        <span className="min-w-0">
          <span className="block text-sm font-black text-gray-700 dark:text-gray-200">
            تفعيل ذكاء عبارات المنافسين في كتابة المحتوى
          </span>
          <span className="mt-1 block text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            عند التفعيل يحلل النظام العبارات المشتركة والمكررة ويقارنها بالكلمة الأساسية والصيغ البديلة وLSI، ثم يمرر الإشارات المهمة إلى مصفوفة المنافسين ومراحل الكتابة دون حشو أو نسخ.
          </span>
        </span>
      </label>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/50 dark:bg-blue-900/10">
          <input
            type="checkbox"
            checked={dualKnowledgeExtractionEnabled}
            onChange={event => onChange('contentWritingDualKnowledgeExtractionEnabled', event.target.checked)}
            className="mt-1 size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="min-w-0">
            <span className="block text-sm font-black text-gray-700 dark:text-gray-200">
              قراءتان مستقلتان لمصفوفة المعرفة
            </span>
            <span className="mt-1 block text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
              ينفذ «القراءة الشاملة المباشرة» و«قراءة صيد الثغرات» لجميع مقاطع المنافسين، ثم يرسل النتيجتين إلى طلب مصالحة ثالث ويبقي مصدر كل فكرة ظاهرًا للمراجعة.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-900/10">
          <input
            type="checkbox"
            checked={multiCandidateGenerationEnabled}
            onChange={event => onChange('contentWritingMultiCandidateGenerationEnabled', event.target.checked)}
            className="mt-1 size-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
          />
          <span className="min-w-0">
            <span className="block text-sm font-black text-gray-700 dark:text-gray-200">
              وضع المقارنة الثنائية للكتابة
            </span>
            <span className="mt-1 block text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
              عند التفعيل يولد «الكتابة المركّزة الشاملة» و«الكتابة العميقة الاستقصائية»، ثم يقارنهما ويعتمد الأفضل. عند التعطيل يستخدم مرشحًا واحدًا باسم «الكتابة المتوازنة» يجمع العمق والتركيز.
            </span>
            <span className={`mt-1.5 inline-flex rounded px-2 py-1 text-[10px] font-black ${multiCandidateGenerationEnabled
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200'}`}>
              {multiCandidateGenerationEnabled
                ? 'الحالي: كتابة مركّزة + كتابة عميقة'
                : 'الحالي: كتابة متوازنة بمرشح واحد'}
            </span>
          </span>
        </label>
      </div>

      <p className="text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        تُثبَّت نسخة سياسة التوليد والأوامر وإشارات عبارات المنافسين وخيارات تعدد القراءات والمرشحين داخل كل جلسة حتى لا تتغير شروطها أثناء الاستئناف. أما خيار سبب تجاوز بوابة الجودة فيُطبق فورًا عند الاعتماد.
      </p>
    </div>
  );
};

export default ContentWritingPromptSettings;
