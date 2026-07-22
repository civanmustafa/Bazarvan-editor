import type { GoalContext } from '../types';

export const CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION = 1;
export const CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE = 90;
export const CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES = 2;
export const CONTENT_WRITING_MAX_REPAIR_PASSES = 3;

export type ContentWritingCriterionSeverity = 'blocking' | 'important' | 'advisory';

export type ContentWritingQualityPolicy = {
  version: number;
  label: string;
  targetWords: { min: number; max: number };
  outlineSections: { min: number; max: number };
  questionH2Minimum: number;
  headingCharacters: {
    h2: { min: number; max: number };
    h3: { min: number; max: number };
    h4: { min: number; max: number };
  };
  introduction: {
    firstParagraphWords: { min: number; max: number };
    secondParagraphWords: { min: number; max: number };
    sentences: { min: number; max: number };
  };
  bodyParagraph: {
    words: { min: number; max: number };
    sentences: { min: number; max: number };
  };
  faqAnswer: {
    words: { min: number; max: number };
    sentences: { min: number; max: number };
  };
  conclusion: {
    words: { min: number; max: number };
    mustBeLastH2: boolean;
    requireList: boolean;
    requireNumber: boolean;
  };
  listIntroduction: {
    words: { min: number; max: number };
    sentences: { min: number; max: number };
    requiredEnding: string;
  };
  sentenceWords: { min: number; max: number };
  product: {
    minimumTables: number;
    requireUsageHeading: boolean;
    requireSpecificationsHeading: boolean;
    requireWarrantyContent: boolean;
  };
  criterionSeverity: Record<string, ContentWritingCriterionSeverity>;
  criterionWeights: Record<string, number>;
};

export type ContentWritingQualityConfiguration = {
  policyVersion: number;
  minimumScore: number;
  maxRepairPasses: number;
  policy: ContentWritingQualityPolicy;
};

const POLICY_V1: ContentWritingQualityPolicy = {
  version: 1,
  label: 'Bazarvan editorial policy v1',
  targetWords: { min: 1_100, max: 1_450 },
  // The editor's H2 count includes FAQ and conclusion, so five body sections
  // produce seven total H2 headings for a 1,100-1,450 word article.
  outlineSections: { min: 5, max: 5 },
  questionH2Minimum: 3,
  headingCharacters: {
    h2: { min: 40, max: 70 },
    h3: { min: 30, max: 60 },
    h4: { min: 20, max: 50 },
  },
  introduction: {
    firstParagraphWords: { min: 30, max: 60 },
    secondParagraphWords: { min: 40, max: 80 },
    sentences: { min: 2, max: 4 },
  },
  bodyParagraph: {
    words: { min: 30, max: 100 },
    sentences: { min: 1, max: 4 },
  },
  faqAnswer: {
    words: { min: 35, max: 75 },
    sentences: { min: 2, max: 3 },
  },
  conclusion: {
    words: { min: 70, max: 120 },
    mustBeLastH2: true,
    requireList: true,
    requireNumber: true,
  },
  listIntroduction: {
    words: { min: 15, max: 40 },
    sentences: { min: 1, max: 2 },
    requiredEnding: ': أو ؟',
  },
  sentenceWords: { min: 6, max: 20 },
  product: {
    minimumTables: 2,
    requireUsageHeading: true,
    requireSpecificationsHeading: true,
    requireWarrantyContent: true,
  },
  criterionSeverity: {
    'quality.targetWordRange': 'blocking',
    'quality.totalH2Count': 'blocking',
    wordCount: 'blocking',
    firstTitle: 'blocking',
    summaryParagraph: 'blocking',
    secondParagraph: 'blocking',
    h2Structure: 'blocking',
    h2Count: 'blocking',
    faqSection: 'blocking',
    answerParagraph: 'blocking',
    lastH2IsConclusion: 'blocking',
    conclusionWordCount: 'blocking',
    keywordStuffing: 'blocking',
    productUsageHeading: 'blocking',
    productTechnicalSpecsHeading: 'blocking',
    productWarrantyContent: 'blocking',
    tablesCount: 'blocking',
    'keyword.primary': 'blocking',
    'keyword.secondariesDistribution': 'important',
    'keyword.company': 'important',
    'keyword.lsiDistribution': 'important',
    'keyword.lsiBalance': 'important',
    paragraphLength: 'important',
    sentenceLength: 'important',
    headingLength: 'important',
    interrogativeH2: 'important',
    stepsIntroduction: 'important',
    punctuation: 'important',
    punctuationSpacing: 'important',
    repeatedBigrams: 'important',
    immediateDuplicateWords: 'important',
  },
  criterionWeights: {
    'quality.targetWordRange': 3,
    'quality.totalH2Count': 3,
    wordCount: 2,
    summaryParagraph: 2,
    secondParagraph: 2,
    h2Structure: 3,
    h2Count: 2,
    faqSection: 2,
    answerParagraph: 2,
    lastH2IsConclusion: 3,
    conclusionWordCount: 2,
    keywordStuffing: 3,
    paragraphLength: 2,
    sentenceLength: 2,
    headingLength: 2,
    interrogativeH2: 2,
    productUsageHeading: 2,
    productTechnicalSpecsHeading: 2,
    productWarrantyContent: 2,
    tablesCount: 2,
    'keyword.primary': 3,
    'keyword.secondariesDistribution': 2,
    'keyword.company': 2,
    'keyword.lsiDistribution': 2,
    'keyword.lsiBalance': 1,
  },
};

export const CONTENT_WRITING_QUALITY_POLICIES: Readonly<Record<number, ContentWritingQualityPolicy>> = {
  1: POLICY_V1,
};

