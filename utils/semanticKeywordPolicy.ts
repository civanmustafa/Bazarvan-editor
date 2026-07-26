import { renderPromptTemplate } from '../constants/promptRegistry';

export type SemanticKeywordInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  primaryKeyword: string;
  companyName: string;
  existingSecondaries: string[];
  existingLsi: string[];
  goalContext: Record<string, unknown>;
};

export type SemanticKeywordTerms = {
  title: string;
  secondaries: string[];
  lsi: string[];
};

export type SemanticKeywordConstraints = {
  numbers: string[];
  locations: string[];
  nationalities: string[];
  qualifiers: string[];
};

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const QUALIFIER_MARKERS = new Set([
  'مدينة', 'دولة', 'محافظة', 'مقاطعة', 'ولاية', 'اقليم', 'منطقة',
  'city', 'country', 'province', 'county', 'state', 'region',
]);

const QUALIFIER_STOP_WORDS = new Set([
  'عن', 'من', 'الى', 'عبر', 'مع', 'لدى', 'حسب', 'افضل', 'احسن', 'best', 'top',
  'for', 'with', 'near', 'and', 'or',
]);

const KNOWN_GEOGRAPHIC_QUALIFIERS = [
  'المملكة العربية السعودية', 'السعودية', 'الامارات العربية المتحدة', 'الامارات',
  'العراق', 'سوريا', 'مصر', 'الاردن', 'لبنان', 'فلسطين', 'قطر', 'الكويت',
  'البحرين', 'عمان', 'اليمن', 'تركيا', 'المغرب', 'الجزائر', 'تونس', 'ليبيا',
  'السودان', 'الخليج العربي', 'الخليج', 'الشرق الاوسط',
  'الرياض', 'جدة', 'مكة', 'المدينة المنورة', 'الدمام', 'الخبر', 'دبي',
  'ابوظبي', 'الشارقة', 'عجمان', 'بغداد', 'اربيل', 'البصرة', 'دمشق', 'حلب',
  'القاهرة', 'الاسكندرية', 'عمان', 'بيروت', 'اسطنبول', 'انقرة', 'انطاليا',
  'الدوحة', 'مدينة الكويت', 'مسقط', 'صنعاء', 'الرباط', 'الدار البيضاء',
  'الجزائر العاصمة', 'تونس العاصمة', 'طرابلس', 'الخرطوم',
  'saudi arabia', 'united arab emirates', 'uae', 'iraq', 'syria', 'egypt',
  'jordan', 'lebanon', 'palestine', 'qatar', 'kuwait', 'bahrain', 'oman',
  'yemen', 'turkey', 'türkiye', 'morocco', 'algeria', 'tunisia', 'libya',
  'sudan', 'middle east', 'riyadh', 'jeddah', 'mecca', 'medina', 'dammam',
  'khobar', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'baghdad', 'erbil',
  'basra', 'damascus', 'aleppo', 'cairo', 'alexandria', 'amman', 'beirut',
  'istanbul', 'ankara', 'antalya', 'doha', 'kuwait city', 'muscat', 'sanaa',
  'rabat', 'casablanca', 'algiers', 'tunis', 'tripoli', 'khartoum',
];

const KNOWN_NATIONALITY_QUALIFIERS = [
  'سعودي', 'سعودية', 'اماراتي', 'اماراتية', 'عراقي', 'عراقية', 'سوري', 'سورية',
  'مصري', 'مصرية', 'اردني', 'اردنية', 'لبناني', 'لبنانية', 'فلسطيني', 'فلسطينية',
  'قطري', 'قطرية', 'كويتي', 'كويتية', 'بحريني', 'بحرينية', 'عماني', 'عمانية',
  'يمني', 'يمنية', 'تركي', 'تركية', 'كردي', 'كردية', 'عربي', 'عربية',
  'خليجي', 'خليجية', 'مغربي', 'مغربية', 'جزائري', 'جزائرية', 'تونسي', 'تونسية',
  'ليبي', 'ليبية', 'سوداني', 'سودانية',
  'saudi', 'emirati', 'iraqi', 'syrian', 'egyptian', 'jordanian', 'lebanese',
  'palestinian', 'qatari', 'kuwaiti', 'bahraini', 'omani', 'yemeni', 'turkish',
  'kurdish', 'arab', 'gulf', 'moroccan', 'algerian', 'tunisian', 'libyan', 'sudanese',
];

