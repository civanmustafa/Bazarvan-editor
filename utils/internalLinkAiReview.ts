import type {
  InternalLinkSuggestion,
  InternalLinkTargetPage,
} from './internalLinkingEngine.ts';
import {
  INTERNAL_LINK_ANCHOR_MAX_WORDS,
  INTERNAL_LINK_ANCHOR_MIN_WORDS,
  normalizeInternalLinkQualityPolicy,
  type InternalLinkQualityPolicyValues,
} from './internalLinkQualityPolicy.ts';

export const INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES = 5;

export type InternalLinkAiReviewStatus = 'approved' | 'caution' | 'rejected';

export type InternalLinkAiReviewCandidate = {
  pageId: string;
  targetUrl: string;
  targetTitle: string;
  paragraphNumber: number;
  paragraphText: string;
  allowedAnchorTexts: string[];
  currentAnchorText: string;
  algorithm: {
    version: InternalLinkSuggestion['algorithmVersion'];
    score: number;
    confidence: InternalLinkSuggestion['confidence'];
    bm25Score: number;
    completenessScore: number;
    matchedTerms: string[];
    reasons: string[];
  };
  targetPage: {
    metaDescription: string;
    h1: string;
    h2: string[];
    h3: string[];
    language: string;
  };
};

export type InternalLinkAiReview = {
  pageId: string;
  status: InternalLinkAiReviewStatus;
  selectedAnchorText: string;
  reason: string;
  anchorWasAdjusted: boolean;
};

export type InternalLinkAiReviewPrompt = {
  prompt: string;
  candidates: InternalLinkAiReviewCandidate[];
};

const boundedText = (value: unknown, maximum: number): string => (
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maximum)
    : ''
);

const uniqueBoundedStrings = (
  values: unknown,
  maximumItems: number,
  maximumChars: number,
): string[] => {
  if (!Array.isArray(values)) return [];
  const unique = new Set<string>();
  for (const item of values) {
    const value = boundedText(item, maximumChars);
    if (!value || unique.has(value)) continue;
    unique.add(value);
    if (unique.size >= maximumItems) break;
  }
  return [...unique];
};

const resolveParagraphText = (
  articleText: string,
  paragraphNumber: number,
  fallback: string,
): string => {
  const paragraphs = articleText
    .split(/(?:\r?\n)+/)
    .map(value => value.trim())
    .filter(Boolean);
  return boundedText(paragraphs[paragraphNumber - 1] || fallback, 2_000);
};

const createAllowedAnchorTexts = (
  suggestion: InternalLinkSuggestion,
  paragraphText: string,
): string[] => {
  const anchors = [
    suggestion.anchorText,
    ...suggestion.alternativeAnchors,
  ];
  const unique = new Set<string>();
  for (const anchor of anchors) {
    const value = boundedText(anchor, 180);
    if (!value || unique.has(value)) continue;
    if (!paragraphText.includes(value)) continue;
    unique.add(value);
    if (unique.size >= 8) break;
  }
  return [...unique];
};

export const createInternalLinkAiReviewCandidates = (input: {
  articleText: string;
  suggestions: InternalLinkSuggestion[];
  pages: InternalLinkTargetPage[];
}): InternalLinkAiReviewCandidate[] => {
  const pagesById = new Map(input.pages.map(page => [page.id, page]));
  return input.suggestions
    .slice(0, INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES)
    .flatMap(suggestion => {
      const page = pagesById.get(suggestion.pageId);
      if (!page) return [];
      const paragraphText = resolveParagraphText(
        input.articleText,
        suggestion.paragraphNumber,
        suggestion.sourceExcerpt,
      );
      const allowedAnchorTexts = createAllowedAnchorTexts(suggestion, paragraphText);
      if (allowedAnchorTexts.length === 0) return [];
      const currentAnchorText = allowedAnchorTexts.includes(suggestion.anchorText)
        ? suggestion.anchorText
        : allowedAnchorTexts[0];
      return [{
        pageId: suggestion.pageId,
        targetUrl: boundedText(suggestion.targetUrl, 2_000),
        targetTitle: boundedText(suggestion.targetTitle, 500),
        paragraphNumber: suggestion.paragraphNumber,
        paragraphText,
        allowedAnchorTexts,
        currentAnchorText,
        algorithm: {
          version: suggestion.algorithmVersion,
          score: suggestion.score,
          confidence: suggestion.confidence,
          bm25Score: suggestion.bm25Score,
          completenessScore: suggestion.completenessScore,
          matchedTerms: uniqueBoundedStrings(suggestion.matchedTerms, 10, 100),
          reasons: uniqueBoundedStrings(suggestion.reasons, 10, 180),
        },
        targetPage: {
          metaDescription: boundedText(page.metaDescription, 700),
          h1: boundedText(page.h1, 500),
          h2: uniqueBoundedStrings(page.h2, 20, 500),
          h3: uniqueBoundedStrings(page.h3, 20, 500),
          language: boundedText(page.pageLanguage, 30),
        },
      }];
    });
};

