import type {
  ContentWritingKnowledgeItem,
  ContentWritingSourceChunk,
} from './contentWritingKnowledge';

export const CONTENT_WRITING_SOURCE_CLAIMS_VERSION = 1;

export type ContentWritingSourceCategory =
  | 'official'
  | 'government'
  | 'academic'
  | 'industry'
  | 'news'
  | 'commercial'
  | 'community'
  | 'unknown';

export type ContentWritingSourceFreshness = 'current' | 'dated' | 'unknown';
export type ContentWritingSourceUsePolicy =
  | 'primary_support'
  | 'contextual_support'
  | 'reference_only';

export type ContentWritingSourceRecord = {
  id: string;
  competitorNumber: number;
  title: string;
  url: string;
  chunkIds: string[];
  category: ContentWritingSourceCategory;
  freshness: ContentWritingSourceFreshness;
  usePolicy: ContentWritingSourceUsePolicy;
  assessmentNotes: string;
  supportedClaimIds: string[];
};

export type ContentWritingSourceRegistry = {
  version: number;
  sources: ContentWritingSourceRecord[];
  primarySourceIds: string[];
  contextualSourceIds: string[];
  referenceOnlySourceIds: string[];
};

export type ContentWritingClaimType =
  | 'factual'
  | 'statistic'
  | 'time_sensitive'
  | 'comparison'
  | 'causal'
  | 'medical'
  | 'legal'
  | 'financial'
  | 'recommendation';

export type ContentWritingClaimRiskLevel = 'high' | 'medium' | 'low';
export type ContentWritingClaimSupportLevel =
  | 'all_competitors'
  | 'multiple_competitors'
  | 'single_competitor';
export type ContentWritingClaimVerificationStatus =
  | 'corroborated_by_competitors'
  | 'single_competitor_reference'
  | 'requires_external_verification'
  | 'conflicting';
export type ContentWritingClaimUsagePolicy = 'allowed' | 'qualify' | 'blocked';

export type ContentWritingClaimLedgerItem = {
  id: string;
  statement: string;
  claimType: ContentWritingClaimType;
  riskLevel: ContentWritingClaimRiskLevel;
  knowledgeItemIds: string[];
  supportingSourceChunkIds: string[];
  supportingSourceIds: string[];
  competitorNumbers: number[];
  supportLevel: ContentWritingClaimSupportLevel;
  verificationStatus: ContentWritingClaimVerificationStatus;
  usagePolicy: ContentWritingClaimUsagePolicy;
  usageGuidance: string;
};

export type ContentWritingClaimLedger = {
  version: number;
  claims: ContentWritingClaimLedgerItem[];
  allowedClaimIds: string[];
  qualifiedClaimIds: string[];
  blockedClaimIds: string[];
  externallyVerifiableClaimIds: string[];
  claimsByKnowledgeItem: Array<{
    knowledgeItemId: string;
    claimIds: string[];
  }>;
};