const ARABIC_NATIONALITY_BASES = [
  'سعودي', 'اماراتي', 'عراقي', 'سوري', 'مصري', 'اردني', 'لبناني', 'فلسطيني',
  'قطري', 'كويتي', 'بحريني', 'عماني', 'يمني', 'تركي', 'كردي', 'عربي',
  'خليجي', 'مغربي', 'جزائري', 'تونسي', 'ليبي', 'سوداني',
];

const GENERIC_SEMANTIC_TERMS = new Set([
  'معلومات', 'نصائح', 'فوائد', 'مميزات', 'خدمات', 'حلول', 'خيارات',
  'دليل شامل', 'افضل خيار', 'تجربة مميزة',
  'information', 'tips', 'benefits', 'features', 'services', 'solutions',
  'options', 'complete guide', 'best option',
].map(value => normalizeSemanticKeywordText(value)));

const SEMANTIC_STOP_WORDS = new Set([
  'في', 'من', 'عن', 'علي', 'الى', 'مع', 'و', 'او', 'ال', 'ل', 'ب',
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
].map(value => normalizeSemanticKeywordText(value)));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

function normalizeDigits(value: string): string {
  return Array.from(value).map((character) => {
    const arabicIndex = ARABIC_DIGITS.indexOf(character);
    if (arabicIndex >= 0) return String(arabicIndex);
    const persianIndex = PERSIAN_DIGITS.indexOf(character);
    return persianIndex >= 0 ? String(persianIndex) : character;
  })
  .join('');
}

