export const CONTENT_WRITING_EDITOR_SOURCE_VERSION = 2;

export type ContentWritingEditorSourceKind =
  | 'information'
  | 'recommendation'
  | 'procedure'
  | 'question';

export type ContentWritingEditorSourceItem = {
  id: string;
  order: number;
  kind: ContentWritingEditorSourceKind;
  heading: string;
  label: string;
  text: string;
  mandatory: true;
};

export type ContentWritingEditorSourceLedger = {
  version: number;
  enabled: boolean;
  source: 'editor_snapshot';
  fingerprint: string;
  sourceCharacterCount: number;
  sourceWordCount: number;
  itemCount: number;
  items: ContentWritingEditorSourceItem[];
  structure: ContentWritingEditorStructureLedger;
};

export type ContentWritingEditorHeadingStructure = {
  id: string;
  level: number;
  text: string;
};

export type ContentWritingEditorLinkStructure = {
  id: string;
  href: string;
  text: string;
};

export type ContentWritingEditorListStructure = {
  id: string;
  kind: 'bulletList' | 'orderedList';
  itemCount: number;
};

export type ContentWritingEditorTableStructure = {
  id: string;
  rowCount: number;
  columnCount: number;
};

export type ContentWritingEditorStructureLedger = {
  version: number;
  source: 'content_json' | 'content_html' | 'plain_text';
  protectedItemCount: number;
  headingCount: number;
  linkCount: number;
  listCount: number;
  listItemCount: number;
  tableCount: number;
  tableRowCount: number;
  headings: ContentWritingEditorHeadingStructure[];
  links: ContentWritingEditorLinkStructure[];
  lists: ContentWritingEditorListStructure[];
  tables: ContentWritingEditorTableStructure[];
};

export type ContentWritingEditorDocumentSnapshot = {
  plainText?: unknown;
  contentJson?: unknown;
  contentHtml?: unknown;
};

export type ContentWritingEditorSourceItemEvidence = {
  itemId: string;
  declared: boolean;
  verified: boolean;
  matchedTokenCount: number;
  sourceTokenCount: number;
  tokenCoveragePercent: number;
};

export type ContentWritingEditorSourceCoverageAudit = {
  version: number;
  requiredItemIds: string[];
  declaredItemIds: string[];
  coveredItemIds: string[];
  missingItemIds: string[];
  coveragePercent: number;
  evidence: ContentWritingEditorSourceItemEvidence[];
};

export type ContentWritingEditorStructureCoverageAudit = {
  version: number;
  required: Pick<
    ContentWritingEditorStructureLedger,
    'headingCount' | 'linkCount' | 'listCount' | 'listItemCount' | 'tableCount' | 'tableRowCount'
  >;
  actual: Pick<
    ContentWritingEditorStructureLedger,
    'headingCount' | 'linkCount' | 'listCount' | 'listItemCount' | 'tableCount' | 'tableRowCount'
  >;
  preservedHeadingIds: string[];
  preservedLinkIds: string[];
  preservedListIds: string[];
  preservedTableIds: string[];
  missingHeadingIds: string[];
  missingLinkIds: string[];
  missingListIds: string[];
  missingTableIds: string[];
  passed: boolean;
};

export type ContentWritingEditorLinkRestoration = {
  markdown: string;
  changed: boolean;
  alreadyPresentLinkIds: string[];
  restoredLinkIds: string[];
  unresolvedLinkIds: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 100_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const uniqueTextList = (value: unknown, maximum = 1_000): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map(item => toText(item, 120)).filter(Boolean))).slice(0, maximum)
  : [];

const countWords = (value: string): number => (
  value.trim() ? value.trim().split(/\s+/u).filter(Boolean).length : 0
);

const fingerprintText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const normalizeSourceText = (value: unknown): string => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\t\u00a0]+/g, ' ')
  .replace(/[ ]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const decodeHtmlEntities = (value: string): string => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code) || 0))
  .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16) || 0));

const htmlToText = (value: string): string => normalizeSourceText(decodeHtmlEntities(
  String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '),
));

