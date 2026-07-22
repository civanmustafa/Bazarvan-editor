import React, { useEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  Check,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { ExternalAiBridgeProvider, ExternalAiOpenMode } from '../types';
import {
  EXTERNAL_AI_BRIDGES,
  EXTERNAL_AI_BRIDGE_PROVIDERS,
  copyExternalAiBridgePrompt,
  openExternalAiBridge,
} from '../utils/externalAiBridge';
import type {
  ExternalContentWritingConversation,
  ExternalContentWritingMessage,
} from '../utils/contentWritingSessions';

type ContentWritingExternalBridgePanelProps = {
  articleId: string;
  isArabic: boolean;
  openMode: ExternalAiOpenMode;
  disabled?: boolean;
  prepareConversation: () => Promise<ExternalContentWritingConversation>;
  onImportResponse: (provider: ExternalAiBridgeProvider, response: string) => void;
  onError: (error: unknown) => void;
};

type BridgeStatus = {
  tone: 'success' | 'warning' | 'error';
  message: string;
} | null;

const EMPTY_RESPONSES: Record<ExternalAiBridgeProvider, string> = {
  chatgpt: '',
  gemini: '',
};

const getStageLabel = (
  message: ExternalContentWritingMessage,
  isArabic: boolean,
): string => {
  const labels: Record<ExternalContentWritingMessage['stage'], [string, string]> = {
    instructions: ['التعليمات والشروط', 'Instructions'],
    article_context: ['بيانات المقالة والمنافسين', 'Article and competitors'],
    generation_request: ['طلب كتابة المقالة', 'Article request'],
  };
  return labels[message.stage][isArabic ? 0 : 1];
};

const ProviderIcon: React.FC<{ provider: ExternalAiBridgeProvider }> = ({ provider }) => (
  provider === 'gemini' ? <Sparkles size={14} /> : <BrainCircuit size={14} />
);

const ContentWritingExternalBridgePanel: React.FC<ContentWritingExternalBridgePanelProps> = ({
  articleId,
  isArabic,
  openMode,
  disabled = false,
  prepareConversation,
  onImportResponse,
  onError,
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const [activeProvider, setActiveProvider] = useState<ExternalAiBridgeProvider>('chatgpt');
  const [conversation, setConversation] = useState<ExternalContentWritingConversation | null>(null);
  const [copiedSequence, setCopiedSequence] = useState(0);
  const [isPreparing, setIsPreparing] = useState(false);
  const [responses, setResponses] = useState<Record<ExternalAiBridgeProvider, string>>(EMPTY_RESPONSES);
  const [status, setStatus] = useState<BridgeStatus>(null);

  useEffect(() => {
    requestRef.current += 1;
    setConversation(null);
    setCopiedSequence(0);
    setIsPreparing(false);
    setResponses(EMPTY_RESPONSES);
    setStatus(null);
  }, [articleId]);

  const showCopyStatus = (message: ExternalContentWritingMessage) => {
    setStatus({
      tone: 'success',
      message: isArabic
        ? `تم نسخ الرسالة ${message.sequenceNumber}/3: ${getStageLabel(message, true)}.`
        : `Message ${message.sequenceNumber}/3 copied: ${getStageLabel(message, false)}.`,
    });
  };

  const copyMessage = async (message: ExternalContentWritingMessage) => {
    try {
      await copyExternalAiBridgePrompt(message.content);
      setCopiedSequence(current => Math.max(current, message.sequenceNumber));
      showCopyStatus(message);
    } catch (error) {
      setStatus({
        tone: 'error',
        message: isArabic ? 'تعذر نسخ الرسالة.' : 'The message could not be copied.',
      });
      onError(error);
    }
  };

  const startExternalConversation = async (provider: ExternalAiBridgeProvider) => {
    if (disabled || isPreparing) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setActiveProvider(provider);
    setConversation(null);
    setCopiedSequence(0);
    setStatus(null);
    setIsPreparing(true);

    const opened = openExternalAiBridge({
      provider,
      mode: openMode,
      anchorElement: anchorRef.current,
      editorElement: document.querySelector('[data-bazarvan-editor-panel="true"]') as HTMLElement | null,
    });

    try {
      const prepared = await prepareConversation();
      if (requestRef.current !== requestId || prepared.articleId !== articleId) return;
      setConversation(prepared);
      const firstMessage = prepared.messages[0];
      try {
        await copyExternalAiBridgePrompt(firstMessage.content);
        if (requestRef.current !== requestId) return;
        setCopiedSequence(1);
        setStatus({
          tone: opened ? 'success' : 'warning',
          message: opened
            ? (isArabic
                ? `تم فتح ${EXTERNAL_AI_BRIDGES[provider].label} ونسخ الرسالة 1/3.`
                : `${EXTERNAL_AI_BRIDGES[provider].label} opened and message 1/3 copied.`)
            : (isArabic
                ? 'تم نسخ الرسالة 1/3، لكن المتصفح منع فتح النافذة.'
                : 'Message 1/3 was copied, but the browser blocked the window.'),
        });
      } catch {
        setStatus({
          tone: 'warning',
          message: isArabic
            ? 'المحادثة جاهزة. انقر الرسالة 1/3 لنسخها.'
            : 'The conversation is ready. Click message 1/3 to copy it.',
        });
      }
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setStatus({
        tone: 'error',
        message: isArabic ? 'تعذر تجهيز محادثة كتابة المحتوى.' : 'The content writing conversation could not be prepared.',
      });
      onError(error);
    } finally {
      if (requestRef.current === requestId) setIsPreparing(false);
    }
  };

  const importResponse = () => {
    const response = responses[activeProvider].trim();
    if (!response) {
      setStatus({
        tone: 'warning',
        message: isArabic
          ? `ألصق المقالة الناتجة من ${EXTERNAL_AI_BRIDGES[activeProvider].label} أولًا.`
          : `Paste the article generated by ${EXTERNAL_AI_BRIDGES[activeProvider].label} first.`,
      });
      return;
    }
    onImportResponse(activeProvider, response);
    setStatus({
      tone: 'success',
      message: isArabic ? 'تم فتح المقالة في نافذة المراجعة.' : 'The article was opened in review.',
    });
  };

  const statusClass = status?.tone === 'error'
    ? 'text-red-600 dark:text-red-400'
    : status?.tone === 'warning'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div ref={anchorRef} className="space-y-2 border-t border-gray-200 pt-3 dark:border-[#3C3C3C]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-gray-600 dark:text-gray-300">
          {isArabic ? 'الكتابة في نافذة خارجية' : 'Write in an external window'}
        </span>
        {conversation && (
          <span className="font-mono text-[10px] text-gray-400" dir="ltr">
            {conversation.estimatedInputTokens.toLocaleString('en')} tokens
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {EXTERNAL_AI_BRIDGE_PROVIDERS.map(provider => (
          <button
            key={provider}
            type="button"
            onClick={() => void startExternalConversation(provider)}
            disabled={disabled || isPreparing}
            title={isArabic
              ? `تجهيز المحادثة وفتح ${EXTERNAL_AI_BRIDGES[provider].label}`
              : `Prepare the conversation and open ${EXTERNAL_AI_BRIDGES[provider].label}`}
            aria-label={isArabic
              ? `تجهيز المحادثة وفتح ${EXTERNAL_AI_BRIDGES[provider].label}`
              : `Prepare the conversation and open ${EXTERNAL_AI_BRIDGES[provider].label}`}
            className="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md border border-[#d4af37]/40 bg-[#d4af37]/10 px-2 text-[11px] font-bold text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#f2d675]"
          >
            {isPreparing && activeProvider === provider
              ? <Loader2 size={14} className="animate-spin" />
              : <ExternalLink size={14} />}
            <ProviderIcon provider={provider} />
            <span className="truncate">{EXTERNAL_AI_BRIDGES[provider].label}</span>
          </button>
        ))}
      </div>

      {conversation && (
        <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-[#333] dark:border-[#3C3C3C] dark:bg-[#242424]">
          {conversation.messages.map(message => {
            const copied = copiedSequence >= message.sequenceNumber;
            const enabled = message.sequenceNumber === 1 || copiedSequence >= message.sequenceNumber - 1;
            return (
              <button
                key={message.stage}
                type="button"
                onClick={() => void copyMessage(message)}
                disabled={!enabled}
                title={isArabic
                  ? `نسخ ${getStageLabel(message, true)}`
                  : `Copy ${getStageLabel(message, false)}`}
                className="flex min-h-9 w-full items-center justify-between gap-2 px-2.5 py-2 text-start text-[11px] font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-200 dark:hover:bg-[#303030]"
              >
                <span className="min-w-0 truncate">
                  {message.sequenceNumber}/3&nbsp; {getStageLabel(message, isArabic)}
                </span>
                {copied ? <Check size={14} className="shrink-0 text-emerald-600" /> : <Copy size={14} className="shrink-0 text-gray-400" />}
              </button>
            );
          })}
        </div>
      )}

      {conversation && copiedSequence >= 3 && (
        <>
          <div className="grid grid-cols-2 rounded-md bg-gray-200 p-0.5 dark:bg-[#303030]" role="tablist" aria-label={isArabic ? 'مصدر المقالة الخارجية' : 'External article source'}>
            {EXTERNAL_AI_BRIDGE_PROVIDERS.map(provider => (
              <button
                key={provider}
                type="button"
                role="tab"
                aria-selected={activeProvider === provider}
                onClick={() => setActiveProvider(provider)}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-bold ${
                  activeProvider === provider
                    ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#242424] dark:text-[#f2d675]'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <ProviderIcon provider={provider} />
                {EXTERNAL_AI_BRIDGES[provider].label}
              </button>
            ))}
          </div>
          <textarea
            value={responses[activeProvider]}
            onChange={event => setResponses(current => ({ ...current, [activeProvider]: event.target.value }))}
            rows={6}
            placeholder={isArabic ? 'ألصق المقالة الناتجة هنا...' : 'Paste the generated article here...'}
            className="w-full resize-y rounded-md border border-gray-300 bg-white px-2 py-2 text-xs leading-5 text-[#333] outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-100"
            dir="auto"
          />
          <button
            type="button"
            onClick={importResponse}
            disabled={!responses[activeProvider].trim()}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[#d4af37] px-3 text-xs font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <ClipboardPaste size={14} />
            {isArabic ? 'مراجعة المقالة واستيرادها' : 'Review and import article'}
          </button>
        </>
      )}

      {status && <div className={`text-[11px] font-bold ${statusClass}`} role="status">{status.message}</div>}
    </div>
  );
};

export default ContentWritingExternalBridgePanel;
