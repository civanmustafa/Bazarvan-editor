import React from 'react';
import { Loader2 } from 'lucide-react';

type GeminiProgressLike = {
  active?: boolean;
  completed?: boolean;
  stage?: string;
  message?: string;
  model?: string;
  requestedModel?: string;
  currentModelIndex?: number;
  modelCount?: number;
  attemptedModels?: string[];
  keyCount?: number;
  attemptedKeyCount?: number;
  attemptedModelKeyCount?: number;
  totalAttemptCount?: number;
  currentKeyIndex?: number;
  keySuffix?: string;
  status?: number;
  reason?: string;
};

type GeminiProgressStatusProps = {
  progress?: GeminiProgressLike | null;
  isArabic?: boolean;
  compact?: boolean;
};

const GeminiProgressStatus: React.FC<GeminiProgressStatusProps> = ({
  progress,
  isArabic = true,
  compact = false,
}) => {
  if (!progress || (!progress.active && !progress.message)) return null;
  const attemptedModelKeyCount = progress.attemptedModelKeyCount ?? progress.attemptedKeyCount;

  const stageLabels: Record<string, string> = isArabic
    ? {
        queued: 'بدء الطلب',
        attempting: 'تجربة',
        retrying: 'إعادة محاولة',
        'failed-key': 'فشل المفتاح',
        'switching-key': 'تبديل المفتاح',
        'switching-model': 'تبديل الموديل',
        success: 'نجاح',
        failed: 'فشل',
      }
    : {
        queued: 'Queued',
        attempting: 'Trying',
        retrying: 'Retrying',
        'failed-key': 'Key failed',
        'switching-key': 'Switching key',
        'switching-model': 'Switching model',
        success: 'Success',
        failed: 'Failed',
      };
  const stageLabel = progress.stage ? stageLabels[progress.stage] || progress.stage : (isArabic ? 'Gemini' : 'Gemini');
  const modelStep = progress.currentModelIndex && progress.modelCount && progress.modelCount > 1
    ? (isArabic ? `الموديل ${progress.currentModelIndex}/${progress.modelCount}` : `model ${progress.currentModelIndex}/${progress.modelCount}`)
    : '';
  const triedModelsStep = progress.attemptedModels?.length && progress.modelCount && progress.modelCount > 1
    ? (isArabic
        ? `الموديلات المجربة ${progress.attemptedModels.length}/${progress.modelCount}`
        : `models tried ${progress.attemptedModels.length}/${progress.modelCount}`)
    : '';
  const keyStep = progress.currentKeyIndex && progress.keyCount
    ? (isArabic ? `المفتاح ${progress.currentKeyIndex}/${progress.keyCount}` : `key ${progress.currentKeyIndex}/${progress.keyCount}`)
    : '';
  const triedStep = attemptedModelKeyCount && progress.keyCount
    ? (isArabic ? `جُرّب ${attemptedModelKeyCount}/${progress.keyCount}` : `tried ${attemptedModelKeyCount}/${progress.keyCount}`)
    : '';
  const suffixStep = progress.keySuffix ? `...${progress.keySuffix}` : '';
  const statusStep = progress.status ? `HTTP ${progress.status}` : '';
  const progressLine = [
    stageLabel,
    keyStep,
    progress.model ? (isArabic ? `على ${progress.model}` : `on ${progress.model}`) : '',
    modelStep,
    triedModelsStep,
    triedStep,
    suffixStep,
    statusStep,
  ].filter(Boolean).join(isArabic ? '، ' : ', ');

  return (
    <div className={`rounded-lg border border-[#d4af37]/25 bg-[#d4af37]/10 text-gray-700 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/15 dark:text-gray-200 ${compact ? 'p-2 text-[10px]' : 'p-2.5 text-[11px]'}`}>
      <div className="flex items-center gap-2 font-bold">
        {progress.active && <Loader2 size={compact ? 12 : 14} className="shrink-0 animate-spin text-[#b8922e]" />}
        <span className="min-w-0 break-words">
          {progressLine || progress.message || (isArabic ? 'جاري الاتصال بـ Gemini...' : 'Contacting Gemini...')}
        </span>
      </div>
    </div>
  );
};

export default GeminiProgressStatus;