export const CONTENT_WRITING_QUALITY_POLICY_VERSIONS = Object.keys(CONTENT_WRITING_QUALITY_POLICIES)
  .map(Number)
  .sort((left, right) => left - right);

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(Math.round(parsed), maximum))
    : fallback;
};

export const resolveContentWritingQualityPolicy = (value: unknown): ContentWritingQualityPolicy => {
  const version = boundedInteger(
    value,
    CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION,
    1,
    CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION,
  );
  return CONTENT_WRITING_QUALITY_POLICIES[version]
    || CONTENT_WRITING_QUALITY_POLICIES[CONTENT_WRITING_ACTIVE_QUALITY_POLICY_VERSION];
};

export const normalizeContentWritingQualityConfiguration = (value: {
  policyVersion?: unknown;
  minimumScore?: unknown;
  maxRepairPasses?: unknown;
} = {}): ContentWritingQualityConfiguration => {
  const policy = resolveContentWritingQualityPolicy(value.policyVersion);
  return {
    policyVersion: policy.version,
    minimumScore: boundedInteger(
      value.minimumScore,
      CONTENT_WRITING_DEFAULT_MINIMUM_QUALITY_SCORE,
      50,
      100,
    ),
    maxRepairPasses: boundedInteger(
      value.maxRepairPasses,
      CONTENT_WRITING_DEFAULT_MAX_REPAIR_PASSES,
      0,
      CONTENT_WRITING_MAX_REPAIR_PASSES,
    ),
    policy,
  };
};

const range = (value: { min: number; max: number }): string => (
  value.min === value.max ? String(value.min) : `${value.min}-${value.max}`
);

export const buildContentWritingQualityContract = (options: {
  configuration: ContentWritingQualityConfiguration;
  language: string;
  goalContext?: Partial<GoalContext>;
}): string => {
  const { policy } = options.configuration;
  const isArabic = options.language !== 'en';
  const isProduct = options.goalContext?.pageType === 'product';
  const lines = isArabic ? [
    `سياسة الجودة: الإصدار ${policy.version}.`,
    `استهدف ${range(policy.targetWords)} كلمة و${range(policy.outlineSections)} أقسام H2 للمتن.`,
    `أنشئ ${policy.questionH2Minimum} عناوين H2 استفهامية على الأقل، وطول كل H2 ${range(policy.headingCharacters.h2)} حرفًا.`,
    `المقدمة فقرتان: الأولى ${range(policy.introduction.firstParagraphWords)} كلمة، والثانية ${range(policy.introduction.secondParagraphWords)} كلمة، وكل فقرة ${range(policy.introduction.sentences)} جمل.`,
    `فقرات المتن ${range(policy.bodyParagraph.words)} كلمة و${range(policy.bodyParagraph.sentences)} جمل، والجملة ${range(policy.sentenceWords)} كلمة قدر الإمكان.`,
    'اجعل قسم H2 إما 80-150 كلمة بلا H3، أو 180-220 كلمة مع 2-3 عناوين H3 و3-5 فقرات.',
    `كل جواب FAQ فقرة من ${range(policy.faqAnswer.words)} كلمة و${range(policy.faqAnswer.sentences)} جمل.`,
    `ضع FAQ قبل الخاتمة، واجعل الخاتمة آخر H2 بطول ${range(policy.conclusion.words)} كلمة.`,
    `الخاتمة تبدأ بمؤشر ختامي، وتحتوي رقمًا وقائمة يسبقها تمهيد صحيح.`,
    `قبل كل قائمة ضع تمهيدًا من ${range(policy.listIntroduction.words)} كلمة و${range(policy.listIntroduction.sentences)} جمل وينتهي بـ${policy.listIntroduction.requiredEnding}.`,
    'وزّع الكلمات الأساسية والصيغ البديلة وLSI طبيعيًا وتجنب الحشو والنسخ والادعاءات غير المدعومة.',
  ] : [
    `Quality policy: version ${policy.version}.`,
    `Target ${range(policy.targetWords)} words and ${range(policy.outlineSections)} body H2 sections.`,
    `Use at least ${policy.questionH2Minimum} interrogative H2 headings; each H2 should be ${range(policy.headingCharacters.h2)} characters.`,
    `Use two introduction paragraphs: ${range(policy.introduction.firstParagraphWords)} and ${range(policy.introduction.secondParagraphWords)} words; each has ${range(policy.introduction.sentences)} sentences.`,
    `Body paragraphs should have ${range(policy.bodyParagraph.words)} words and ${range(policy.bodyParagraph.sentences)} sentences; aim for ${range(policy.sentenceWords)} words per sentence.`,
    'Make each H2 section either 80-150 words without H3, or 180-220 words with 2-3 H3 headings and 3-5 paragraphs.',
    `Each FAQ answer must have ${range(policy.faqAnswer.words)} words and ${range(policy.faqAnswer.sentences)} sentences.`,
    `Place FAQ before the conclusion; the conclusion must be the last H2 and contain ${range(policy.conclusion.words)} words.`,
    'The conclusion must start with a concluding indicator and include a number plus a properly introduced list.',
    `Every list needs a ${range(policy.listIntroduction.words)}-word, ${range(policy.listIntroduction.sentences)}-sentence introduction ending with a colon or question mark.`,
    'Distribute target terms naturally and avoid stuffing, copying, and unsupported claims.',
  ];

  if (isProduct) {
    lines.push(isArabic
      ? `هذه صفحة منتج: أضف عنوانًا للاستخدام، وعنوانًا للمواصفات، ومحتوى للضمان، و${policy.product.minimumTables} جدولين على الأقل.`
      : `This is a product page: include usage and specifications headings, warranty content, and at least ${policy.product.minimumTables} tables.`);
  }
  return lines.map(line => `- ${line}`).join('\n');
};