const normalizeProtectedText = (value: unknown): string => normalizeSourceText(value)
  .toLocaleLowerCase()
  .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي')
  .replace(/ة/gu, 'ه')
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeProtectedHref = (value: unknown): string => {
  const href = decodeHtmlEntities(toText(value, 4_000)).replace(/\s+/g, ' ').trim();
  if (!href || /^(?:javascript|data|vbscript):/i.test(href)) return '';
  return href;
};

const getTipTapNodeText = (value: unknown): string => {
  if (!isRecord(value)) return '';
  const ownText = toText(value.text, 100_000);
  const childText = Array.isArray(value.content)
    ? value.content.map(getTipTapNodeText).filter(Boolean).join(' ')
    : '';
  return normalizeSourceText(ownText || childText);
};

const extractTipTapPlainText = (value: unknown): string => {
  if (!isRecord(value)) return '';
  if (value.type === 'text') return toText(value.text, 100_000);
  if (value.type === 'hardBreak') return '\n';
  if (!Array.isArray(value.content)) return '';
  const blockSeparator = [
    'doc',
    'paragraph',
    'heading',
    'listItem',
    'bulletList',
    'orderedList',
    'table',
    'tableRow',
  ].includes(toText(value.type, 60)) ? '\n' : ' ';
  return normalizeSourceText(value.content.map(extractTipTapPlainText).join(blockSeparator));
};

const createEmptyStructureLedger = (
  source: ContentWritingEditorStructureLedger['source'] = 'plain_text',
): ContentWritingEditorStructureLedger => ({
  version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
  source,
  protectedItemCount: 0,
  headingCount: 0,
  linkCount: 0,
  listCount: 0,
  listItemCount: 0,
  tableCount: 0,
  tableRowCount: 0,
  headings: [],
  links: [],
  lists: [],
  tables: [],
});

const finalizeStructureLedger = (options: {
  source: ContentWritingEditorStructureLedger['source'];
  headings: Array<Omit<ContentWritingEditorHeadingStructure, 'id'>>;
  links: Array<Omit<ContentWritingEditorLinkStructure, 'id'>>;
  lists: Array<Omit<ContentWritingEditorListStructure, 'id'>>;
  tables: Array<Omit<ContentWritingEditorTableStructure, 'id'>>;
}): ContentWritingEditorStructureLedger => {
  const headings = options.headings
    .filter(item => item.text)
    .map((item, index) => ({ ...item, id: `H${String(index + 1).padStart(3, '0')}` }));
  const seenLinks = new Set<string>();
  const links = options.links.flatMap((item): ContentWritingEditorLinkStructure[] => {
    const href = normalizeProtectedHref(item.href);
    const identity = `${href}\u0000${normalizeProtectedText(item.text)}`;
    if (!href || seenLinks.has(identity)) return [];
    seenLinks.add(identity);
    return [{
      ...item,
      href,
      id: `A${String(seenLinks.size).padStart(3, '0')}`,
    }];
  });
  const lists = options.lists.map((item, index) => ({
    ...item,
    itemCount: Math.max(1, Math.round(item.itemCount || 1)),
    id: `L${String(index + 1).padStart(3, '0')}`,
  }));
  const tables = options.tables.map((item, index) => ({
    ...item,
    rowCount: Math.max(1, Math.round(item.rowCount || 1)),
    columnCount: Math.max(1, Math.round(item.columnCount || 1)),
    id: `T${String(index + 1).padStart(3, '0')}`,
  }));
  return {
    version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
    source: options.source,
    protectedItemCount: headings.length + links.length + lists.length + tables.length,
    headingCount: headings.length,
    linkCount: links.length,
    listCount: lists.length,
    listItemCount: lists.reduce((sum, item) => sum + item.itemCount, 0),
    tableCount: tables.length,
    tableRowCount: tables.reduce((sum, item) => sum + item.rowCount, 0),
    headings,
    links,
    lists,
    tables,
  };
};

