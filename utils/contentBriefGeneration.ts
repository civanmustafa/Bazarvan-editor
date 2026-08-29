import type { GoalContext } from '../types.ts';
import { renderPromptTemplateVariables } from '../constants/promptTemplateRenderer.ts';

type ContentBriefInput = {
  title: string;
  primaryKeyword: string;
  alternativeKeywords: string[];
  articleLanguage: 'ar' | 'en';
  goalContext: Partial<GoalContext> | null | undefined;
};

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseJsonValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
  ];
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue to the next safe candidate.
    }
  }
  return null;
};

export const buildContentBriefPrompt = (
  input: ContentBriefInput,
  template: string,
): string => {
  const normalizedGoalContext = isRecord(input.goalContext) ? input.goalContext : {};
  const {
    generatedBrief: existingGeneratedBrief,
    ...manualChoices
  } = normalizedGoalContext;
  return renderPromptTemplateVariables(template, {
    article_title: toText(input.title) || 'غير محدد',
    primary_keyword: toText(input.primaryKeyword) || 'غير محددة',
    alternative_keywords: input.alternativeKeywords.map(toText).filter(Boolean).join(', ') || 'غير محددة',
    article_language: input.articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية',
    manual_choices_json: JSON.stringify(manualChoices, null, 2),
    existing_generated_brief: toText(existingGeneratedBrief) || 'لا يوجد موجز مولد سابق.',
  });
};

export const parseContentBriefText = (rawResponse: string): string => {
  const parsed = parseJsonValue(rawResponse);
  const readCandidate = (value: unknown): string => toText(value);
  let candidate = '';

  if (typeof parsed === 'string') {
    candidate = readCandidate(parsed);
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>;
    const nested = root.result && typeof root.result === 'object' && !Array.isArray(root.result)
      ? root.result as Record<string, unknown>
      : {};
    candidate = [
      root.briefText,
      root.generatedBrief,
      root.contentBrief,
      root.brief,
      root.summary,
      nested.briefText,
      nested.generatedBrief,
      nested.contentBrief,
      nested.brief,
      nested.summary,
    ].map(readCandidate).find(Boolean) || '';
  }

  if (!candidate) {
    const plainResponse = rawResponse
      .replace(/^```(?:json|markdown|text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (plainResponse && !plainResponse.startsWith('{') && !plainResponse.startsWith('[')) {
      candidate = plainResponse;
    }
  }

  return candidate.slice(0, 12_000);
};