type SourceAssessment = {
  competitorNumber: number;
  category: ContentWritingSourceCategory;
  freshness: ContentWritingSourceFreshness;
  assessmentNotes: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 2_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toUniqueTextList = (
  value: unknown,
  maximumItems = 500,
  maximumLength = 120,
): string[] => Array.isArray(value)
  ? Array.from(new Set(
    value.map(item => toText(item, maximumLength)).filter(Boolean),
  )).slice(0, maximumItems)
  : [];

const normalizeSourceCategory = (value: unknown): ContentWritingSourceCategory => {
  const category = toText(value, 40) as ContentWritingSourceCategory;
  return [
    'official',
    'government',
    'academic',
    'industry',
    'news',
    'commercial',
    'community',
  ].includes(category)
    ? category
    : 'unknown';
};

const normalizeSourceFreshness = (value: unknown): ContentWritingSourceFreshness => {
  if (value === 'current' || value === 'dated') return value;
  return 'unknown';
};

const deriveSourceUsePolicy = (
  category: ContentWritingSourceCategory,
  freshness: ContentWritingSourceFreshness,
): ContentWritingSourceUsePolicy => {
  if (
    ['official', 'government', 'academic'].includes(category)
    && freshness !== 'dated'
  ) {
    return 'primary_support';
  }
  if (
    ['official', 'government', 'academic', 'industry', 'news'].includes(category)
  ) {
    return 'contextual_support';
  }
  return 'reference_only';
};

const normalizeSourceAssessments = (
  value: unknown,
  chunks: readonly ContentWritingSourceChunk[],
): SourceAssessment[] => {
  const source = isRecord(value) ? value : {};
  const persistedRegistry = isRecord(source.sourceRegistry) ? source.sourceRegistry : {};
  const candidates = Array.isArray(source.sourceAssessments)
    ? source.sourceAssessments
    : Array.isArray(source.sources)
      ? source.sources
      : Array.isArray(persistedRegistry.sources)
        ? persistedRegistry.sources
        : [];
  const validCompetitorNumbers = new Set(chunks.map(chunk => chunk.competitorNumber));
  const byCompetitor = new Map<number, SourceAssessment>();
  candidates.forEach(candidate => {
    if (!isRecord(candidate)) return;
    const competitorNumber = Math.round(Number(candidate.competitorNumber));
    if (!validCompetitorNumbers.has(competitorNumber) || byCompetitor.has(competitorNumber)) return;
    byCompetitor.set(competitorNumber, {
      competitorNumber,
      category: normalizeSourceCategory(candidate.category),
      freshness: normalizeSourceFreshness(candidate.freshness),
      assessmentNotes: toText(candidate.assessmentNotes ?? candidate.notes, 800),
    });
  });
  return Array.from(validCompetitorNumbers)
    .sort((left, right) => left - right)
    .map(competitorNumber => byCompetitor.get(competitorNumber) || {
      competitorNumber,
      category: 'unknown',
      freshness: 'unknown',
      assessmentNotes: '',
    });
};

const buildSourceRegistry = (
  assessments: readonly SourceAssessment[],
  chunks: readonly ContentWritingSourceChunk[],
  claims: readonly ContentWritingClaimLedgerItem[],
): ContentWritingSourceRegistry => {
  const sources = assessments.map((assessment): ContentWritingSourceRecord => {
    const sourceChunks = chunks.filter(
      chunk => chunk.competitorNumber === assessment.competitorNumber,
    );
    const category = assessment.category;
    const freshness = assessment.freshness;
    return {
      id: `SRC${assessment.competitorNumber}`,
      competitorNumber: assessment.competitorNumber,
      title: sourceChunks.find(chunk => chunk.title)?.title || '',
      url: sourceChunks.find(chunk => chunk.url)?.url || '',
      chunkIds: sourceChunks.map(chunk => chunk.id),
      category,
      freshness,
      usePolicy: deriveSourceUsePolicy(category, freshness),
      assessmentNotes: assessment.assessmentNotes,
      supportedClaimIds: claims
        .filter(claim => claim.competitorNumbers.includes(assessment.competitorNumber))
        .map(claim => claim.id),
    };
  });
  return {
    version: CONTENT_WRITING_SOURCE_CLAIMS_VERSION,
    sources,
    primarySourceIds: sources
      .filter(source => source.usePolicy === 'primary_support')
      .map(source => source.id),
    contextualSourceIds: sources
      .filter(source => source.usePolicy === 'contextual_support')
      .map(source => source.id),
    referenceOnlySourceIds: sources
      .filter(source => source.usePolicy === 'reference_only')
      .map(source => source.id),
  };
};

const normalizeClaimType = (value: unknown): ContentWritingClaimType => {
  const claimType = toText(value, 40) as ContentWritingClaimType;
  return [
    'statistic',
    'time_sensitive',
    'comparison',
    'causal',
    'medical',
    'legal',
    'financial',
    'recommendation',
  ].includes(claimType)
    ? claimType
    : 'factual';
};

const normalizeRiskLevel = (value: unknown): ContentWritingClaimRiskLevel => {
  if (value === 'high' || value === 'low') return value;
  return 'medium';
};

const deriveSupportLevel = (
  competitorCount: number,
  totalCompetitorCount: number,
): ContentWritingClaimSupportLevel => {
  if (competitorCount > 1 && competitorCount === totalCompetitorCount) {
    return 'all_competitors';
  }
  if (competitorCount > 1) return 'multiple_competitors';
  return 'single_competitor';
};

const deriveClaimPolicy = (options: {
  claimType: ContentWritingClaimType;
  riskLevel: ContentWritingClaimRiskLevel;
  competitorCount: number;
  supportingSources: readonly ContentWritingSourceRecord[];
  conflicting: boolean;
}): Pick<
  ContentWritingClaimLedgerItem,
  'verificationStatus' | 'usagePolicy'
> => {
  if (options.conflicting) {
    return { verificationStatus: 'conflicting', usagePolicy: 'qualify' };
  }
  const sensitive = ['medical', 'legal', 'financial'].includes(options.claimType);
  const freshnessSensitive = ['statistic', 'time_sensitive'].includes(options.claimType);
  const hasPrimarySource = options.supportingSources.some(
    source => source.usePolicy === 'primary_support',
  );
  if (
    options.riskLevel === 'high'
    || sensitive
    || (freshnessSensitive && !hasPrimarySource)
  ) {
    return {
      verificationStatus: 'requires_external_verification',
      usagePolicy: 'qualify',
    };
  }
  if (options.competitorCount > 1) {
    return {
      verificationStatus: 'corroborated_by_competitors',
      usagePolicy: options.riskLevel === 'medium' ? 'qualify' : 'allowed',
    };
  }
  return {
    verificationStatus: 'single_competitor_reference',
    usagePolicy: 'qualify',
  };
};

const normalizeClaims = (options: {
  value: unknown;
  items: readonly ContentWritingKnowledgeItem[];
  chunks: readonly ContentWritingSourceChunk[];
  sourceRegistry: ContentWritingSourceRegistry;
}): ContentWritingClaimLedgerItem[] => {
  const source = isRecord(options.value) ? options.value : {};
  const persistedLedger = isRecord(source.claimLedger) ? source.claimLedger : {};
  const declaredClaims = Array.isArray(source.claims)
    ? source.claims
    : Array.isArray(persistedLedger.claims)
      ? persistedLedger.claims
      : [];
  const fallbackClaims = declaredClaims.length === 0
    ? options.items
      .filter(item => ['claim', 'evidence', 'comparison'].includes(item.kind))
      .map(item => ({
        statement: item.detail,
        claimType: item.kind === 'comparison' ? 'comparison' : 'factual',
        riskLevel: 'medium',
        knowledgeItemIds: [item.id],
        supportingSourceChunkIds: item.sourceChunkIds,
      }))
    : declaredClaims;
  const chunksById = new Map(options.chunks.map(chunk => [chunk.id, chunk]));
  const itemsById = new Map(options.items.map(item => [item.id, item]));
  const validChunkIds = new Set(chunksById.keys());
  const seenIds = new Set<string>();
  const totalCompetitorCount = new Set(options.chunks.map(chunk => chunk.competitorNumber)).size;

  return fallbackClaims.flatMap((candidate, index): ContentWritingClaimLedgerItem[] => {
    if (!isRecord(candidate)) return [];
    let id = toText(candidate.id, 120) || `CL${String(index + 1).padStart(3, '0')}`;
    if (seenIds.has(id)) id = `CL${String(index + 1).padStart(3, '0')}`;
    while (seenIds.has(id)) id = `${id}-${seenIds.size + 1}`;
    const statement = toText(candidate.statement ?? candidate.claim, 2_000);
    let knowledgeItemIds = toUniqueTextList(candidate.knowledgeItemIds)
      .filter(itemId => itemsById.has(itemId));
    let supportingSourceChunkIds = toUniqueTextList(
      candidate.supportingSourceChunkIds ?? candidate.sourceChunkIds,
    ).filter(chunkId => validChunkIds.has(chunkId));
    if (supportingSourceChunkIds.length === 0 && knowledgeItemIds.length > 0) {
      supportingSourceChunkIds = Array.from(new Set(
        knowledgeItemIds.flatMap(itemId => itemsById.get(itemId)?.sourceChunkIds || []),
      ));
    }
    if (knowledgeItemIds.length === 0 && supportingSourceChunkIds.length > 0) {
      const supportingChunkSet = new Set(supportingSourceChunkIds);
      knowledgeItemIds = options.items
        .filter(item => item.sourceChunkIds.some(chunkId => supportingChunkSet.has(chunkId)))
        .map(item => item.id)
        .slice(0, 20);
    }
    if (!statement || knowledgeItemIds.length === 0 || supportingSourceChunkIds.length === 0) {
      return [];
    }
    const competitorNumbers = Array.from(new Set(
      supportingSourceChunkIds.flatMap(chunkId => {
        const competitorNumber = chunksById.get(chunkId)?.competitorNumber;
        return competitorNumber ? [competitorNumber] : [];
      }),
    )).sort((left, right) => left - right);
    if (competitorNumbers.length === 0) return [];
    const supportingSources = options.sourceRegistry.sources.filter(
      sourceRecord => competitorNumbers.includes(sourceRecord.competitorNumber),
    );
    const claimType = normalizeClaimType(candidate.claimType ?? candidate.type);
    const riskLevel = normalizeRiskLevel(candidate.riskLevel);
    const policy = deriveClaimPolicy({
      claimType,
      riskLevel,
      competitorCount: competitorNumbers.length,
      supportingSources,
      conflicting: candidate.conflicting === true
        || candidate.evidenceStatus === 'conflicting',
    });
    seenIds.add(id);
    return [{
      id,
      statement,
      claimType,
      riskLevel,
      knowledgeItemIds,
      supportingSourceChunkIds,
      supportingSourceIds: supportingSources.map(sourceRecord => sourceRecord.id),
      competitorNumbers,
      supportLevel: deriveSupportLevel(competitorNumbers.length, totalCompetitorCount),
      verificationStatus: policy.verificationStatus,
      usagePolicy: policy.usagePolicy,
      usageGuidance: toText(candidate.usageGuidance, 800),
    }];
  }).slice(0, 300);
};

const buildClaimLedger = (
  claims: readonly ContentWritingClaimLedgerItem[],
  items: readonly ContentWritingKnowledgeItem[],
): ContentWritingClaimLedger => ({
  version: CONTENT_WRITING_SOURCE_CLAIMS_VERSION,
  claims: [...claims],
  allowedClaimIds: claims
    .filter(claim => claim.usagePolicy === 'allowed')
    .map(claim => claim.id),
  qualifiedClaimIds: claims
    .filter(claim => claim.usagePolicy === 'qualify')
    .map(claim => claim.id),
  blockedClaimIds: claims
    .filter(claim => claim.usagePolicy === 'blocked')
    .map(claim => claim.id),
  externallyVerifiableClaimIds: claims
    .filter(claim => claim.verificationStatus === 'requires_external_verification')
    .map(claim => claim.id),
  claimsByKnowledgeItem: items.map(item => ({
    knowledgeItemId: item.id,
    claimIds: claims
      .filter(claim => claim.knowledgeItemIds.includes(item.id))
      .map(claim => claim.id),
  })).filter(item => item.claimIds.length > 0),
});

export const normalizeContentWritingSourceClaims = (options: {
  value: unknown;
  items: readonly ContentWritingKnowledgeItem[];
  chunks: readonly ContentWritingSourceChunk[];
}): {
  sourceRegistry: ContentWritingSourceRegistry;
  claimLedger: ContentWritingClaimLedger;
} => {
  const assessments = normalizeSourceAssessments(options.value, options.chunks);
  const provisionalSourceRegistry = buildSourceRegistry(assessments, options.chunks, []);
  const claims = normalizeClaims({
    value: options.value,
    items: options.items,
    chunks: options.chunks,
    sourceRegistry: provisionalSourceRegistry,
  });
  return {
    sourceRegistry: buildSourceRegistry(assessments, options.chunks, claims),
    claimLedger: buildClaimLedger(claims, options.items),
  };
};

export const selectContentWritingClaims = (options: {
  claimLedger: ContentWritingClaimLedger;
  knowledgeItemIds: readonly string[];
  sourceChunkIds?: readonly string[];
}): ContentWritingClaimLedgerItem[] => {
  const knowledgeItemIds = new Set(options.knowledgeItemIds);
  const sourceChunkIds = new Set(options.sourceChunkIds || []);
  return options.claimLedger.claims.filter(claim => (
    claim.knowledgeItemIds.some(id => knowledgeItemIds.has(id))
    || claim.supportingSourceChunkIds.some(id => sourceChunkIds.has(id))
  ));
};

export const summarizeContentWritingClaimUsage = (options: {
  claimLedger: ContentWritingClaimLedger;
  usedClaimIds: readonly string[];
}): {
  usedClaimIds: string[];
  allowedClaimIds: string[];
  qualifiedClaimIds: string[];
  blockedClaimIds: string[];
} => {
  const declared = new Set(options.usedClaimIds);
  const usedClaimIds = options.claimLedger.claims
    .filter(claim => declared.has(claim.id))
    .map(claim => claim.id);
  const select = (policy: ContentWritingClaimUsagePolicy): string[] => (
    options.claimLedger.claims
      .filter(claim => declared.has(claim.id) && claim.usagePolicy === policy)
      .map(claim => claim.id)
  );
  return {
    usedClaimIds,
    allowedClaimIds: select('allowed'),
    qualifiedClaimIds: select('qualify'),
    blockedClaimIds: select('blocked'),
  };
};