const buildTipTapStructureLedger = (value: unknown): ContentWritingEditorStructureLedger => {
  if (!isRecord(value)) return createEmptyStructureLedger('content_json');
  const headings: Array<Omit<ContentWritingEditorHeadingStructure, 'id'>> = [];
  const links: Array<Omit<ContentWritingEditorLinkStructure, 'id'>> = [];
  const lists: Array<Omit<ContentWritingEditorListStructure, 'id'>> = [];
  const tables: Array<Omit<ContentWritingEditorTableStructure, 'id'>> = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    const type = toText(node.type, 60);
    const attrs = isRecord(node.attrs) ? node.attrs : {};
    if (type === 'heading') {
      headings.push({
        level: Math.max(1, Math.min(6, Math.round(Number(attrs.level) || 2))),
        text: getTipTapNodeText(node),
      });
    }
    if (type === 'bulletList' || type === 'orderedList') {
      lists.push({
        kind: type,
        itemCount: Array.isArray(node.content)
          ? Math.max(1, node.content.filter(item => isRecord(item) && item.type === 'listItem').length)
          : 1,
      });
    }
    if (type === 'table') {
      const rows = Array.isArray(node.content)
        ? node.content.filter(item => isRecord(item) && item.type === 'tableRow')
        : [];
      tables.push({
        rowCount: Math.max(1, rows.length),
        columnCount: Math.max(1, ...rows.map(row => (
          Array.isArray(row.content)
            ? row.content.filter((cell: unknown) => isRecord(cell) && (
                cell.type === 'tableCell' || cell.type === 'tableHeader'
              )).length
            : 0
        ))),
      });
    }
    if (type === 'text' && Array.isArray(node.marks)) {
      node.marks.forEach(mark => {
        if (!isRecord(mark) || mark.type !== 'link') return;
        const markAttrs = isRecord(mark.attrs) ? mark.attrs : {};
        links.push({
          href: normalizeProtectedHref(markAttrs.href),
          text: toText(node.text, 5_000),
        });
      });
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(value);
  return finalizeStructureLedger({ source: 'content_json', headings, links, lists, tables });
};

const buildHtmlStructureLedger = (value: unknown): ContentWritingEditorStructureLedger => {
  const html = typeof value === 'string' ? value : '';
  if (!html.trim()) return createEmptyStructureLedger('content_html');
  const headings = Array.from(html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi))
    .map(match => ({ level: Number(match[1]), text: htmlToText(match[2]) }));
  const links = Array.from(html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi))
    .map(match => ({ href: match[1] || match[2] || match[3] || '', text: htmlToText(match[4]) }));
  const lists = Array.from(html.matchAll(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi))
    .map(match => ({
      kind: match[1].toLowerCase() === 'ol' ? 'orderedList' as const : 'bulletList' as const,
      itemCount: Math.max(1, Array.from(match[2].matchAll(/<li\b/gi)).length),
    }));
  const tables = Array.from(html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi))
    .map(match => {
      const rows = Array.from(match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
      return {
        rowCount: Math.max(1, rows.length),
        columnCount: Math.max(1, ...rows.map(row => (
          Array.from(row[1].matchAll(/<t[hd]\b/gi)).length
        ))),
      };
    });
  return finalizeStructureLedger({ source: 'content_html', headings, links, lists, tables });
};

const buildMarkdownStructureLedger = (value: unknown): ContentWritingEditorStructureLedger => {
  const markdown = String(value || '').replace(/\r\n?/g, '\n');
  const headings = Array.from(markdown.matchAll(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gmu))
    .map(match => ({ level: match[1].length, text: normalizeSourceText(match[2]) }));
  const links = [
    ...Array.from(markdown.matchAll(/\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g))
      .map(match => ({ href: match[2] || match[3] || '', text: match[1] })),
    ...buildHtmlStructureLedger(markdown).links.map(link => ({ href: link.href, text: link.text })),
  ];
  const lines = markdown.split('\n');
  const lists: Array<Omit<ContentWritingEditorListStructure, 'id'>> = [];
  for (let index = 0; index < lines.length;) {
    const bullet = /^\s*[-+*]\s+\S/u.test(lines[index]);
    const ordered = /^\s*\d+[.)]\s+\S/u.test(lines[index]);
    if (!bullet && !ordered) {
      index += 1;
      continue;
    }
    const kind = ordered ? 'orderedList' as const : 'bulletList' as const;
    let itemCount = 0;
    while (index < lines.length && (
      kind === 'orderedList'
        ? /^\s*\d+[.)]\s+\S/u.test(lines[index])
        : /^\s*[-+*]\s+\S/u.test(lines[index])
    )) {
      itemCount += 1;
      index += 1;
    }
    lists.push({ kind, itemCount });
  }
  const tables: Array<Omit<ContentWritingEditorTableStructure, 'id'>> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      !lines[index].includes('|')
      || !/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/u.test(lines[index + 1])
    ) continue;
    let rowCount = 1;
    const columnCount = Math.max(1, lines[index].split('|').filter(cell => cell.trim()).length);
    index += 2;
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
      rowCount += 1;
      index += 1;
    }
    tables.push({ rowCount, columnCount });
    index -= 1;
  }
  return finalizeStructureLedger({ source: 'plain_text', headings, links, lists, tables });
};