export function normalizeSemanticKeywordText(value: string): string {
  return normalizeDigits(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}\s.,٫]+/gu, ' ')
    .replace(/[.,٫]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const extractNumbers = (value: string): string[] => Array.from(new Set(
  normalizeDigits(value)
    .match(/\p{N}+(?:[.,٫]\p{N}+)?/gu)
    ?.map(number => number.replace('٫', '.').replace(',', '.')) || [],
));

const containsPhrase = (value: string, phrase: string): boolean => {
  const normalizedValue = normalizeSemanticKeywordText(value);
  const normalizedPhrase = normalizeSemanticKeywordText(phrase);
  if (!normalizedPhrase) return false;
  if (` ${normalizedValue} `.includes(` ${normalizedPhrase} `)) return true;
  if (!/[\u0600-\u06FF]/u.test(normalizedPhrase)) return false;

  const valueTokens = normalizedValue.split(' ');
  const phraseTokens = normalizedPhrase.split(' ');
  return valueTokens.some((token, index) => {
    const firstPhraseToken = phraseTokens[0];
    const firstMatches = token === firstPhraseToken
      || (
        token.length === firstPhraseToken.length + 1
        && /^[ولبكف]/u.test(token)
        && token.slice(1) === firstPhraseToken
      );
    if (!firstMatches) return false;
    return phraseTokens.slice(1).every(
      (phraseToken, offset) => valueTokens[index + offset + 1] === phraseToken,
    );
  });
};

const uniquePhrases = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeSemanticKeywordText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const stripArabicWordPrefixes = (value: string): string => {
  if (value.startsWith('لل')) return value.slice(2);
  let result = value;
  if (/^[ولبكف]/u.test(result)) result = result.slice(1);
  if (result.startsWith('ال')) result = result.slice(2);
  return result;
};

const canonicalizeArabicNationality = (value: string): string => {
  const normalized = normalizeSemanticKeywordText(value);
  if (!normalized || normalized.includes(' ')) return '';
  const unprefixed = stripArabicWordPrefixes(normalized);
  return ARABIC_NATIONALITY_BASES.find(base => (
    unprefixed === base
    || unprefixed === `${base}ة`
    || unprefixed === `${base}ه`
    || unprefixed === `${base}ون`
    || unprefixed === `${base}ين`
    || unprefixed === `${base}ات`
  )) || '';
};

const isNationalityQualifier = (value: string): boolean => {
  if (canonicalizeArabicNationality(value)) return true;
  const normalized = normalizeSemanticKeywordText(value);
  return KNOWN_NATIONALITY_QUALIFIERS.some(
    qualifier => normalizeSemanticKeywordText(qualifier) === normalized,
  );
};

const detectNationalityQualifiers = (primaryKeyword: string): string[] => (
  normalizeSemanticKeywordText(primaryKeyword)
    .split(' ')
    .map(canonicalizeArabicNationality)
    .filter(Boolean)
);

const detectMarkerQualifiers = (primaryKeyword: string): string[] => {
  const tokens = normalizeSemanticKeywordText(primaryKeyword).split(' ').filter(Boolean);
  const detected: string[] = [];

  tokens.forEach((token, index) => {
    if (!QUALIFIER_MARKERS.has(token)) return;
    const nextIndex = QUALIFIER_MARKERS.has(tokens[index + 1])
      ? index + 2
      : index + 1;
    const next = tokens[nextIndex];
    if (!next || QUALIFIER_STOP_WORDS.has(next) || /^\d/.test(next)) return;
    const following = tokens[nextIndex + 1];
    const phrase = following && !QUALIFIER_STOP_WORDS.has(following) && !QUALIFIER_MARKERS.has(following)
      ? `${next} ${following}`
      : next;
    detected.push(phrase);
  });

  return detected;
};

const getGoalContextQualifier = (goalContext: Record<string, unknown>): string => (
  toTrimmedString(goalContext.targetCountry)
  || toTrimmedString(goalContext.targetLocation)
  || toTrimmedString(goalContext.market)
);

export const getSemanticKeywordConstraints = (
  input: SemanticKeywordInput,
  modelQualifiers: string[] = [],
): SemanticKeywordConstraints => {
  const primaryKeyword = input.primaryKeyword.trim();
  const primaryNationalities = detectNationalityQualifiers(primaryKeyword);
  const dictionaryLocations = KNOWN_GEOGRAPHIC_QUALIFIERS
    .filter(qualifier => containsPhrase(primaryKeyword, qualifier));
  const dictionaryNationalities = KNOWN_NATIONALITY_QUALIFIERS
    .filter(qualifier => containsPhrase(primaryKeyword, qualifier))
    .map(qualifier => canonicalizeArabicNationality(qualifier) || qualifier);
  const goalQualifier = getGoalContextQualifier(input.goalContext);
  const verifiedModelQualifiers = modelQualifiers
    .map(value => value.trim())
    .filter(value => normalizeSemanticKeywordText(value).length >= 2)
    .filter(value => (
      containsPhrase(primaryKeyword, value)
      || primaryNationalities.includes(canonicalizeArabicNationality(value))
    ))
    .map(value => canonicalizeArabicNationality(value) || value);
  const verifiedModelLocations = verifiedModelQualifiers.filter(
    qualifier => !isNationalityQualifier(qualifier),
  );
  const verifiedModelNationalities = verifiedModelQualifiers.filter(isNationalityQualifier);
  const locations = uniquePhrases([
    ...dictionaryLocations,
    ...detectMarkerQualifiers(primaryKeyword),
    ...(goalQualifier && containsPhrase(primaryKeyword, goalQualifier) ? [goalQualifier] : []),
    ...verifiedModelLocations,
  ]);
  const nationalities = uniquePhrases([
    ...dictionaryNationalities,
    ...primaryNationalities,
    ...verifiedModelNationalities,
  ]);

  return {
    numbers: extractNumbers(primaryKeyword),
    locations,
    nationalities,
    qualifiers: uniquePhrases([...locations, ...nationalities]),
  };
};

const formatProtectedConstraints = (constraints: SemanticKeywordConstraints): string => [
  constraints.numbers.length
    ? `- قيد الرقم نشط لأن الكلمة الأساسية تحتوي: ${constraints.numbers.join('، ')}. حافظ عليه في كل صيغة بديلة دون تغيير أو إضافة رقم آخر.`
    : '- قيد الرقم غير نشط لأن الكلمة الأساسية لا تحتوي رقمًا؛ لا يلزم إدخال رقم في الصيغ، ويُمنع اختراع رقم أو سنة.',
  constraints.locations.length
    ? `- قيد الموقع نشط لأن الكلمة الأساسية تحتوي: ${constraints.locations.join('، ')}. حافظ عليه في كل صيغة بديلة.`
    : '- قيد الموقع غير نشط؛ لا يلزم إدخال دولة أو مدينة أو منطقة في الصيغ.',
  constraints.nationalities.length
    ? `- قيد القومية نشط لأن الكلمة الأساسية تحتوي: ${constraints.nationalities.join('، ')}. حافظ عليها في كل صيغة بديلة بصيغتها أو تصريفها الصحيح.`
    : '- قيد القومية غير نشط؛ لا يلزم إدخال قومية أو نسبة جغرافية في الصيغ.',
  '- طبّق فقط القيود النشطة أعلاه؛ قد يكون النشط قيدًا واحدًا أو قيدين أو القيود الثلاثة وفق الكلمة الأساسية.',
  '- هذه القيود تخص الصيغ البديلة فقط، ولا يُشترط تكرار الرقم أو الموقع أو القومية داخل كلمات LSI.',
].join('\n');

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength).trim()}\n\n[تم اختصار مقتطف المقالة.]`;
};

export const renderSemanticKeywordPrompt = (
  input: SemanticKeywordInput,
  template: string,
): string => {
  const constraints = getSemanticKeywordConstraints(input);
  return renderPromptTemplate(template, {
    primary_keyword: input.primaryKeyword.trim(),
    company_name: input.companyName.trim() || '-',
    article_title: input.title.trim() || '-',
    article_language: input.articleLanguage === 'en' ? 'الإنجليزية' : 'العربية',
    goal_context: JSON.stringify(input.goalContext || {}, null, 2),
    existing_alternative_keywords: input.existingSecondaries.join('، ') || '-',
    existing_lsi_keywords: input.existingLsi.join('، ') || '-',
    protected_constraints: formatProtectedConstraints(constraints),
    article_excerpt: truncateText(input.plainText, 12_000) || '-',
  });
};

export const buildSemanticKeywordRepairPrompt = (
  input: SemanticKeywordInput,
  template: string,
  previousResponse: string,
): string => [
  renderSemanticKeywordPrompt(input, template),
  '',
  'الرد السابق لم يحقق عدد النتائج أو خالف قيدًا نشطًا من القيود المذكورة أعلاه.',
  'صححه مرة واحدة، وطبّق فقط ما اكتشفه النظام فعلًا من رقم أو موقع أو قومية داخل الكلمة الأساسية.',
  '<previous_response>',
  truncateText(previousResponse, 4_000),
  '</previous_response>',
  'أرجع كائن JSON المصحح فقط.',
].join('\n');

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (isRecord(value)) {
    return toStringList(
      value.term
      ?? value.text
      ?? value.keyword
      ?? value.value
      ?? value.name
      ?? value.label,
    );
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n\r,;\u060C\u061B|*\/#]+|\s+-\s+/g)
    .map(item => item.replace(/^[-•*]\s*/, '').replace(/[.,;\u060C\u061B]+$/g, '').trim())
    .filter(Boolean);
};

const firstList = (source: unknown, keys: string[]): string[] => {
  if (!isRecord(source)) return [];
  for (const key of keys) {
    const values = toStringList(source[key]);
    if (values.length > 0) return values;
  }
  return [];
};

const extractJsonRecord = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const source = fenced || trimmed;

  try {
    const parsed = JSON.parse(source);
    return isRecord(parsed) ? parsed : {};
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return {};
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
};

const getSemanticTokens = (value: string): string[] => normalizeSemanticKeywordText(value)
  .split(' ')
  .filter(token => token.length > 2 && !SEMANTIC_STOP_WORDS.has(token));

const hasProtectedSemanticOverlap = (term: string, protectedTerms: string[]): boolean => {
  const normalizedTerm = normalizeSemanticKeywordText(term);
  if (!normalizedTerm) return true;

  return protectedTerms.some((protectedTerm) => {
    const normalizedProtected = normalizeSemanticKeywordText(protectedTerm);
    if (!normalizedProtected) return false;
    if (normalizedTerm === normalizedProtected) return true;
    if (containsPhrase(normalizedTerm, normalizedProtected) || containsPhrase(normalizedProtected, normalizedTerm)) {
      return true;
    }

    const termTokens = new Set(normalizedTerm.split(' '));
    return getSemanticTokens(protectedTerm).some(token => termTokens.has(token));
  });
};

const uniqueTerms = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values
    .map(value => value.replace(/[.،,;؛]+$/g, '').trim())
    .filter((value) => {
      const key = normalizeSemanticKeywordText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const respectsProtectedConstraints = (
  term: string,
  constraints: SemanticKeywordConstraints,
): boolean => {
  const termNumbers = extractNumbers(term);
  if (
    constraints.numbers.some(number => !termNumbers.includes(number))
    || termNumbers.some(number => !constraints.numbers.includes(number))
  ) {
    return false;
  }
  return constraints.qualifiers.every((qualifier) => {
    const nationality = canonicalizeArabicNationality(qualifier);
    if (!nationality) return containsPhrase(term, qualifier);
    return normalizeSemanticKeywordText(term)
      .split(' ')
      .some(token => canonicalizeArabicNationality(token) === nationality);
  });
};

export const parseSemanticKeywordTerms = (
  responseText: string,
  input: SemanticKeywordInput,
): SemanticKeywordTerms => {
  const source = extractJsonRecord(responseText);
  const nestedKeywords = isRecord(source.keywords) ? source.keywords : {};
  const semantic = isRecord(source.semantic) ? source.semantic : {};
  const seo = isRecord(source.seo) ? source.seo : {};
  const modelQualifiers = firstList(source, [
    'protectedQualifiers',
    'protected_qualifiers',
    'qualifiers',
  ]);
  const constraints = getSemanticKeywordConstraints(input, modelQualifiers);
  const secondaryKeys = ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms'];
  const lsiKeys = ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms'];

  const secondaries = uniqueTerms([
    ...firstList(source, secondaryKeys),
    ...firstList(nestedKeywords, secondaryKeys),
    ...firstList(semantic, secondaryKeys),
    ...firstList(seo, secondaryKeys),
  ])
    .filter(term => normalizeSemanticKeywordText(term) !== normalizeSemanticKeywordText(input.primaryKeyword))
    .filter(term => !hasProtectedSemanticOverlap(term, [input.companyName]))
    .filter(term => respectsProtectedConstraints(term, constraints))
    .slice(0, 6);

  const lsiProtectedTerms = [input.primaryKeyword, input.companyName, ...secondaries].filter(Boolean);
  const lsi = uniqueTerms([
    ...firstList(source, lsiKeys),
    ...firstList(nestedKeywords, lsiKeys),
    ...firstList(semantic, lsiKeys),
    ...firstList(seo, lsiKeys),
  ])
    .filter(term => !hasProtectedSemanticOverlap(term, lsiProtectedTerms))
    .filter(term => !GENERIC_SEMANTIC_TERMS.has(normalizeSemanticKeywordText(term)))
    .slice(0, 16);

  return {
    title: toTrimmedString(source.title),
    secondaries,
    lsi,
  };
};

export const hasUsableSemanticKeywordTerms = (
  terms: Pick<SemanticKeywordTerms, 'secondaries' | 'lsi'>,
  needsSecondaries: boolean,
  needsLsi: boolean,
): boolean => (
  (!needsSecondaries || terms.secondaries.length >= 4)
  && (!needsLsi || terms.lsi.length >= 10)
);

export const describeSemanticKeywordValidationFailure = (
  terms: Pick<SemanticKeywordTerms, 'secondaries' | 'lsi'>,
  input: SemanticKeywordInput,
  needsSecondaries = true,
  needsLsi = true,
): string => {
  const constraints = getSemanticKeywordConstraints(input);
  const shortages = [
    needsSecondaries && terms.secondaries.length < 4
      ? `الصيغ البديلة الصالحة ${terms.secondaries.length}/4`
      : '',
    needsLsi && terms.lsi.length < 10
      ? `كلمات LSI الصالحة ${terms.lsi.length}/10`
      : '',
  ].filter(Boolean);
  const activeConstraints = [
    constraints.numbers.length ? `الرقم (${constraints.numbers.join('، ')})` : '',
    constraints.locations.length ? `الموقع (${constraints.locations.join('، ')})` : '',
    constraints.nationalities.length ? `القومية (${constraints.nationalities.join('، ')})` : '',
  ].filter(Boolean);
  const constraintSummary = activeConstraints.length
    ? `القيود النشطة المستخرجة من الكلمة الأساسية فقط: ${activeConstraints.join('، ')}.`
    : 'لم يُكتشف في الكلمة الأساسية رقم أو موقع أو قومية إلزامية.';

  return `لم تُعتمد نتيجة التوليد: ${shortages.join('، ') || 'النتيجة غير مكتملة'}. ${constraintSummary} لا تُفرض هذه القيود على كلمات LSI. حاول مرة أخرى.`;
};
