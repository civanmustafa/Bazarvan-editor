export type PresentedContentWritingKnowledgeItem = {
  topic: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
  competitorNumbers: number[];
  originalityOpportunity: string;
};

export type PresentedContentWritingSource = {
  competitorNumber: number;
  category: string;
  freshness: string;
  notes: string;
};

export type PresentedContentWritingClaim = {
  statement: string;
  claimType: string;
  riskLevel: 'high' | 'medium' | 'low';
  competitorNumbers: number[];
  conflicting: boolean;
  guidance: string;
};

export type PresentedContentWritingKnowledge = {
  processedChunkCount: number;
  competitorCount: number;
  items: PresentedContentWritingKnowledgeItem[];
  sources: PresentedContentWritingSource[];
  claims: PresentedContentWritingClaim[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 4_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toNumberList = (value: unknown): number[] => Array.isArray(value)
  ? Array.from(new Set(
    value
      .map(item => Math.round(Number(item)))
      .filter(item => Number.isFinite(item) && item > 0),
  )).sort((left, right) => left - right)
  : [];

const getCompetitorNumbersFromChunkIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap(item => {
    const match = toText(item, 120).match(/^C(\d+)-S\d+$/i);
    return match ? [Number(match[1])] : [];
  }))).sort((left, right) => left - right);
};

export const parseContentWritingPresentationObject = (
  value: string,
): Record<string, unknown> | null => {
  const normalized = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
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

const normalizePriority = (value: unknown): 'high' | 'medium' | 'low' => (
  value === 'high' || value === 'low' ? value : 'medium'
);

export const presentContentWritingKnowledge = (
  outputText: string,
): PresentedContentWritingKnowledge | null => {
  const source = parseContentWritingPresentationObject(outputText);
  if (!source) return null;

  const items = Array.isArray(source.items)
    ? source.items.flatMap((value): PresentedContentWritingKnowledgeItem[] => {
      if (!isRecord(value)) return [];
      const topic = toText(value.topic, 500);
      const detail = toText(value.detail);
      if (!topic && !detail) return [];
      const explicitCompetitors = toNumberList(value.competitorNumbers);
      return [{
        topic: topic || detail.slice(0, 120),
        detail,
        priority: normalizePriority(value.priority),
        competitorNumbers: explicitCompetitors.length > 0
          ? explicitCompetitors
          : getCompetitorNumbersFromChunkIds(value.sourceChunkIds),
        originalityOpportunity: toText(value.originalityOpportunity),
      }];
    })
    : [];

  const sources = Array.isArray(source.sourceAssessments)
    ? source.sourceAssessments.flatMap((value): PresentedContentWritingSource[] => {
      if (!isRecord(value)) return [];
      const competitorNumber = Math.round(Number(value.competitorNumber));
      if (!Number.isFinite(competitorNumber) || competitorNumber < 1) return [];
      return [{
        competitorNumber,
        category: toText(value.category, 80) || 'unknown',
        freshness: toText(value.freshness, 80) || 'unknown',
        notes: toText(value.assessmentNotes),
      }];
    }).sort((left, right) => left.competitorNumber - right.competitorNumber)
    : [];

  const claims = Array.isArray(source.claims)
    ? source.claims.flatMap((value): PresentedContentWritingClaim[] => {
      if (!isRecord(value)) return [];
      const statement = toText(value.statement);
      if (!statement) return [];
      return [{
        statement,
        claimType: toText(value.claimType, 80) || 'factual',
        riskLevel: normalizePriority(value.riskLevel),
        competitorNumbers: getCompetitorNumbersFromChunkIds(value.supportingSourceChunkIds),
        conflicting: value.conflicting === true,
        guidance: toText(value.usageGuidance),
      }];
    })
    : [];

  const processedChunkCount = Array.isArray(source.processedChunkIds)
    ? source.processedChunkIds.filter(value => Boolean(toText(value, 120))).length
    : 0;
  const competitorNumbers = new Set<number>();
  items.forEach(item => item.competitorNumbers.forEach(number => competitorNumbers.add(number)));
  sources.forEach(item => competitorNumbers.add(item.competitorNumber));
  claims.forEach(item => item.competitorNumbers.forEach(number => competitorNumbers.add(number)));

  if (items.length === 0 && sources.length === 0 && claims.length === 0) return null;
  return {
    processedChunkCount,
    competitorCount: competitorNumbers.size,
    items,
    sources,
    claims,
  };
};
