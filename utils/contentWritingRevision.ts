import type { ContentWritingQualityReport } from './contentWritingQuality';
import {
  summarizeContentWritingCoverage,
  type ContentWritingKnowledgeBase,
  type ContentWritingSectionCoverage,
} from './contentWritingKnowledge';
import { summarizeContentWritingClaimUsage } from './contentWritingClaims';
import type { ContentWritingOutline } from './contentWritingWorkflow';

export const CONTENT_WRITING_MAX_REVISION_OPERATIONS = 16;

export type ContentWritingRevisionScope = 'local' | 'structural' | 'global';
export type ContentWritingRevisionAction = 'replace' | 'insert_before' | 'insert_after' | 'delete';
export type ContentWritingRevisionTargetKind =
  | 'introduction'
  | 'section'
  | 'faq'
  | 'conclusion'
  | 'unknown_section'
  | 'heading'
  | 'block';

export type ContentWritingRevisionTarget = {
  id: string;
  regionId: string;
  sectionKey?: string;
  kind: ContentWritingRevisionTargetKind;
  heading: string;
  markdown: string;
  wordCount: number;
  start: number;
  end: number;
};

export type ContentWritingRevisionDocument = {
  markdown: string;
  targets: ContentWritingRevisionTarget[];
};

export type ContentWritingRevisionOperation = {
  id: string;
  scope: ContentWritingRevisionScope;
  action: ContentWritingRevisionAction;
  targetId: string;
  instructions: string;
  reason: string;
  criterionIds: string[];
  requiredIdeaIds: string[];
  requiredClaimIds: string[];
};

export type ContentWritingRevisionPlan = {
  operations: ContentWritingRevisionOperation[];
};

export type ContentWritingRevisionEdit = {
  operationId: string;
  targetId: string;
  action: ContentWritingRevisionAction;
  replacementMarkdown: string;
  coveredIdeaIds: string[];
  usedSourceChunkIds: string[];
  usedClaimIds: string[];
};

export type ContentWritingRevisionEditBundle = {
  edits: ContentWritingRevisionEdit[];
};

export type ContentWritingRevisionApplication = {
  candidateMarkdown: string;
  appliedEdits: ContentWritingRevisionEdit[];
  unchangedTargetIds: string[];
  errors: string[];
};

export type ContentWritingQualityRegression = {
  criterionId: string;
  before: string;
  after: string;
};

export type ContentWritingQualityGuard = {
  accepted: boolean;
  scoreBefore: number;
  scoreAfter: number;
  newFailureIds: string[];
  regressions: ContentWritingQualityRegression[];
  reasons: string[];
};

