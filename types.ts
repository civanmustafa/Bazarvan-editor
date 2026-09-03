

/*
 * Shared application contracts.
 * Update these types before wiring new analysis fields through contexts or UI.
 *
 * Important flow:
 * CheckResult -> StructureAnalysis -> FullAnalysis -> sidebars/dashboard/AI prompts.
 */
export type AnalysisStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface GoogleDescriptionSuggestion {
  text: string;
  callToAction: string;
}

export interface Keywords {
  primary: string;
  secondaries: string[];
  company: string;
  clientId?: string;
  lsi: string[];
  googleTitles?: string[];
  googleDescriptions?: GoogleDescriptionSuggestion[];
}

export interface GoalContext {
  targetWordRange?: string;
  pageType: string;
  objective: string;
  audienceScope: string;
  targetCountry: string;
  targetAudience: string;
  audienceKnowledgeLevel: string;
  audienceNeeds: string;
  readerOutcome: string;
  desiredAction: string;
  marketingStage: string;
  uniqueAngle: string;
  evidenceRequirements: string;
  freshnessRequirements: string;
  brandVoice: string;
  topicSensitivity: string;
  searchIntent: string;
  generatedBrief: string;
}

export type ClientGoalContexts = Record<string, GoalContext>;

export type ExternalAiBridgeProvider = 'chatgpt' | 'gemini';
export type ExternalAiOpenMode = 'window' | 'tab';

// Kept as an alias because the persisted preference still uses the legacy key.
export type ChatGptOpenMode = ExternalAiOpenMode;

export interface AiAnalysisOptions {
  manualCommand: boolean;
  articleTitle: boolean;
  articleToc: boolean;
  currentConclusion: boolean;
  editorText: boolean;
  competitorContent: boolean;
  targetKeywords: boolean;
  companyName: boolean;
  goalContext: boolean;
  keywordCriteria: boolean;
  basicStructureCriteria: boolean;
  headingsSequenceCriteria: boolean;
  productPageCriteria: boolean;
  interactionCtaCriteria: boolean;
  conclusionCriteria: boolean;
}

export interface ReadyCommandAnalysisHistoryMeta {
  commandId: string;
  commandLabel: string;
  skipPatchInstructions?: boolean;
  savesContentSummary?: boolean;
}

