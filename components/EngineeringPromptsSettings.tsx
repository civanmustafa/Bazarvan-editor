import React, { useMemo, useState } from 'react';
import { LockKeyhole, RotateCcw, Save, TerminalSquare } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  DEFAULT_ENGINEERING_PROMPTS,
  ENGINEERING_PROMPT_DEFINITIONS,
  ENGINEERING_PROMPT_PASSWORD,
  normalizeEngineeringPrompts,
} from '../constants/engineeringPrompts';
import type { EngineeringPromptDefinition, EngineeringPromptSource, EngineeringPrompts } from '../types';

const inputClass = 'w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500';

const getSourceOrder = (source: EngineeringPromptSource) => (source === 'smartAnalysis' ? 0 : 1);

const EngineeringPromptsSettings: React.FC = () => {
  const { engineeringPrompts, handleSaveEngineeringPrompts, t } = useUser();
  const labels = t.engineeringPrompts;
  const [password, setPassword] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [draftPrompts, setDraftPrompts] = useState<EngineeringPrompts>(() => normalizeEngineeringPrompts(engineeringPrompts));

  const groupedDefinitions = useMemo(() => {
    return ENGINEERING_PROMPT_DEFINITIONS
      .slice()
      .sort((a, b) => getSourceOrder(a.source) - getSourceOrder(b.source))
      .reduce<Record<EngineeringPromptSource, EngineeringPromptDefinition[]>>((groups, definition) => {
        groups[definition.source].push(definition);
        return groups;
      }, { smartAnalysis: [], toolbar: [] });
  }, []);

  const handleUnlock = () => {
    if (password === ENGINEERING_PROMPT_PASSWORD) {
      setDraftPrompts(normalizeEngineeringPrompts(engineeringPrompts));
      setIsUnlocked(true);
      setError('');
      setStatus('');
      setPassword('');
      return;
    }
    setError(labels.wrongPassword);
  };

  const handlePromptChange = (id: string, value: string) => {
    setDraftPrompts(prev => ({ ...prev, [id]: value }));
    setStatus('');
  };

  const handleResetPrompt = (id: string) => {
    setDraftPrompts(prev => ({ ...prev, [id]: DEFAULT_ENGINEERING_PROMPTS[id] || '' }));
    setStatus('');
  };

  const handleResetAll = () => {
    setDraftPrompts(normalizeEngineeringPrompts(DEFAULT_ENGINEERING_PROMPTS));
    setStatus('');
  };

  const handleSave = () => {
    handleSaveEngineeringPrompts(draftPrompts);
    setDraftPrompts(normalizeEngineeringPrompts(draftPrompts));
    setStatus(labels.saved);
  };

  const getPromptLabel = (definition: EngineeringPromptDefinition) => {
    if (definition.source === 'smartAnalysis') {
      return (t.rightSidebar as any)[definition.labelKey] || definition.labelKey;
    }
    return (t.aiMenu as any)[definition.labelKey] || definition.labelKey;
  };

  const renderPromptCard = (definition: EngineeringPromptDefinition) => (
    <div key={definition.id} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h6 className="truncate text-sm font-bold text-[#333333] dark:text-gray-100">{getPromptLabel(definition)}</h6>
          <p className="mt-0.5 text-[10px] font-mono text-gray-400">{definition.id}</p>
        </div>
        <button
          type="button"
          onClick={() => handleResetPrompt(definition.id)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:text-gray-400 dark:hover:bg-[#d4af37]/20"
          title={labels.resetOne}
        >
          <RotateCcw size={13} />
          <span>{labels.resetOne}</span>
        </button>
      </div>
      {definition.variables && definition.variables.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
          <span className="font-bold">{labels.variables}:</span>
          {definition.variables.map(variable => (
            <code key={variable} className="rounded bg-gray-100 px-1.5 py-0.5 text-[#8a6f1d] dark:bg-[#2A2A2A] dark:text-[#f2d675]">{variable}</code>
          ))}
        </div>
      )}
      <textarea
        value={draftPrompts[definition.id] || ''}
        onChange={(event) => handlePromptChange(definition.id, event.target.value)}
        rows={7}
        className={`${inputClass} custom-scrollbar font-mono text-xs leading-relaxed`}
      />
    </div>
  );

  return (
    <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-[#3C3C3C]">
      <div className="flex items-center gap-2">
        <TerminalSquare size={18} className="text-[#d4af37]" />
        <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300">{labels.title}</h4>
      </div>

      {!isUnlocked ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <div className="mb-3 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <LockKeyhole size={16} className="mt-0.5 shrink-0 text-[#d4af37]" />
            <p>{labels.lockedDescription}</p>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleUnlock();
              }}
              className={inputClass}
              placeholder={labels.passwordPlaceholder}
            />
            <button
              type="button"
              onClick={handleUnlock}
              className="shrink-0 rounded-lg bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
            >
              {labels.unlock}
            </button>
          </div>
          {error && <p className="mt-2 text-xs font-bold text-red-600 dark:text-red-400">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          {(['smartAnalysis', 'toolbar'] as EngineeringPromptSource[]).map(source => (
            <div key={source} className="space-y-2">
              <h5 className="text-xs font-black uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {source === 'smartAnalysis' ? labels.smartAnalysisSource : labels.toolbarSource}
              </h5>
              <div className="space-y-3">
                {groupedDefinitions[source].map(renderPromptCard)}
              </div>
            </div>
          ))}

          <div className="sticky bottom-0 z-10 flex gap-2 border-t border-gray-200 bg-white/95 py-3 backdrop-blur dark:border-[#3C3C3C] dark:bg-[#2A2A2A]/95">
            <button
              type="button"
              onClick={handleSave}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#d4af37] p-2 text-sm font-bold text-white hover:bg-[#b8922e]"
            >
              <Save size={16} />
              <span>{labels.save}</span>
            </button>
            <button
              type="button"
              onClick={handleResetAll}
              className="flex items-center justify-center gap-2 rounded-lg bg-gray-100 p-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#d4af37]/25"
            >
              <RotateCcw size={16} />
              <span>{labels.resetAll}</span>
            </button>
          </div>
          {status && <p className="text-xs font-bold text-green-600 dark:text-green-400">{status}</p>}
        </div>
      )}
    </div>
  );
};

export default EngineeringPromptsSettings;
