import React, { useMemo } from 'react';
import { KeyRound, Settings2 } from 'lucide-react';
import {
  GEMINI_FREE_MODEL_OPTIONS,
  GEMINI_PAID_MODEL_OPTIONS,
  OPENAI_ANALYSIS_MODEL,
} from '../constants/modelRegistry';
import {
  encodeContentWritingResumeModel,
  parseContentWritingResumeModel,
} from '../constants/contentWritingResume';
import { navigateToAppPath } from '../utils/appRoutes';

type ContentWritingResumeSettingsProps = {
  values: Record<string, unknown>;
  onChange: (field: 'contentWritingResumeModel', value: string) => void;
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const ContentWritingResumeSettings: React.FC<ContentWritingResumeSettingsProps> = ({ values, onChange }) => {
  const resumeModelValue = String(values.contentWritingResumeModel || '');
  const openAiModel = String(values.defaultOpenAiModel || OPENAI_ANALYSIS_MODEL).trim()
    || OPENAI_ANALYSIS_MODEL;
  const modelOptions = useMemo(() => ([
    {
      value: '',
      label: 'اختيار المستخدم الظاهر أعلى تبويب كتابة المحتوى',
    },
    ...GEMINI_FREE_MODEL_OPTIONS.map(option => ({
      value: encodeContentWritingResumeModel('gemini', option.value),
      label: `Gemini المجاني — ${option.label}`,
    })),
    ...GEMINI_PAID_MODEL_OPTIONS.map(option => ({
      value: encodeContentWritingResumeModel('geminiPaid', option.value),
      label: `Gemini Pro — ${option.label}`,
    })),
    {
      value: encodeContentWritingResumeModel('openai', openAiModel),
      label: `OpenAI — ${openAiModel}`,
    },
  ]), [openAiModel]);
  const preference = parseContentWritingResumeModel(resumeModelValue);

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/10">
      <div className="mb-4 flex items-start gap-2">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
        <div>
          <div className="text-sm font-black text-gray-800 dark:text-gray-100">إعدادات الاستئناف</div>
          <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            يحدد الموديل أدناه الاختيار الابتدائي فقط. جميع مفاتيح الاستئناف محفوظة ومدارة من مركز المزودات الموحد، ولا يوجد نموذج منفصل لحفظها في إعدادات الكتابة.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">
            الموديل الخاص بالاستئناف
          </span>
          <select
            value={modelOptions.some(option => option.value === resumeModelValue) ? resumeModelValue : ''}
            onChange={event => onChange('contentWritingResumeModel', event.target.value)}
            className={inputClass}
          >
            {modelOptions.map(option => (
              <option key={option.value || 'user-selection'} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="mt-1.5 block text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            احفظ إعدادات الصفحة بعد تغييره. إذا اختار المستخدم موديلًا آخر في تبويب الكتابة، فسيُستأنف بالموديل الذي اختاره المستخدم.
          </span>
        </label>

        <div className="rounded-md border border-indigo-200 bg-white p-3 dark:border-indigo-900/60 dark:bg-[#242424]">
          <div className="text-sm font-black text-gray-800 dark:text-gray-100">مفتاح الاستئناف وصلاحياته</div>
          <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            من مركز المزودات اختر {preference ? 'المزود المطابق للموديل المحدد' : 'مزود الذكاء الاصطناعي المطلوب'}، ثم اختر الغرض «استئناف جلسات كتابة المحتوى». احفظه دون تعيين أو عيّنه صراحة لمستخدم محدد أو للجميع.
          </p>
          <button
            type="button"
            onClick={() => navigateToAppPath('/settings/ai')}
            className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-xs font-black text-white hover:bg-indigo-700"
          >
            <Settings2 size={15} />
            فتح مركز المزودات والمفاتيح
          </button>
        </div>
      </div>
    </div>
  );
};

export default ContentWritingResumeSettings;