export interface ReadyCommandAnalysisBatchItem extends ReadyCommandAnalysisHistoryMeta {
  userPrompt: string;
  options: AiAnalysisOptions;
  competitorSources?: Array<{
    competitorNumber: number;
    url: string;
    title: string;
    text: string;
  }>;
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
  skipPatchInstructions?: boolean;
  savesContentSummary?: boolean;
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
  violationCount?: number;
  displayCountLabel?: string;
  violatingItems?: { 
    from: number; 
    to: number; 
    message: string; 
    text?: string;
    sectionFrom?: number; 
    sectionTo?: number;
    pairedFrom?: number;
    pairedTo?: number;
    pairedText?: string;
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
    paragraphPair: CheckResult;
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
    immediateDuplicateWords: CheckResult;
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
    callToActionHeading: CheckResult;
    callToActionWordCount: CheckResult;
    callToActionParagraphsSentences: CheckResult;
    callToActionBulletList: CheckResult;
    callToActionFinalSentence: CheckResult;
    sentenceBeginnings: CheckResult;
    warningWords: CheckResult;
    punctuationSpacing: CheckResult;
    repeatedBigrams: CheckResult;
    slowWords: CheckResult;
    wordConsistency: CheckResult;
    commonEnglishTerms: CheckResult;
    wordsToDelete: CheckResult;
    keywordStuffing: CheckResult;
    productUsageHeading: CheckResult;
    productTechnicalSpecsHeading: CheckResult;
    productWarrantyContent: CheckResult;
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

export type AiPatchProvider = 'gemini' | 'geminiPaid' | 'chatgpt';

export type AiContentPatchOperation =
  | 'replace_block'
  | 'replace_text'
  | 'delete_block'
  | 'insert_after_heading'
  | 'insert_before_heading'
  | 'append_to_section'
  | 'insert_before_faq'
  | 'insert_before_conclusion'
  | 'append_to_article';

export type AiContentPatchStatus = 'pending' | 'applied' | 'failed';

export interface AiPatchResolvedTarget {
  from: number;
  to: number;
  selectFrom: number;
  selectTo: number;
  mode: 'insert' | 'replace';
}

export interface AiContentPatch {
  id: string;
  provider: AiPatchProvider;
  commandId?: string;
  /** Links a comprehensive competitor-analysis card to its semantic idea cluster. */
  clusterId?: string;
  /** Independent competitor result IDs that this card turns into an editor-ready change. */
  sourceItemIds?: string[];
  operation: AiContentPatchOperation;
  title: string;
  marker?: string;
  anchorText?: string;
  targetText?: string;
  placementLabel?: string;
  contentMarkdown: string;
  reason?: string;
  confidence?: number;
  mergeDeleteTargetText?: string;
  mergeDeleteAnchorText?: string;
  mergeDeletePlacementLabel?: string;
  mergeDeleteStatus?: AiContentPatchStatus;
  mergeDeleteApplyError?: string;
  resolvedTarget?: AiPatchResolvedTarget;
  status: AiContentPatchStatus;
  applyError?: string;
}

export interface AIExecutionHistorySnapshot {
  activityId: string;
  state: 'running' | 'success' | 'failed' | 'cancelled';
  stage: string;
  surface: string;
  action: string;
  message: string;
  provider: string;
  requestedProvider: string;
  model: string;
  requestedModel: string;
  commandId: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AIHistoryItem {
  id: string;
  articleScope?: string;
  articleId?: string | null;
  articleKey?: string;
  type: 'fix-violation' | 'user-command' | 'manual-analysis' | 'ai-execution';
  createdAt?: string;
  updatedAt?: string;
  ruleTitle?: string; // For 'fix-violation'
  originalText: string;
  suggestions: string[];
  from: number;
  to: number;
  appliedSuggestion?: string;
  applyError?: string;
  bulkFixReviewItem?: BulkFixReviewItem;
  analysisResult?: string;
  analysisPatches?: AiContentPatch[];
  provider?: AiPatchProvider;
  commandId?: string;
  execution?: AIExecutionHistorySnapshot;
}

export type BulkFixReviewStatus = 'pending' | 'applied' | 'failed' | 'skipped';

export interface BulkFixReviewStats {
  words: number;
  sentences: number;
  paragraphs: number;
  characters: number;
}

export interface BulkFixCriterionSummary {
  title: string;
  current: string | number;
  required: string | number;
  status?: string;
  message?: string;
  source?: 'target' | 'protection' | 'article';
  isListIntroContext?: boolean;
}

export interface BulkFixCriterionCheck {
  criterionTitle: string;
  before: string;
  after: string;
  required: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  source?: 'target' | 'protection' | 'article';
}

export interface BulkFixReviewVariant {
  id: string;
  label: string;
  fixedText: string;
  statsBefore: BulkFixReviewStats;
  statsAfter: BulkFixReviewStats;
  criteriaChecks?: BulkFixCriterionCheck[];
}

export interface BulkFixRelatedRule {
  title: string;
  count: number;
  sourceRuleTitles: string[];
}

export interface BulkFixTargetFingerprint {
  unitType?: 'paragraph' | 'heading' | 'section' | 'block';
  firstBlockIndex?: number;
  lastBlockIndex?: number;
  blockCount?: number;
  firstBlockType?: string;
  lastBlockType?: string;
  sectionHeading?: string;
  previousText?: string;
  nextText?: string;
  originalStart?: string;
  originalEnd?: string;
}

export interface BulkFixReviewItem {
  id: string;
  articleScope?: string;
  articleId?: string | null;
  articleKey?: string;
  ruleTitle: string;
  ruleTitles?: string[];
  criteria?: BulkFixCriterionSummary[];
  originalText: string;
  targetFingerprint?: BulkFixTargetFingerprint;
  fixedText: string;
  variants?: BulkFixReviewVariant[];
  from: number;
  to: number;
  message?: string;
  status: BulkFixReviewStatus;
  applyError?: string;
  appliedVariantId?: string;
}
