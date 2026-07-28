import type { ContentWritingStepType } from './contentWritingSessions';
import type {
  CompetitorPhraseIntelligenceDecision,
  CompetitorPhraseIntelligenceItem,
  CompetitorPhraseIntelligenceResult,
} from './competitorPhraseAnalysis';

export type ContentWritingPhraseAttachmentMode =
  | 'direct_stage_instructions'
  | 'generation_request'
  | 'compact_article_context';

export type ContentWritingPhraseMatchLocation = {
  lineNumber: number;
  excerpt: string;
  occurrenceCount: number;
};

export type ContentWritingPhraseAuditItem = {
  id: string;
  text: string;
  decision: CompetitorPhraseIntelligenceDecision;
  score: number;
  totalCount: number;
  competitorCount: number;
  competitorNumbers: number[];
  matchedKeywordTerms: string[];
  rationale: string;
  sentToStage: boolean;
  observedInOutput: boolean;
  outputOccurrenceCount: number;
  locations: ContentWritingPhraseMatchLocation[];
};

export type ContentWritingPhraseAudit = {
  version: 1;
  enabled: boolean;
  available: boolean;
  attachedToStage: boolean;
  stageType: ContentWritingStepType;
  attachmentModes: ContentWritingPhraseAttachmentMode[];
  analyzedCompetitorCount: number;
  analyzedPhraseCount: number;
  sentPhraseCount: number;
  observedPhraseCount: number;
  observedOccurrenceCount: number;
  outputSubject: 'stage_result' | 'accepted_candidate_article';
  items: ContentWritingPhraseAuditItem[];
};