const resolveEditorStructureLedger = (options: {
  contentJson?: unknown;
  contentHtml?: unknown;
  plainText?: unknown;
}): ContentWritingEditorStructureLedger => {
  const candidates = [
    buildTipTapStructureLedger(options.contentJson),
    buildHtmlStructureLedger(options.contentHtml),
    buildMarkdownStructureLedger(options.plainText),
  ];
  return candidates.sort((left, right) => (
    right.protectedItemCount - left.protectedItemCount
    || right.linkCount - left.linkCount
    || right.tableCount - left.tableCount
  ))[0] || createEmptyStructureLedger();
};

const isLikelyHeading = (value: string): boolean => {
  const text = value.replace(/^#{1,6}\s+/, '').trim();
  if (!text || text.length > 140 || countWords(text) > 14) return false;
  if (/\?|؟|(?:نوصي|يوصى|يُنصح|ينصح|الأفضل|من المهم|يجب|ينبغي|احرص|تجنب|توصية|ابدأ|ثم|بعد ذلك|recommend|should|must|avoid)/iu.test(text)) {
    return false;
  }
  return /^#{1,6}\s+/.test(value)
    || (!/[.!؟؛:]$/u.test(text) && !/^[-*•\d]+[.)-]?\s+/u.test(text));
};

const splitLongSegment = (value: string, maximumCharacters = 650): string[] => {
  const text = value.trim();
  if (!text) return [];
  if (text.length <= maximumCharacters) return [text];
  const sentences = text.split(/(?<=[.!؟؛])\s+/u).filter(Boolean);
  const output: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) output.push(current.trim());
    current = '';
  };
  sentences.forEach(sentence => {
    if (sentence.length > maximumCharacters) {
      flush();
      let remaining = sentence.trim();
      while (remaining.length > maximumCharacters) {
        const window = remaining.slice(0, maximumCharacters + 1);
        const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('،'));
        const end = boundary >= Math.round(maximumCharacters * 0.55)
          ? boundary
          : maximumCharacters;
        output.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
      }
      if (remaining) current = remaining;
      return;
    }
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maximumCharacters) flush();
    current = current ? `${current} ${sentence}` : sentence;
  });
  flush();
  return output;
};

const classifyItem = (value: string): ContentWritingEditorSourceKind => {
  if (/\?|؟/u.test(value)) return 'question';
  if (/(?:نوصي|يوصى|يُنصح|ينصح|الأفضل|من المهم|يجب|ينبغي|احرص|تجنب|توصية|recommend|should|must|avoid)/iu.test(value)) {
    return 'recommendation';
  }
  if (/(?:الخطوة|خطوات|طريقة|كيفية|ابدأ|اطلب|راجع|حدد|قارن|اختر|ثم|بعد ذلك|أولاً|أولا|ثانياً|ثانيا|procedure|steps?|how to)/iu.test(value)) {
    return 'procedure';
  }
  return 'information';
};

const createItemLabel = (value: string): string => {
  const normalized = value
    .replace(/^[-*•\d]+[.)-]?\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 110 ? `${normalized.slice(0, 107).trim()}…` : normalized;
};

