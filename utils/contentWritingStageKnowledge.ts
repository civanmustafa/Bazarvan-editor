import type { ContentWritingStep, ContentWritingStepType } from './contentWritingSessions';
import {
  normalizeContentWritingEvidenceTrace,
  normalizeContentWritingSectionCoverage,
} from './contentWritingEvidence';
import type { ContentWritingTransparencySnapshot } from './contentWritingTransparency';
import {
  presentContentWritingCoverageAudit,
  presentContentWritingOutline,
} from './contentWritingStepPresentation';

export type ContentWritingStageKnowledgeReferenceKind =
  | 'created'
  | 'planned'
  | 'declared_used'
  | 'flagged'
  | 'not_declared';

export type ContentWritingStageKnowledgeScope = 'creation' | 'complete' | 'targeted';

export type ContentWritingStageKnowledgeUsage = {
  stageType: ContentWritingStepType;
  scope: ContentWritingStageKnowledgeScope;
  referenceKind: ContentWritingStageKnowledgeReferenceKind;
  sentKnowledgeItemIds: string[];
  sentSourceIds: string[];
  sentClaimIds: string[];
  sentSourceChunkIds: string[];
  referencedKnowledgeItemIds: string[];
  referencedSourceIds: string[];
  referencedClaimIds: string[];
  referencedSourceChunkIds: string[];
};

const unique = (values: readonly string[]): string[] => Array.from(new Set(
  values.map(value => String(value || '').trim()).filter(Boolean),
));

const sourceIdsForReferences = (
  snapshot: ContentWritingTransparencySnapshot,
  knowledgeItemIds: readonly string[],
  claimIds: readonly string[],
  chunkIds: readonly string[],
): string[] => {
  const referencedChunkIds = new Set(chunkIds);
  const referencedClaimIds = new Set(claimIds);
  const referencedKnowledgeItemIds = new Set(knowledgeItemIds);
  snapshot.knowledge.items
    .filter(item => referencedKnowledgeItemIds.has(item.id))
    .flatMap(item => item.sourceChunkIds)
    .forEach(chunkId => referencedChunkIds.add(chunkId));
  snapshot.knowledge.claimLedger.claims
    .filter(claim => referencedClaimIds.has(claim.id))
    .flatMap(claim => claim.supportingSourceChunkIds)
    .forEach(chunkId => referencedChunkIds.add(chunkId));
  return snapshot.knowledge.sourceRegistry.sources
    .filter(source => (
      referencedClaimIds.size > 0
        && source.supportedClaimIds.some(claimId => referencedClaimIds.has(claimId))
    ) || source.chunkIds.some(chunkId => referencedChunkIds.has(chunkId)))
    .map(source => source.id);
};

const completeRegistryUsage = (
  stepType: ContentWritingStepType,
  snapshot: ContentWritingTransparencySnapshot,
  referenceKind: ContentWritingStageKnowledgeReferenceKind = 'not_declared',
): ContentWritingStageKnowledgeUsage => ({
  stageType: stepType,
  scope: 'complete',
  referenceKind,
  sentKnowledgeItemIds: snapshot.knowledge.items.map(item => item.id),
  sentSourceIds: snapshot.knowledge.sourceRegistry.sources.map(source => source.id),
  sentClaimIds: snapshot.knowledge.claimLedger.claims.map(claim => claim.id),
  // Later stages receive the complete normalized registries. Original source
  // excerpt text is attached only to the creation or targeted section stages.
  sentSourceChunkIds: [],
  referencedKnowledgeItemIds: [],
  referencedSourceIds: [],
  referencedClaimIds: [],
  referencedSourceChunkIds: [],
});

