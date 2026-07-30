export const CLIENT_LINK_PHRASE_PROFILE_VERSION = 1;
export const CLIENT_LINK_AI_EXCERPT_MAX_CHARACTERS = 24_000;

export type ClientLinkProfileGenerationStatus = 'pending' | 'ready' | 'skipped' | 'failed';
export type ClientLinkProfileReviewStatus = 'pending' | 'approved' | 'rejected';
export type ClientLinkPageIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational'
  | 'local'
  | 'mixed';

export type ClientPageAiLinkProfile = {
  pageId: string;
  clientId: string;
  profileVersion: number;
  sourceSignature: string;
  generationStatus: ClientLinkProfileGenerationStatus;
  reviewStatus: ClientLinkProfileReviewStatus;
  primaryPhrase: string;
  alternativePhrases: string[];
  longTailPhrases: string[];
  relatedEntities: string[];
  negativePhrases: string[];
  pageIntent: ClientLinkPageIntent | '';
  confidence: number;
  provider: string;
  model: string;
  errorCode: string;
  errorMessage: string;
  generatedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedClientLinkPhraseProfile = {
  primaryPhrase: string;
  alternativePhrases: string[];
  longTailPhrases: string[];
  relatedEntities: string[];
  negativePhrases: string[];
  pageIntent: ClientLinkPageIntent;
  confidence: number;
};

const INTENTS = new Set<ClientLinkPageIntent>([
  'informational',
  'commercial',
  'transactional',
  'navigational',
  'local',
  'mixed',
]);

const GENERIC_PHRASES = new Set([
  'اضغط هنا',
  'اعرف المزيد',
  'معرفة المزيد',
  'اقرأ المزيد',
  'المزيد',
  'هذه الصفحة',
  'هذا الرابط',
  'هنا',
  'click here',
  'learn more',
  'read more',
]);

const normalizeComparablePhrase = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
  .replace(/\u0640/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const cleanPhrase = (value: unknown, maximumLength = 160): string => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`«»]+|["'`«»]+$/g, '')
    .trim()
    .slice(0, maximumLength);
  if (
    cleaned.length < 2
    || /(?:https?:\/\/|www\.|javascript:|data:)/i.test(cleaned)
    || GENERIC_PHRASES.has(normalizeComparablePhrase(cleaned))
  ) return '';
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > 0 && words.length <= 12 ? cleaned : '';
};

const normalizePhraseList = (
  value: unknown,
  maximumItems: number,
  excluded: Set<string> = new Set(),
): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set(excluded);
  const phrases: string[] = [];
  for (const item of value) {
    const phrase = cleanPhrase(item);
    const comparable = normalizeComparablePhrase(phrase);
    if (!phrase || !comparable || seen.has(comparable)) continue;
    seen.add(comparable);
    phrases.push(phrase);
    if (phrases.length >= maximumItems) break;
  }
  return phrases;
};

const parseJsonRecord = (text: string): Record<string, unknown> | null => {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
};

export const parseGeneratedClientLinkPhraseProfile = (
  responseText: string,
  fallbackPrimaryPhrase: string,
): GeneratedClientLinkPhraseProfile | null => {
  const source = parseJsonRecord(responseText);
  if (!source) return null;

  const primaryPhrase = cleanPhrase(source.primaryPhrase)
    || cleanPhrase(source.primary_phrase)
    || cleanPhrase(fallbackPrimaryPhrase);
  if (!primaryPhrase) return null;

  const primaryComparable = normalizeComparablePhrase(primaryPhrase);
  const alternativePhrases = normalizePhraseList(
    source.alternativePhrases ?? source.alternative_phrases,
    24,
    new Set([primaryComparable]),
  );
  const alternatives = new Set([
    primaryComparable,
    ...alternativePhrases.map(normalizeComparablePhrase),
  ]);
  const longTailPhrases = normalizePhraseList(
    source.longTailPhrases ?? source.long_tail_phrases,
    16,
    alternatives,
  );
  const relatedEntities = normalizePhraseList(
    source.relatedEntities ?? source.related_entities,
    20,
  );
  const negativePhrases = normalizePhraseList(
    source.negativePhrases ?? source.negative_phrases,
    16,
    new Set([
      ...alternatives,
      ...longTailPhrases.map(normalizeComparablePhrase),
    ]),
  );
  const rawIntent = typeof source.pageIntent === 'string'
    ? source.pageIntent
    : typeof source.page_intent === 'string'
      ? source.page_intent
      : '';
  const pageIntent = INTENTS.has(rawIntent as ClientLinkPageIntent)
    ? rawIntent as ClientLinkPageIntent
    : 'mixed';
  const rawConfidence = Number(source.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
    : 50;

  return {
    primaryPhrase,
    alternativePhrases,
    longTailPhrases,
    relatedEntities,
    negativePhrases,
    pageIntent,
    confidence,
  };
};

export const isClientPageAiLinkProfileActive = (
  profile: ClientPageAiLinkProfile | null | undefined,
): profile is ClientPageAiLinkProfile => Boolean(
  profile
  && profile.generationStatus === 'ready'
  && profile.reviewStatus !== 'rejected'
  && profile.primaryPhrase.trim()
  && (profile.reviewStatus === 'approved' || profile.confidence >= 70),
);
