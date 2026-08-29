const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/**
 * Canonical normalization for Arabic/English search, signatures, and matching.
 * Keep this function deterministic: persisted semantic signatures depend on it.
 */
export const normalizeArabicEnglishText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(ARABIC_DIACRITICS, '')
  .replace(/\u0640/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CORE_STOP_WORD_VALUES = [
  'في', 'من', 'الى', 'إلى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'او', 'أو', 'ام', 'أم',
  'بل', 'لا', 'نعم', 'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'هو', 'هي', 'هم', 'هن', 'هذا', 'هذه',
  'ذلك', 'تلك', 'الذي', 'التي', 'الذين', 'كان', 'كانت', 'يكون', 'تكون', 'يتم', 'تم', 'قد',
  'لقد', 'ان', 'إن', 'أن', 'كما', 'كل', 'اي', 'أي', 'غير', 'ما', 'ماذا', 'كيف', 'عند',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by',
  'at', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'these', 'those', 'it',
  'its', 'you', 'your', 'we', 'our',
];

/** Shared stop words used by both semantic indexing and internal-link matching. */
export const CORE_ARABIC_ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set(
  CORE_STOP_WORD_VALUES.map(normalizeArabicEnglishText),
);

const CLIENT_SEMANTIC_EXTRA_STOP_WORD_VALUES = [
  'بعد', 'قبل', 'بين', 'ضمن', 'حول',
];

/**
 * The semantic index historically excluded a few extra positional words.
 * Keeping the explicit profile preserves existing signatures and ranking while
 * sharing the canonical core list with internal linking.
 */
export const CLIENT_SEMANTIC_STOP_WORDS: ReadonlySet<string> = new Set([
  ...CORE_ARABIC_ENGLISH_STOP_WORDS,
  ...CLIENT_SEMANTIC_EXTRA_STOP_WORD_VALUES.map(normalizeArabicEnglishText),
]);
