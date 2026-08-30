import AppSelect from './AppSelect';
import React from 'react';
import { createPortal } from 'react-dom';
import { Building2, Loader2, Plus, X } from 'lucide-react';
import { notifyClientDirectoryChanged } from '../hooks/useClientDirectory';
import { inferClientDefaultLanguage } from '../utils/clientCompanyIdentity';
import {
  createDraftClientCenterClient,
  type ClientCenterClient,
} from '../utils/clientCenter';

type QuickClientCreateModalProps = {
  isOpen: boolean;
  initialName: string;
  primaryKeyword: string;
  fallbackLanguage: string;
  onClose: () => void;
  onCreated: (client: ClientCenterClient) => void | Promise<void>;
};

const inputClass = 'w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm font-semibold text-gray-700 outline-none focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const QuickClientCreateModal: React.FC<QuickClientCreateModalProps> = ({
  isOpen,
  initialName,
  primaryKeyword,
  fallbackLanguage,
  onClose,
  onCreated,
}) => {
  const [name, setName] = React.useState(initialName);
  const [defaultLanguage, setDefaultLanguage] = React.useState('ar');
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) return;
    setName(initialName.trim());
    setDefaultLanguage(inferClientDefaultLanguage(primaryKeyword, fallbackLanguage));
    setIsSaving(false);
    setError('');
  }, [fallbackLanguage, initialName, isOpen, primaryKeyword]);

  React.useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim().replace(/\s+/g, ' ');
    if (normalizedName.length < 2) {
      setError('أدخل اسم الشركة/العميل من حرفين على الأقل.');
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      const client = await createDraftClientCenterClient({
        name: normalizedName,
        defaultLanguage,
      });
      notifyClientDirectoryChanged();
      await onCreated(client);
      onClose();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'تعذر إنشاء سجل العميل الأولي.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 p-3 backdrop-blur-[1px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-client-modal-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]"
        data-testid="quick-client-create-modal"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-[#3C3C3C]">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-[#d4af37]/15 p-2 text-[#b8922e] dark:text-[#f2d675]">
              <Building2 size={20} />
            </span>
            <div>
              <h2 id="quick-client-modal-title" className="text-lg font-black text-gray-900 dark:text-gray-100">
                إضافة شركة/عميل جديد
              </h2>
              <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
                سيُنشأ سجل أولي في مركز العملاء، ويمكن للمسؤول إكمال الدومين وبقية التفاصيل لاحقًا.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-[#1F1F1F] dark:hover:text-gray-200"
            aria-label="إغلاق نافذة إضافة العميل"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="block space-y-1.5">
            <span className="text-xs font-black text-gray-700 dark:text-gray-200">اسم الشركة/العميل</span>
            <input
              className={inputClass}
              value={name}
              onChange={event => setName(event.target.value)}
              required
              minLength={2}
              maxLength={160}
              autoFocus
              data-testid="quick-client-name"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-black text-gray-700 dark:text-gray-200">اللغة الافتراضية</span>
            <AppSelect
              className={inputClass}
              value={defaultLanguage}
              onChange={event => setDefaultLanguage(event.target.value)}
              data-testid="quick-client-language"
            >
              <option value="ar">العربية</option>
              <option value="en">الإنجليزية</option>
              <option value="tr">التركية</option>
            </AppSelect>
            <span className="block text-[11px] font-semibold leading-5 text-gray-400">
              تُحدد تلقائيًا من الكلمة الأساسية؛ إذا كانت بالعربية فستكون العربية هي الاختيار الافتراضي.
            </span>
          </label>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-4 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200 dark:hover:bg-[#3C3C3C]"
          >
            إلغاء
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
            <span>{isSaving ? 'جارٍ الإنشاء...' : 'إنشاء واختيار العميل'}</span>
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

export default QuickClientCreateModal;
