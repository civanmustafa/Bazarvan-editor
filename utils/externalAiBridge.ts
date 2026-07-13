import type { ExternalAiBridgeProvider, ExternalAiOpenMode } from '../types';

export type ExternalAiBridgeDefinition = {
  id: ExternalAiBridgeProvider;
  label: string;
  url: string;
  windowName: string;
};

export const EXTERNAL_AI_BRIDGE_PROVIDERS = Object.freeze([
  'chatgpt',
  'gemini',
] as const satisfies readonly ExternalAiBridgeProvider[]);

export const EXTERNAL_AI_BRIDGES = Object.freeze({
  chatgpt: Object.freeze({
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    windowName: 'bazarvan-chatgpt-bridge',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    windowName: 'bazarvan-gemini-bridge',
  }),
} satisfies Record<ExternalAiBridgeProvider, ExternalAiBridgeDefinition>);

type PopupLayout = {
  anchorRect?: Pick<DOMRect, 'width' | 'top'> | null;
  editorRect?: Pick<DOMRect, 'top'> | null;
  availableLeft: number;
  availableTop: number;
  availableWidth: number;
  availableHeight: number;
  browserTop: number;
};

export const buildExternalAiPopupFeatures = ({
  anchorRect,
  editorRect,
  availableLeft,
  availableTop,
  availableWidth,
  availableHeight,
  browserTop,
}: PopupLayout): string => {
  const availableRight = availableLeft + availableWidth;
  const availableBottom = availableTop + availableHeight;
  const fallbackWidth = Math.min(420, Math.max(320, Math.floor(availableWidth * 0.24)));
  const measuredWidth = Math.round(anchorRect?.width || fallbackWidth);
  const popupWidth = Math.max(320, Math.min(availableWidth, measuredWidth));
  const measuredTop = browserTop + Math.round(editorRect?.top ?? anchorRect?.top ?? 0);
  const maximumTop = Math.max(availableTop, availableBottom - 520);
  const popupTop = Math.max(availableTop, Math.min(maximumTop, Math.floor(measuredTop)));
  const popupHeight = Math.max(520, Math.min(availableHeight, availableBottom - popupTop));
  const popupLeft = Math.max(availableLeft, Math.floor(availableRight - popupWidth));

  return [
    'popup=yes',
    `width=${popupWidth}`,
    `height=${popupHeight}`,
    `left=${popupLeft}`,
    `top=${popupTop}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
};

type OpenExternalAiBridgeOptions = {
  provider: ExternalAiBridgeProvider;
  mode: ExternalAiOpenMode;
  anchorElement?: HTMLElement | null;
  editorElement?: HTMLElement | null;
};

export const openExternalAiBridge = ({
  provider,
  mode,
  anchorElement,
  editorElement,
}: OpenExternalAiBridgeOptions): boolean => {
  const definition = EXTERNAL_AI_BRIDGES[provider];
  const target = mode === 'tab' ? '_blank' : definition.windowName;
  const features = mode === 'tab'
    ? undefined
    : buildExternalAiPopupFeatures({
        anchorRect: anchorElement?.getBoundingClientRect(),
        editorRect: editorElement?.getBoundingClientRect(),
        availableLeft: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
        availableTop: (window.screen as Screen & { availTop?: number }).availTop ?? 0,
        availableWidth: window.screen.availWidth || 1200,
        availableHeight: window.screen.availHeight || 900,
        browserTop: window.screenY ?? window.screenTop ?? 0,
      });

  const externalWindow = window.open(definition.url, target, features);
  if (!externalWindow) return false;

  // Prevent the external site from controlling the editor window.
  try {
    externalWindow.opener = null;
    externalWindow.focus();
  } catch {
    // The external page can become cross-origin before focus is called.
  }
  return true;
};

export const copyExternalAiBridgePrompt = async (prompt: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(prompt);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = prompt;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.inset = '-9999px auto auto -9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard API is not available.');
};

export type ExternalAiBridgeLaunchResult = {
  opened: boolean;
  copied: boolean;
};

type LaunchExternalAiBridgeOptions = OpenExternalAiBridgeOptions & {
  prompt: string;
};

export const launchExternalAiBridge = async (
  options: LaunchExternalAiBridgeOptions,
): Promise<ExternalAiBridgeLaunchResult> => {
  // Open synchronously from the click handler so popup blockers do not reject it
  // while clipboard permission is being resolved.
  const opened = openExternalAiBridge(options);
  try {
    await copyExternalAiBridgePrompt(options.prompt);
    return { opened, copied: true };
  } catch (error) {
    console.error(`Could not copy ${options.provider} bridge prompt:`, error);
    return { opened, copied: false };
  }
};
