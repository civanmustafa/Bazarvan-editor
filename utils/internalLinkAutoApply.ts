import type { Editor } from '@tiptap/core';
import {
  normalizeInternalLinkText,
  normalizeInternalLinkUrl,
  resolveInternalLinkTargetUrl,
  type InternalLinkSuggestion,
  type InternalLinkTargetPage,
} from './internalLinkingEngine.ts';
import {
  INTERNAL_LINK_ANCHOR_MAX_WORDS,
  INTERNAL_LINK_ANCHOR_MIN_WORDS,
  normalizeInternalLinkQualityPolicy,
  type InternalLinkQualityPolicyValues,
} from './internalLinkQualityPolicy.ts';

export const AUTOMATIC_INTERNAL_LINK_MINIMUM_SCORE = 90;
export const AUTOMATIC_INTERNAL_LINK_MINIMUM_SCORE_MARGIN = 12;
export const AUTOMATIC_INTERNAL_LINK_MINIMUM_MATCHED_TERMS = 3;
export const AUTOMATIC_INTERNAL_LINK_MINIMUM_COMPLETENESS = 70;
export const AUTOMATIC_INTERNAL_LINK_MINIMUM_BM25_SCORE = 1.5;
export const AUTOMATIC_INTERNAL_LINK_MAX_PER_RUN = 5;
export const AUTOMATIC_INTERNAL_LINK_GUARD_VERSION = 'strict-context-v2';

const EXPLICIT_ANCHOR_MATCH_SOURCES = new Set(['title', 'heading', 'phrase']);
const UNICODE_WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

export type AutomaticInternalLinkInsertion = {
  suggestion: InternalLinkSuggestion;
  from: number;
  to: number;
};

export type ExistingInternalLinkState = {
  urls: string[];
  anchors: string[];
};

type TextBlock = {
  paragraphNumber: number;
  text: string;
  positions: number[];
  eligible: boolean;
};

const countAnchorWords = (value: string): number => (
  value.match(/[\p{L}\p{N}\p{M}]+/gu)?.length || 0
);

const isSafeHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
    );
  } catch {
    return false;
  }
};

const isWordBoundary = (value: string | undefined): boolean => (
  !value || !UNICODE_WORD_CHARACTER.test(value)
);

