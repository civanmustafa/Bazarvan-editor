import React, { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';

type GeminiProgressLike = {
  id?: string;
  progressId?: string;
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
  onCancel?: (progressId: string) => void | Promise<void>;
};

const GeminiProgressStatus: React.FC<GeminiProgressStatusProps> = ({
  progress,
  isArabic = true,
  compact = false,
  onCancel,
}) => {
  const [isCancelling, setIsCancelling] = useState(false);
  const progressId = progress?.progressId || progress?.id || '';

  useEffect(() => {
    setIsCancelling(false);
  }, [progressId, progress?.stage]);

  if (!progress || (!progress.active && !progress.message)) return null;
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
        cancelled: 'تم الإيقاف',
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
        cancelled: 'Cancelled',
      };
  const stageLabel = progress.stage ? stageLabels[progress.stage] || progress.stage : (isArabic ? 'Gemini' : 'Gemini');
  const modelPosition = progress.currentModelIndex && progress.modelCount
    ? `${progress.currentModelIndex}/${progress.modelCount}`
    : '';
  const modelStep = progress.model
    ? `${isArabic ? 'الموديل' : 'Model'} ${progress.model}${modelPosition ? ` (${modelPosition})` : ''}`
    : '';
  const keyStep = progress.currentKeyIndex && progress.keyCount
    ? `${isArabic ? 'المفتاح' : 'Key'} ${progress.currentKeyIndex}/${progress.keyCount}`
    : '';
  const suffixStep = progress.keySuffix ? `...${progress.keySuffix}` : '';
  const statusStep = progress.status ? `HTTP ${progress.status}` : '';
  const singleLine = [modelStep, keyStep, suffixStep, stageLabel, statusStep]
    .filter(Boolean)
    .join(isArabic ? '، ' : ', ');
  const canCancel = Boolean(progress.active && !progress.completed && progressId && onCancel);
  const handleCancel = async () => {
    if (!canCancel || isCancelling || !onCancel) return;
    setIsCancelling(true);
    try {
      await onCancel(progressId);
    } catch (error) {
      console.error('Could not cancel Gemini analysis:', error);
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <div className={`rounded-lg border ${progress.stage === 'cancelled' ? 'border-red-300 bg-red-50/80 dark:border-red-500/40 dark:bg-red-500/10' : 'border-[#d4af37]/25 bg-[#d4af37]/10 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/15'} text-gray-700 dark:text-gray-200 ${compact ? 'p-2 text-[10px]' : 'p-2.5 text-[11px]'}`}>
      <div className="flex items-start gap-2">
        {progress.active && <Loader2 size={compact ? 12 : 14} className="shrink-0 animate-spin text-[#b8922e]" />}
        <div className="min-w-0 flex-1 truncate" title={[singleLine, progress.message].filter(Boolean).join('\n')}>
          <div className="truncate whitespace-nowrap font-bold">
            {singleLine || progress.message || (isArabic ? 'جاري الاتصال بـ Gemini...' : 'Contacting Gemini...')}
          </div>
        </div>
        {canCancel && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={isCancelling}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-red-300 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:cursor-wait disabled:opacity-60 dark:border-red-500/50 dark:bg-[#262626] dark:text-red-400 dark:hover:bg-red-500/10"
            title={isArabic ? 'إيقاف التحليل الذكي' : 'Stop AI analysis'}
            aria-label={isArabic ? 'إيقاف التحليل الذكي' : 'Stop AI analysis'}
          >
            {isCancelling
              ? <Loader2 size={13} className="animate-spin" />
              : <Square size={12} fill="currentColor" />}
          </button>
        )}
      </div>
    </div>
  );
};

export default GeminiProgressStatus;