export const buildContentWritingEditorSourceLedger = (
  value: unknown,
): ContentWritingEditorSourceLedger => {
  const snapshot: ContentWritingEditorDocumentSnapshot = isRecord(value) && (
    Object.prototype.hasOwnProperty.call(value, 'plainText')
    || Object.prototype.hasOwnProperty.call(value, 'contentJson')
    || Object.prototype.hasOwnProperty.call(value, 'contentHtml')
  ) ? value : { plainText: value };
  const sourceText = normalizeSourceText(
    snapshot.plainText
    || extractTipTapPlainText(snapshot.contentJson)
    || htmlToText(typeof snapshot.contentHtml === 'string' ? snapshot.contentHtml : ''),
  );
  const rawItems: Array<{ heading: string; text: string }> = [];
  let heading = '';
  let headingConsumed = false;
  sourceText.split(/\n+/u).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    if (isLikelyHeading(line)) {
      if (heading && !headingConsumed) rawItems.push({ heading: '', text: heading });
      heading = line.replace(/^#{1,6}\s+/, '').trim();
      headingConsumed = false;
      return;
    }
    splitLongSegment(line).forEach(text => rawItems.push({ heading, text }));
    headingConsumed = true;
  });
  if (heading && !headingConsumed) rawItems.push({ heading: '', text: heading });

  const items = rawItems.map((item, index): ContentWritingEditorSourceItem => ({
    id: `E${String(index + 1).padStart(3, '0')}`,
    order: index + 1,
    kind: classifyItem(item.text),
    heading: item.heading,
    label: createItemLabel(item.text),
    text: item.text,
    mandatory: true,
  }));
  const structure = resolveEditorStructureLedger(snapshot);
  return {
    version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
    enabled: items.length > 0,
    source: 'editor_snapshot',
    fingerprint: fingerprintText(sourceText),
    sourceCharacterCount: Array.from(sourceText).length,
    sourceWordCount: countWords(sourceText),
    itemCount: items.length,
    items,
    structure,
  };
};

