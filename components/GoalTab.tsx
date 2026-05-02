import React from 'react';
import { Target } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import GoalContextFields from './GoalContextFields';

const GoalTab: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
    const { uiLanguage } = useUser();
    const { 
        goalContext,
        setGoalContext,
    } = useEditor();

  const t = translations[uiLanguage].goalTab;
  const updateGoalContext = (key: keyof typeof goalContext, value: string) => {
    setGoalContext(prev => ({ ...prev, [key]: value }));
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
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t.contextDescription}</p>
            </div>
            <GoalContextFields goalContext={goalContext} onChange={updateGoalContext} />
        </div>

      </div>
    </div>
  );
};

export default GoalTab;