const normalizePageIdentity = (value: string, baseUrl = ''): string => {
  try {
    const parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    const hostname = parsed.hostname.toLocaleLowerCase().replace(/\.$/, '');
    const port = (
      (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')
    ) ? '' : parsed.port;
    const pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return `${hostname}${port ? `:${port}` : ''}${pathname}`;
  } catch {
    return '';
  }
};

const pageAliasIdentities = (page: InternalLinkTargetPage): string[] => (
  [page.inputUrl, page.finalUrl, page.canonicalUrl]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(value => normalizePageIdentity(value))
    .filter(Boolean)
);

export const countExistingAutomaticInventoryLinks = (
  existingUrls: string[],
  pages: InternalLinkTargetPage[],
  currentPageUrl: string,
): number => {
  const targetIdentities = new Set(
    pages
      .flatMap(pageAliasIdentities)
      .filter(Boolean),
  );
  return existingUrls
    .map(url => normalizePageIdentity(url, currentPageUrl))
    .filter(identity => identity && targetIdentities.has(identity))
    .length;
};

export const findBoundedAnchorOccurrences = (
  sourceText: string,
  anchorText: string,
): Array<{ from: number; to: number }> => {
  const target = anchorText.trim();
  if (!sourceText || !target || target.length > sourceText.length) return [];

  const ranges: Array<{ from: number; to: number }> = [];
  for (let from = 0; from + target.length <= sourceText.length; from += 1) {
    const to = from + target.length;
    const candidate = sourceText.slice(from, to);
    if (candidate.localeCompare(target, undefined, { sensitivity: 'accent' }) !== 0) continue;
    if (!isWordBoundary(sourceText[from - 1]) || !isWordBoundary(sourceText[to])) continue;
    ranges.push({ from, to });
  }
  return ranges;
};

const collectTextBlocks = (editor: Editor): TextBlock[] => {
  const blocks: TextBlock[] = [];
  let paragraphNumber = 0;

  editor.state.doc.descendants((node, position) => {
    if (!node.isTextblock || !node.textContent.trim()) return;
    paragraphNumber += 1;

    const text: string[] = [];
    const positions: number[] = [];
    let previousEnd = -1;
    node.descendants((child, relativePosition) => {
      if (!child.isText || !child.text) return;
      const absolutePosition = position + 1 + relativePosition;
      if (previousEnd >= 0 && absolutePosition > previousEnd) {
        text.push('\n');
        positions.push(-1);
      }
      for (let index = 0; index < child.text.length; index += 1) {
        text.push(child.text[index]);
        positions.push(absolutePosition + index);
      }
      previousEnd = absolutePosition + child.text.length;
    });

    const resolvedPosition = editor.state.doc.resolve(
      Math.min(editor.state.doc.content.size, Math.max(0, position + 1)),
    );
    const ancestorNames = Array.from(
      { length: resolvedPosition.depth + 1 },
      (_, depth) => resolvedPosition.node(depth).type.name,
    );
    const isInsideExcludedContainer = ancestorNames.some(name => (
      name === 'heading'
      || name === 'codeBlock'
      || name === 'tableCell'
      || name === 'tableHeader'
    ));

    blocks.push({
      paragraphNumber,
      text: text.join(''),
      positions,
      eligible: node.type.name === 'paragraph' && !isInsideExcludedContainer,
    });
  });

  return blocks;
};

const sourceExcerptMatchesBlock = (
  sourceExcerpt: string,
  blockText: string,
): boolean => {
  const normalizedExcerpt = normalizeInternalLinkText(
    sourceExcerpt.replace(/\.{3}\s*$/u, ''),
  );
  if (!normalizedExcerpt) return false;
  return normalizeInternalLinkText(blockText).includes(normalizedExcerpt);
};

const rangeAllowsFullLinkMark = (
  editor: Editor,
  from: number,
  to: number,
): boolean => {
  const linkMark = editor.schema.marks.link;
  if (!linkMark || to <= from) return false;

  let coveredTextSize = 0;
  let allowed = true;
  editor.state.doc.nodesBetween(from, to, (node, position, parent) => {
    if (!allowed || !node.isText) return;
    const overlapFrom = Math.max(from, position);
    const overlapTo = Math.min(to, position + node.nodeSize);
    if (overlapTo <= overlapFrom) return;
    coveredTextSize += overlapTo - overlapFrom;
    if (
      !parent?.type.allowsMarkType(linkMark)
      || node.marks.some(mark => (
        mark.type.excludes(linkMark)
        || linkMark.excludes(mark.type)
      ))
    ) {
      allowed = false;
    }
  });
  return allowed && coveredTextSize === to - from;
};

export const findUniqueContextualAnchorRange = (
  editor: Editor,
  suggestion: InternalLinkSuggestion,
): { from: number; to: number } | null => {
  const linkMark = editor.schema.marks.link;
  if (!linkMark) return null;

  const matches = collectTextBlocks(editor)
    .filter(block => (
      block.eligible
      && block.paragraphNumber === suggestion.paragraphNumber
      && sourceExcerptMatchesBlock(suggestion.sourceExcerpt, block.text)
    ))
    .flatMap(block => findBoundedAnchorOccurrences(block.text, suggestion.anchorText)
      .flatMap(range => {
        const mapped = block.positions.slice(range.from, range.to);
        if (
          mapped.length !== range.to - range.from
          || mapped.some(position => position < 0)
          || mapped.some((position, index) => index > 0 && position !== mapped[index - 1] + 1)
        ) return [];
        const from = mapped[0];
        const to = mapped[mapped.length - 1] + 1;
        if (
          to <= from
          || editor.state.doc.rangeHasMark(from, to, linkMark)
          || !rangeAllowsFullLinkMark(editor, from, to)
        ) return [];
        return [{ from, to }];
      }));

  return matches.length === 1 ? matches[0] : null;
};

export const readExistingInternalLinks = (editor: Editor): ExistingInternalLinkState => {
  const links: Array<{ href: string; text: string; end: number }> = [];
  editor.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const link = node.marks.find(mark => mark.type.name === 'link');
    const href = typeof link?.attrs.href === 'string' ? link.attrs.href.trim() : '';
    if (!href) return;
    const previous = links[links.length - 1];
    if (previous && previous.href === href && previous.end === position) {
      previous.text += node.text;
      previous.end = position + node.nodeSize;
      return;
    }
    links.push({ href, text: node.text, end: position + node.nodeSize });
  });
  return {
    urls: links.map(link => link.href),
    anchors: links.map(link => link.text.trim()).filter(Boolean),
  };
};

