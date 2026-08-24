import { parseHTML } from 'linkedom';

export type PreservedArticleLinkIssue = {
  href: string;
  anchor: string;
  reason: 'anchor_missing' | 'anchor_ambiguous' | 'unsafe_href' | 'empty_anchor';
};

export type PreservedArticleLinksResult = {
  html: string;
  preservedCount: number;
  missingSafeLinks: PreservedArticleLinkIssue[];
};

type TipTapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type TipTapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
};

const normalizeVisibleText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const normalizeHref = (value: string): string => value.trim();

const isSafeArticleHref = (href: string): boolean => (
  /^(?:https?:\/\/|\/|#|mailto:|tel:)/i.test(href)
  && !/[\u0000-\u001f\u007f]/.test(href)
);

const linkKey = (href: string, anchor: string): string => (
  `${normalizeHref(href)}\u0000${normalizeVisibleText(anchor).toLocaleLowerCase()}`
);

const hasAncestorTag = (node: any, tagNames: Set<string>): boolean => {
  let current = node?.parentNode;
  while (current) {
    const tag = String(current.tagName || '').toLowerCase();
    if (tagNames.has(tag)) return true;
    current = current.parentNode;
  }
  return false;
};

const collectTextNodes = (root: any): any[] => {
  const result: any[] = [];
  const blockedAncestors = new Set(['a', 'script', 'style', 'noscript', 'template']);

  const visit = (node: any): void => {
    if (!node) return;
    if (node.nodeType === 3) {
      if (!hasAncestorTag(node, blockedAncestors)) result.push(node);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (blockedAncestors.has(tag)) return;
    Array.from(node.childNodes || []).forEach(visit);
  };

  visit(root);
  return result;
};

const findAnchorRanges = (text: string, anchor: string): Array<{ start: number; end: number }> => {
  const compactAnchor = normalizeVisibleText(anchor);
  if (!compactAnchor) return [];

  const escaped = compactAnchor
    .split(' ')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const matcher = new RegExp(escaped, 'giu');
  const matches = Array.from(text.matchAll(matcher));
  return matches.flatMap(match => match.index === undefined ? [] : [{
    start: match.index,
    end: match.index + match[0].length,
  }]);
};

/**
 * Re-applies the article's existing links only when the original anchor occurs at
 * one unambiguous text location. Ambiguous or missing anchors are reported so a
 * background writer can stop for review instead of silently dropping a link.
 */
export const preserveExistingArticleLinks = ({
  sourceHtml,
  targetHtml,
}: {
  sourceHtml: string;
  targetHtml: string;
}): PreservedArticleLinksResult => {
  const source = parseHTML(`<!doctype html><html><body>${sourceHtml || ''}</body></html>`).document;
  const target = parseHTML(`<!doctype html><html><body>${targetHtml || ''}</body></html>`).document;
  const targetBody = target.body;
  const issues: PreservedArticleLinkIssue[] = [];
  let preservedCount = 0;

  const targetLinkCounts = new Map<string, number>();
  Array.from(targetBody.querySelectorAll('a[href]')).forEach((element: any) => {
    const href = normalizeHref(element.getAttribute('href') || '');
    const anchor = normalizeVisibleText(element.textContent || '');
    if (!href || !anchor || !isSafeArticleHref(href)) return;
    const key = linkKey(href, anchor);
    targetLinkCounts.set(key, (targetLinkCounts.get(key) || 0) + 1);
  });

  const consumedTargetLinks = new Map<string, number>();
  Array.from(source.body.querySelectorAll('a[href]')).forEach((sourceLink: any) => {
    const href = normalizeHref(sourceLink.getAttribute('href') || '');
    const anchor = normalizeVisibleText(sourceLink.textContent || '');

    if (!anchor) {
      issues.push({ href, anchor, reason: 'empty_anchor' });
      return;
    }
    if (!isSafeArticleHref(href)) {
      issues.push({ href, anchor, reason: 'unsafe_href' });
      return;
    }

    const key = linkKey(href, anchor);
    const alreadyConsumed = consumedTargetLinks.get(key) || 0;
    const alreadyPresent = targetLinkCounts.get(key) || 0;
    if (alreadyConsumed < alreadyPresent) {
      consumedTargetLinks.set(key, alreadyConsumed + 1);
      preservedCount += 1;
      return;
    }

    const candidates = collectTextNodes(targetBody).flatMap(textNode => (
      findAnchorRanges(String(textNode.data || ''), anchor).map(range => ({ textNode, range }))
    ));

    if (candidates.length === 0) {
      issues.push({ href, anchor, reason: 'anchor_missing' });
      return;
    }
    if (candidates.length !== 1) {
      issues.push({ href, anchor, reason: 'anchor_ambiguous' });
      return;
    }

    const { textNode, range } = candidates[0];
    if (!range) return;
    const originalText = String(textNode.data || '');
    const parent = textNode.parentNode;
    if (!parent) {
      issues.push({ href, anchor, reason: 'anchor_missing' });
      return;
    }

    const before = originalText.slice(0, range.start);
    const matched = originalText.slice(range.start, range.end);
    const after = originalText.slice(range.end);
    if (before) parent.insertBefore(target.createTextNode(before), textNode);

    const link = target.createElement('a');
    link.setAttribute('href', href);
    link.setAttribute('rel', 'noopener');
    link.setAttribute('target', '_self');
    link.appendChild(target.createTextNode(matched));
    parent.insertBefore(link, textNode);
    if (after) parent.insertBefore(target.createTextNode(after), textNode);
    parent.removeChild(textNode);
    preservedCount += 1;
  });

  return {
    html: targetBody.innerHTML,
    preservedCount,
    missingSafeLinks: issues,
  };
};

const readStyleValue = (element: any, property: string): string => {
  const direct = String(element?.style?.getPropertyValue?.(property) || '').trim();
  if (direct) return direct;
  const style = String(element?.getAttribute?.('style') || '');
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim() || '';
};

const readBlockAttrs = (element: any, language: 'ar' | 'en'): Record<string, unknown> => {
  const attrs: Record<string, unknown> = {};
  const dir = String(element?.getAttribute?.('dir') || '').toLowerCase();
  attrs.dir = dir === 'rtl' || dir === 'ltr' ? dir : language === 'ar' ? 'rtl' : 'ltr';
  const align = readStyleValue(element, 'text-align').toLowerCase()
    || String(element?.getAttribute?.('align') || '').toLowerCase();
  if (['left', 'right', 'center', 'justify'].includes(align)) attrs.textAlign = align;
  return attrs;
};

const dedupeMarks = (marks: TipTapMark[]): TipTapMark[] => {
  const seen = new Set<string>();
  return marks.filter(mark => {
    const key = `${mark.type}:${JSON.stringify(mark.attrs || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const appendElementMarks = (element: any, marks: TipTapMark[]): TipTapMark[] => {
  const next = [...marks];
  const tag = String(element?.tagName || '').toLowerCase();
  const styleWeight = readStyleValue(element, 'font-weight').toLowerCase();
  const styleDecoration = readStyleValue(element, 'text-decoration').toLowerCase();
  const styleFont = readStyleValue(element, 'font-style').toLowerCase();

  if (tag === 'strong' || tag === 'b' || styleWeight === 'bold' || Number(styleWeight) >= 600) {
    next.push({ type: 'bold' });
  }
  if (tag === 'em' || tag === 'i' || styleFont === 'italic') next.push({ type: 'italic' });
  if (tag === 's' || tag === 'strike' || tag === 'del' || styleDecoration.includes('line-through')) {
    next.push({ type: 'strike' });
  }
  if (tag === 'u' || styleDecoration.includes('underline')) next.push({ type: 'underline' });
  if (tag === 'code' && String(element?.parentNode?.tagName || '').toLowerCase() !== 'pre') {
    next.push({ type: 'code' });
  }
  if (tag === 'mark') {
    const color = readStyleValue(element, 'background-color') || element.getAttribute('data-color') || undefined;
    next.push(color ? { type: 'highlight', attrs: { color } } : { type: 'highlight' });
  }
  if (tag === 'a') {
    const href = normalizeHref(element.getAttribute('href') || '');
    if (isSafeArticleHref(href)) {
      next.push({
        type: 'link',
        attrs: {
          href,
          target: element.getAttribute('target') || '_self',
          rel: element.getAttribute('rel') || 'noopener',
          class: element.getAttribute('class') || null,
        },
      });
    }
  }
  return dedupeMarks(next);
};

const isBlockTag = (tag: string): boolean => new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]).has(tag);

const convertInlineChildren = (element: any, inheritedMarks: TipTapMark[] = []): TipTapNode[] => {
  const output: TipTapNode[] = [];
  Array.from(element?.childNodes || []).forEach((child: any) => {
    if (child.nodeType === 3) {
      const text = String(child.data || '').replace(/\r/g, '');
      if (!text) return;
      output.push({
        type: 'text',
        text,
        ...(inheritedMarks.length > 0 ? { marks: dedupeMarks(inheritedMarks) } : {}),
      });
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = String(child.tagName || '').toLowerCase();
    if (tag === 'br') {
      output.push({ type: 'hardBreak' });
      return;
    }
    if (isBlockTag(tag)) {
      const text = normalizeVisibleText(child.textContent || '');
      if (text) output.push({ type: 'text', text, ...(inheritedMarks.length ? { marks: inheritedMarks } : {}) });
      return;
    }
    output.push(...convertInlineChildren(child, appendElementMarks(child, inheritedMarks)));
  });
  return output;
};

const ensureParagraph = (nodes: TipTapNode[], element: any, language: 'ar' | 'en'): TipTapNode[] => {
  if (nodes.length > 0 && nodes.every(node => node.type === 'text' || node.type === 'hardBreak')) {
    return [{ type: 'paragraph', attrs: readBlockAttrs(element, language), content: nodes }];
  }
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', attrs: readBlockAttrs(element, language) }];
};

const convertBlock = (element: any, language: 'ar' | 'en'): TipTapNode[] => {
  const tag = String(element?.tagName || '').toLowerCase();
  if (!tag) return [];

  if (tag === 'p') {
    const content = convertInlineChildren(element);
    return [{ type: 'paragraph', attrs: readBlockAttrs(element, language), ...(content.length ? { content } : {}) }];
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(4, Math.max(1, Number(tag.slice(1)) || 2));
    const content = convertInlineChildren(element);
    return [{
      type: 'heading',
      attrs: { ...readBlockAttrs(element, language), level },
      ...(content.length ? { content } : {}),
    }];
  }
  if (tag === 'blockquote') {
    const content = convertBlockChildren(element, language);
    return [{ type: 'blockquote', content: content.length ? content : ensureParagraph([], element, language) }];
  }
  if (tag === 'ul' || tag === 'ol') {
    const content = Array.from(element.children || [])
      .filter((child: any) => String(child.tagName || '').toLowerCase() === 'li')
      .flatMap((child: any) => convertBlock(child, language));
    return [{
      type: tag === 'ul' ? 'bulletList' : 'orderedList',
      attrs: {
        ...readBlockAttrs(element, language),
        ...(tag === 'ol' ? { start: Math.max(1, Number(element.getAttribute('start')) || 1) } : {}),
      },
      content,
    }];
  }
  if (tag === 'li') {
    const content: TipTapNode[] = [];
    const pendingInline: TipTapNode[] = [];
    const flushInline = (): void => {
      if (pendingInline.length === 0) return;
      content.push({ type: 'paragraph', attrs: readBlockAttrs(element, language), content: pendingInline.splice(0) });
    };
    Array.from(element.childNodes || []).forEach((child: any) => {
      if (child.nodeType === 3) {
        const text = String(child.data || '');
        if (text.trim()) pendingInline.push({ type: 'text', text });
        return;
      }
      if (child.nodeType !== 1) return;
      const childTag = String(child.tagName || '').toLowerCase();
      if (isBlockTag(childTag)) {
        flushInline();
        content.push(...convertBlock(child, language));
      } else {
        pendingInline.push(...convertInlineChildren({ childNodes: [child] }));
      }
    });
    flushInline();
    return [{ type: 'listItem', attrs: readBlockAttrs(element, language), content: content.length ? content : ensureParagraph([], element, language) }];
  }
  if (tag === 'pre') {
    const text = String(element.textContent || '').replace(/\r/g, '');
    return [{ type: 'codeBlock', attrs: { language: null }, ...(text ? { content: [{ type: 'text', text }] } : {}) }];
  }
  if (tag === 'hr') return [{ type: 'horizontalRule' }];
  if (tag === 'table') {
    const rows = Array.from(element.querySelectorAll('tr')).flatMap((row: any) => convertBlock(row, language));
    return [{ type: 'table', content: rows }];
  }
  if (tag === 'tr') {
    const cells = Array.from(element.children || [])
      .filter((cell: any) => ['td', 'th'].includes(String(cell.tagName || '').toLowerCase()))
      .flatMap((cell: any) => convertBlock(cell, language));
    return [{ type: 'tableRow', content: cells }];
  }
  if (tag === 'td' || tag === 'th') {
    const colspan = Math.max(1, Number(element.getAttribute('colspan')) || 1);
    const rowspan = Math.max(1, Number(element.getAttribute('rowspan')) || 1);
    const content = convertBlockChildren(element, language);
    return [{
      type: tag === 'th' ? 'tableHeader' : 'tableCell',
      attrs: { colspan, rowspan, colwidth: null },
      content: content.length ? content : ensureParagraph([], element, language),
    }];
  }
  if (tag === 'br') return [{ type: 'paragraph', attrs: readBlockAttrs(element, language), content: [{ type: 'hardBreak' }] }];

  const children = convertBlockChildren(element, language);
  if (children.length) return children;
  const inline = convertInlineChildren(element);
  return inline.length ? ensureParagraph(inline, element, language) : [];
};

const convertBlockChildren = (element: any, language: 'ar' | 'en'): TipTapNode[] => {
  const output: TipTapNode[] = [];
  let pendingInline: TipTapNode[] = [];
  const flushInline = (): void => {
    if (pendingInline.length === 0) return;
    const meaningful = pendingInline.some(node => node.type !== 'text' || Boolean(node.text?.trim()));
    if (meaningful) {
      output.push({ type: 'paragraph', attrs: readBlockAttrs(element, language), content: pendingInline });
    }
    pendingInline = [];
  };

  Array.from(element?.childNodes || []).forEach((child: any) => {
    if (child.nodeType === 3) {
      const text = String(child.data || '').replace(/\r/g, '');
      if (text.trim()) pendingInline.push({ type: 'text', text });
      return;
    }
    if (child.nodeType !== 1) return;
    const childTag = String(child.tagName || '').toLowerCase();
    if (isBlockTag(childTag) || ['li', 'tr', 'td', 'th'].includes(childTag)) {
      flushInline();
      output.push(...convertBlock(child, language));
    } else {
      pendingInline.push(...convertInlineChildren({ childNodes: [child] }));
    }
  });
  flushInline();
  return output;
};

/** Convert trusted, generated article HTML to the canonical JSON stored by TipTap. */
export const htmlToTipTapJson = (html: string, language: 'ar' | 'en'): Record<string, unknown> => {
  const document = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`).document;
  const content = convertBlockChildren(document.body, language);
  return {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph', attrs: { dir: language === 'ar' ? 'rtl' : 'ltr' } }],
  };
};
