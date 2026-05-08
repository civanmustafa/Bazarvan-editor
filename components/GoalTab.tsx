import React from 'react';
import { AlertCircle, CheckCircle, Copy, Loader2, Save, Sparkles, Target } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
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
        title,
    } = useEditor();
    const { generateGoalContext } = useAI();
    const [lastSavedCompany, setLastSavedCompany] = React.useState('');
    const [copyStatus, setCopyStatus] = React.useState('');
    const [isGeneratingGoalContext, setIsGeneratingGoalContext] = React.useState(false);
    const [goalContextGenerationStatus, setGoalContextGenerationStatus] = React.useState('');
    const [isGoalContextGenerationSuccess, setIsGoalContextGenerationSuccess] = React.useState(false);

  const t = translations[uiLanguage].goalTab;
  const companyName = keywords.company.trim();
  const hasGoalContextSource = Boolean(
    title.trim() ||
    keywords.primary.trim() ||
    keywords.secondaries.some(term => term.trim())
  );
  const isClientSaved = Boolean(companyName && clientGoalContexts[companyName]);
  const savedMessage = companyName && lastSavedCompany === companyName
    ? t.clientContextSaved.replace('{company}', companyName)
    : '';
  const contextStatusMessage = savedMessage || (isClientSaved ? t.clientAlreadySaved : '');
  const visibleStatusMessage = goalContextGenerationStatus || copyStatus || contextStatusMessage;
  const visibleStatusClass = goalContextGenerationStatus && !isGoalContextGenerationSuccess
    ? 'text-red-600 dark:text-red-400'
    : 'text-green-600 dark:text-green-400';

  const updateGoalContext = (key: keyof typeof goalContext, value: string) => {
    setGoalContextGenerationStatus('');
    setGoalContext(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveClientContext = () => {
    if (!companyName || isClientSaved) return;
    handleSaveClientGoalContext(companyName, goalContext);
    setLastSavedCompany(companyName);
    setGoalContextGenerationStatus('');
    setCopyStatus('');
  };

  const handleCopyClientContext = async () => {
    await navigator.clipboard.writeText(formatGoalContextForCopy(companyName, goalContext, t));
    setGoalContextGenerationStatus('');
    setCopyStatus(t.clientContextCopied);
  };

  const handleGenerateGoalContext = async () => {
    if (!hasGoalContextSource || isGeneratingGoalContext) {
      setIsGoalContextGenerationSuccess(false);
      setGoalContextGenerationStatus(t.goalContextSourceRequired);
      return;
    }

    setIsGeneratingGoalContext(true);
    setGoalContextGenerationStatus('');
    setCopyStatus('');

    try {
      const result = await generateGoalContext();
      if (result.error || !result.context) {
        setIsGoalContextGenerationSuccess(false);
        setGoalContextGenerationStatus(result.error || t.goalContextGenerationFailed);
        return;
      }

      setGoalContext(result.context);
      setLastSavedCompany('');
      setIsGoalContextGenerationSuccess(true);
      setGoalContextGenerationStatus(t.goalContextGenerated);
    } catch (error) {
      setIsGoalContextGenerationSuccess(false);
      setGoalContextGenerationStatus(t.goalContextGenerationFailed);
    } finally {
      setIsGeneratingGoalContext(false);
    }
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
              <button
                type="button"
                onClick={handleGenerateGoalContext}
                disabled={isGeneratingGoalContext || !hasGoalContextSource}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#d4af37]/10 px-3 py-2 text-sm font-bold text-[#b8922e] transition-colors hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#d4af37]/20 dark:text-[#f2d675] dark:hover:bg-[#d4af37]/30"
                title={!hasGoalContextSource ? t.goalContextSourceRequired : t.generateGoalContext}
              >
                {isGeneratingGoalContext ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                <span>{isGeneratingGoalContext ? t.generatingGoalContext : t.generateGoalContext}</span>
              </button>
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
                    <p className={`flex items-start gap-2 text-xs font-bold ${visibleStatusClass}`} aria-live="polite">
                        {goalContextGenerationStatus && !isGoalContextGenerationSuccess
                          ? <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                          : <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                        }
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