export const normalizeContentWritingEditorSourceLedger = (
  value: unknown,
): ContentWritingEditorSourceLedger => {
  const source = isRecord(value) ? value : {};
  const items = Array.isArray(source.items)
    ? source.items.flatMap((item, index): ContentWritingEditorSourceItem[] => {
        if (!isRecord(item)) return [];
        const text = toText(item.text, 5_000);
        if (!text) return [];
        const kind: ContentWritingEditorSourceKind = (
          item.kind === 'recommendation'
          || item.kind === 'procedure'
          || item.kind === 'question'
        ) ? item.kind : 'information';
        return [{
          id: toText(item.id, 120) || `E${String(index + 1).padStart(3, '0')}`,
          order: Math.max(1, Math.round(Number(item.order) || index + 1)),
          kind,
          heading: toText(item.heading, 300),
          label: toText(item.label, 300) || createItemLabel(text),
          text,
          mandatory: true,
        }];
      })
    : [];
  const structureSource = isRecord(source.structure) ? source.structure : {};
  const normalizeHeadingStructures = (): ContentWritingEditorHeadingStructure[] => (
    Array.isArray(structureSource.headings) ? structureSource.headings : []
  ).flatMap((item, index): ContentWritingEditorHeadingStructure[] => {
    if (!isRecord(item)) return [];
    const text = toText(item.text, 500);
    if (!text) return [];
    return [{
      id: toText(item.id, 120) || `H${String(index + 1).padStart(3, '0')}`,
      level: Math.max(1, Math.min(6, Math.round(Number(item.level) || 2))),
      text,
    }];
  });
  const normalizeLinkStructures = (): ContentWritingEditorLinkStructure[] => (
    Array.isArray(structureSource.links) ? structureSource.links : []
  ).flatMap((item, index): ContentWritingEditorLinkStructure[] => {
    if (!isRecord(item)) return [];
    const href = normalizeProtectedHref(item.href);
    if (!href) return [];
    return [{
      id: toText(item.id, 120) || `A${String(index + 1).padStart(3, '0')}`,
      href,
      text: toText(item.text, 500),
    }];
  });
  const normalizeListStructures = (): ContentWritingEditorListStructure[] => (
    Array.isArray(structureSource.lists) ? structureSource.lists : []
  ).flatMap((item, index): ContentWritingEditorListStructure[] => {
    if (!isRecord(item)) return [];
    return [{
      id: toText(item.id, 120) || `L${String(index + 1).padStart(3, '0')}`,
      kind: item.kind === 'orderedList' ? 'orderedList' : 'bulletList',
      itemCount: Math.max(1, Math.round(Number(item.itemCount) || 1)),
    }];
  });
  const normalizeTableStructures = (): ContentWritingEditorTableStructure[] => (
    Array.isArray(structureSource.tables) ? structureSource.tables : []
  ).flatMap((item, index): ContentWritingEditorTableStructure[] => {
    if (!isRecord(item)) return [];
    return [{
      id: toText(item.id, 120) || `T${String(index + 1).padStart(3, '0')}`,
      rowCount: Math.max(1, Math.round(Number(item.rowCount) || 1)),
      columnCount: Math.max(1, Math.round(Number(item.columnCount) || 1)),
    }];
  });
  const headings = normalizeHeadingStructures();
  const links = normalizeLinkStructures();
  const lists = normalizeListStructures();
  const tables = normalizeTableStructures();
  const structure = finalizeStructureLedger({
    source: structureSource.source === 'content_json' || structureSource.source === 'content_html'
      ? structureSource.source
      : 'plain_text',
    headings: headings.map(({ level, text }) => ({ level, text })),
    links: links.map(({ href, text }) => ({ href, text })),
    lists: lists.map(({ kind, itemCount }) => ({ kind, itemCount })),
    tables: tables.map(({ rowCount, columnCount }) => ({ rowCount, columnCount })),
  });
  return {
    version: Math.max(1, Math.round(Number(source.version) || CONTENT_WRITING_EDITOR_SOURCE_VERSION)),
    enabled: items.length > 0,
    source: 'editor_snapshot',
    fingerprint: toText(source.fingerprint, 120) || fingerprintText(items.map(item => item.text).join('\n')),
    sourceCharacterCount: Math.max(0, Math.round(Number(source.sourceCharacterCount) || items.reduce((sum, item) => sum + item.text.length, 0))),
    sourceWordCount: Math.max(0, Math.round(Number(source.sourceWordCount) || items.reduce((sum, item) => sum + countWords(item.text), 0))),
    itemCount: items.length,
    items,
    structure,
  };
};

const normalizeToken = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي')
  .replace(/ة/gu, 'ه')
  .replace(/^(?:وال|بال|كال|فال|لل)/u, '')
  .replace(/^(?:و|ف|ب|ك|ل)/u, '');

const STOP_WORDS = new Set([
  'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'من', 'في', 'على', 'الى', 'عن', 'مع', 'او',
  'and', 'the', 'for', 'from', 'with', 'this', 'that', 'are', 'is', 'to', 'of',
]);

const tokenize = (value: string): string[] => Array.from(new Set(
  String(value || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/u)
    .map(normalizeToken)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
));

