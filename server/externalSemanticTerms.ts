import {
  buildSemanticKeywordRepairPrompt,
  describeSemanticKeywordValidationFailure,
  hasUsableSemanticKeywordTerms,
  parseSemanticKeywordTerms,
  renderSemanticKeywordPrompt,
  type SemanticKeywordInput,
  type SemanticKeywordTerms,
} from '../utils/semanticKeywordPolicy';

export type ExternalSemanticKeywords = {
  primary: string;
  secondaries: string[];
  company: string;
  lsi: string[];
};

export type ExternalSemanticArticleInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  keywords: ExternalSemanticKeywords;
  goalContext: Record<string, unknown>;
};

export type ExternalSemanticTerms = Pick<SemanticKeywordTerms, 'secondaries' | 'lsi'>;

const toSemanticInput = (article: ExternalSemanticArticleInput): SemanticKeywordInput => ({
  title: article.title,
  plainText: article.plainText,
  articleLanguage: article.articleLanguage,
  primaryKeyword: article.keywords.primary,
  companyName: article.keywords.company,
  existingSecondaries: article.keywords.secondaries,
  existingLsi: article.keywords.lsi,
  goalContext: article.goalContext,
});

/*
 * Firecrawl and competitor extraction do not participate in this flow.
 * This module only generates keyword alternatives and LSI terms, and delegates
 * both prompt rendering and deterministic constraint checks to one shared policy.
 */
export const parseExternalSemanticTerms = (
  responseText: string,
  article: ExternalSemanticArticleInput,
): ExternalSemanticTerms => {
  const parsed = parseSemanticKeywordTerms(responseText, toSemanticInput(article));
  return {
    secondaries: parsed.secondaries,
    lsi: parsed.lsi,
  };
};

export const hasUsableExternalSemanticTerms = (
  terms: ExternalSemanticTerms,
  needsSecondaries: boolean,
  needsLsi: boolean,
): boolean => hasUsableSemanticKeywordTerms(terms, needsSecondaries, needsLsi);

export const describeExternalSemanticValidationFailure = (
  terms: ExternalSemanticTerms,
  article: ExternalSemanticArticleInput,
  needsSecondaries: boolean,
  needsLsi: boolean,
): string => describeSemanticKeywordValidationFailure(
  terms,
  toSemanticInput(article),
  needsSecondaries,
  needsLsi,
);

export const buildExternalSemanticPrompt = (
  article: ExternalSemanticArticleInput,
  template: string,
): string => renderSemanticKeywordPrompt(toSemanticInput(article), template);

export const buildExternalSemanticRepairPrompt = (
  article: ExternalSemanticArticleInput,
  previousResponse: string,
  template: string,
): string => buildSemanticKeywordRepairPrompt(
  toSemanticInput(article),
  template,
  previousResponse,
);
