import React from 'react';
import { Loader2 } from 'lucide-react';

type GeminiProgressLike = {
  active?: boolean;
  completed?: boolean;
  message?: string;
  model?: string;
  requestedModel?: string;
  keyCount?: number;
  attemptedKeyCount?: number;
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

  const meta = [
    progress.model ? `${isArabic ? 'الموديل' : 'Model'}: ${progress.model}` : '',
    progress.requestedModel && progress.requestedModel !== progress.model ? `${isArabic ? 'المطلوب' : 'Requested'}: ${progress.requestedModel}` : '',
    progress.currentKeyIndex && progress.keyCount ? `${isArabic ? 'المفتاح' : 'Key'} ${progress.currentKeyIndex}/${progress.keyCount}` : '',
    progress.attemptedKeyCount && progress.keyCount ? `${isArabic ? 'تمت تجربة' : 'Tried'} ${progress.attemptedKeyCount}/${progress.keyCount}` : '',
    progress.keySuffix ? `...${progress.keySuffix}` : '',
    progress.status ? `HTTP ${progress.status}` : '',
    progress.reason || '',
  ].filter(Boolean).join(' | ');

  return (
    <div className={`rounded-lg border border-[#d4af37]/25 bg-[#d4af37]/10 text-gray-700 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/15 dark:text-gray-200 ${compact ? 'p-2 text-[10px]' : 'p-2.5 text-[11px]'}`}>
      <div className="flex items-center gap-2 font-bold">
        {progress.active && <Loader2 size={compact ? 12 : 14} className="shrink-0 animate-spin text-[#b8922e]" />}
        <span className="min-w-0 break-words">
          {progress.message || (isArabic ? 'جاري الاتصال بـ Gemini...' : 'Contacting Gemini...')}
        </span>
      </div>
      {meta && (
        <div className="mt-1 ps-5 font-black uppercase tracking-wide text-gray-500 dark:text-gray-400" dir="ltr">
          {meta}
        </div>
      )}
    </div>
  );
};

export default GeminiProgressStatus;