export const evaluateContentWritingEditorSourceCoverage = (options: {
  outputText: string;
  items: readonly ContentWritingEditorSourceItem[];
  requiredItemIds?: readonly string[];
  declaredItemIds?: readonly string[];
}): ContentWritingEditorSourceCoverageAudit => {
  const requiredSet = new Set(options.requiredItemIds || options.items.map(item => item.id));
  const declaredSet = new Set(options.declaredItemIds || []);
  const requiredItems = options.items.filter(item => requiredSet.has(item.id));
  const outputTokens = new Set(tokenize(options.outputText));
  const normalizedOutput = normalizeSourceText(options.outputText).toLocaleLowerCase();
  const evidence = requiredItems.map((item): ContentWritingEditorSourceItemEvidence => {
    const sourceTokens = tokenize(`${item.heading} ${item.text}`);
    const matchedTokenCount = sourceTokens.filter(token => outputTokens.has(token)).length;
    const tokenCoverage = sourceTokens.length > 0 ? matchedTokenCount / sourceTokens.length : 0;
    const declared = declaredSet.has(item.id);
    const normalizedItem = normalizeSourceText(item.text).toLocaleLowerCase();
    const exactMatch = normalizedItem.length >= 20 && normalizedOutput.includes(normalizedItem);
    const lowEvidenceThreshold = sourceTokens.length <= 2
      ? matchedTokenCount >= sourceTokens.length && sourceTokens.length > 0
      : matchedTokenCount >= 2 && tokenCoverage >= 0.18;
    const strongEvidenceThreshold = sourceTokens.length <= 3
      ? matchedTokenCount >= Math.max(1, sourceTokens.length - 1)
      : matchedTokenCount >= 3 && tokenCoverage >= 0.34;
    return {
      itemId: item.id,
      declared,
      verified: exactMatch || strongEvidenceThreshold || (declared && lowEvidenceThreshold),
      matchedTokenCount,
      sourceTokenCount: sourceTokens.length,
      tokenCoveragePercent: Math.round(tokenCoverage * 100),
    };
  });
  const coveredItemIds = evidence.filter(item => item.verified).map(item => item.itemId);
  const missingItemIds = evidence.filter(item => !item.verified).map(item => item.itemId);
  return {
    version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
    requiredItemIds: requiredItems.map(item => item.id),
    declaredItemIds: uniqueTextList(options.declaredItemIds),
    coveredItemIds,
    missingItemIds,
    coveragePercent: requiredItems.length > 0
      ? Math.round((coveredItemIds.length / requiredItems.length) * 100)
      : 100,
    evidence,
  };
};

export const evaluateContentWritingEditorStructureCoverage = (options: {
  outputMarkdown: string;
  structure: ContentWritingEditorStructureLedger;
}): ContentWritingEditorStructureCoverageAudit => {
  const required = options.structure;
  const actual = buildMarkdownStructureLedger(options.outputMarkdown);
  const actualHeadings = new Map<string, number>();
  actual.headings.forEach(heading => {
    const key = `${heading.level}:${normalizeProtectedText(heading.text)}`;
    actualHeadings.set(key, (actualHeadings.get(key) || 0) + 1);
  });
  const preservedHeadingIds: string[] = [];
  const missingHeadingIds: string[] = [];
  required.headings.forEach(heading => {
    const key = `${heading.level}:${normalizeProtectedText(heading.text)}`;
    const count = actualHeadings.get(key) || 0;
    if (count > 0) {
      preservedHeadingIds.push(heading.id);
      actualHeadings.set(key, count - 1);
    } else {
      missingHeadingIds.push(heading.id);
    }
  });

  const actualLinkHrefs = new Map<string, number>();
  actual.links.forEach(link => {
    const key = normalizeProtectedHref(link.href);
    actualLinkHrefs.set(key, (actualLinkHrefs.get(key) || 0) + 1);
  });
  const preservedLinkIds: string[] = [];
  const missingLinkIds: string[] = [];
  required.links.forEach(link => {
    const key = normalizeProtectedHref(link.href);
    const count = actualLinkHrefs.get(key) || 0;
    if (key && count > 0) {
      preservedLinkIds.push(link.id);
      actualLinkHrefs.set(key, count - 1);
    } else {
      missingLinkIds.push(link.id);
    }
  });

  const unmatchedLists = [...actual.lists];
  const preservedListIds: string[] = [];
  const missingListIds: string[] = [];
  required.lists.forEach(list => {
    const candidateIndex = unmatchedLists.findIndex(candidate => (
      candidate.kind === list.kind && candidate.itemCount >= list.itemCount
    ));
    if (candidateIndex >= 0) {
      preservedListIds.push(list.id);
      unmatchedLists.splice(candidateIndex, 1);
    } else {
      missingListIds.push(list.id);
    }
  });

  const unmatchedTables = [...actual.tables];
  const preservedTableIds: string[] = [];
  const missingTableIds: string[] = [];
  required.tables.forEach(table => {
    const candidateIndex = unmatchedTables.findIndex(candidate => (
      candidate.rowCount >= table.rowCount && candidate.columnCount >= table.columnCount
    ));
    if (candidateIndex >= 0) {
      preservedTableIds.push(table.id);
      unmatchedTables.splice(candidateIndex, 1);
    } else {
      missingTableIds.push(table.id);
    }
  });

  const counts = (ledger: ContentWritingEditorStructureLedger) => ({
    headingCount: ledger.headingCount,
    linkCount: ledger.linkCount,
    listCount: ledger.listCount,
    listItemCount: ledger.listItemCount,
    tableCount: ledger.tableCount,
    tableRowCount: ledger.tableRowCount,
  });
  const passed = (
    missingHeadingIds.length === 0
    && missingLinkIds.length === 0
    && missingListIds.length === 0
    && missingTableIds.length === 0
  );
  return {
    version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
    required: counts(required),
    actual: counts(actual),
    preservedHeadingIds,
    preservedLinkIds,
    preservedListIds,
    preservedTableIds,
    missingHeadingIds,
    missingLinkIds,
    missingListIds,
    missingTableIds,
    passed,
  };
};

