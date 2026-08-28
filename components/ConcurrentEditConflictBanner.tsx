import React, { useState } from 'react';
import { AlertTriangle, Download, Loader2, Upload } from 'lucide-react';
import { useEditorSelector } from '../contexts/EditorContext';

const ConcurrentEditConflictBanner: React.FC = () => {
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const conflict = useEditorSelector(context => context.concurrentEditConflict);
  const reloadActiveArticleFromRemote = useEditorSelector(context => context.reloadActiveArticleFromRemote);
  const handleSaveDraft = useEditorSelector(context => context.handleSaveDraft);
  const [action, setAction] = useState<'reload' | 'overwrite' | ''>('');

  if (!activeArticleId || !conflict || conflict.articleId !== activeArticleId) return null;

  const reloadLatest = async () => {
    setAction('reload');
    await reloadActiveArticleFromRemote(activeArticleId);
    setAction('');
  };

  const overwriteLatest = async () => {
    const confirmed = window.confirm(
      'سيتم اعتماد النسخة المفتوحة لديك فوق النسخة الأحدث على الخادم. هل تريد المتابعة؟',
    );
    if (!confirmed) return;
    setAction('overwrite');
    await handleSaveDraft({ reason: 'manual', force: true, overwriteConflict: true });
    setAction('');
  };

  return (
    <div
      className="border-y border-amber-300 bg-amber-50 px-3 py-3 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
      role="alert"
      dir="rtl"
    >
      <div className="flex flex-wrap items-center gap-3">
        <AlertTriangle size={20} className="shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-[240px] flex-1">
          <p className="text-sm font-black">تم اكتشاف تعديل أحدث من محرر آخر</p>
          <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-200/90">
            أوقفنا الحفظ لحماية عمل الطرفين. نسختك ما زالت محفوظة محليًا؛ حمّل النسخة الأحدث للمراجعة، أو اعتمد نسختك الحالية بقرار صريح.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { void reloadLatest(); }}
            disabled={Boolean(action)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 bg-white px-3 text-xs font-black text-amber-900 transition hover:bg-amber-100 disabled:opacity-60 dark:border-amber-400/40 dark:bg-black/20 dark:text-amber-100"
          >
            {action === 'reload' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            تحميل النسخة الأحدث
          </button>
          <button
            type="button"
            onClick={() => { void overwriteLatest(); }}
            disabled={Boolean(action)}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-600 px-3 text-xs font-black text-white transition hover:bg-amber-700 disabled:opacity-60"
          >
            {action === 'overwrite' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            اعتماد نسختي الحالية
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConcurrentEditConflictBanner;
