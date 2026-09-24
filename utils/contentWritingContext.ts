import {
  CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET,
  CONTENT_WRITING_PROTECTED_SYSTEM_GUARD,
  DEFAULT_CONTENT_WRITING_TEMPLATES,
  inspectContentWritingTemplate,
  renderContentWritingTemplate,
  type ContentWritingTemplateSet,
  type ContentWritingTemplateStage,
} from '../constants/contentWriting';
import type { GoalContext, Keywords } from '../types';
import {
  chunkContentWritingCompetitor,
  chunkContentWritingReference,
  type ContentWritingSourceChunk,
} from './contentWritingKnowledge';
import { buildContentWritingSourceInstructionsBlock } from './contentWritingSourceInstructions';
import { getUsableCompetitorText } from './competitorContent';
import {
  CONTENT_WRITING_MIN_CONFIGURABLE_COMPETITOR_COUNT,
  MAX_ARTICLE_COMPETITORS,
  normalizeContentWritingMinimumCompetitors,
} from '../constants/competitors';
import {
  countContentWritingTargetWords,
  parseContentWritingTargetWordRange,
} from './contentWritingTargets';
import {
  type CompetitorSourceClass,
} from './competitorSourcePolicy';

export const CONTENT_WRITING_MIN_COMPETITOR_COUNT = 3;
export { CONTENT_WRITING_MIN_CONFIGURABLE_COMPETITOR_COUNT };
export { normalizeContentWritingMinimumCompetitors };
export const CONTENT_WRITING_MAX_COMPETITOR_COUNT = MAX_ARTICLE_COMPETITORS;
export const CONTENT_WRITING_MIN_COMPETITOR_WORDS = 0;
export const CONTENT_WRITING_MIN_COMPETITOR_UNIQUE_TOKENS = 0;
export const CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS = 0;

export type ContentWritingCompetitorInput = {
  id?: string;
  position?: number;
  title?: string;
  url?: string;
  content: string;
  sourceClass?: CompetitorSourceClass;
  contentWeight?: number;
};

export type ContentWritingArticleInput = {
  articleId?: string;
  title: string;
  language: 'ar' | 'en' | string;
  keywords: Partial<Keywords>;
  goalContext: Partial<GoalContext>;
  competitors: readonly ContentWritingCompetitorInput[];
  writingSources?: readonly ContentWritingReferenceInput[];
};

export type ContentWritingReferenceInput = {
  id: string;
  title?: string;
  url?: string;
  content: string;
  sourceRole: 'primary' | 'supporting';
  focusInstructions?: string;
  enabled: boolean;
  status: 'pending' | 'extracting' | 'ready' | 'failed';
};

export type ContentWritingReadinessIssue = {
  code: string;
  label: string;
};

export type ContentWritingPromptMessage = {
  stage: ContentWritingTemplateStage;
  role: 'system' | 'user';
  content: string;
};

export type ContentWritingPromptBundle = {
  ready: boolean;
  messages: ContentWritingPromptMessage[];
  variables: Record<string, string>;
  competitors: ContentWritingCompetitorInput[];
  competitorQualityAudit: ContentWritingCompetitorQualityAudit;
  competitorChunks: ContentWritingSourceChunk[];
  writingSourceChunks: ContentWritingSourceChunk[];
  sourceChunks: ContentWritingSourceChunk[];
  readinessIssues: ContentWritingReadinessIssue[];
  templateIssues: Array<{
    stage: ContentWritingTemplateStage;
    unknownPlaceholders: string[];
    missingRequiredPlaceholders: string[];
    missingValues: string[];
  }>;
  estimatedInputTokens: number;
  maxInputTokens: number;
  exceedsInputBudget: boolean;
};

export type ContentWritingCompetitorQualityReason =
  | 'content_too_short'
  | 'low_information_density'
  | 'duplicate_content';

export type ContentWritingCompetitorQualityItem = {
  position: number;
  title: string;
  url: string;
  hostname: string;
  sourceIdentity: string;
  wordCount: number;
  uniqueTokenCount: number;
  minimumWordCount: number;
  minimumUniqueTokenCount: number;
  sourceClass: CompetitorSourceClass;
  contentWeight: number;
  accepted: boolean;
  reasons: ContentWritingCompetitorQualityReason[];
};