const countLiteralTextOccurrences = (value: string, search: string): number => {
  if (!search) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - search.length) {
    const index = value.indexOf(search, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, search.length);
  }
  return count;
};

/** Restores frozen editor hrefs only when their exact visible anchor is unique. */
export const restoreContentWritingEditorLinks = (options: {
  markdown: string;
  structure: ContentWritingEditorStructureLedger;
}): ContentWritingEditorLinkRestoration => {
  const originalMarkdown = String(options.markdown || '').replace(/\r\n?/g, '\n');
  let markdown = originalMarkdown;
  const actual = buildMarkdownStructureLedger(markdown);
  const hrefAvailability = new Map<string, number>();
  actual.links.forEach(link => {
    const href = normalizeProtectedHref(link.href);
    hrefAvailability.set(href, (hrefAvailability.get(href) || 0) + 1);
  });
  const alreadyPresentLinkIds: string[] = [];
  const restoredLinkIds: string[] = [];
  const unresolvedLinkIds: string[] = [];

  options.structure.links.forEach(link => {
    const href = normalizeProtectedHref(link.href);
    const available = hrefAvailability.get(href) || 0;
    if (href && available > 0) {
      alreadyPresentLinkIds.push(link.id);
      hrefAvailability.set(href, available - 1);
      return;
    }
    const anchor = normalizeSourceText(link.text);
    if (!href || !anchor || countLiteralTextOccurrences(markdown, anchor) !== 1) {
      unresolvedLinkIds.push(link.id);
      return;
    }
    const anchorIndex = markdown.indexOf(anchor);
    const prefix = markdown.slice(0, anchorIndex);
    const suffix = markdown.slice(anchorIndex + anchor.length);
    const markdownLinkPrefix = prefix.lastIndexOf('[');
    const markdownLinkSuffix = suffix.match(/^\]\([^\n)]*\)/)?.[0] || '';
    if (
      markdownLinkPrefix >= 0
      && !prefix.slice(markdownLinkPrefix + 1).includes(']')
      && markdownLinkSuffix
    ) {
      markdown = `${prefix.slice(0, markdownLinkPrefix)}[${anchor}](${href})${suffix.slice(markdownLinkSuffix.length)}`;
    } else {
      markdown = `${prefix}[${anchor}](${href})${suffix}`;
    }
    restoredLinkIds.push(link.id);
  });

  return {
    markdown,
    changed: markdown !== originalMarkdown,
    alreadyPresentLinkIds,
    restoredLinkIds,
    unresolvedLinkIds,
  };
};

export const contentWritingEditorSourceLedgerToPromptJson = (
  ledger: ContentWritingEditorSourceLedger,
): string => JSON.stringify({
  version: ledger.version,
  source: ledger.source,
  policy: 'Every item is mandatory. Preserve its useful meaning; do not copy wording unless necessary.',
  items: ledger.items,
  protectedStructure: {
    policy: 'Preserve every heading at its level, every exact link href, and at least the listed list/table dimensions.',
    ...ledger.structure,
  },
}, null, 2);
