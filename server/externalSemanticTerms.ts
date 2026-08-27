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

const buildRequestedSemanticListsPrompt = (
  needsSecondaries: boolean,
  needsLsi: boolean,
): string => [
  '<requested_semantic_lists>',
  needsSecondaries
    ? '- أنشئ الصيغ البديلة المطلوبة في secondaries.'
    : '- لا تنشئ صيغًا بديلة؛ أرجع secondaries كمصفوفة فارغة.',
  needsLsi
    ? '- أنشئ كلمات LSI المطلوبة في lsi.'
    : '- لا تنشئ كلمات LSI؛ أرجع lsi كمصفوفة فارغة.',
  '- لا تُرجع محتوى لقائمة لم يطلبها النظام في هذه المهمة.',
  '</requested_semantic_lists>',
].join('\n');

export const buildExternalSemanticPrompt = (
  article: ExternalSemanticArticleInput,
  template: string,
  needsSecondaries = true,
  needsLsi = true,
): string => [
  renderSemanticKeywordPrompt(toSemanticInput(article), template),
  '',
  buildRequestedSemanticListsPrompt(needsSecondaries, needsLsi),
].join('\n');

export const buildExternalSemanticRepairPrompt = (
  article: ExternalSemanticArticleInput,
  previousResponse: string,
  template: string,
  needsSecondaries = true,
  needsLsi = true,
): string => [
  buildSemanticKeywordRepairPrompt(
    toSemanticInput(article),
    template,
    previousResponse,
  ),
  '',
  buildRequestedSemanticListsPrompt(needsSecondaries, needsLsi),
].join('\n');
