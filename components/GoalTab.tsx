import React from 'react';
import { CheckCircle, Copy, Save, Target } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import GoalContextFields from './GoalContextFields';
import { formatGoalContextForCopy } from '../utils/goalContext';

const GoalTab: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
    const {
        uiLanguage,
        clientGoalContexts,
        handleSaveClientGoalContext,
    } = useUser();
    const { 
        goalContext,
        setGoalContext,
        keywords,
    } = useEditor();
    const [lastSavedCompany, setLastSavedCompany] = React.useState('');
    const [copyStatus, setCopyStatus] = React.useState('');

  const t = translations[uiLanguage].goalTab;
  const companyName = keywords.company.trim();
  const isClientSaved = Boolean(companyName && clientGoalContexts[companyName]);
  const savedMessage = companyName && lastSavedCompany === companyName
    ? t.clientContextSaved.replace('{company}', companyName)
    : '';
  const contextStatusMessage = savedMessage || (isClientSaved ? t.clientAlreadySaved : '');
  const visibleStatusMessage = copyStatus || contextStatusMessage;

  const updateGoalContext = (key: keyof typeof goalContext, value: string) => {
    setGoalContext(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveClientContext = () => {
    if (!companyName || isClientSaved) return;
    handleSaveClientGoalContext(companyName, goalContext);
    setLastSavedCompany(companyName);
    setCopyStatus('');
  };

  const handleCopyClientContext = async () => {
    await navigator.clipboard.writeText(formatGoalContextForCopy(companyName, goalContext, t));
    setCopyStatus(t.clientContextCopied);
  };

  return (
    <div className={`${embedded ? 'p-0' : 'p-4'} space-y-4`}>
      <div className="bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border dark:border-[#3C3C3C] p-4 space-y-4 transition-all duration-300 border-gray-200 dark:border-transparent">
        <div className="space-y-3">
            <div>
                <div className="flex items-center gap-2">
                    <span className="text-[#d4af37]"><Target size={20} /></span>
                    <h4 className="text-sm font-bold text-[#333333] dark:text-gray-100">{t.contextTitle}</h4>
                </div>
            </div>
            <GoalContextFields goalContext={goalContext} onChange={updateGoalContext} />
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={handleSaveClientContext}
                    disabled={!companyName || isClientSaved}
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#d4af37] text-white transition-colors hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                    title={!companyName ? t.companyRequiredForContextSave : t.saveClientContext}
                    aria-label={t.saveClientContext}
                >
                    <Save size={16} />
                </button>
                <button
                    type="button"
                    onClick={handleCopyClientContext}
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-[#d4af37]/15 dark:bg-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#d4af37]/25"
                    title={t.copyClientContext}
                    aria-label={t.copyClientContext}
                >
                    <Copy size={16} />
                </button>
              </div>
                {visibleStatusMessage && (
                    <p className="flex items-start gap-2 text-xs font-bold text-green-600 dark:text-green-400" aria-live="polite">
                        <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                        <span>{visibleStatusMessage}</span>
                    </p>
                )}
                {!companyName && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t.companyRequiredForContextSave}
                    </p>
                )}
            </div>
        </div>

      </div>
    </div>
  );
};

export default GoalTab;
