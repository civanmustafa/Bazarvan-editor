import { renderPromptTemplateVariables } from '../constants/promptTemplateRenderer.ts';

export const META_DESCRIPTION_MIN_LENGTH = 140;
export const META_DESCRIPTION_MAX_LENGTH = 150;

export type MetaDescriptionValidation = {
  normalized: string;
  length: number;
  lengthValid: boolean;
  includesPrimaryKeyword: boolean;
  valid: boolean;
};

export type MetaDescriptionSuggestionPair = [string, string];

export const META_DESCRIPTION_GENERATION_MAX_ATTEMPTS = 2;

export type MetaDescriptionGenerationMode = 'automatic_apply' | 'writing_suggestions';

export type MetaDescriptionGenerationPromptInput =
  | {
      mode: 'automatic_apply';
      title: string;
      primaryKeyword: string;
      articleLanguage: 'ar' | 'en';
      tableOfContents: string[];
      goalContext: Record<string, unknown>;
      previousInvalidResponse?: string;
    }
  | {
      mode: 'writing_suggestions';
      title: string;
      primaryKeyword: string;
      articleLanguage: 'ar' | 'en';
      finalArticle: string;
      goalContext: Record<string, unknown>;
      template?: string;
      previousInvalidResponse?: string;
    };

export type ValidMetaDescriptionGeneration =
  | { mode: 'automatic_apply'; description: string; descriptions: [string] }
  | { mode: 'writing_suggestions'; descriptions: MetaDescriptionSuggestionPair };

const normalizeForComparison = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

export const normalizeMetaDescription = (value: unknown): string => (
  typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
);

export const countMetaDescriptionCharacters = (value: unknown): number => (
  Array.from(normalizeMetaDescription(value)).length
);

export const validateMetaDescription = (
  value: unknown,
  primaryKeyword: unknown,
): MetaDescriptionValidation => {
  const normalized = normalizeMetaDescription(value);
  const keyword = normalizeMetaDescription(primaryKeyword);
  const length = Array.from(normalized).length;
  const lengthValid = length >= META_DESCRIPTION_MIN_LENGTH
    && length <= META_DESCRIPTION_MAX_LENGTH;
  const includesPrimaryKeyword = Boolean(
    keyword
    && normalizeForComparison(normalized).includes(normalizeForComparison(keyword)),
  );
  return {
    normalized,
    length,
    lengthValid,
    includesPrimaryKeyword,
    valid: lengthValid && includesPrimaryKeyword,
  };
};

const decodeBasicHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');

