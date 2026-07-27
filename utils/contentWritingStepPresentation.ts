import {
  parseContentWritingPresentationObject,
} from './contentWritingKnowledgePresentation.ts';

export type PresentedContentWritingOutlineSection = {
  title: string;
  brief: string;
  targetWords: number | null;
  subheadings: string[];
  requiredIdeaIds: string[];
  requiredClaimIds: string[];
  sourceChunkIds: string[];
};

export type PresentedContentWritingCoverageAudit = {
  missingIdeaIds: string[];
  weakIdeaIds: string[];
  unsupportedClaimIds: string[];
  blockedClaimIds: string[];
  missingIdeaCount: number;
  weakIdeaCount: number;
  unsupportedClaimCount: number;
  blockedClaimCount: number;
  duplicateTopics: string[];
  repairs: Array<{
    sectionKey: string;
    instructions: string;
    ideaIds: string[];
    claimIds: string[];
    sourceChunkIds: string[];
    ideaCount: number;
    claimCount: number;
  }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 4_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toTextList = (value: unknown, maximumItems = 100): string[] => Array.isArray(value)
  ? value.map(item => toText(item, 500)).filter(Boolean).slice(0, maximumItems)
  : [];

const listCount = (value: unknown): number => (
  Array.isArray(value) ? value.filter(item => Boolean(toText(item, 120))).length : 0
);

export const presentContentWritingOutline = (
  outputText: string,
): PresentedContentWritingOutlineSection[] | null => {
  const source = parseContentWritingPresentationObject(outputText);
  if (!source || !Array.isArray(source.sections)) return null;
  const sections = source.sections.flatMap((value): PresentedContentWritingOutlineSection[] => {
    if (!isRecord(value)) return [];
    const title = toText(value.title, 500);
    if (!title) return [];
    const targetWordsValue = Math.round(Number(value.targetWords));
    return [{
      title,
      brief: toText(value.brief),
      targetWords: Number.isFinite(targetWordsValue) && targetWordsValue > 0
        ? targetWordsValue
        : null,
      subheadings: toTextList(value.subheadings, 10),
      requiredIdeaIds: toTextList(value.requiredIdeaIds),
      requiredClaimIds: toTextList(value.requiredClaimIds),
      sourceChunkIds: toTextList(value.sourceChunkIds),
    }];
  });
  return sections.length > 0 ? sections : null;
};

export const presentContentWritingCoverageAudit = (
  outputText: string,
): PresentedContentWritingCoverageAudit | null => {
  const source = parseContentWritingPresentationObject(outputText);
  if (!source) return null;
  const repairs = Array.isArray(source.repairs)
    ? source.repairs.flatMap((value): PresentedContentWritingCoverageAudit['repairs'] => {
      if (!isRecord(value)) return [];
      const instructions = toText(value.instructions);
      if (!instructions) return [];
      return [{
        sectionKey: toText(value.sectionKey, 120),
        instructions,
        ideaIds: toTextList(value.ideaIds),
        claimIds: toTextList(value.claimIds),
        sourceChunkIds: toTextList(value.sourceChunkIds),
        ideaCount: listCount(value.ideaIds),
        claimCount: listCount(value.claimIds),
      }];
    })
    : [];
  const duplicateTopics = toTextList(source.duplicateTopics, 50);
  const missingIdeaIds = toTextList(source.missingIdeaIds);
  const weakIdeaIds = toTextList(source.weakIdeaIds);
  const unsupportedClaimIds = toTextList(source.unsupportedClaimIds);
  const blockedClaimIds = toTextList(source.blockedClaimIds);
  const audit = {
    missingIdeaIds,
    weakIdeaIds,
    unsupportedClaimIds,
    blockedClaimIds,
    missingIdeaCount: missingIdeaIds.length,
    weakIdeaCount: weakIdeaIds.length,
    unsupportedClaimCount: unsupportedClaimIds.length,
    blockedClaimCount: blockedClaimIds.length,
    duplicateTopics,
    repairs,
  };
  return Object.values(audit).some(value => Array.isArray(value) ? value.length > 0 : value > 0)
    ? audit
    : {
        ...audit,
        repairs: [],
      };
};