export const buildContentWritingStageKnowledgeUsage = (options: {
  step: ContentWritingStep;
  snapshot: ContentWritingTransparencySnapshot;
  evidenceTrace?: unknown;
}): ContentWritingStageKnowledgeUsage => {
  const {
    step,
    snapshot,
    evidenceTrace,
  } = options;
  const allSourceIds = snapshot.knowledge.sourceRegistry.sources.map(source => source.id);
  const allChunkIds = snapshot.chunks.map(chunk => chunk.id);

  if (step.stepType === 'competitor_index') {
    const referencedSourceChunkIds = unique(
      snapshot.knowledge.modelProcessedChunkIds.length > 0
        ? snapshot.knowledge.modelProcessedChunkIds
        : snapshot.knowledge.processedChunkIds,
    );
    return {
      stageType: step.stepType,
      scope: 'creation',
      referenceKind: 'created',
      sentKnowledgeItemIds: [],
      sentSourceIds: allSourceIds,
      sentClaimIds: [],
      sentSourceChunkIds: allChunkIds,
      referencedKnowledgeItemIds: snapshot.knowledge.items.map(item => item.id),
      referencedSourceIds: allSourceIds,
      referencedClaimIds: snapshot.knowledge.claimLedger.claims.map(claim => claim.id),
      referencedSourceChunkIds,
    };
  }

  if (step.stepType === 'outline') {
    const usage = completeRegistryUsage(step.stepType, snapshot, 'planned');
    const sections = presentContentWritingOutline(step.outputText || '') || [];
    const referencedKnowledgeItemIds = unique(sections.flatMap(section => section.requiredIdeaIds));
    const referencedClaimIds = unique(sections.flatMap(section => section.requiredClaimIds));
    const referencedSourceChunkIds = unique(sections.flatMap(section => section.sourceChunkIds));
    return {
      ...usage,
      referencedKnowledgeItemIds,
      referencedClaimIds,
      referencedSourceChunkIds,
      referencedSourceIds: sourceIdsForReferences(
        snapshot,
        referencedKnowledgeItemIds,
        referencedClaimIds,
        referencedSourceChunkIds,
      ),
    };
  }

  if (step.stepType === 'section' || step.stepType === 'section_repair') {
    const normalizedTrace = normalizeContentWritingEvidenceTrace(
      evidenceTrace,
      step.promptText || '',
    );
    if (!normalizedTrace) {
      return {
        ...completeRegistryUsage(step.stepType, snapshot),
        scope: 'targeted',
      };
    }
    const coverage = normalizeContentWritingSectionCoverage(step.metadata.sectionCoverage);
    const sentSourceChunkIds = normalizedTrace.sourceChunks.map(chunk => chunk.id);
    const referencedKnowledgeItemIds = coverage.coveredIdeaIds;
    const referencedClaimIds = coverage.usedClaimIds;
    const referencedSourceChunkIds = coverage.usedSourceChunkIds;
    return {
      stageType: step.stepType,
      scope: 'targeted',
      referenceKind: 'declared_used',
      // Every later stage receives the complete normalized registries through
      // compactArticleContext. Sections additionally receive only their
      // relevant original excerpts and focused records in the stage prompt.
      sentKnowledgeItemIds: snapshot.knowledge.items.map(item => item.id),
      sentSourceIds: snapshot.knowledge.sourceRegistry.sources.map(source => source.id),
      sentClaimIds: snapshot.knowledge.claimLedger.claims.map(claim => claim.id),
      sentSourceChunkIds,
      referencedKnowledgeItemIds,
      referencedSourceIds: sourceIdsForReferences(
        snapshot,
        referencedKnowledgeItemIds,
        referencedClaimIds,
        referencedSourceChunkIds,
      ),
      referencedClaimIds,
      referencedSourceChunkIds,
    };
  }

  if (step.stepType === 'coverage_audit') {
    const usage = completeRegistryUsage(step.stepType, snapshot, 'flagged');
    const audit = presentContentWritingCoverageAudit(step.outputText || '');
    if (!audit) return usage;
    const referencedKnowledgeItemIds = unique([
      ...audit.missingIdeaIds,
      ...audit.weakIdeaIds,
      ...audit.repairs.flatMap(repair => repair.ideaIds),
    ]);
    const referencedClaimIds = unique([
      ...audit.unsupportedClaimIds,
      ...audit.blockedClaimIds,
      ...audit.repairs.flatMap(repair => repair.claimIds),
    ]);
    const referencedSourceChunkIds = unique(
      audit.repairs.flatMap(repair => repair.sourceChunkIds),
    );
    return {
      ...usage,
      referencedKnowledgeItemIds,
      referencedClaimIds,
      referencedSourceChunkIds,
      referencedSourceIds: sourceIdsForReferences(
        snapshot,
        referencedKnowledgeItemIds,
        referencedClaimIds,
        referencedSourceChunkIds,
      ),
    };
  }

  // Introduction, FAQ, conclusion, final review, and quality repair receive the
  // complete normalized matrix/source/claim registries in the compact session
  // context, but their prose output does not declare individual IDs used.
  return completeRegistryUsage(step.stepType, snapshot);
};