export const extractArticleTableOfContents = (
  contentHtml: unknown,
  plainText: unknown,
  maximumItems = 18,
): string[] => {
  const html = typeof contentHtml === 'string' ? contentHtml : '';
  const headings = Array.from(html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi))
    .map(match => normalizeMetaDescription(decodeBasicHtmlEntities(
      String(match[1] || '').replace(/<[^>]+>/g, ' '),
    )))
    .filter(Boolean);
  if (headings.length > 0) return Array.from(new Set(headings)).slice(0, maximumItems);

  const text = typeof plainText === 'string' ? plainText : '';
  return Array.from(new Set(
    text
      .split(/\r?\n/g)
      .map(line => normalizeMetaDescription(line.replace(/^#{1,6}\s+/, '')))
      .filter(line => line.length >= 4 && line.length <= 120),
  )).slice(0, maximumItems);
};

const jsonObjectFromText = (value: string): Record<string, unknown> | null => {
  const candidates = [
    value.trim(),
    value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || '',
    value.match(/\{[\s\S]*\}/)?.[0]?.trim() || '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next safe JSON envelope.
    }
  }
  return null;
};

export const normalizeMetaDescriptionSuggestions = (value: unknown): string[] => {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (
          (value as Record<string, unknown>).metaDescriptionSuggestions
          ?? (value as Record<string, unknown>).metaDescriptions
          ?? (value as Record<string, unknown>).suggestions
        )
      : [];
  if (!Array.isArray(source)) return [];

  const seen = new Set<string>();
  return source
    .map(normalizeMetaDescription)
    .filter(candidate => {
      const comparisonKey = normalizeForComparison(candidate);
      if (!comparisonKey || seen.has(comparisonKey)) return false;
      seen.add(comparisonKey);
      return true;
    });
};

export const parseGeneratedMetaDescriptionSuggestions = (value: string): string[] => {
  const parsed = jsonObjectFromText(value);
  if (!parsed) return [];
  return normalizeMetaDescriptionSuggestions(parsed);
};

export const getValidMetaDescriptionSuggestionPair = (
  value: unknown,
  primaryKeyword: unknown,
): MetaDescriptionSuggestionPair | null => {
  const candidates = typeof value === 'string'
    ? parseGeneratedMetaDescriptionSuggestions(value)
    : normalizeMetaDescriptionSuggestions(value);
  if (candidates.length !== 2) return null;
  const validated = candidates.map(candidate => validateMetaDescription(candidate, primaryKeyword));
  if (!validated.every(result => result.valid)) return null;
  return [validated[0].normalized, validated[1].normalized];
};

export const parseGeneratedMetaDescription = (value: string): string => {
  const parsed = jsonObjectFromText(value);
  const candidate = parsed?.metaDescription ?? parsed?.meta_description ?? parsed?.description;
  if (typeof candidate === 'string') return normalizeMetaDescription(candidate);
  if (!parsed) return normalizeMetaDescription(value.replace(/^['"“”]+|['"“”]+$/g, ''));
  return '';
};

export const buildMetaDescriptionPrompt = (input: {
  title: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  tableOfContents: string[];
  goalContext: Record<string, unknown>;
  previousInvalidDescription?: string;
}): string => {
  const language = input.articleLanguage === 'en' ? 'English' : 'Arabic';
  const repair = input.previousInvalidDescription
    ? `\nThe previous draft was invalid and must be rewritten, not explained:\n${input.previousInvalidDescription}`
    : '';
  return [
    'Write one SEO meta description for the supplied article.',
    `Output language: ${language}.`,
    `The final description must contain exactly 140 to 150 Unicode characters, including spaces and punctuation.`,
    `Include the primary keyword exactly as supplied: ${input.primaryKeyword}`,
    'Reflect the page goal and the article table of contents. Do not invent facts, prices, guarantees, or claims.',
    'Use a natural, specific sentence that describes the page and encourages a relevant click without clickbait.',
    'Return JSON only in this exact shape: {"metaDescription":"..."}',
    `Article title: ${input.title}`,
    `Page goal context: ${JSON.stringify(input.goalContext)}`,
    `Table of contents: ${JSON.stringify(input.tableOfContents)}`,
    repair,
  ].join('\n');
};

export const buildMetaDescriptionSuggestionsPrompt = (input: {
  title: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  finalArticle: string;
  goalContext: Record<string, unknown>;
  template?: string;
  previousInvalidResponse?: string;
}): string => {
  const language = input.articleLanguage === 'en' ? 'English' : 'Arabic';
  const variables: Record<string, string> = {
    article_title: input.title,
    primary_keyword: input.primaryKeyword,
    output_language: language,
    goal_context_json: JSON.stringify(input.goalContext),
    final_article: input.finalArticle,
  };
  const defaultTemplate = [
    'Generate exactly two distinct SEO meta-description suggestions for the final article.',
    'Output language: {{output_language}}.',
    'Each description must contain exactly 140 to 150 Unicode characters, including spaces and punctuation.',
    'Each description must include the primary keyword exactly as supplied: {{primary_keyword}}',
    'Ground both descriptions in the final article and page goal. Do not invent facts, prices, guarantees, or claims.',
    'Make the two descriptions genuinely different in phrasing while preserving the same search intent.',
    'Return JSON only in this exact shape: {"metaDescriptionSuggestions":["...","..."]}',
    'Article title: {{article_title}}',
    'Page goal context: {{goal_context_json}}',
    '<final_article>',
    '{{final_article}}',
    '</final_article>',
  ].join('\n');
  const rendered = renderPromptTemplateVariables(
    input.template?.trim() || defaultTemplate,
    variables,
  );
  const repair = input.previousInvalidResponse?.trim()
    ? [
        '',
        'The previous response was invalid. Rewrite both descriptions and return the required JSON only.',
        '<invalid_previous_response>',
        input.previousInvalidResponse.slice(0, 4_000),
        '</invalid_previous_response>',
      ].join('\n')
    : '';
  return `${rendered}${repair}`;
};

/**
 * One public prompt contract for both product modes. The automatic ready-state
 * job asks for one directly applicable description, while content writing asks
 * for two reviewable suggestions. Both retain the same length, keyword, page
 * goal, grounding, and JSON-only rules.
 */
export const buildMetaDescriptionGenerationPrompt = (
  input: MetaDescriptionGenerationPromptInput,
): string => input.mode === 'automatic_apply'
  ? buildMetaDescriptionPrompt({
      title: input.title,
      primaryKeyword: input.primaryKeyword,
      articleLanguage: input.articleLanguage,
      tableOfContents: input.tableOfContents,
      goalContext: input.goalContext,
      previousInvalidDescription: input.previousInvalidResponse,
    })
  : buildMetaDescriptionSuggestionsPrompt({
      title: input.title,
      primaryKeyword: input.primaryKeyword,
      articleLanguage: input.articleLanguage,
      finalArticle: input.finalArticle,
      goalContext: input.goalContext,
      template: input.template,
      previousInvalidResponse: input.previousInvalidResponse,
    });

/** Validates and normalizes either generation mode through the same policy. */
export const parseValidMetaDescriptionGeneration = (options: {
  mode: MetaDescriptionGenerationMode;
  response: unknown;
  primaryKeyword: unknown;
}): ValidMetaDescriptionGeneration | null => {
  if (options.mode === 'writing_suggestions') {
    const descriptions = getValidMetaDescriptionSuggestionPair(
      options.response,
      options.primaryKeyword,
    );
    return descriptions
      ? { mode: 'writing_suggestions', descriptions }
      : null;
  }

  const responseRecord = options.response
    && typeof options.response === 'object'
    && !Array.isArray(options.response)
    ? options.response as Record<string, unknown>
    : null;
  const candidate = typeof options.response === 'string'
    ? parseGeneratedMetaDescription(options.response)
    : normalizeMetaDescription(
        responseRecord?.metaDescription
        ?? responseRecord?.meta_description
        ?? responseRecord?.description,
      );
  const validation = validateMetaDescription(candidate, options.primaryKeyword);
  return validation.valid
    ? {
        mode: 'automatic_apply',
        description: validation.normalized,
        descriptions: [validation.normalized],
      }
    : null;
};

export const shouldRetryMetaDescriptionGeneration = (
  attemptNumber: number,
): boolean => (
  Number.isFinite(attemptNumber)
  && Math.max(0, Math.round(attemptNumber)) < META_DESCRIPTION_GENERATION_MAX_ATTEMPTS
);