export type ContentWritingCompetitorQualityAudit = {
  version: number;
  minimumCompetitors: number;
  minimumWordsPerCompetitor: number;
  minimumDistinctDomains: number;
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  distinctDomainCount: number;
  replacementNeededCount: number;
  items: ContentWritingCompetitorQualityItem[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value : '';

const toTextList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(toText) : []
);

const normalizeList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => toText(item).trim()).filter(Boolean)
    : []
);

const hasText = (value: unknown): boolean => typeof value === 'string' && Boolean(value.trim());

const competitorHostname = (value: unknown): string => {
  const url = toText(value).trim();
  if (!url) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.toLocaleLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const competitorSourceIdentity = (
  competitor: ContentWritingCompetitorInput,
  index: number,
): string => {
  const hostname = competitorHostname(competitor.url);
  if (hostname) return `domain:${hostname}`;
  const stableSlot = toText(competitor.id).trim()
    || String(Math.max(1, Math.round(Number(competitor.position) || index + 1)));
  // A manually pasted competitor has no domain. Its persisted row/slot remains
  // useful for audit display, but source diversity is not an acceptance gate.
  return `manual:${stableSlot}`;
};

const competitorContentTokens = (value: string): string[] => String(value || '')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .split(/\s+/u)
  .filter(token => token.length >= 3);

export const selectQualityContentWritingCompetitors = (
  values: readonly ContentWritingCompetitorInput[],
  maximum = CONTENT_WRITING_MAX_COMPETITOR_COUNT,
  minimumCompetitors = CONTENT_WRITING_MIN_COMPETITOR_COUNT,
): {
  competitors: ContentWritingCompetitorInput[];
  audit: ContentWritingCompetitorQualityAudit;
} => {
  const normalized = normalizeContentWritingCompetitors(values);
  const normalizedMinimumCompetitors = normalizeContentWritingMinimumCompetitors(minimumCompetitors);
  const items = normalized.map((competitor, index): ContentWritingCompetitorQualityItem => {
    const tokens = competitorContentTokens(competitor.content);
    const wordCount = countContentWritingTargetWords(competitor.content);
    const uniqueTokenCount = new Set(tokens).size;
    const reasons: ContentWritingCompetitorQualityReason[] = [];
    return {
      position: Math.max(1, Math.round(Number(competitor.position) || index + 1)),
      title: toText(competitor.title).trim(),
      url: toText(competitor.url).trim(),
      hostname: competitorHostname(competitor.url),
      sourceIdentity: competitorSourceIdentity(competitor, index),
      wordCount,
      uniqueTokenCount,
      minimumWordCount: 0,
      minimumUniqueTokenCount: 0,
      sourceClass: 'commercial',
      contentWeight: 1,
      accepted: true,
      reasons,
    };
  });
  const selected = normalized.slice(0, Math.max(0, maximum));
  const distinctDomainCount = new Set(
    selected.map((competitor, index) => competitorSourceIdentity(competitor, index)),
  ).size;
  return {
    competitors: selected,
    audit: {
      version: 1,
      minimumCompetitors: normalizedMinimumCompetitors,
      minimumWordsPerCompetitor: 0,
      minimumDistinctDomains: 0,
      inputCount: normalized.length,
      acceptedCount: selected.length,
      rejectedCount: Math.max(0, normalized.length - selected.length),
      distinctDomainCount,
      replacementNeededCount: Math.max(0, normalizedMinimumCompetitors - selected.length),
      items,
    },
  };
};

export const normalizeContentWritingCompetitor = (
  value: unknown,
  fallbackPosition = 0,
): ContentWritingCompetitorInput | null => {
  if (!isRecord(value)) return null;
  const content = getUsableCompetitorText(
    value.content
    ?? value.contentText
    ?? value.content_text
    ?? value.text
    ?? value.plainText
    ?? value.plain_text,
  );
  if (!content.trim()) return null;
  const rawPosition = Number(value.position);
  return {
    id: toText(value.id).trim() || undefined,
    position: Number.isFinite(rawPosition) ? rawPosition : fallbackPosition,
    title: toText(value.title).trim() || undefined,
    url: toText(value.url ?? value.sourceUrl ?? value.source_url ?? value.canonicalUrl ?? value.canonical_url).trim() || undefined,
    content,
    sourceClass: 'commercial',
    contentWeight: 1,
  };
};

export const normalizeContentWritingCompetitors = (
  values: readonly unknown[],
): ContentWritingCompetitorInput[] => values
  .map((value, index) => normalizeContentWritingCompetitor(value, index + 1))
  .filter((value): value is ContentWritingCompetitorInput => Boolean(value))
  .sort((left, right) => (left.position || 0) - (right.position || 0));

export const getContentWritingCompetitorsFromMetadata = (
  metadata: unknown,
): ContentWritingCompetitorInput[] => {
  const root = isRecord(metadata) ? metadata : {};
  const attachments = isRecord(root.attachments) ? root.attachments : {};
  const source = isRecord(attachments.competitors)
    ? attachments.competitors
    : isRecord(root.competitors)
      ? root.competitors
      : {};
  const texts = toTextList(source.texts);
  // attachments.competitors.texts is the single canonical competitor input saved
  // by Firecrawl or the editor. Preview cards are UI-only and never duplicated here.
  const urls = toTextList(source.urls);
  const titles = toTextList(source.titles);
  return normalizeContentWritingCompetitors(texts.map((content, index) => ({
    position: index + 1,
    content,
    url: urls[index],
    title: titles[index],
  })));
};

const getGoalContextIssues = (goalContext: Partial<GoalContext>): ContentWritingReadinessIssue[] => {
  const issues: ContentWritingReadinessIssue[] = [];
  const required: Array<[keyof GoalContext, string]> = [
    ['pageType', 'نوع الصفحة'],
    ['objective', 'هدف الصفحة'],
    ['audienceScope', 'نطاق الجمهور'],
    ['searchIntent', 'نية البحث'],
  ];
  required.forEach(([key, label]) => {
    if (!hasText(goalContext[key])) issues.push({ code: `goal_context.${key}`, label });
  });
  if (
    hasText(goalContext.targetWordRange)
    && !parseContentWritingTargetWordRange(goalContext.targetWordRange)
  ) {
    issues.push({
      code: 'goal_context.targetWordRange',
      label: 'نطاق عدد الكلمات (مثال: 1200-1800)',
    });
  }
  return issues;
};

export const validateContentWritingReadiness = (
  input: ContentWritingArticleInput,
  options: {
    requireCompany?: boolean;
    requireGoalContext?: boolean;
    minimumCompetitors?: number;
  } = {},
): {
  issues: ContentWritingReadinessIssue[];
  competitors: ContentWritingCompetitorInput[];
  competitorQualityAudit: ContentWritingCompetitorQualityAudit;
} => {
  const issues: ContentWritingReadinessIssue[] = [];
  const secondaryKeywords = normalizeList(input.keywords.secondaries);
  const lsiKeywords = normalizeList(input.keywords.lsi);
  const qualitySelection = selectQualityContentWritingCompetitors(
    input.competitors,
    CONTENT_WRITING_MAX_COMPETITOR_COUNT,
    options.minimumCompetitors,
  );
  const competitors = qualitySelection.competitors;
  const minimumCompetitors = qualitySelection.audit.minimumCompetitors;

  if (!hasText(input.title)) issues.push({ code: 'article_title', label: 'عنوان المقالة' });
  if (!hasText(input.keywords.primary)) issues.push({ code: 'primary_keyword', label: 'الكلمة المفتاحية الأساسية' });
  if (secondaryKeywords.length === 0) issues.push({ code: 'alternative_keywords', label: 'الصيغ البديلة' });
  if (lsiKeywords.length === 0) issues.push({ code: 'lsi_keywords', label: 'كلمات LSI' });
  if (options.requireCompany !== false && !hasText(input.keywords.company)) {
    issues.push({ code: 'company_name', label: 'اسم الشركة' });
  }
  if (options.requireGoalContext !== false) issues.push(...getGoalContextIssues(input.goalContext));
  if (competitors.length < minimumCompetitors) {
    issues.push({
      code: 'competitors',
      label: `نصوص المنافسين المؤهلة: ${competitors.length}/${minimumCompetitors} على الأقل`,
    });
  }
  const blockedPrimarySources = (input.writingSources || []).filter(source => (
    source.enabled && source.sourceRole === 'primary' && source.status !== 'ready'
  ));
  if (blockedPrimarySources.length > 0) {
    issues.push({
      code: 'writing_sources.primary_not_ready',
      label: `مصادر الكتابة الأساسية غير الجاهزة (${blockedPrimarySources.length})`,
    });
  }

  return { issues, competitors, competitorQualityAudit: qualitySelection.audit };
};

export const estimateContentWritingInputTokens = (value: string): number => {
  const characterCount = Array.from(String(value || '')).length;
  return Math.max(1, Math.ceil(characterCount / 2));
};

const createGoalContextValue = (goalContext: Partial<GoalContext>): string => {
  const serialized: Record<string, string> = {
    pageType: toText(goalContext.pageType),
    objective: toText(goalContext.objective),
    audienceScope: toText(goalContext.audienceScope),
    searchIntent: toText(goalContext.searchIntent),
  };
  const optionalFields: Array<keyof GoalContext> = [
    'targetWordRange',
    'targetCountry',
    'targetAudience',
    'audienceKnowledgeLevel',
    'audienceNeeds',
    'readerOutcome',
    'marketingStage',
    'uniqueAngle',
    'evidenceRequirements',
    'brandVoice',
    'topicSensitivity',
    'generatedBrief',
  ];
  optionalFields.forEach(key => {
    const value = toText(goalContext[key]);
    if (value) serialized[key] = value;
  });
  return JSON.stringify(serialized, null, 2);
};

const createCompetitorChunks = (
  competitors: ContentWritingCompetitorInput[],
): ContentWritingSourceChunk[] => competitors.flatMap((competitor, index) => (
  chunkContentWritingCompetitor({
    competitorNumber: index + 1,
    title: competitor.title,
    url: competitor.url,
    content: competitor.content,
  })
));

const createCompetitorsValue = (
  competitors: ContentWritingCompetitorInput[],
  chunks: ContentWritingSourceChunk[],
): string => JSON.stringify(
  competitors.map((competitor, index) => ({
    competitorNumber: index + 1,
    title: competitor.title || '',
    url: competitor.url || '',
    sourceClass: competitor.sourceClass || 'commercial',
    contentWeight: competitor.contentWeight ?? 1,
    usageGuidance: (competitor.contentWeight ?? 1) < 1
      ? 'Trusted government reference accepted at the reduced source threshold; use as supporting evidence with lower comparative weight.'
      : 'Full-weight competitor source.',
    chunks: chunks
      .filter(chunk => chunk.competitorNumber === index + 1)
      .map(chunk => ({ sourceId: chunk.id, text: chunk.text })),
  })),
  null,
  2,
)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

const createWritingSourceChunks = (
  sources: readonly ContentWritingReferenceInput[],
): ContentWritingSourceChunk[] => sources
  .filter(source => source.enabled && source.status === 'ready' && Boolean(source.content.trim()))
  .flatMap((source, index) => chunkContentWritingReference({
    sourceNumber: index + 1,
    sourceId: source.id,
    title: source.title,
    url: source.url,
    content: source.content,
    sourceRole: source.sourceRole,
    focusInstructions: source.focusInstructions,
  }));

const createWritingSourcesValue = (
  sources: readonly ContentWritingReferenceInput[],
  chunks: readonly ContentWritingSourceChunk[],
): string => JSON.stringify(
  sources
    .filter(source => source.enabled && source.status === 'ready' && Boolean(source.content.trim()))
    .map(source => ({
      id: source.id,
      title: source.title || '',
      url: source.url || '',
      role: source.sourceRole,
      chunks: chunks
        .filter(chunk => chunk.sourceId === source.id)
        .map(chunk => ({ sourceId: chunk.id, text: chunk.text })),
    })),
  null,
  2,
)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

export const buildContentWritingPromptBundle = (
  input: ContentWritingArticleInput,
  options: {
    templates?: Partial<ContentWritingTemplateSet>;
    maxInputTokens?: number;
    requireCompany?: boolean;
    requireGoalContext?: boolean;
    minimumCompetitors?: number;
  } = {},
): ContentWritingPromptBundle => {
  const templates: ContentWritingTemplateSet = {
    ...DEFAULT_CONTENT_WRITING_TEMPLATES,
    ...(options.templates || {}),
  };
  const { issues: readinessIssues, competitors, competitorQualityAudit } = validateContentWritingReadiness(
    input,
    {
      requireCompany: options.requireCompany,
      requireGoalContext: options.requireGoalContext,
      minimumCompetitors: options.minimumCompetitors,
    },
  );
  const competitorChunks = createCompetitorChunks(competitors);
  const writingSourceChunks = createWritingSourceChunks(input.writingSources || []);
  const sourceChunks = [...writingSourceChunks, ...competitorChunks];
  const writingSourceInstructionsBlock = buildContentWritingSourceInstructionsBlock(
    (input.writingSources || [])
      .filter(source => source.enabled && source.status === 'ready' && Boolean(source.content.trim()))
      .map(source => ({
        sourceId: source.id,
        sourceRole: source.sourceRole,
        instructions: source.focusInstructions,
      })),
  );
  const variables: Record<string, string> = {
    article_id: toText(input.articleId).trim() || 'غير متوفر',
    article_title: toText(input.title),
    article_language: toText(input.language) || 'ar',
    writing_sources_json: createWritingSourcesValue(input.writingSources || [], writingSourceChunks),
    primary_keyword: toText(input.keywords.primary),
    alternative_keywords: normalizeList(input.keywords.secondaries).join('، '),
    lsi_keywords: normalizeList(input.keywords.lsi).join('، '),
    company_name: toText(input.keywords.company) || (options.requireCompany === false
      ? (input.language === 'en'
        ? 'Not specified — do not invent a company or brand.'
        : 'غير محدد — لا تخترع اسم شركة أو علامة تجارية.')
      : ''),
    goal_context: createGoalContextValue(input.goalContext),
    competitors_json: createCompetitorsValue(competitors, competitorChunks),
  };
  const stageDefinitions: Array<{
    stage: ContentWritingTemplateStage;
    role: 'system' | 'user';
  }> = [
    { stage: 'instructions', role: 'system' },
    { stage: 'articleContext', role: 'user' },
    { stage: 'generationRequest', role: 'user' },
  ];
  const templateIssues: ContentWritingPromptBundle['templateIssues'] = [];
  const messages = stageDefinitions.map(({ stage, role }) => {
    const inspection = inspectContentWritingTemplate(stage, templates[stage]);
    const rendered = renderContentWritingTemplate(templates[stage], variables);
    if (!inspection.isValid || rendered.missingValues.length > 0) {
      templateIssues.push({
        stage,
        unknownPlaceholders: inspection.unknownPlaceholders,
        missingRequiredPlaceholders: inspection.missingRequiredPlaceholders,
        missingValues: rendered.missingValues,
      });
    }
    return {
      stage,
      role,
      content: stage === 'instructions'
        ? `${rendered.text}\n\n${CONTENT_WRITING_PROTECTED_SYSTEM_GUARD}`
        : stage === 'articleContext' && writingSourceInstructionsBlock
          ? `${rendered.text}\n\n${writingSourceInstructionsBlock}`
        : rendered.text,
    };
  });
  const estimatedInputTokens = estimateContentWritingInputTokens(
    messages.map(message => message.content).join('\n\n'),
  );
  const maxInputTokens = Number.isFinite(options.maxInputTokens)
    ? Math.max(1, Math.round(options.maxInputTokens as number))
    : CONTENT_WRITING_DEFAULT_INPUT_TOKEN_BUDGET;
  const exceedsInputBudget = estimatedInputTokens > maxInputTokens;

  return {
    ready: readinessIssues.length === 0 && templateIssues.length === 0 && !exceedsInputBudget,
    messages,
    variables,
    competitors,
    competitorQualityAudit,
    competitorChunks,
    writingSourceChunks,
    sourceChunks,
    readinessIssues,
    templateIssues,
    estimatedInputTokens,
    maxInputTokens,
    exceedsInputBudget,
  };
};