export type ContentWritingKnowledgeGuard = {
  accepted: boolean;
  coverageBeforePercent: number;
  coverageAfterPercent: number;
  lostIdeaIds: string[];
  blockedClaimIds: string[];
  sectionCoverages: Array<{
    sectionKey: string;
    coverage: ContentWritingSectionCoverage;
  }>;
  reasons: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 20_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const toUniqueTextList = (
  value: unknown,
  maximumItems = 200,
  maximumLength = 120,
): string[] => Array.isArray(value)
  ? Array.from(new Set(
    value.map(item => toText(item, maximumLength)).filter(Boolean),
  )).slice(0, maximumItems)
  : [];

const stripCodeFence = (value: string): string => value
  .trim()
  .replace(/^```(?:json|markdown|md)?\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
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

const normalizeMarkdown = (value: string): string => (
  String(value || '').replace(/\r\n?/g, '\n').trim()
);

const normalizeHeading = (value: string): string => value
  .replace(/[*_`~]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .toLocaleLowerCase();

const countWords = (value: string): number => (
  String(value || '').match(/[\p{L}\p{N}]+/gu)?.length || 0
);

const trimRange = (
  markdown: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } => {
  let start = Math.max(0, rawStart);
  let end = Math.min(markdown.length, rawEnd);
  while (start < end && /\s/.test(markdown[start])) start += 1;
  while (end > start && /\s/.test(markdown[end - 1])) end -= 1;
  return { start, end };
};

const findBodyBlocks = (
  markdown: string,
  region: ContentWritingRevisionTarget,
): ContentWritingRevisionTarget[] => {
  const regionMarkdown = markdown.slice(region.start, region.end);
  const headingMatch = region.kind === 'introduction'
    ? null
    : regionMarkdown.match(/^##[ \t]+.*(?:\n|$)/);
  const bodyOffset = headingMatch?.[0].length || 0;
  const body = regionMarkdown.slice(bodyOffset);
  const blockPattern = /\S(?:[\s\S]*?\S)?(?=\n[ \t]*\n|$)/g;
  const blocks: ContentWritingRevisionTarget[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(body)) !== null) {
    const range = trimRange(
      markdown,
      region.start + bodyOffset + match.index,
      region.start + bodyOffset + match.index + match[0].length,
    );
    if (range.start >= range.end) continue;
    const blockMarkdown = markdown.slice(range.start, range.end);
    blocks.push({
      id: `${region.id}:block-${String(blocks.length + 1).padStart(2, '0')}`,
      regionId: region.id,
      ...(region.sectionKey ? { sectionKey: region.sectionKey } : {}),
      kind: 'block',
      heading: region.heading,
      markdown: blockMarkdown,
      wordCount: countWords(blockMarkdown),
      start: range.start,
      end: range.end,
    });
  }
  return blocks;
};

const isFaqHeading = (value: string): boolean => (
  /(?:الأسئلة\s+الشائعة|اسئلة\s+شائعة|frequently\s+asked|faq)/iu.test(value)
);

const isConclusionHeading = (value: string): boolean => (
  /(?:الخاتمة|خاتمة|conclusion|final\s+thoughts)/iu.test(value)
);

export const buildContentWritingRevisionDocument = (options: {
  markdown: string;
  outline: ContentWritingOutline;
}): ContentWritingRevisionDocument => {
  const markdown = normalizeMarkdown(options.markdown);
  const outlineByTitle = new Map(
    options.outline.sections.map((section, index) => [
      normalizeHeading(section.title),
      `section-${String(index + 1).padStart(2, '0')}`,
    ]),
  );
  const headingPattern = /^##[ \t]+(.+?)\s*$/gm;
  const headings: Array<{ index: number; title: string }> = [];
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingPattern.exec(markdown)) !== null) {
    headings.push({ index: headingMatch.index, title: headingMatch[1].trim() });
  }

  const regions: ContentWritingRevisionTarget[] = [];
  const h1Match = markdown.match(/^#[ \t]+.*(?:\n|$)/);
  const introductionRange = trimRange(
    markdown,
    h1Match?.[0].length || 0,
    headings[0]?.index ?? markdown.length,
  );
  if (introductionRange.start < introductionRange.end) {
    const introductionMarkdown = markdown.slice(introductionRange.start, introductionRange.end);
    regions.push({
      id: 'introduction',
      regionId: 'introduction',
      kind: 'introduction',
      heading: '',
      markdown: introductionMarkdown,
      wordCount: countWords(introductionMarkdown),
      start: introductionRange.start,
      end: introductionRange.end,
    });
  }

  const usedIds = new Set(regions.map(region => region.id));
  headings.forEach((heading, index) => {
    const range = trimRange(
      markdown,
      heading.index,
      headings[index + 1]?.index ?? markdown.length,
    );
    if (range.start >= range.end) return;
    const normalizedTitle = normalizeHeading(heading.title);
    const sectionKey = outlineByTitle.get(normalizedTitle);
    let id = sectionKey || (
      isFaqHeading(heading.title)
        ? 'faq'
        : isConclusionHeading(heading.title)
          ? 'conclusion'
          : `h2-${String(index + 1).padStart(2, '0')}`
    );
    if (usedIds.has(id)) id = `${id}-${String(index + 1).padStart(2, '0')}`;
    usedIds.add(id);
    const kind: ContentWritingRevisionTargetKind = sectionKey
      ? 'section'
      : id.startsWith('faq')
        ? 'faq'
        : id.startsWith('conclusion')
          ? 'conclusion'
          : 'unknown_section';
    const regionMarkdown = markdown.slice(range.start, range.end);
    regions.push({
      id,
      regionId: id,
      ...(sectionKey ? { sectionKey } : {}),
      kind,
      heading: heading.title,
      markdown: regionMarkdown,
      wordCount: countWords(regionMarkdown),
      start: range.start,
      end: range.end,
    });
  });

  const blocks = regions.flatMap(region => findBodyBlocks(markdown, region));
  const headingTargets = regions.flatMap((region): ContentWritingRevisionTarget[] => {
    if (region.kind === 'introduction') return [];
    const lineEnd = markdown.indexOf('\n', region.start);
    const end = lineEnd >= 0 && lineEnd < region.end ? lineEnd : region.end;
    const headingMarkdown = markdown.slice(region.start, end).trim();
    return [{
      id: `${region.id}:heading`,
      regionId: region.id,
      ...(region.sectionKey ? { sectionKey: region.sectionKey } : {}),
      kind: 'heading',
      heading: region.heading,
      markdown: headingMarkdown,
      wordCount: countWords(headingMarkdown.replace(/^##[ \t]+/, '')),
      start: region.start,
      end,
    }];
  });
  return { markdown, targets: [...regions, ...headingTargets, ...blocks] };
};

export const contentWritingRevisionTargetsToPromptJson = (
  document: ContentWritingRevisionDocument,
): string => JSON.stringify(document.targets.map(target => ({
  id: target.id,
  regionId: target.regionId,
  sectionKey: target.sectionKey || null,
  kind: target.kind,
  heading: target.heading,
  wordCount: target.wordCount,
  markdown: target.markdown,
  allowedActions: target.kind === 'block'
    ? ['replace', 'delete']
    : target.kind === 'heading'
      ? ['replace']
    : ['replace', 'insert_before', 'insert_after', 'delete'],
})), null, 2);

export const parseContentWritingRevisionPlan = (
  value: unknown,
  document: ContentWritingRevisionDocument,
): ContentWritingRevisionPlan => {
  const source = parseJsonObject(value);
  if (!source || !Array.isArray(source.operations)) return { operations: [] };
  const targets = new Map(document.targets.map(target => [target.id, target]));
  const usedOperationIds = new Set<string>();
  const usedTargetIds = new Set<string>();
  const regionLevelTargets = new Set<string>();
  const blockTargetRegions = new Set<string>();
  const operations = source.operations.flatMap((item, index): ContentWritingRevisionOperation[] => {
    if (!isRecord(item)) return [];
    const targetId = toText(item.targetId, 160);
    const target = targets.get(targetId);
    if (!target) return [];
    const scope = toText(item.scope, 40) as ContentWritingRevisionScope;
    const action = toText(item.action, 40) as ContentWritingRevisionAction;
    if (!['local', 'structural', 'global'].includes(scope)) return [];
    if (!['replace', 'insert_before', 'insert_after', 'delete'].includes(action)) return [];
    const localTarget = target.kind === 'block' || target.kind === 'heading';
    if (scope === 'local' && !localTarget) return [];
    if (scope === 'structural' && localTarget) return [];
    if (localTarget && (action === 'insert_before' || action === 'insert_after')) return [];
    if (target.kind === 'heading' && action !== 'replace') return [];
    if (usedTargetIds.has(target.id)) return [];
    if (localTarget) {
      if (regionLevelTargets.has(target.regionId)) return [];
    } else if (
      regionLevelTargets.has(target.regionId)
      || blockTargetRegions.has(target.regionId)
    ) {
      return [];
    }
    const instructions = toText(item.instructions, 4_000);
    if (!instructions) return [];
    const fallbackId = `R${String(index + 1).padStart(3, '0')}`;
    let id = toText(item.id, 80).replace(/[^a-zA-Z0-9:_-]/g, '') || fallbackId;
    if (usedOperationIds.has(id)) id = fallbackId;
    usedOperationIds.add(id);
    usedTargetIds.add(target.id);
    if (localTarget) blockTargetRegions.add(target.regionId);
    else regionLevelTargets.add(target.regionId);
    return [{
      id,
      scope,
      action,
      targetId,
      instructions,
      reason: toText(item.reason, 1_000),
      criterionIds: toUniqueTextList(item.criterionIds, 50),
      requiredIdeaIds: toUniqueTextList(item.requiredIdeaIds, 100),
      requiredClaimIds: toUniqueTextList(item.requiredClaimIds, 100),
    }];
  }).slice(0, CONTENT_WRITING_MAX_REVISION_OPERATIONS);
  return { operations };
};

export const parseContentWritingRevisionEdits = (
  value: unknown,
  plan: ContentWritingRevisionPlan,
): ContentWritingRevisionEditBundle => {
  const source = parseJsonObject(value);
  if (!source || !Array.isArray(source.edits)) return { edits: [] };
  const operations = new Map(plan.operations.map(operation => [operation.id, operation]));
  const usedOperationIds = new Set<string>();
  const edits = source.edits.flatMap((item): ContentWritingRevisionEdit[] => {
    if (!isRecord(item)) return [];
    const operationId = toText(item.operationId, 80);
    const operation = operations.get(operationId);
    if (!operation || usedOperationIds.has(operationId)) return [];
    const replacementMarkdown = toText(item.replacementMarkdown, 30_000);
    if (operation.action !== 'delete' && !replacementMarkdown) return [];
    usedOperationIds.add(operationId);
    return [{
      operationId,
      targetId: operation.targetId,
      action: operation.action,
      replacementMarkdown,
      coveredIdeaIds: toUniqueTextList(item.coveredIdeaIds),
      usedSourceChunkIds: toUniqueTextList(item.usedSourceChunkIds),
      usedClaimIds: toUniqueTextList(item.usedClaimIds),
    }];
  });
  return { edits };
};

const containsH1 = (value: string): boolean => /^#[ \t]+\S/m.test(value);
const containsH2 = (value: string): boolean => /^##[ \t]+\S/m.test(value);

const validateReplacement = (
  target: ContentWritingRevisionTarget,
  edit: ContentWritingRevisionEdit,
): string | null => {
  if (edit.action === 'delete') return null;
  const replacement = normalizeMarkdown(edit.replacementMarkdown);
  if (!replacement) return 'empty_replacement';
  if (containsH1(replacement)) return 'h1_not_allowed';
  if (target.kind === 'block' && containsH2(replacement)) return 'local_edit_changed_h2_structure';
  if (
    target.kind === 'heading'
    && (!/^##[ \t]+\S[^\n]*$/u.test(replacement) || replacement.includes('\n'))
  ) {
    return 'heading_edit_must_return_one_h2';
  }
  if (target.kind === 'introduction' && containsH2(replacement)) return 'introduction_edit_added_h2';
  if (
    target.kind !== 'block'
    && target.kind !== 'heading'
    && target.kind !== 'introduction'
    && edit.action === 'replace'
    && !/^##[ \t]+\S/m.test(replacement)
  ) {
    return 'section_replacement_missing_h2';
  }
  if (
    (edit.action === 'insert_before' || edit.action === 'insert_after')
    && !/^##[ \t]+\S/m.test(replacement)
  ) {
    return 'inserted_structure_missing_h2';
  }
  return null;
};

const rangesOverlap = (
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean => left.start < right.end && right.start < left.end;

export const applyContentWritingRevisionEdits = (
  document: ContentWritingRevisionDocument,
  bundle: ContentWritingRevisionEditBundle,
): ContentWritingRevisionApplication => {
  const targets = new Map(document.targets.map(target => [target.id, target]));
  const errors: string[] = [];
  const candidates = bundle.edits.flatMap(edit => {
    const target = targets.get(edit.targetId);
    if (!target) {
      errors.push(`${edit.operationId}:unknown_target`);
      return [];
    }
    const replacementError = validateReplacement(target, edit);
    if (replacementError) {
      errors.push(`${edit.operationId}:${replacementError}`);
      return [];
    }
    const replacement = edit.action === 'delete'
      ? ''
      : normalizeMarkdown(edit.replacementMarkdown);
    const start = edit.action === 'insert_after' ? target.end : target.start;
    const end = edit.action === 'replace' || edit.action === 'delete' ? target.end : start;
    const inserted = edit.action === 'insert_before'
      ? `${replacement}\n\n`
      : edit.action === 'insert_after'
        ? `\n\n${replacement}`
        : replacement;
    return [{ edit, target, start, end, replacement: inserted }];
  });

  for (let index = 0; index < candidates.length; index += 1) {
    for (let other = index + 1; other < candidates.length; other += 1) {
      if (rangesOverlap(candidates[index], candidates[other])) {
        errors.push(`${candidates[index].edit.operationId}:overlapping_edit`);
        errors.push(`${candidates[other].edit.operationId}:overlapping_edit`);
      }
    }
  }
  if (errors.length > 0) {
    return {
      candidateMarkdown: document.markdown,
      appliedEdits: [],
      unchangedTargetIds: document.targets.map(target => target.id),
      errors: Array.from(new Set(errors)),
    };
  }

  let candidateMarkdown = document.markdown;
  [...candidates]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .forEach(candidate => {
      candidateMarkdown = [
        candidateMarkdown.slice(0, candidate.start),
        candidate.replacement,
        candidateMarkdown.slice(candidate.end),
      ].join('');
    });
  candidateMarkdown = normalizeMarkdown(candidateMarkdown);
  const h1Count = candidateMarkdown.match(/^#[ \t]+\S/gm)?.length || 0;
  if (h1Count !== 1) {
    return {
      candidateMarkdown: document.markdown,
      appliedEdits: [],
      unchangedTargetIds: document.targets.map(target => target.id),
      errors: ['candidate_must_keep_exactly_one_h1'],
    };
  }

  const affectedRegions = new Set(candidates.map(candidate => candidate.target.regionId));
  return {
    candidateMarkdown,
    appliedEdits: candidates.map(candidate => candidate.edit),
    unchangedTargetIds: document.targets
      .filter(target => !affectedRegions.has(target.regionId))
      .map(target => target.id),
    errors: [],
  };
};

const statusRank = (status: string): number => {
  if (status === 'fail') return 2;
  if (status === 'warn') return 1;
  return 0;
};

export const compareContentWritingQualityReports = (
  before: ContentWritingQualityReport,
  after: ContentWritingQualityReport,
): ContentWritingQualityGuard => {
  const beforeById = new Map(before.criteria.map(criterion => [criterion.id, criterion]));
  const newFailureIds = after.criteria
    .filter(criterion => (
      criterion.status === 'fail'
      && beforeById.get(criterion.id)?.status !== 'fail'
    ))
    .map(criterion => criterion.id);
  const regressions = after.criteria.flatMap((criterion): ContentWritingQualityRegression[] => {
    const previous = beforeById.get(criterion.id);
    if (!previous || statusRank(criterion.status) <= statusRank(previous.status)) return [];
    return [{
      criterionId: criterion.id,
      before: previous.status,
      after: criterion.status,
    }];
  });
  const reasons: string[] = [];
  if (after.score < before.score) reasons.push('quality_score_decreased');
  if (newFailureIds.length > 0) reasons.push('new_quality_failure');
  if (regressions.length > 0) reasons.push('quality_criterion_regressed');
  return {
    accepted: reasons.length === 0,
    scoreBefore: before.score,
    scoreAfter: after.score,
    newFailureIds,
    regressions,
    reasons,
  };
};

const normalizeClaimSearchText = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle || needle.length < 8) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
};

export const evaluateContentWritingRevisionKnowledge = (options: {
  beforeMarkdown: string;
  candidateMarkdown: string;
  document: ContentWritingRevisionDocument;
  application: ContentWritingRevisionApplication;
  knowledge: ContentWritingKnowledgeBase;
  sectionCoverages: ReadonlyMap<string, ContentWritingSectionCoverage>;
}): ContentWritingKnowledgeGuard => {
  const validIdeaIds = new Set(options.knowledge.items.map(item => item.id));
  const validChunkIds = new Set(options.knowledge.processedChunkIds);
  const validClaimIds = new Set(options.knowledge.claimLedger.claims.map(claim => claim.id));
  const blockedClaimIds = new Set(options.knowledge.claimLedger.blockedClaimIds);
  const targets = new Map(options.document.targets.map(target => [target.id, target]));
  const nextCoverages = new Map(
    Array.from(options.sectionCoverages.entries()).map(([key, coverage]) => [
      key,
      {
        coveredIdeaIds: [...coverage.coveredIdeaIds],
        usedSourceChunkIds: [...coverage.usedSourceChunkIds],
        usedClaimIds: [...coverage.usedClaimIds],
      },
    ]),
  );

  options.application.appliedEdits.forEach(edit => {
    const target = targets.get(edit.targetId);
    if (!target?.sectionKey) return;
    const previous = nextCoverages.get(target.sectionKey) || {
      coveredIdeaIds: [],
      usedSourceChunkIds: [],
      usedClaimIds: [],
    };
    const declared: ContentWritingSectionCoverage = {
      coveredIdeaIds: edit.coveredIdeaIds.filter(id => validIdeaIds.has(id)),
      usedSourceChunkIds: edit.usedSourceChunkIds.filter(id => validChunkIds.has(id)),
      usedClaimIds: edit.usedClaimIds.filter(id => validClaimIds.has(id)),
    };
    const replacesWholeSection = target.id === target.regionId
      && (edit.action === 'replace' || edit.action === 'delete');
    nextCoverages.set(target.sectionKey, replacesWholeSection
      ? declared
      : {
          coveredIdeaIds: Array.from(new Set([
            ...previous.coveredIdeaIds,
            ...declared.coveredIdeaIds,
          ])),
          usedSourceChunkIds: Array.from(new Set([
            ...previous.usedSourceChunkIds,
            ...declared.usedSourceChunkIds,
          ])),
          usedClaimIds: Array.from(new Set([
            ...previous.usedClaimIds,
            ...declared.usedClaimIds,
          ])),
        });
  });

  const beforeCoverage = summarizeContentWritingCoverage({
    knowledge: options.knowledge,
    sectionCoverages: Array.from(options.sectionCoverages.values()),
  });
  const afterCoverage = summarizeContentWritingCoverage({
    knowledge: options.knowledge,
    sectionCoverages: Array.from(nextCoverages.values()),
  });
  const lostIdeaIds = beforeCoverage.coveredIdeaIds.filter(
    id => !afterCoverage.coveredIdeaIds.includes(id),
  );
  const claimUsage = summarizeContentWritingClaimUsage({
    claimLedger: options.knowledge.claimLedger,
    usedClaimIds: Array.from(nextCoverages.values()).flatMap(coverage => coverage.usedClaimIds),
  });
  const newlyDeclaredBlockedClaimIds = claimUsage.usedClaimIds.filter(id => blockedClaimIds.has(id));
  const beforeText = normalizeClaimSearchText(options.beforeMarkdown);
  const candidateText = normalizeClaimSearchText(options.candidateMarkdown);
  const newlyInsertedBlockedStatements = options.knowledge.claimLedger.claims
    .filter(claim => claim.usagePolicy === 'blocked')
    .filter(claim => {
      const statement = normalizeClaimSearchText(claim.statement);
      return countOccurrences(candidateText, statement) > countOccurrences(beforeText, statement);
    })
    .map(claim => claim.id);
  const unsafeClaimIds = Array.from(new Set([
    ...newlyDeclaredBlockedClaimIds,
    ...newlyInsertedBlockedStatements,
  ]));
  const reasons: string[] = [];
  if (afterCoverage.coveragePercent < beforeCoverage.coveragePercent || lostIdeaIds.length > 0) {
    reasons.push('knowledge_coverage_decreased');
  }
  if (unsafeClaimIds.length > 0) reasons.push('blocked_claim_introduced');
  return {
    accepted: reasons.length === 0,
    coverageBeforePercent: beforeCoverage.coveragePercent,
    coverageAfterPercent: afterCoverage.coveragePercent,
    lostIdeaIds,
    blockedClaimIds: unsafeClaimIds,
    sectionCoverages: Array.from(nextCoverages.entries()).map(([sectionKey, coverage]) => ({
      sectionKey,
      coverage,
    })),
    reasons,
  };
};
