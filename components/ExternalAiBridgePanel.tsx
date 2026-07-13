import React, { useEffect, useRef, useState } from 'react';
import { BrainCircuit, ClipboardPaste, ExternalLink, Sparkles } from 'lucide-react';
import type { ExternalAiBridgeProvider, ExternalAiOpenMode } from '../types';
import {
  EXTERNAL_AI_BRIDGES,
  EXTERNAL_AI_BRIDGE_PROVIDERS,
  launchExternalAiBridge,
} from '../utils/externalAiBridge';

type ExternalAiBridgePanelProps = {
  isArabic: boolean;
  openMode: ExternalAiOpenMode;
  anchorRef: React.RefObject<HTMLElement | null>;
  getPrompt: (provider: ExternalAiBridgeProvider) => string | null;
  onImportResponse: (provider: ExternalAiBridgeProvider, response: string) => void;
};

type BridgeStatus = {
  message: string;
  tone: 'success' | 'warning' | 'error';
} | null;

const EMPTY_RESPONSES: Record<ExternalAiBridgeProvider, string> = {
  chatgpt: '',
  gemini: '',
};

const providerIcon = (provider: ExternalAiBridgeProvider) => (
  provider === 'gemini' ? <Sparkles size={14} /> : <BrainCircuit size={14} />
);

const ExternalAiBridgePanel: React.FC<ExternalAiBridgePanelProps> = ({
  isArabic,
  openMode,
  anchorRef,
  getPrompt,
  onImportResponse,
}) => {
  const [activeProvider, setActiveProvider] = useState<ExternalAiBridgeProvider>('chatgpt');
  const [responses, setResponses] = useState<Record<ExternalAiBridgeProvider, string>>(EMPTY_RESPONSES);
  const [status, setStatus] = useState<BridgeStatus>(null);
  const statusTimerRef = useRef<number | null>(null);
  const activeDefinition = EXTERNAL_AI_BRIDGES[activeProvider];
  const activeResponse = responses[activeProvider];

  useEffect(() => () => {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
  }, []);

  const showStatus = (nextStatus: Exclude<BridgeStatus, null>) => {
    setStatus(nextStatus);
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => setStatus(null), 3500);
  };

  const handleLaunch = async (provider: ExternalAiBridgeProvider) => {
    const prompt = getPrompt(provider);
    if (!prompt) return;

    setActiveProvider(provider);
    const definition = EXTERNAL_AI_BRIDGES[provider];
    const result = await launchExternalAiBridge({
      provider,
      prompt,
      mode: openMode,
      anchorElement: anchorRef.current,
      editorElement: document.querySelector('[data-bazarvan-editor-panel="true"]') as HTMLElement | null,
    });

    if (result.copied && result.opened) {
      showStatus({
        tone: 'success',
        message: isArabic
          ? `تم نسخ الأمر وفتح ${definition.label}.`
          : `Prompt copied and ${definition.label} opened.`,
      });
      return;
    }
    if (result.copied) {
      showStatus({
        tone: 'warning',
        message: isArabic
          ? `تم نسخ الأمر، لكن المتصفح منع فتح ${definition.label}.`
          : `Prompt copied, but the browser blocked ${definition.label}.`,
      });
      return;
    }
    showStatus({
      tone: 'error',
      message: result.opened
        ? (isArabic
            ? `تم فتح ${definition.label}، لكن تعذر نسخ الأمر.`
            : `${definition.label} opened, but the prompt could not be copied.`)
        : (isArabic
            ? `تعذر نسخ الأمر وفتح ${definition.label}.`
            : `Could not copy the prompt or open ${definition.label}.`),
    });
  };

  const handleImport = () => {
    const response = activeResponse.trim();
    if (!response) {
      showStatus({
        tone: 'warning',
        message: isArabic
          ? `ألصق رد ${activeDefinition.label} أولًا.`
          : `Paste the ${activeDefinition.label} response first.`,
      });
      return;
    }

    onImportResponse(activeProvider, response);
    setResponses(previous => ({ ...previous, [activeProvider]: '' }));
    showStatus({
      tone: 'success',
      message: isArabic
        ? `تم تنظيم رد ${activeDefinition.label} وإضافته إلى النتائج.`
        : `${activeDefinition.label} response organized and added to results.`,
    });
  };

  const statusClass = status?.tone === 'error'
    ? 'text-red-600 dark:text-red-400'
    : status?.tone === 'warning'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
      <div className="grid grid-cols-2 gap-2">
        {EXTERNAL_AI_BRIDGE_PROVIDERS.map(provider => {
          const definition = EXTERNAL_AI_BRIDGES[provider];
          return (
            <button
              key={provider}
              type="button"
              onClick={() => void handleLaunch(provider)}
              className="flex min-w-0 items-center justify-center gap-1.5 rounded-md bg-[#d4af37] px-2 py-2 text-center text-[11px] font-bold leading-4 text-white hover:bg-[#b8922e]"
              title={isArabic ? `نسخ الطلب الحالي وفتح ${definition.label}` : `Copy the current prompt and open ${definition.label}`}
            >
              <ExternalLink size={14} />
              <span className="min-w-0 whitespace-normal break-words">
                {isArabic ? `نسخ وفتح ${definition.label}` : `Copy and open ${definition.label}`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 rounded-md bg-gray-200 p-0.5 dark:bg-[#303030]" role="tablist" aria-label={isArabic ? 'مصدر الرد الخارجي' : 'External response source'}>
        {EXTERNAL_AI_BRIDGE_PROVIDERS.map(provider => {
          const definition = EXTERNAL_AI_BRIDGES[provider];
          const isActive = activeProvider === provider;
          return (
            <button
              key={provider}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveProvider(provider)}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-bold transition-colors ${
                isActive
                  ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#242424] dark:text-[#f2d675]'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
              }`}
            >
              {providerIcon(provider)}
              {definition.label}
            </button>
          );
        })}
      </div>

      <textarea
        value={activeResponse}
        onChange={event => setResponses(previous => ({ ...previous, [activeProvider]: event.target.value }))}
        rows={5}
        placeholder={isArabic ? `ألصق رد ${activeDefinition.label} هنا...` : `Paste the ${activeDefinition.label} response here...`}
        className="w-full resize-y rounded-md border border-gray-300 bg-white px-2 py-2 text-xs leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-100 dark:placeholder:text-gray-500"
        dir="auto"
      />
      <button
        type="button"
        onClick={handleImport}
        disabled={!activeResponse.trim()}
        className="flex w-full items-center justify-center gap-1 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <ClipboardPaste size={14} />
        {isArabic ? `تنظيم رد ${activeDefinition.label}` : `Organize ${activeDefinition.label} response`}
      </button>

      {status && (
        <div className={`text-[11px] font-bold ${statusClass}`} role="status">
          {status.message}
        </div>
      )}
    </div>
  );
};

export default ExternalAiBridgePanel;
