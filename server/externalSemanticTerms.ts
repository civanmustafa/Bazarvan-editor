import {
  buildSemanticKeywordRepairPrompt,
  describeSemanticKeywordValidationFailure,
  hasUsableSemanticKeywordTerms,
  parseSemanticKeywordTerms,
  renderSemanticKeywordPrompt,
  type SemanticKeywordInput,
  type SemanticKeywordTerms,
} from '../utils/semanticKeywordPolicy';
import type { GoogleDescriptionSuggestion } from '../types';

export type ExternalSemanticKeywords = {
  primary: string;
  secondaries: string[];
  company: string;
  lsi: string[];
  googleTitles: string[];
  googleDescriptions: GoogleDescriptionSuggestion[];
};

export type ExternalSemanticArticleInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  keywords: ExternalSemanticKeywords;
  goalContext: Record<string, unknown>;
};

export type ExternalSemanticTerms = Pick<SemanticKeywordTerms, 'secondaries' | 'lsi' | 'googleTitles' | 'googleDescriptions'>;

const toSemanticInput = (article: ExternalSemanticArticleInput): SemanticKeywordInput => ({
  title: article.title,
  plainText: article.plainText,
  articleLanguage: article.articleLanguage,
  primaryKeyword: article.keywords.primary,
  companyName: article.keywords.company,
  existingSecondaries: article.keywords.secondaries,
  existingLsi: article.keywords.lsi,
  existingGoogleTitles: article.keywords.googleTitles,
  existingGoogleDescriptions: article.keywords.googleDescriptions,
  goalContext: article.goalContext,
});

/*
 * Firecrawl and competitor extraction do not participate in this flow.
 * This module runs one unified command for alternatives, LSI terms, and two
 * Google title/description suggestions. Every surface shares this policy.
 */
export const parseExternalSemanticTerms = (
  responseText: string,
  article: ExternalSemanticArticleInput,
): ExternalSemanticTerms => {
  const parsed = parseSemanticKeywordTerms(responseText, toSemanticInput(article));
  return {
    secondaries: parsed.secondaries,
    lsi: parsed.lsi,
    googleTitles: parsed.googleTitles,
    googleDescriptions: parsed.googleDescriptions,
  };
};

export const hasUsableExternalSemanticTerms = (
  terms: ExternalSemanticTerms,
  needsSecondaries: boolean,
  needsLsi: boolean,
  needsGoogleMetadata = true,
): boolean => hasUsableSemanticKeywordTerms(
  terms,
  needsSecondaries,
  needsLsi,
  needsGoogleMetadata,
);

export const describeExternalSemanticValidationFailure = (
  terms: ExternalSemanticTerms,
  article: ExternalSemanticArticleInput,
  needsSecondaries: boolean,
  needsLsi: boolean,
  needsGoogleMetadata = true,
): string => describeSemanticKeywordValidationFailure(
  terms,
  toSemanticInput(article),
  needsSecondaries,
  needsLsi,
  needsGoogleMetadata,
);

const buildRequestedSemanticListsPrompt = (
  needsSecondaries: boolean,
  needsLsi: boolean,
): string => [
  '<requested_semantic_lists>',
  needsSecondaries
    ? '- أنشئ الصيغ البديلة المطلوبة في secondaries.'
    : '- أنشئ صيغًا بديلة جديدة ضمن الأمر الموحد، لكن النظام لن يستبدل القائمة الحالية تلقائيًا.',
  needsLsi
    ? '- أنشئ كلمات LSI المطلوبة في lsi.'
    : '- أنشئ كلمات LSI جديدة ضمن الأمر الموحد، لكن النظام لن يستبدل القائمة الحالية تلقائيًا.',
  '- أنشئ دائمًا googleTitles وgoogleDescriptions كاملتين حتى تكون استجابة الأمر الهندسي موحدة.',
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
