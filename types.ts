

export type AnalysisStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface Keywords {
  primary: string;
  secondaries: string[];
  company: string;
  lsi: string[];
}

export interface GoalContext {
  pageType: string;
  objective: string;
  audienceScope: string;
  targetCountry: string;
  targetAudience: string;
  searchIntent: string;
}

export type ClientGoalContexts = Record<string, GoalContext>;

export interface AiAnalysisOptions {
  manualCommand: boolean;
  editorText: boolean;
  targetKeywords: boolean;
  companyName: boolean;
  goalContext: boolean;
  keywordCriteria: boolean;
  basicStructureCriteria: boolean;
  headingsSequenceCriteria: boolean;
  interactionCtaCriteria: boolean;
  conclusionCriteria: boolean;
}

export type EngineeringPromptSource = 'smartAnalysis' | 'toolbar';
export type EngineeringPromptId = string;
export type EngineeringPrompts = Record<EngineeringPromptId, string>;

export interface EngineeringPromptDefinition {
  id: EngineeringPromptId;
  source: EngineeringPromptSource;
  labelKey: string;
  defaultValue: string;
  variables?: string[];
  options?: Partial<AiAnalysisOptions>;
}

export interface KeywordCheck {
  text: string;
  isMet: boolean;
}

export interface KeywordStats {
  count: number;
  percentage: number;
  requiredCount: [number, number];
  requiredPercentage: [number, number];
  status: AnalysisStatus;
}

export interface PrimaryKeywordAnalysis extends KeywordStats {
  checks: KeywordCheck[];
}

export interface SecondaryKeywordAnalysis extends KeywordStats {
  checks: KeywordCheck[];
}

export interface CompanyNameAnalysis extends KeywordStats {}

export interface LsiKeywordAnalysis {
  distribution: KeywordStats;
  balance: CheckResult;
  keywords: {
      text: string;
      count: number;
      percentage: number;
  }[];
}

export interface KeywordAnalysis {
  primary: PrimaryKeywordAnalysis;
  secondaries: SecondaryKeywordAnalysis[];
  secondariesDistribution: KeywordStats;
  company: CompanyNameAnalysis;
  lsi: LsiKeywordAnalysis;
}

export interface CheckResult {
  title: string;
  description?: string;
  status: AnalysisStatus;
  current: string | number;
  required: string | number;
  progress: number; // Value from 0 to 1
  details?: string;
  violatingItems?: { 
    from: number; 
    to: number; 
    message: string; 
    sectionFrom?: number; 
    sectionTo?: number 
  }[];
}

export interface StructureAnalysis {
    wordCount: CheckResult;
    firstTitle: CheckResult;
    secondTitle: CheckResult;
    includesExcludes: CheckResult;
    preTravelH2: CheckResult;
    pricingH2: CheckResult;
    whoIsItForH2: CheckResult;
    summaryParagraph: CheckResult;
    secondParagraph: CheckResult;
    paragraphLength: CheckResult;
    tableListOpportunities: CheckResult;
    h2Structure: CheckResult;
    h2Count: CheckResult;
    h3Structure: CheckResult;
    h4Structure: CheckResult;
    betweenH2H3: CheckResult;
    faqSection: CheckResult;
    answerParagraph: CheckResult;
    ambiguousHeadings: CheckResult;
    ambiguousParagraphReferences: CheckResult;
    punctuation: CheckResult;
    paragraphEndings: CheckResult;
    interrogativeH2: CheckResult;
    differentTransitionalWords: CheckResult;
    duplicateWordsInParagraph: CheckResult;
    duplicateWordsInHeading: CheckResult;
    sentenceLength: CheckResult;
    stepsIntroduction: CheckResult;
    automaticLists: CheckResult;
    ctaWords: CheckResult;
    interactiveLanguage: CheckResult;
    arabicOnly: CheckResult;
    lastH2IsConclusion: CheckResult;
    conclusionParagraph: CheckResult;
    conclusionWordCount: CheckResult;
    conclusionHasList: CheckResult;
    conclusionHasNumber: CheckResult;
    sentenceBeginnings: CheckResult;
    warningWords: CheckResult;
    punctuationSpacing: CheckResult;
    repeatedBigrams: CheckResult;
    slowWords: CheckResult;
    wordConsistency: CheckResult;
    wordsToDelete: CheckResult;
    keywordStuffing: CheckResult;
    mandatoryH2Sections: CheckResult;
    supportingH2Sections: CheckResult;
    tablesCount: CheckResult;
    headingLength: CheckResult;
}

export interface DuplicatePhrase {
    text: string;
    count: number;
    locations: number[]; // start indices
    containsKeyword?: boolean;
}

export interface DuplicateAnalysis {
    2: DuplicatePhrase[];
    3: DuplicatePhrase[];
    4: DuplicatePhrase[];
    5: DuplicatePhrase[];
    6: DuplicatePhrase[];
    7: DuplicatePhrase[];
    8: DuplicatePhrase[];
}

export interface StructureStats {
  violatingCriteriaCount: number;
  totalErrorsCount: number;
  paragraphCount: number;
  headingCount: number;
}

export interface DuplicateStats {
  totalWords: number;
  uniqueWords: number;
  keywordDuplicatesCount: number;
  totalDuplicates: number;
  commonDuplicatesCount: number;
}

export interface FullAnalysis {
  keywordAnalysis: KeywordAnalysis;
  structureAnalysis: StructureAnalysis;
  structureStats: StructureStats;
  duplicateAnalysis: DuplicateAnalysis;
  duplicateStats: DuplicateStats;
  wordCount: number;
}

export interface HeadingAnalysisResult {
  original: string;
  level: number;
  from: number;
  to: number;
  flaws: string[];
  suggestions: string[];
}

export type AiPatchProvider = 'gemini' | 'chatgpt';

export type AiContentPatchOperation =
  | 'replace_block'
  | 'replace_text'
  | 'insert_after_heading'
  | 'insert_before_heading'
  | 'append_to_section'
  | 'insert_before_faq'
  | 'insert_before_conclusion'
  | 'append_to_article';

export type AiContentPatchStatus = 'pending' | 'applied' | 'failed';

export interface AiContentPatch {
  id: string;
  provider: AiPatchProvider;
  operation: AiContentPatchOperation;
  title: string;
  marker?: string;
  anchorText?: string;
  targetText?: string;
  placementLabel?: string;
  contentMarkdown: string;
  reason?: string;
  confidence?: number;
  status: AiContentPatchStatus;
  applyError?: string;
}

export interface AIHistoryItem {
  id: string;
  type: 'fix-violation' | 'user-command';
  ruleTitle?: string; // For 'fix-violation'
  originalText: string;
  suggestions: string[];
  from: number;
  to: number;
  appliedSuggestion?: string;
  applyError?: string;
}

export type BulkFixReviewStatus = 'pending' | 'applied' | 'failed' | 'skipped';

export interface BulkFixReviewStats {
  words: number;
  sentences: number;
  paragraphs: number;
  characters: number;
}

export interface BulkFixReviewVariant {
  id: string;
  label: string;
  fixedText: string;
  statsBefore: BulkFixReviewStats;
  statsAfter: BulkFixReviewStats;
}

export interface BulkFixRelatedRule {
  title: string;
  count: number;
  sourceRuleTitles: string[];
}

export interface BulkFixReviewItem {
  id: string;
  ruleTitle: string;
  ruleTitles?: string[];
  originalText: string;
  fixedText: string;
  variants?: BulkFixReviewVariant[];
  from: number;
  to: number;
  message?: string;
  status: BulkFixReviewStatus;
  applyError?: string;
  appliedVariantId?: string;
}
