import React, { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, X, XCircle } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  AI_KEY_USAGE_FEEDBACK_EVENT,
  formatAiKeySuffix,
  type AiKeyUsageFeedback,
} from '../utils/aiKeyUsageFeedback';

const NOTICE_TTL_MS = 9_000;

const AiKeyUsageToast: React.FC = () => {
  const { uiLanguage } = useUser();
  const isArabic = uiLanguage !== 'en';
  const [notices, setNotices] = useState<AiKeyUsageFeedback[]>([]);

  useEffect(() => {
    const handleFeedback = (event: Event) => {
      const feedback = (event as CustomEvent<AiKeyUsageFeedback>).detail;
      if (!feedback?.id || !Array.isArray(feedback.entries) || feedback.entries.length === 0) return;
      setNotices(current => [...current.filter(item => item.id !== feedback.id), feedback].slice(-4));
      window.setTimeout(() => {
        setNotices(current => current.filter(item => item.id !== feedback.id));
      }, NOTICE_TTL_MS);
    };
    window.addEventListener(AI_KEY_USAGE_FEEDBACK_EVENT, handleFeedback);
    return () => window.removeEventListener(AI_KEY_USAGE_FEEDBACK_EVENT, handleFeedback);
  }, []);

  if (notices.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[10000] flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2" dir={isArabic ? 'rtl' : 'ltr'}>
      {notices.map(notice => {
        const hasSuccess = notice.entries.some(entry => entry.outcome === 'success');
        const hasFailure = notice.entries.some(entry => entry.outcome === 'failed');
        const title = hasSuccess && hasFailure
          ? (isArabic ? 'نتيجة استخدام مفاتيح API' : 'API key usage result')
          : hasSuccess
            ? (isArabic ? 'نجح مفتاح API' : 'API key succeeded')
            : (isArabic ? 'فشل مفتاح API' : 'API key failed');
        return (
          <div key={notice.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-[#3C3C3C] dark:bg-[#242424]">
            <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-[#333]">
              <KeyRound size={15} className="shrink-0 text-[#b8922e]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-black text-gray-800 dark:text-gray-100">{title}</div>
                <div className="truncate text-[10px] font-bold text-gray-400" dir="ltr">{notice.provider}</div>
              </div>
              <button
                type="button"
                onClick={() => setNotices(current => current.filter(item => item.id !== notice.id))}
                className="flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-[#333] dark:hover:text-gray-100"
                aria-label={isArabic ? 'إغلاق' : 'Close'}
              >
                <X size={14} />
              </button>
            </div>
            <div className="max-h-44 overflow-y-auto p-2 custom-scrollbar">
              {notice.entries.map((entry, index) => (
                <div
                  key={`${entry.outcome}-${entry.keySuffix}-${entry.status || 0}-${index}`}
                  className={`mb-1 flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] font-bold last:mb-0 ${
                    entry.outcome === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                  }`}
                >
                  {entry.outcome === 'success'
                    ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
                    : <XCircle size={13} className="mt-0.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    {entry.outcome === 'success'
                      ? (isArabic ? 'نجح المفتاح' : 'Key succeeded')
                      : (isArabic ? 'فشل المفتاح' : 'Key failed')}
                    {' '}
                    <span className="font-mono font-black" dir="ltr">{formatAiKeySuffix(entry.keySuffix)}</span>
                    {entry.status ? ` · HTTP ${entry.status}` : ''}
                    {entry.model ? <span className="mt-0.5 block truncate font-mono text-[9px] opacity-75" dir="ltr">{entry.model}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default AiKeyUsageToast;
