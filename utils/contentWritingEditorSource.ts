export const CONTENT_WRITING_EDITOR_SOURCE_VERSION = 1;

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
  const sourceText = normalizeSourceText(value);
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
  return {
    version: CONTENT_WRITING_EDITOR_SOURCE_VERSION,
    enabled: items.length > 0,
    source: 'editor_snapshot',
    fingerprint: fingerprintText(sourceText),
    sourceCharacterCount: Array.from(sourceText).length,
    sourceWordCount: countWords(sourceText),
    itemCount: items.length,
    items,
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
  return {
    version: Math.max(1, Math.round(Number(source.version) || CONTENT_WRITING_EDITOR_SOURCE_VERSION)),
    enabled: items.length > 0,
    source: 'editor_snapshot',
    fingerprint: toText(source.fingerprint, 120) || fingerprintText(items.map(item => item.text).join('\n')),
    sourceCharacterCount: Math.max(0, Math.round(Number(source.sourceCharacterCount) || items.reduce((sum, item) => sum + item.text.length, 0))),
    sourceWordCount: Math.max(0, Math.round(Number(source.sourceWordCount) || items.reduce((sum, item) => sum + countWords(item.text), 0))),
    itemCount: items.length,
    items,
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

export const contentWritingEditorSourceLedgerToPromptJson = (
  ledger: ContentWritingEditorSourceLedger,
): string => JSON.stringify({
  version: ledger.version,
  source: ledger.source,
  policy: 'Every item is mandatory. Preserve its useful meaning; do not copy wording unless necessary.',
  items: ledger.items,
}, null, 2);
