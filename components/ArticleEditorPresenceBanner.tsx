import React from 'react';
import { AlertTriangle, Loader2, WifiOff } from 'lucide-react';
import { useEditorSelector } from '../contexts/EditorContext';
import { useUser } from '../contexts/UserContext';
import { useActiveArticleEditorPresence } from '../hooks/useArticleEditorPresence';

const joinNames = (names: string[]): string => {
  if (names.length <= 2) return names.join(' و');
  return `${names.slice(0, 2).join(' و')} و${names.length - 2} آخرين`;
};

const ArticleEditorPresenceBanner: React.FC = () => {
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const { currentUserId } = useUser();
  const { otherEditors, status } = useActiveArticleEditorPresence(activeArticleId, currentUserId);

  if (!activeArticleId) return null;

  if (status === 'loading') {
    return (
      <div
        className="border-y border-sky-200 bg-sky-50 px-3 py-2 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100"
        role="status"
        dir="rtl"
      >
        <div className="flex items-center gap-2 text-xs font-bold">
          <Loader2 size={15} className="shrink-0 animate-spin" />
          جار التحقق من وجود مستخدم آخر داخل المقالة...
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        className="border-y border-red-300 bg-red-50 px-3 py-2 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
        role="alert"
        dir="rtl"
      >
        <div className="flex items-center gap-2 text-xs font-black">
          <WifiOff size={16} className="shrink-0" />
          تعذر التحقق من وجود محرر آخر الآن. تجنب الحفظ المتزامن حتى يعود الاتصال.
        </div>
      </div>
    );
  }

  if (otherEditors.length === 0) return null;

  const names = joinNames(otherEditors.map(editor => editor.displayName));
  return (
    <div
      className="border-y border-amber-300 bg-amber-50 px-3 py-3 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
      role="alert"
      aria-live="assertive"
      dir="rtl"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <div>
          <p className="text-sm font-black">هذه المقالة مفتوحة الآن لدى {names}</p>
          <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-200/90">
            يمكنك المعاينة، لكن لا تبدأ التعديل أو الحفظ بالتزامن حتى يغادر المستخدم الآخر لتجنب تعارض النسخ.
          </p>
        </div>
      </div>
    </div>
  );
};

export default ArticleEditorPresenceBanner;
