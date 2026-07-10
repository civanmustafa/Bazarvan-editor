import type { ExternalEngineeringCommand } from './externalEngineeringCommands';

export type ExternalEngineeringPromptInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  keywords: {
    primary: string;
    secondaries: string[];
    company: string;
    lsi: string[];
  };
  goalContext: Record<string, unknown>;
  competitorUrls: string[];
  competitorTexts: string[];
};

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength).trim()}\n\n[Input shortened.]`;
};

const formatCompetitorText = (value: string): string => truncateText(value, 8_000)
  .split(/\n{2,}/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)
  .map((paragraph, index) => `[Paragraph ${index + 1}] ${paragraph}`)
  .join('\n\n');

const buildCompetitorBlocks = (
  texts: string[],
  urls: string[],
): string => Array.from({ length: Math.max(texts.length, urls.length) }, (_, index) => {
  const text = texts[index]?.trim() || '';
  const url = urls[index]?.trim() || '';
  if (!text && !url) return '';
  return [
    `### Competitor ${index + 1}`,
    `URL: ${url || '-'}`,
    text ? 'Evidence text:' : 'The URL context tool may be used for this competitor.',
    text ? formatCompetitorText(text) : '',
  ].filter(Boolean).join('\n');
}).filter(Boolean).join('\n\n');

export const EXTERNAL_ENGINEERING_OUTPUT_CONTRACT = [
  'Return strict JSON only. Do not place any text outside the JSON object.',
  'Use this exact top-level shape:',
  '{"analysisMarkdown":"...","patches":[{"marker":"patch_1","operation":"insert_after_heading","title":"...","anchorText":"...","targetText":"","placementLabel":"...","contentMarkdown":"...","reason":"...","confidence":0.85}]}',
  'analysisMarkdown contains the concise diagnostic report and [[PATCH:patch_1]] markers only where needed.',
  'Do not duplicate patch title, reason, placement, or content in analysisMarkdown.',
  'Write analysisMarkdown, title, reason, and placementLabel in Arabic.',
  'Write contentMarkdown in the article language. Keep targetText and anchorText verbatim from the article.',
  'Allowed operations: replace_block, replace_text, delete_block, insert_after_heading, insert_before_heading, append_to_section, insert_before_faq, insert_before_conclusion, append_to_article.',
  'Use replace_block when changing existing text and include the current text in targetText.',
  'Use an insertion operation only for genuinely new content.',
  'Each patch may contain only one independent H2 section. Split multiple H2 sections into separate patches.',
  'If a recommendation comes from competitor content, cite competitor number and evidence paragraph in reason.',
  'If it is an AI inference, say so in reason instead of inventing a competitor citation.',
  'Do not use bold Markdown inside analysisMarkdown or contentMarkdown.',
].join('\n');

export const buildExternalEngineeringPrompt = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
): string => [
  'You are running a saved engineering command for an external article analysis job.',
  `Command ${command.sequence} of 5: ${command.label}`,
  '',
  'Saved command instructions:',
  '---',
  command.prompt,
  '---',
  '',
  'Article context:',
  `Article language: ${input.articleLanguage === 'en' ? 'English' : 'Arabic'}`,
  `Article title: ${input.title}`,
  `Primary keyword: ${input.keywords.primary}`,
  `Alternative forms: ${input.keywords.secondaries.join(', ')}`,
  `LSI terms: ${input.keywords.lsi.join(', ')}`,
  `Company or brand: ${input.keywords.company}`,
  `Page goal context: ${JSON.stringify(input.goalContext)}`,
  '',
  'Current article text:',
  '---',
  truncateText(input.plainText, 20_000),
  '---',
  '',
  'Competitor inputs:',
  buildCompetitorBlocks(input.competitorTexts, input.competitorUrls),
  '',
  EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
].join('\n');

export const buildExternalEngineeringRepairPrompt = (
  previousResponse: string,
): string => [
  'Convert the previous response into the required strict JSON format.',
  'Preserve its useful analysis and proposed article text. Do not add new claims.',
  '',
  EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
  '',
  'Previous response:',
  '---',
  truncateText(previousResponse, 20_000),
  '---',
].join('\n');
