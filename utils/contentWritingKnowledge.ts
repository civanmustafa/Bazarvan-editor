export const CONTENT_WRITING_COMPETITOR_CHUNK_SIZE = 1_600;
export const CONTENT_WRITING_KNOWLEDGE_VERSION = 1;

export type ContentWritingSourceChunk = {
  id: string;
  competitorNumber: number;
  title: string;
  url: string;
  text: string;
};

export type ContentWritingKnowledgeItem = {
  id: string;
  topic: string;
  detail: string;
  kind: string;
  priority: 'high' | 'medium' | 'low';
  sourceChunkIds: string[];
};

export type ContentWritingKnowledgeBase = {
  version: number;
  items: ContentWritingKnowledgeItem[];
  processedChunkIds: string[];
  modelProcessedChunkIds: string[];
  fallbackChunkIds: string[];
};

export type ContentWritingSectionCoverage = {
  coveredIdeaIds: string[];
  usedSourceChunkIds: string[];
};

export type ContentWritingCoverageRepair = {
  sectionKey: string;
  instructions: string;
  ideaIds: string[];
  sourceChunkIds: string[];
};

export type ContentWritingCoverageAudit = {
  missingIdeaIds: string[];
  weakIdeaIds: string[];
  duplicateTopics: string[];
  repairs: ContentWritingCoverageRepair[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 20_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toUniqueTextList = (
  value: unknown,
  maximumItems = 500,
  maximumLength = 120,
): string[] => Array.isArray(value)
  ? Array.from(new Set(
    value
      .map(item => toText(item, maximumLength))
      .filter(Boolean),
  )).slice(0, maximumItems)
  : [];

const stripCodeFence = (value: string): string => value
  .trim()
  .replace(/^```(?:json|markdown|md)?\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  const normalized = stripCodeFence(value);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return null;
};

const chooseChunkEnd = (value: string, start: number, maximum: number): number => {
  const hardEnd = Math.min(value.length, start + maximum);
  if (hardEnd >= value.length) return value.length;
  const minimumEnd = start + Math.floor(maximum * 0.6);
  const candidate = value.slice(minimumEnd, hardEnd);
  const newline = candidate.lastIndexOf('\n');
  if (newline >= 0) return minimumEnd + newline + 1;
  const whitespace = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\t'));
  return whitespace >= 0 ? minimumEnd + whitespace + 1 : hardEnd;
};

export const chunkContentWritingCompetitor = (options: {
  competitorNumber: number;
  title?: string;
  url?: string;
  content: string;
  maximumCharacters?: number;
}): ContentWritingSourceChunk[] => {
  const content = String(options.content || '');
  const maximum = Math.max(
    400,
    Math.min(Math.round(options.maximumCharacters || CONTENT_WRITING_COMPETITOR_CHUNK_SIZE), 4_000),
  );
  const chunks: ContentWritingSourceChunk[] = [];
  let start = 0;
  while (start < content.length) {
    const end = chooseChunkEnd(content, start, maximum);
    chunks.push({
      id: `C${options.competitorNumber}-S${String(chunks.length + 1).padStart(3, '0')}`,
      competitorNumber: options.competitorNumber,
      title: toText(options.title, 500),
      url: toText(options.url, 2_000),
      text: content.slice(start, end),
    });
    start = end;
  }
  return chunks;
};

export const reconstructContentWritingCompetitor = (
  chunks: readonly ContentWritingSourceChunk[],
): string => chunks.map(chunk => chunk.text).join('');

export const normalizeContentWritingSourceChunks = (
  value: unknown,
): ContentWritingSourceChunk[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): ContentWritingSourceChunk[] => {
    if (!isRecord(item)) return [];
    const id = toText(item.id, 120);
    const text = typeof item.text === 'string' ? item.text : '';
    const competitorNumber = Math.max(1, Math.min(3, Math.round(Number(item.competitorNumber) || 1)));
    if (!id || seen.has(id) || !text) return [];
    seen.add(id);
    return [{
      id,
      competitorNumber,
      title: toText(item.title, 500),
      url: toText(item.url, 2_000),
      text,
    }];
  }).slice(0, 5_000);
};

const normalizePriority = (value: unknown): ContentWritingKnowledgeItem['priority'] => {
  if (value === 'high' || value === 'low') return value;
  return 'medium';
};

export const normalizeContentWritingKnowledgeBase = (
  value: unknown,
  chunks: readonly ContentWritingSourceChunk[],
): ContentWritingKnowledgeBase => {
  const source = typeof value === 'string' ? parseJsonObject(value) : isRecord(value) ? value : {};
  const validChunkIds = new Set(chunks.map(chunk => chunk.id));
  const declaredModelProcessedChunkIds = toUniqueTextList(source.modelProcessedChunkIds, 5_000)
    .filter(id => validChunkIds.has(id));
  const modelProcessedChunkIds = Array.isArray(source.modelProcessedChunkIds)
    ? declaredModelProcessedChunkIds
    : toUniqueTextList(source.processedChunkIds, 5_000).filter(id => validChunkIds.has(id));
  const itemsSource = Array.isArray(source.items) ? source.items : [];
  const seenItemIds = new Set<string>();
  const items: ContentWritingKnowledgeItem[] = itemsSource.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const proposedId = toText(item.id, 120) || `K${String(index + 1).padStart(3, '0')}`;
    const id = seenItemIds.has(proposedId)
      ? `K${String(index + 1).padStart(3, '0')}`
      : proposedId;
    const topic = toText(item.topic, 500);
    const detail = toText(item.detail ?? item.summary, 2_500);
    const sourceChunkIds = toUniqueTextList(item.sourceChunkIds)
      .filter(chunkId => validChunkIds.has(chunkId));
    if (!topic || !detail || sourceChunkIds.length === 0 || seenItemIds.has(id)) return [];
    seenItemIds.add(id);
    return [{
      id,
      topic,
      detail,
      kind: toText(item.kind, 120) || 'topic',
      priority: normalizePriority(item.priority),
      sourceChunkIds,
    }];
  }).slice(0, 300);

  const representedChunks = new Set(items.flatMap(item => item.sourceChunkIds));
  const fallbackChunkIds = toUniqueTextList(source.fallbackChunkIds, 5_000)
    .filter(id => validChunkIds.has(id));
  chunks.forEach(chunk => {
    if (representedChunks.has(chunk.id)) return;
    if (!fallbackChunkIds.includes(chunk.id)) fallbackChunkIds.push(chunk.id);
    let index = items.length + 1;
    let id = `K${String(index).padStart(3, '0')}`;
    while (seenItemIds.has(id)) {
      index += 1;
      id = `K${String(index).padStart(3, '0')}`;
    }
    seenItemIds.add(id);
    items.push({
      id,
      topic: `${chunk.title || `Competitor ${chunk.competitorNumber}`} — source ${chunk.id}`,
      detail: chunk.text.trim().slice(0, CONTENT_WRITING_COMPETITOR_CHUNK_SIZE),
      kind: 'source_fallback',
      priority: 'medium',
      sourceChunkIds: [chunk.id],
    });
  });

  return {
    version: CONTENT_WRITING_KNOWLEDGE_VERSION,
    items,
    processedChunkIds: chunks.map(chunk => chunk.id),
    modelProcessedChunkIds,
    fallbackChunkIds,
  };
};

export const parseContentWritingKnowledgeBase = (
  value: string,
  chunks: readonly ContentWritingSourceChunk[],
): ContentWritingKnowledgeBase => {
  const source = parseJsonObject(value);
  if (!source || !Array.isArray(source.items)) {
    throw new Error('The competitor index must be valid JSON with an items array.');
  }
  const knowledge = normalizeContentWritingKnowledgeBase(source, chunks);
  if (knowledge.items.length === 0) {
    throw new Error('The competitor index did not return any usable knowledge items.');
  }
  return knowledge;
};

const tokenize = (value: string): Set<string> => new Set(
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .slice(0, 500),
);

const lexicalScore = (queryTokens: Set<string>, value: string): number => {
  const valueTokens = tokenize(value);
  let score = 0;
  queryTokens.forEach(token => {
    if (valueTokens.has(token)) score += 1;
  });
  return score;
};

export const selectRelevantContentWritingChunks = (options: {
  title: string;
  brief: string;
  requiredIdeaIds: readonly string[];
  knowledge: ContentWritingKnowledgeBase;
  chunks: readonly ContentWritingSourceChunk[];
  extraChunkCount?: number;
}): ContentWritingSourceChunk[] => {
  const requiredIdeas = new Set(options.requiredIdeaIds);
  const requiredChunkIds = new Set(
    options.knowledge.items
      .filter(item => requiredIdeas.has(item.id))
      .flatMap(item => item.sourceChunkIds),
  );
  const queryTokens = tokenize(`${options.title}\n${options.brief}`);
  const rankedExtras = options.chunks
    .filter(chunk => !requiredChunkIds.has(chunk.id))
    .map(chunk => ({
      chunk,
      score: lexicalScore(queryTokens, `${chunk.title}\n${chunk.text}`),
    }))
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, Math.max(0, Math.min(options.extraChunkCount ?? 2, 5)))
    .map(item => item.chunk);
  return [
    ...options.chunks.filter(chunk => requiredChunkIds.has(chunk.id)),
    ...rankedExtras,
  ];
};

export const parseContentWritingSectionResult = (
  value: string,
  validIdeaIds: readonly string[],
  validChunkIds: readonly string[],
): { markdown: string; coverage: ContentWritingSectionCoverage } => {
  const source = parseJsonObject(value);
  if (!source) throw new Error('The section must be valid JSON.');
  const markdown = toText(source.markdown, 100_000);
  if (!markdown) throw new Error('The section JSON must contain non-empty Markdown.');
  const ideaSet = new Set(validIdeaIds);
  const chunkSet = new Set(validChunkIds);
  return {
    markdown,
    coverage: {
      coveredIdeaIds: toUniqueTextList(source.coveredIdeaIds).filter(id => ideaSet.has(id)),
      usedSourceChunkIds: toUniqueTextList(source.usedSourceChunkIds).filter(id => chunkSet.has(id)),
    },
  };
};

export const normalizeContentWritingSectionCoverage = (
  value: unknown,
): ContentWritingSectionCoverage => {
  const source = isRecord(value) ? value : {};
  return {
    coveredIdeaIds: toUniqueTextList(source.coveredIdeaIds),
    usedSourceChunkIds: toUniqueTextList(source.usedSourceChunkIds),
  };
};

export const parseContentWritingCoverageAudit = (
  value: string,
  options: {
    validIdeaIds: readonly string[];
    validChunkIds: readonly string[];
    validSectionKeys: readonly string[];
  },
): ContentWritingCoverageAudit => {
  const source = parseJsonObject(value);
  if (!source) throw new Error('The coverage audit must be valid JSON.');
  const ideaIds = new Set(options.validIdeaIds);
  const chunkIds = new Set(options.validChunkIds);
  const sectionKeys = new Set(options.validSectionKeys);
  const repairs = Array.isArray(source.repairs)
    ? source.repairs.flatMap((item): ContentWritingCoverageRepair[] => {
      if (!isRecord(item)) return [];
      const sectionKey = toText(item.sectionKey, 120);
      const instructions = toText(item.instructions, 2_000);
      if (!sectionKeys.has(sectionKey) || !instructions) return [];
      return [{
        sectionKey,
        instructions,
        ideaIds: toUniqueTextList(item.ideaIds).filter(id => ideaIds.has(id)),
        sourceChunkIds: toUniqueTextList(item.sourceChunkIds).filter(id => chunkIds.has(id)),
      }];
    }).slice(0, 3)
    : [];
  return {
    missingIdeaIds: toUniqueTextList(source.missingIdeaIds).filter(id => ideaIds.has(id)),
    weakIdeaIds: toUniqueTextList(source.weakIdeaIds).filter(id => ideaIds.has(id)),
    duplicateTopics: toUniqueTextList(source.duplicateTopics, 50, 500),
    repairs,
  };
};

export const summarizeContentWritingCoverage = (options: {
  knowledge: ContentWritingKnowledgeBase;
  sectionCoverages: readonly ContentWritingSectionCoverage[];
}): {
  coveredIdeaIds: string[];
  missingIdeaIds: string[];
  coveragePercent: number;
} => {
  const covered = new Set(options.sectionCoverages.flatMap(coverage => coverage.coveredIdeaIds));
  const allIds = options.knowledge.items.map(item => item.id);
  const coveredIdeaIds = allIds.filter(id => covered.has(id));
  const missingIdeaIds = allIds.filter(id => !covered.has(id));
  return {
    coveredIdeaIds,
    missingIdeaIds,
    coveragePercent: allIds.length > 0
      ? Math.round((coveredIdeaIds.length / allIds.length) * 100)
      : 100,
  };
};

export const contentWritingKnowledgeToPromptJson = (
  knowledge: ContentWritingKnowledgeBase,
): string => JSON.stringify({
  version: knowledge.version,
  items: knowledge.items,
  processedChunkIds: knowledge.processedChunkIds,
  fallbackChunkIds: knowledge.fallbackChunkIds,
}, null, 2);