export const isAutomaticInternalLinkSuggestionEligible = (input: {
  suggestion: InternalLinkSuggestion;
  page: InternalLinkTargetPage;
  currentPageUrl: string;
  qualityPolicy?: Partial<InternalLinkQualityPolicyValues> | null;
}): boolean => {
  const { suggestion, page } = input;
  const policy = normalizeInternalLinkQualityPolicy(input.qualityPolicy);
  const anchorWordCount = countAnchorWords(suggestion.anchorText);
  const explicitDeterministicMatch = suggestion.anchorMatchSources.some(source => (
    EXPLICIT_ANCHOR_MATCH_SOURCES.has(source)
  ));
  const approvedAiPrimaryMatch = (
    suggestion.anchorMatchSources.includes('ai_primary')
    && page.aiLinkProfile?.reviewStatus === 'approved'
  );
  const targetUrl = resolveInternalLinkTargetUrl(page);
  const currentPageIdentity = normalizePageIdentity(input.currentPageUrl);
  const targetAliases = pageAliasIdentities(page);

  if (
    page.isEnabled === false
    || page.robotsIndex === false
    || page.crawlStatus !== 'ready'
    || (
      typeof page.httpStatus === 'number'
      && (page.httpStatus < 200 || page.httpStatus >= 400)
    )
  ) return false;
  if (!input.currentPageUrl || !isSafeHttpUrl(input.currentPageUrl)) return false;
  if (!targetUrl || !isSafeHttpUrl(targetUrl)) return false;
  if (normalizeInternalLinkUrl(targetUrl) !== normalizeInternalLinkUrl(suggestion.targetUrl)) return false;
  if (currentPageIdentity && targetAliases.includes(currentPageIdentity)) return false;

  return (
    suggestion.confidence === 'strong'
    && suggestion.score >= Math.max(AUTOMATIC_INTERNAL_LINK_MINIMUM_SCORE, policy.minimumScore)
    && suggestion.scoreMargin >= AUTOMATIC_INTERNAL_LINK_MINIMUM_SCORE_MARGIN
    && suggestion.matchedTerms.length >= Math.max(
      AUTOMATIC_INTERNAL_LINK_MINIMUM_MATCHED_TERMS,
      policy.minimumMatchedTerms,
    )
    && suggestion.completenessScore >= AUTOMATIC_INTERNAL_LINK_MINIMUM_COMPLETENESS
    && suggestion.bm25Score >= AUTOMATIC_INTERNAL_LINK_MINIMUM_BM25_SCORE
    && anchorWordCount >= INTERNAL_LINK_ANCHOR_MIN_WORDS
    && anchorWordCount <= INTERNAL_LINK_ANCHOR_MAX_WORDS
    && (explicitDeterministicMatch || approvedAiPrimaryMatch)
  );
};

const rangesOverlap = (
  left: { from: number; to: number },
  right: { from: number; to: number },
): boolean => left.from < right.to && right.from < left.to;

const selectionTouchesRange = (
  editor: Editor,
  range: { from: number; to: number },
): boolean => (
  editor.state.selection.from <= range.to
  && editor.state.selection.to >= range.from
);

