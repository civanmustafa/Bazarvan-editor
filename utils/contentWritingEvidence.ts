import type {
  ContentWritingKnowledgeBase,
  ContentWritingKnowledgeItem,
  ContentWritingSectionCoverage,
  ContentWritingSourceChunk,
} from './contentWritingKnowledge';
import {
  normalizeContentWritingSourceChunks,
  selectRelevantContentWritingChunks,
} from './contentWritingKnowledge';
import {
  selectContentWritingClaims,
  type ContentWritingClaimLedgerItem,
} from './contentWritingClaims';

export const CONTENT_WRITING_EVIDENCE_TRACE_VERSION = 1;

export type ContentWritingEvidenceTrace = {
  version: number;
  sectionKey: string;
  sectionTitle: string;
  knowledgeItems: ContentWritingKnowledgeItem[];
  claims: ContentWritingClaimLedgerItem[];
  sourceChunks: ContentWritingSourceChunk[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 10_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toTextList = (value: unknown, maximumItems = 500): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map(item => toText(item, 240)).filter(Boolean))).slice(0, maximumItems)
  : [];

const toNumberList = (value: unknown): number[] => Array.isArray(value)
  ? Array.from(new Set(
    value
      .map(item => Math.round(Number(item)))
      .filter(item => Number.isFinite(item) && item > 0),
  )).sort((left, right) => left - right)
  : [];

const normalizeKnowledgeItems = (value: unknown): ContentWritingKnowledgeItem[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ContentWritingKnowledgeItem[] => {
    if (!isRecord(candidate)) return [];
    const id = toText(candidate.id, 120);
    const topic = toText(candidate.topic, 500);
    const detail = toText(candidate.detail ?? candidate.summary, 4_000);
    const sourceChunkIds = toTextList(candidate.sourceChunkIds);
    if (!id || !topic || !detail || sourceChunkIds.length === 0) return [];
    const competitorNumbers = toNumberList(candidate.competitorNumbers);
    const priority = candidate.priority === 'high' || candidate.priority === 'low'
      ? candidate.priority
      : 'medium';
    const coverageLevel = candidate.coverageLevel === 'all_competitors'
      || candidate.coverageLevel === 'multiple_competitors'
      ? candidate.coverageLevel
      : 'single_competitor';
    return [{
      id,
      topic,
      detail,
      kind: toText(candidate.kind, 120) || 'topic',
      priority,
      sourceChunkIds,
      competitorNumbers,
      coverageCount: competitorNumbers.length,
      coverageLevel,
      originalityOpportunity: toText(candidate.originalityOpportunity, 1_500),
    }];
  }).slice(0, 300);
};

const normalizeClaims = (value: unknown): ContentWritingClaimLedgerItem[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ContentWritingClaimLedgerItem[] => {
    if (!isRecord(candidate)) return [];
    const id = toText(candidate.id, 120);
    const statement = toText(candidate.statement ?? candidate.claim, 4_000);
    const knowledgeItemIds = toTextList(candidate.knowledgeItemIds);
    const supportingSourceChunkIds = toTextList(
      candidate.supportingSourceChunkIds ?? candidate.sourceChunkIds,
    );
    if (!id || !statement) return [];
    const claimType = [
      'statistic',
      'time_sensitive',
      'comparison',
      'causal',
      'medical',
      'legal',
      'financial',
      'recommendation',
    ].includes(toText(candidate.claimType, 40))
      ? candidate.claimType as ContentWritingClaimLedgerItem['claimType']
      : 'factual';
    const riskLevel = candidate.riskLevel === 'high' || candidate.riskLevel === 'low'
      ? candidate.riskLevel
      : 'medium';
    const competitorNumbers = toNumberList(candidate.competitorNumbers);
    const supportLevel = candidate.supportLevel === 'all_competitors'
      || candidate.supportLevel === 'multiple_competitors'
      ? candidate.supportLevel
      : 'single_competitor';
    const verificationStatus = [
      'corroborated_by_competitors',
      'single_competitor_reference',
      'requires_external_verification',
      'conflicting',
    ].includes(toText(candidate.verificationStatus, 80))
      ? candidate.verificationStatus as ContentWritingClaimLedgerItem['verificationStatus']
      : 'single_competitor_reference';
    const usagePolicy = candidate.usagePolicy === 'allowed' || candidate.usagePolicy === 'blocked'
      ? candidate.usagePolicy
      : 'qualify';
    return [{
      id,
      statement,
      claimType,
      riskLevel,
      knowledgeItemIds,
      supportingSourceChunkIds,
      supportingSourceIds: toTextList(candidate.supportingSourceIds),
      competitorNumbers,
      supportLevel,
      verificationStatus,
      usagePolicy,
      usageGuidance: toText(candidate.usageGuidance, 1_500),
    }];
  }).slice(0, 300);
};

