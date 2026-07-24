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
  type ContentWritingSourceChunk,
} from './contentWritingKnowledge';

export const CONTENT_WRITING_REQUIRED_COMPETITOR_COUNT = 3;

export type ContentWritingCompetitorInput = {
  id?: string;
  position?: number;
  title?: string;
  url?: string;
  content: string;
};

export type ContentWritingArticleInput = {
  articleId?: string;
  title: string;
  language: 'ar' | 'en' | string;
  articleText: string;
  keywords: Partial<Keywords>;
  goalContext: Partial<GoalContext>;
  competitors: readonly ContentWritingCompetitorInput[];
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
  competitorChunks: ContentWritingSourceChunk[];
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

export const normalizeContentWritingCompetitor = (
  value: unknown,
  fallbackPosition = 0,
): ContentWritingCompetitorInput | null => {
  if (!isRecord(value)) return null;
  const content = toText(
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
    ['local', 'country', 'regional'].includes(toText(goalContext.audienceScope).trim())
    && !hasText(goalContext.targetCountry)
  ) {
    issues.push({ code: 'goal_context.targetCountry', label: 'الدولة أو الموقع المستهدف' });
  }
  return issues;
};

export const validateContentWritingReadiness = (
  input: ContentWritingArticleInput,
): { issues: ContentWritingReadinessIssue[]; competitors: ContentWritingCompetitorInput[] } => {
  const issues: ContentWritingReadinessIssue[] = [];
  const secondaryKeywords = normalizeList(input.keywords.secondaries);
  const lsiKeywords = normalizeList(input.keywords.lsi);
  const competitors = normalizeContentWritingCompetitors(input.competitors)
    .slice(0, CONTENT_WRITING_REQUIRED_COMPETITOR_COUNT);

  if (!hasText(input.title)) issues.push({ code: 'article_title', label: 'عنوان المقالة' });
  if (!hasText(input.keywords.primary)) issues.push({ code: 'primary_keyword', label: 'الكلمة المفتاحية الأساسية' });
  if (secondaryKeywords.length === 0) issues.push({ code: 'alternative_keywords', label: 'الصيغ البديلة' });
  if (lsiKeywords.length === 0) issues.push({ code: 'lsi_keywords', label: 'كلمات LSI' });
  if (!hasText(input.keywords.company)) issues.push({ code: 'company_name', label: 'اسم الشركة' });
  issues.push(...getGoalContextIssues(input.goalContext));
  if (competitors.length < CONTENT_WRITING_REQUIRED_COMPETITOR_COUNT) {
    issues.push({
      code: 'competitors',
      label: `المحتوى الكامل لثلاثة منافسين (${competitors.length}/${CONTENT_WRITING_REQUIRED_COMPETITOR_COUNT})`,
    });
  }

  return { issues, competitors };
};

export const estimateContentWritingInputTokens = (value: string): number => {
  const characterCount = Array.from(String(value || '')).length;
  return Math.max(1, Math.ceil(characterCount / 2));
};

const createGoalContextValue = (goalContext: Partial<GoalContext>): string => {
  const targetAudience = toText(goalContext.targetAudience).trim();
  return JSON.stringify({
    pageType: toText(goalContext.pageType),
    objective: toText(goalContext.objective),
    audienceScope: toText(goalContext.audienceScope),
    targetCountry: toText(goalContext.targetCountry),
    ...(targetAudience ? { targetAudience } : {}),
    searchIntent: toText(goalContext.searchIntent),
  }, null, 2);
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

export const buildContentWritingPromptBundle = (
  input: ContentWritingArticleInput,
  options: {
    templates?: Partial<ContentWritingTemplateSet>;
    maxInputTokens?: number;
  } = {},
): ContentWritingPromptBundle => {
  const templates: ContentWritingTemplateSet = {
    ...DEFAULT_CONTENT_WRITING_TEMPLATES,
    ...(options.templates || {}),
  };
  const { issues: readinessIssues, competitors } = validateContentWritingReadiness(input);
  const competitorChunks = createCompetitorChunks(competitors);
  const variables: Record<string, string> = {
    article_id: toText(input.articleId).trim() || 'غير متوفر',
    article_title: toText(input.title),
    article_language: toText(input.language) || 'ar',
    article_text: toText(input.articleText) || 'لا يوجد نص حالي؛ اكتب المقالة من البداية.',
    primary_keyword: toText(input.keywords.primary),
    alternative_keywords: normalizeList(input.keywords.secondaries).join('، '),
    lsi_keywords: normalizeList(input.keywords.lsi).join('، '),
    company_name: toText(input.keywords.company),
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
    competitorChunks,
    readinessIssues,
    templateIssues,
    estimatedInputTokens,
    maxInputTokens,
    exceedsInputBudget,
  };
};