export const planAutomaticInternalLinkInsertions = (input: {
  editor: Editor;
  suggestions: InternalLinkSuggestion[];
  pages: InternalLinkTargetPage[];
  currentPageUrl: string;
  qualityPolicy?: Partial<InternalLinkQualityPolicyValues> | null;
  maximumInsertions?: number;
}): AutomaticInternalLinkInsertion[] => {
  const pageById = new Map(input.pages.map(page => [page.id, page]));
  const existingTargets = new Set(
    readExistingInternalLinks(input.editor).urls
      .map(url => normalizePageIdentity(url, input.currentPageUrl))
      .filter(Boolean),
  );
  const accepted: AutomaticInternalLinkInsertion[] = [];
  const usedParagraphs = new Set<number>();
  const maximumInsertions = Math.max(
    0,
    Math.min(AUTOMATIC_INTERNAL_LINK_MAX_PER_RUN, input.maximumInsertions ?? AUTOMATIC_INTERNAL_LINK_MAX_PER_RUN),
  );

  for (const suggestion of [...input.suggestions].sort((left, right) => (
    right.score - left.score
    || right.scoreMargin - left.scoreMargin
    || left.pageId.localeCompare(right.pageId)
  ))) {
    if (accepted.length >= maximumInsertions) break;
    const page = pageById.get(suggestion.pageId);
    if (!page || usedParagraphs.has(suggestion.paragraphNumber)) continue;
    if (!isAutomaticInternalLinkSuggestionEligible({
      suggestion,
      page,
      currentPageUrl: input.currentPageUrl,
      qualityPolicy: input.qualityPolicy,
    })) continue;

    const targetUrl = resolveInternalLinkTargetUrl(page);
    const normalizedTarget = normalizePageIdentity(targetUrl);
    const aliasIdentities = pageAliasIdentities(page);
    if (
      !normalizedTarget
      || aliasIdentities.some(identity => existingTargets.has(identity))
    ) continue;
    const range = findUniqueContextualAnchorRange(input.editor, suggestion);
    if (
      !range
      || selectionTouchesRange(input.editor, range)
      || accepted.some(item => rangesOverlap(item, range))
    ) continue;

    accepted.push({
      suggestion: { ...suggestion, targetUrl },
      ...range,
    });
    aliasIdentities.forEach(identity => existingTargets.add(identity));
    usedParagraphs.add(suggestion.paragraphNumber);
  }

  return accepted;
};

export const applyAutomaticInternalLinkInsertions = (
  editor: Editor,
  insertions: AutomaticInternalLinkInsertion[],
): boolean => {
  if (insertions.length === 0 || editor.isDestroyed || editor.view.composing) return false;
  const linkMark = editor.schema.marks.link;
  if (!linkMark) return false;

  const transaction = insertions.reduce((currentTransaction, insertion) => (
    currentTransaction.addMark(
      insertion.from,
      insertion.to,
      linkMark.create({
        href: insertion.suggestion.targetUrl,
        target: '_self',
        rel: 'noopener',
      }),
    )
  ), editor.state.tr);
  transaction.setMeta('automaticInternalLinkInsertion', {
    guardVersion: AUTOMATIC_INTERNAL_LINK_GUARD_VERSION,
    count: insertions.length,
  });
  if (
    !transaction.docChanged
    || insertions.some(insertion => {
      let coveredTextSize = 0;
      let fullyLinked = true;
      transaction.doc.nodesBetween(insertion.from, insertion.to, (node, position) => {
        if (!fullyLinked || !node.isText) return;
        const overlapFrom = Math.max(insertion.from, position);
        const overlapTo = Math.min(insertion.to, position + node.nodeSize);
        if (overlapTo <= overlapFrom) return;
        coveredTextSize += overlapTo - overlapFrom;
        const link = node.marks.find(mark => mark.type === linkMark);
        if (link?.attrs.href !== insertion.suggestion.targetUrl) fullyLinked = false;
      });
      return !fullyLinked || coveredTextSize !== insertion.to - insertion.from;
    })
  ) return false;
  editor.view.dispatch(transaction);
  return true;
};