const parseTaggedArray = (promptText: string, tagName: string): unknown[] => {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const start = promptText.indexOf(startTag);
  const end = promptText.indexOf(endTag, start + startTag.length);
  if (start < 0 || end < 0) return [];
  const candidate = promptText.slice(start + startTag.length, end).trim();
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const normalizeContentWritingSectionCoverage = (
  value: unknown,
): ContentWritingSectionCoverage => {
  const source = isRecord(value) ? value : {};
  return {
    coveredIdeaIds: toTextList(source.coveredIdeaIds),
    usedSourceChunkIds: toTextList(source.usedSourceChunkIds),
    usedClaimIds: toTextList(source.usedClaimIds),
  };
};

export const normalizeContentWritingEvidenceTrace = (
  value: unknown,
  promptText = '',
): ContentWritingEvidenceTrace | null => {
  const source = isRecord(value) ? value : {};
  const knowledgeItems = normalizeKnowledgeItems(
    Array.isArray(source.knowledgeItems)
      ? source.knowledgeItems
      : parseTaggedArray(promptText, 'assigned_knowledge_json'),
  );
  const claims = normalizeClaims(
    Array.isArray(source.claims)
      ? source.claims
      : parseTaggedArray(promptText, 'relevant_claims_ledger_json'),
  );
  const sourceChunks = normalizeContentWritingSourceChunks(
    Array.isArray(source.sourceChunks)
      ? source.sourceChunks
      : parseTaggedArray(promptText, 'relevant_competitor_source_chunks_json'),
  );
  if (knowledgeItems.length === 0 && claims.length === 0 && sourceChunks.length === 0) return null;
  return {
    version: Math.max(1, Math.round(Number(source.version) || CONTENT_WRITING_EVIDENCE_TRACE_VERSION)),
    sectionKey: toText(source.sectionKey, 120),
    sectionTitle: toText(source.sectionTitle, 500),
    knowledgeItems,
    claims,
    sourceChunks,
  };
};

export const reconstructContentWritingEvidenceTrace = (options: {
  sectionKey: string;
  sectionTitle: string;
  sectionBrief?: string;
  requiredIdeaIds?: readonly string[];
  requiredClaimIds?: readonly string[];
  requiredSourceChunkIds?: readonly string[];
  knowledge: ContentWritingKnowledgeBase;
  chunks: readonly ContentWritingSourceChunk[];
}): ContentWritingEvidenceTrace | null => {
  const requiredIdeaIds = Array.from(new Set(options.requiredIdeaIds || []));
  const requiredSourceChunkIds = new Set(options.requiredSourceChunkIds || []);
  const selectedChunks = selectRelevantContentWritingChunks({
    title: options.sectionTitle,
    brief: options.sectionBrief || '',
    requiredIdeaIds,
    knowledge: options.knowledge,
    chunks: options.chunks,
  });
  const sourceChunks = [
    ...options.chunks.filter(chunk => requiredSourceChunkIds.has(chunk.id)),
    ...selectedChunks,
  ].filter((chunk, index, list) => (
    list.findIndex(candidate => candidate.id === chunk.id) === index
  ));
  const requiredClaimIds = new Set(options.requiredClaimIds || []);
  const claims = requiredClaimIds.size > 0
    ? options.knowledge.claimLedger.claims.filter(claim => requiredClaimIds.has(claim.id))
    : selectContentWritingClaims({
        claimLedger: options.knowledge.claimLedger,
        knowledgeItemIds: requiredIdeaIds,
        sourceChunkIds: sourceChunks.map(chunk => chunk.id),
      });
  const knowledgeItems = options.knowledge.items.filter(item => requiredIdeaIds.includes(item.id));
  if (knowledgeItems.length === 0 && claims.length === 0 && sourceChunks.length === 0) return null;
  return {
    version: CONTENT_WRITING_EVIDENCE_TRACE_VERSION,
    sectionKey: options.sectionKey,
    sectionTitle: options.sectionTitle,
    knowledgeItems,
    claims,
    sourceChunks,
  };
};
