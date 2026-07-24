interface LinkElementLike {
  getAttribute: (name: string) => string | null;
}

interface ClosestTargetLike {
  closest?: (selector: string) => LinkElementLike | null;
}

export interface EditorLinkClickDecision {
  isLink: boolean;
  openUrl: string;
}

interface EditorLinkClickOptions {
  baseUrl?: string;
  openUrl?: (url: string) => void;
}

const getLinkElement = (target: EventTarget | null): LinkElementLike | null => {
  if (!target || typeof (target as ClosestTargetLike).closest !== 'function') {
    return null;
  }

  return (target as ClosestTargetLike).closest?.('a[href]') ?? null;
};

const resolveSafeLinkUrl = (href: string, baseUrl: string): string => {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
};

export const resolveEditorLinkClick = (
  target: EventTarget | null,
  ctrlKey: boolean,
  mouseButton: number,
  baseUrl: string,
): EditorLinkClickDecision => {
  const linkElement = getLinkElement(target);
  if (!linkElement) {
    return { isLink: false, openUrl: '' };
  }

  const href = linkElement.getAttribute('href')?.trim() ?? '';
  const openUrl = ctrlKey && mouseButton === 0 && href
    ? resolveSafeLinkUrl(href, baseUrl)
    : '';

  return { isLink: true, openUrl };
};

export const handleEditorLinkClick = (
  event: MouseEvent,
  options: EditorLinkClickOptions = {},
): boolean => {
  const baseUrl = options.baseUrl
    ?? (typeof window !== 'undefined' ? window.location.href : 'https://localhost/');
  const decision = resolveEditorLinkClick(event.target, event.ctrlKey, event.button, baseUrl);

  if (!decision.isLink) {
    return false;
  }

  // A regular click must remain available for caret placement and text selection.
  event.preventDefault();
  if (!decision.openUrl) {
    return false;
  }

  const openUrl = options.openUrl ?? ((url: string) => {
    const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (openedWindow) {
      openedWindow.opener = null;
    }
  });
  openUrl(decision.openUrl);
  return true;
};