export const buildInternalLinkAiReviewPrompt = (input: {
  articleTitle: string;
  articleLanguage?: string;
  articleText: string;
  suggestions: InternalLinkSuggestion[];
  pages: InternalLinkTargetPage[];
  qualityPolicy?: Partial<InternalLinkQualityPolicyValues> | null;
  promptTemplate: string;
}): InternalLinkAiReviewPrompt => {
  const candidates = createInternalLinkAiReviewCandidates(input);
  if (candidates.length === 0) {
    throw new Error('لا توجد اقتراحات خوارزمية صالحة لإرسالها إلى المراجعة الاختيارية.');
  }
  const qualityPolicy = normalizeInternalLinkQualityPolicy(input.qualityPolicy);
  const qualityRules = {
    minimumScore: qualityPolicy.minimumScore,
    maxLinksPer1000Words: qualityPolicy.maxLinksPer1000Words,
    absoluteMaximumLinks: qualityPolicy.absoluteMaximumLinks,
    maximumLinksPerTarget: qualityPolicy.maximumLinksPerTarget,
    minimumMatchedTerms: qualityPolicy.minimumMatchedTerms,
    anchorWordRange: {
      minimum: INTERNAL_LINK_ANCHOR_MIN_WORDS,
      maximum: INTERNAL_LINK_ANCHOR_MAX_WORDS,
    },
    forbiddenAnchors: qualityPolicy.forbiddenAnchors,
    fixedRules: [
      'مصدر الصفحات هو مركز العميل وموقعه العام فقط.',
      'لا تُقبل صفحة غير موجودة ضمن المرشحين المرفقين.',
      'لا يُقبل نص رابط غير موجود حرفيًا ضمن allowedAnchorTexts.',
      'نتيجة الذكاء الاصطناعي استشارية ولا تُطبق تلقائيًا.',
    ],
  };
  const template = input.promptTemplate;
  if (!template.trim()) {
    throw new Error('أمر مراجعة الربط الداخلي غير متوفر في إعدادات الأوامر الهندسية.');
  }
  const variables = {
    article_title: boundedText(input.articleTitle, 500) || 'مقالة بلا عنوان',
    article_language: boundedText(input.articleLanguage, 30) || 'ar',
    candidate_suggestions_json: JSON.stringify(candidates, null, 2),
    quality_rules_json: JSON.stringify(qualityRules, null, 2),
  };
  return {
    candidates,
    prompt: Object.entries(variables).reduce((result, [key, value]) => (
      result.replaceAll(`{{${key}}}`, value)
    ), template),
  };
};

const stripJsonFence = (raw: string): string => {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || trimmed;
};

const parseJsonPayload = (raw: string): unknown => {
  const source = stripJsonFence(raw);
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('لم تُرجع المراجعة استجابة JSON صالحة.');
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      throw new Error('لم تُرجع المراجعة استجابة JSON صالحة.');
    }
  }
};

const REVIEW_STATUSES = new Set<InternalLinkAiReviewStatus>([
  'approved',
  'caution',
  'rejected',
]);

export const parseInternalLinkAiReviewResponse = (
  raw: string,
  candidates: InternalLinkAiReviewCandidate[],
): InternalLinkAiReview[] => {
  const payload = parseJsonPayload(raw);
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const reviews = Array.isArray(record.reviews) ? record.reviews : [];
  const candidatesById = new Map(candidates.map(candidate => [candidate.pageId, candidate]));
  const seen = new Set<string>();
  const validated: InternalLinkAiReview[] = [];

  for (const item of reviews) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const review = item as Record<string, unknown>;
    const pageId = boundedText(review.pageId, 200);
    const candidate = candidatesById.get(pageId);
    if (!candidate || seen.has(pageId)) continue;
    const status = boundedText(review.status, 30) as InternalLinkAiReviewStatus;
    if (!REVIEW_STATUSES.has(status)) continue;
    const requestedAnchor = boundedText(review.selectedAnchorText, 180);
    const anchorWasAdjusted = !candidate.allowedAnchorTexts.includes(requestedAnchor);
    const selectedAnchorText = anchorWasAdjusted
      ? candidate.currentAnchorText
      : requestedAnchor;
    const reason = boundedText(review.reason, 280)
      || 'لم تُرفق المراجعة سببًا واضحًا.';
    validated.push({
      pageId,
      status,
      selectedAnchorText,
      reason: anchorWasAdjusted
        ? `${reason} تم تجاهل نص ربط غير موجود في القائمة المسموح بها.`
        : reason,
      anchorWasAdjusted,
    });
    seen.add(pageId);
    if (validated.length >= INTERNAL_LINK_AI_REVIEW_MAX_CANDIDATES) break;
  }

  if (validated.length === 0) {
    throw new Error('لم تتضمن استجابة المراجعة أي نتيجة مطابقة للاقتراحات الخوارزمية المرسلة.');
  }
  return validated;
};