const PROMPT_BUCKET_LIMITS: Record<CompetitorPhraseIntelligenceDecision, number> = {
  must_cover: 25,
  supporting: 25,
  review: 20,
  low_priority: 20,
  ignore: 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeSearchText = (value: string): string => (
  value
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

const countOccurrences = (text: string, phrase: string): number => {
  if (!text || !phrase) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length - phrase.length) {
    const index = text.indexOf(phrase, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, phrase.length);
  }
  return count;
};

const phraseIdentity = (item: CompetitorPhraseIntelligenceItem): string => (
  String(item.normalizedText || '').trim() || normalizeSearchText(String(item.text || ''))
);

const normalizePhraseItems = (
  intelligence: CompetitorPhraseIntelligenceResult,
): Array<CompetitorPhraseIntelligenceItem & { id: string }> => {
  const knownIds = new Map<string, string>();
  (Array.isArray(intelligence.items) ? intelligence.items : []).forEach((item, index) => {
    const identity = phraseIdentity(item);
    if (identity && !knownIds.has(identity)) {
      knownIds.set(identity, String(item.id || `CP${String(index + 1).padStart(3, '0')}`));
    }
  });

  const orderedBuckets: CompetitorPhraseIntelligenceItem[][] = [
    Array.isArray(intelligence.mustCover) ? intelligence.mustCover : [],
    Array.isArray(intelligence.supporting) ? intelligence.supporting : [],
    Array.isArray(intelligence.review) ? intelligence.review : [],
    Array.isArray(intelligence.lowPriority) ? intelligence.lowPriority : [],
    Array.isArray(intelligence.ignored) ? intelligence.ignored : [],
  ];
  const result: Array<CompetitorPhraseIntelligenceItem & { id: string }> = [];
  const seen = new Set<string>();
  const source = (Array.isArray(intelligence.items) && intelligence.items.length > 0)
    ? intelligence.items
    : orderedBuckets.flat();

  source.forEach((item, index) => {
    const identity = phraseIdentity(item);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    result.push({
      ...item,
      id: String(item.id || knownIds.get(identity) || `CP${String(index + 1).padStart(3, '0')}`),
    });
  });
  return result;
};

const getSentPhraseIdentities = (
  intelligence: CompetitorPhraseIntelligenceResult,
): Set<string> => {
  const buckets: Array<[CompetitorPhraseIntelligenceDecision, CompetitorPhraseIntelligenceItem[]]> = [
    ['must_cover', Array.isArray(intelligence.mustCover) ? intelligence.mustCover : []],
    ['supporting', Array.isArray(intelligence.supporting) ? intelligence.supporting : []],
    ['review', Array.isArray(intelligence.review) ? intelligence.review : []],
    ['low_priority', Array.isArray(intelligence.lowPriority) ? intelligence.lowPriority : []],
    ['ignore', Array.isArray(intelligence.ignored) ? intelligence.ignored : []],
  ];
  return new Set(
    buckets.flatMap(([decision, items]) => (
      items
        .slice(0, PROMPT_BUCKET_LIMITS[decision])
        .map(phraseIdentity)
        .filter(Boolean)
    )),
  );
};

const getAttachmentModes = (
  stepType: ContentWritingStepType,
  attached: boolean,
): ContentWritingPhraseAttachmentMode[] => {
  if (!attached) return [];
  return stepType === 'competitor_index'
    ? ['generation_request', 'direct_stage_instructions']
    : ['generation_request', 'compact_article_context'];
};

export const getContentWritingPhraseAuditOutput = (options: {
  outputText?: string | null;
  metadata?: Record<string, unknown>;
}): {
  text: string;
  subject: ContentWritingPhraseAudit['outputSubject'];
} => {
  const acceptedDraft = isRecord(options.metadata)
    ? String(options.metadata.acceptedDraft || '').trim()
    : '';
  return acceptedDraft
    ? { text: acceptedDraft, subject: 'accepted_candidate_article' }
    : { text: String(options.outputText || '').trim(), subject: 'stage_result' };
};

export const buildContentWritingPhraseAudit = (options: {
  stepType: ContentWritingStepType;
  intelligence?: CompetitorPhraseIntelligenceResult | null;
  outputText?: string | null;
  outputSubject?: ContentWritingPhraseAudit['outputSubject'];
}): ContentWritingPhraseAudit => {
  const intelligence = options.intelligence;
  const enabled = intelligence?.enabled === true;
  const phraseItems = intelligence ? normalizePhraseItems(intelligence) : [];
  const available = phraseItems.length > 0;
  const attachedToStage = enabled && available;
  const sentIdentities = intelligence && enabled
    ? getSentPhraseIdentities(intelligence)
    : new Set<string>();
  const outputLines = String(options.outputText || '').split(/\r?\n/);

  const items = phraseItems.map((item): ContentWritingPhraseAuditItem => {
    const normalizedPhrase = normalizeSearchText(item.text);
    const locations = normalizedPhrase
      ? outputLines.flatMap((line, index): ContentWritingPhraseMatchLocation[] => {
          const normalizedLine = normalizeSearchText(line);
          const occurrenceCount = countOccurrences(normalizedLine, normalizedPhrase);
          if (occurrenceCount === 0) return [];
          const excerpt = line.replace(/\s+/g, ' ').trim();
          return [{
            lineNumber: index + 1,
            excerpt: excerpt.length > 240 ? `${excerpt.slice(0, 237)}...` : excerpt,
            occurrenceCount,
          }];
        })
      : [];
    const outputOccurrenceCount = locations.reduce(
      (total, location) => total + location.occurrenceCount,
      0,
    );
    return {
      id: item.id,
      text: String(item.text || '').trim(),
      decision: item.decision,
      score: Number(item.score) || 0,
      totalCount: Number(item.totalCount) || 0,
      competitorCount: Number(item.competitorCount) || 0,
      competitorNumbers: Array.isArray(item.competitors)
        ? item.competitors.map(occurrence => Number(occurrence.competitorNumber)).filter(Number.isFinite)
        : [],
      matchedKeywordTerms: Array.isArray(item.matchedKeywordTerms)
        ? item.matchedKeywordTerms.map(String).filter(Boolean)
        : [],
      rationale: String(item.rationale || '').trim(),
      sentToStage: sentIdentities.has(phraseIdentity(item)),
      observedInOutput: outputOccurrenceCount > 0,
      outputOccurrenceCount,
      locations,
    };
  });
  const observedItems = items.filter(item => item.observedInOutput);

  return {
    version: 1,
    enabled,
    available,
    attachedToStage,
    stageType: options.stepType,
    attachmentModes: getAttachmentModes(options.stepType, attachedToStage),
    analyzedCompetitorCount: Number(intelligence?.analyzedCompetitorCount) || 0,
    analyzedPhraseCount: items.length,
    sentPhraseCount: items.filter(item => item.sentToStage).length,
    observedPhraseCount: observedItems.length,
    observedOccurrenceCount: observedItems.reduce(
      (total, item) => total + item.outputOccurrenceCount,
      0,
    ),
    outputSubject: options.outputSubject || 'stage_result',
    items,
  };
};
