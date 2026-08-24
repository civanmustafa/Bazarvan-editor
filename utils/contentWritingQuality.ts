import type {
  AnalysisStatus,
  CheckResult,
  FullAnalysis,
  GoalContext,
  Keywords,
} from '../types';
import {
  normalizeContentWritingQualityConfiguration,
  type ContentWritingCriterionSeverity,
  type ContentWritingQualityConfiguration,
} from '../constants/contentWritingQuality';
import type { AnalysisDocumentNode } from './analysis/analysisUtils';
import { runContentAnalysis } from './analysis/runContentAnalysis';
import {
  contentWritingMarkdownToPlainText,
  normalizeFinalContentWritingResult,
  prepareContentWritingResultForEditor,
} from './contentWritingWorkflow';
import {
  getPromptTemplate,
  PROMPT_TEMPLATE_IDS,
  renderPromptTemplate,
} from '../constants/promptRegistry';
import {
  evaluateContentWritingFaqDraftIndependence,
  type ContentWritingFaqDraftIndependence,
} from './contentWritingFaq';
import type { ContentWritingKnowledgeBase } from './contentWritingKnowledge';

export type ContentWritingQualityCriterionResult = {
  id: string;
  title: string;
  status: AnalysisStatus;
  severity: ContentWritingCriterionSeverity;
  weight: number;
  current: string | number;
  required: string | number;
  violationCount: number;
  messages: string[];
};

export type ContentWritingQualityReport = {
  policyVersion: number;
  minimumScore: number;
  score: number;
  passed: boolean;
  blockingFailureCount: number;
  failedCount: number;
  warningCount: number;
  passedCount: number;
  wordCount: number;
  repairPasses: number;
  criteria: ContentWritingQualityCriterionResult[];
  generatedAt: string;
};

export type ContentWritingQualityEvaluation = {
  report: ContentWritingQualityReport;
  analysis: FullAnalysis;
};

type MarkdownAnalysisDocument = {
  nodes: AnalysisDocumentNode[];
  textContent: string;
  tableCount: number;
};

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const stripInlineMarkdown = (value: string): string => value
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[*_`~]/g, '')
  .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const isTableSeparator = (value: string): boolean => (
  /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(value)
);

const isTableRow = (value: string): boolean => value.includes('|') && value.split('|').length >= 3;

const isOrderedListLine = (value: string): boolean => (
  /^\s*(?:[\p{N}]{1,2}[.)\-–—:]|\([\p{N}]{1,2}\))\s+\S/u.test(value)
);

const isListLine = (value: string): boolean => (
  /^\s*(?:[-+*•‣◦⁃–—]|[\p{N}]{1,2}[.)\-–—:]|\([\p{N}]{1,2}\))\s+\S/u.test(value)
);

const stripListMarker = (value: string): string => value.replace(
  /^\s*(?:[-+*•‣◦⁃–—]|[\p{N}]{1,2}[.)\-–—:]|\([\p{N}]{1,2}\))\s+/u,
  '',
);

const createNode = (
  type: string,
  text: string,
  pos: number,
  level?: number,
  listItemCount?: number,
): AnalysisDocumentNode => ({
  type,
  text,
  contentText: text,
  pos,
  nodeSize: Math.max(2, text.length + 2),
  ...(listItemCount !== undefined ? { listItemCount } : {}),
  ...(level ? { level } : {}),
});

export const createContentWritingAnalysisDocument = (
  markdown: string,
  articleTitle = '',
): MarkdownAnalysisDocument => {
  const prepared = prepareContentWritingResultForEditor(markdown, articleTitle);
  const normalized = normalizeFinalContentWritingResult(prepared.markdown).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const nodes: AnalysisDocumentNode[] = [];
  let pos = 0;
  let tableCount = 0;

  const pushNode = (type: string, text: string, level?: number): void => {
    const normalizedText = stripInlineMarkdown(text);
    if (!normalizedText) return;
    const node = createNode(type, normalizedText, pos, level);
    nodes.push(node);
    pos += node.nodeSize || 2;
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      pushNode('heading', heading[2], heading[1].length);
      index += 1;
      continue;
    }

    if (isListLine(line)) {
      const values: string[] = [];
      while (index < lines.length && isListLine(lines[index])) {
        values.push(stripListMarker(lines[index]));
        index += 1;
      }
      const normalizedText = stripInlineMarkdown(values.join(' '));
      if (normalizedText) {
        const node = createNode(isOrderedListLine(line) ? 'orderedList' : 'bulletList', normalizedText, pos, undefined, values.length);
        nodes.push(node);
        pos += node.nodeSize || 2;
      }
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const values = [line];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]) && lines[index].trim()) {
        values.push(lines[index]);
        index += 1;
      }
      tableCount += 1;
      pushNode('table', values.join(' '));
      continue;
    }

    // Keep quality analysis aligned with parseMarkdownToHtml(), which renders
    // every non-empty plain-text line as its own editor paragraph. Merging
    // adjacent lines here made a visibly present second introduction paragraph
    // disappear from the quality document.
    const paragraphLine = line.replace(/^\s*>\s?/, '');
    index += 1;
    pushNode('paragraph', paragraphLine);
  }

  const normalizedArticleTitle = stripInlineMarkdown(articleTitle);
  if (normalizedArticleTitle) {
    const titleNode = createNode('heading', normalizedArticleTitle, 0, 1);
    nodes.forEach(node => {
      node.pos += titleNode.nodeSize || 2;
    });
    nodes.unshift(titleNode);
  }

  return {
    nodes,
    textContent: contentWritingMarkdownToPlainText(normalized),
    tableCount,
  };
};

const getCriterionSeverity = (
  id: string,
  configuration: ContentWritingQualityConfiguration,
): ContentWritingCriterionSeverity => configuration.policy.criterionSeverity[id] || 'advisory';

const getCriterionWeight = (
  id: string,
  configuration: ContentWritingQualityConfiguration,
): number => Math.max(1, configuration.policy.criterionWeights[id] || 1);

const normalizeCriterion = (
  id: string,
  result: CheckResult,
  configuration: ContentWritingQualityConfiguration,
): ContentWritingQualityCriterionResult => ({
  id,
  title: result.title,
  status: result.status,
  severity: getCriterionSeverity(id, configuration),
  weight: getCriterionWeight(id, configuration),
  current: result.current,
  required: result.required,
  violationCount: Math.max(0, result.violationCount ?? result.violatingItems?.length ?? 0),
  messages: Array.from(new Set(
    (result.violatingItems || [])
      .map(item => toText(item.message))
      .filter(Boolean),
  )).slice(0, 8),
});

const keywordResult = (
  id: string,
  title: string,
  value: { status: AnalysisStatus; count: number; requiredCount: [number, number] },
  configuration: ContentWritingQualityConfiguration,
): ContentWritingQualityCriterionResult => normalizeCriterion(id, {
  title,
  status: value.status,
  current: value.count,
  required: `${value.requiredCount[0]}-${value.requiredCount[1]}`,
  progress: value.status === 'pass' ? 1 : 0,
}, configuration);

const collectCriteria = (
  analysis: FullAnalysis,
  configuration: ContentWritingQualityConfiguration,
  faqIndependence: ContentWritingFaqDraftIndependence,
): ContentWritingQualityCriterionResult[] => {
  const targetWords = configuration.policy.targetWords;
  const targetBodyH2Count = configuration.policy.outlineSections;
  const targetH2Count = {
    min: targetBodyH2Count.min + 2,
    max: targetBodyH2Count.max + 2,
  };
  const currentH2Count = Number(analysis.structureAnalysis.h2Count?.current) || 0;
  const wordRangePassed = (
    analysis.wordCount >= targetWords.min
    && analysis.wordCount <= targetWords.max
  );
  const h2RangePassed = (
    currentH2Count >= targetH2Count.min
    && currentH2Count <= targetH2Count.max
  );
  const policyCriteria = [
    normalizeCriterion('quality.targetWordRange', {
      title: 'نطاق طول المقالة المعتمد',
      status: wordRangePassed ? 'pass' : 'fail',
      current: analysis.wordCount,
      required: `${targetWords.min}-${targetWords.max}`,
      progress: wordRangePassed ? 1 : 0,
      violationCount: wordRangePassed ? 0 : 1,
    }, configuration),
    normalizeCriterion('quality.totalH2Count', {
      title: 'النطاق المعتمد لعدد عناوين H2',
      status: h2RangePassed ? 'pass' : 'fail',
      current: currentH2Count,
      required: targetH2Count.min === targetH2Count.max
        ? targetH2Count.min
        : `${targetH2Count.min}-${targetH2Count.max}`,
      progress: h2RangePassed ? 1 : 0,
      violationCount: h2RangePassed ? 0 : 1,
    }, configuration),
    normalizeCriterion('quality.faqIndependence', {
      title: 'استقلالية الأسئلة الشائعة وقيمتها الجديدة',
      status: faqIndependence.passed ? 'pass' : 'fail',
      current: faqIndependence.passed
        ? faqIndependence.entries.length
        : faqIndependence.bodyDuplicateQuestions.length + faqIndependence.faqDuplicateQuestions.length,
      required: 'أسئلة موثقة لا تعيد أفكار المتن ولا تكرر بعضها',
      progress: faqIndependence.passed ? 1 : 0,
      violationCount: faqIndependence.bodyDuplicateQuestions.length
        + faqIndependence.faqDuplicateQuestions.length
        + (faqIndependence.faqFound && faqIndependence.entries.length > 0 ? 0 : 1),
      violatingItems: [
        ...faqIndependence.bodyDuplicateQuestions.map(question => ({
          from: 0,
          to: 0,
          text: question,
          message: `السؤال «${question}» يعيد معلومة موجودة في متن المقالة بدل إضافة قيمة جديدة.`,
        })),
        ...faqIndependence.faqDuplicateQuestions.map(question => ({
          from: 0,
          to: 0,
          text: question,
          message: `السؤال «${question}» قريب معنويًا من سؤال شائع آخر.`,
        })),
        ...(!faqIndependence.faqFound || faqIndependence.entries.length === 0 ? [{
          from: 0,
          to: 0,
          message: 'لم يُعثر على أسئلة وأجوبة صالحة يمكن تدقيق استقلاليتها.',
        }] : []),
      ],
    }, configuration),
  ];
  const structure = Object.entries(analysis.structureAnalysis)
    // The session-specific range above is the single authoritative word-count
    // criterion. Keeping the editor's generic >=800 rule here would create a
    // second, contradictory requirement for short or custom assignments.
    .filter(([id, result]) => id !== 'wordCount' && result.status !== 'info')
    .map(([id, result]) => normalizeCriterion(id, result, configuration));
  const keyword = analysis.keywordAnalysis;
  const keywordCriteria: ContentWritingQualityCriterionResult[] = [
    keywordResult('keyword.primary', 'الكلمة المفتاحية الأساسية', keyword.primary, configuration),
    ...keyword.secondaries.map((item, index) => keywordResult(
      `keyword.secondary.${index + 1}`,
      `الصيغة البديلة ${index + 1}`,
      item,
      configuration,
    )),
    keywordResult('keyword.secondariesDistribution', 'توزيع الصيغ البديلة', keyword.secondariesDistribution, configuration),
    keywordResult('keyword.company', 'اسم الشركة', keyword.company, configuration),
    keywordResult('keyword.lsiDistribution', 'توزيع كلمات LSI', keyword.lsi.distribution, configuration),
    normalizeCriterion('keyword.lsiBalance', keyword.lsi.balance, configuration),
  ];
  return [...policyCriteria, ...structure, ...keywordCriteria];
};

const criterionScoreValue = (status: AnalysisStatus): number | null => {
  if (status === 'pass') return 1;
  if (status === 'warn') return 0.5;
  if (status === 'fail') return 0;
  return null;
};

const summarizeQualityCriteria = (
  criteria: readonly ContentWritingQualityCriterionResult[],
): Pick<
  ContentWritingQualityReport,
  'score' | 'blockingFailureCount' | 'failedCount' | 'warningCount' | 'passedCount'
> => {
  const scoredCriteria = criteria.flatMap(criterion => {
    const value = criterionScoreValue(criterion.status);
    return value === null ? [] : [{ criterion, value }];
  });
  const totalWeight = scoredCriteria.reduce((sum, item) => sum + item.criterion.weight, 0);
  const earnedWeight = scoredCriteria.reduce((sum, item) => sum + item.criterion.weight * item.value, 0);
  return {
    score: totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0,
    blockingFailureCount: criteria.filter(criterion => (
      criterion.severity === 'blocking' && criterion.status === 'fail'
    )).length,
    failedCount: criteria.filter(criterion => criterion.status === 'fail').length,
    warningCount: criteria.filter(criterion => criterion.status === 'warn').length,
    passedCount: criteria.filter(criterion => criterion.status === 'pass').length,
  };
};

export const addContentWritingQualityCriteria = (
  report: ContentWritingQualityReport,
  additions: readonly ContentWritingQualityCriterionResult[],
): ContentWritingQualityReport => {
  const replacementIds = new Set(additions.map(criterion => criterion.id));
  const criteria = [
    ...report.criteria.filter(criterion => !replacementIds.has(criterion.id)),
    ...additions,
  ];
  const summary = summarizeQualityCriteria(criteria);
  return {
    ...report,
    ...summary,
    passed: criteria.length > 0
      && summary.score >= report.minimumScore
      && summary.blockingFailureCount === 0,
    criteria,
    generatedAt: new Date().toISOString(),
  };
};

export const evaluateContentWritingQuality = (options: {
  markdown: string;
  articleTitle: string;
  keywords: Keywords;
  goalContext: GoalContext;
  articleLanguage: 'ar' | 'en';
  configuration?: {
    policyVersion?: number;
    minimumScore?: number;
    maxRepairPasses?: number;
    policy?: unknown;
  };
  repairPasses?: number;
}): ContentWritingQualityEvaluation => {
  const configuration = normalizeContentWritingQualityConfiguration(options.configuration);
  const document = createContentWritingAnalysisDocument(options.markdown, options.articleTitle);
  const analysis = runContentAnalysis({
    analysisNodes: document.nodes,
    textContent: document.textContent,
    keywords: options.keywords,
    goalContext: options.goalContext,
    articleLanguage: options.articleLanguage,
    uiLanguage: options.articleLanguage,
    tableCount: document.tableCount,
  });
  const faqIndependence = evaluateContentWritingFaqDraftIndependence(options.markdown);
  const criteria = collectCriteria(analysis, configuration, faqIndependence);
  const summary = summarizeQualityCriteria(criteria);
  return {
    analysis,
    report: {
      policyVersion: configuration.policyVersion,
      minimumScore: configuration.minimumScore,
      score: summary.score,
      // A high weighted score must never hide a blocking editorial or safety
      // failure. Both conditions are required before a draft can be published.
      passed: summary.score >= configuration.minimumScore
        && summary.blockingFailureCount === 0,
      blockingFailureCount: summary.blockingFailureCount,
      failedCount: summary.failedCount,
      warningCount: summary.warningCount,
      passedCount: summary.passedCount,
      wordCount: analysis.wordCount,
      repairPasses: Math.max(0, Math.round(options.repairPasses || 0)),
      criteria,
      generatedAt: new Date().toISOString(),
    },
  };
};

export type ContentWritingSourceAccuracyInput = {
  knowledge?: ContentWritingKnowledgeBase | null;
  usedClaimIds?: readonly string[];
  /**
   * Used only as a conservative fallback when an older session has no
   * persisted knowledge ledger. Existing values remain reviewable, while any
   * value introduced by the external patch is blocked.
   */
  baselineMarkdown?: string;
};

export type ContentWritingSourceAccuracyAudit = {
  numericValues: string[];
  priceValues: string[];
  supportedNumericValues: string[];
  unsupportedNumericValues: string[];
  unsupportedPriceValues: string[];
  blockedClaimIds: string[];
  eligibleClaimIds: string[];
};

const EXACT_NUMBER_SOURCE = String.raw`\d+(?:[.,]\d+)*`;
const EXACT_PERCENT_PATTERN = new RegExp(
  String.raw`(${EXACT_NUMBER_SOURCE})\s*(?:%|٪|percent|بالمئة|في\s+المئة)`,
  'giu',
);
const EXACT_YEAR_PATTERN = /(?<![\p{L}\p{N}])((?:19|20)\d{2})(?![\p{L}\p{N}])/gu;
const EXACT_DURATION_PATTERN = new RegExp(
  String.raw`(${EXACT_NUMBER_SOURCE})\s*(hours?|days?|months?|years?|ساعة|ساعات|يوم(?:اً|ا)?|أيام|شهر|أشهر|سنة|سنوات|عام|أعوام)`,
  'giu',
);
const EXACT_PRICE_PATTERN = new RegExp(
  String.raw`(?:([$€£¥])\s*(${EXACT_NUMBER_SOURCE})|(${EXACT_NUMBER_SOURCE})\s*(USD|EUR|GBP|JPY|SAR|AED|QAR|KWD|TRY|دولار(?:اً|ا)?|ريال(?:اً|ا)?|درهم(?:اً|ا)?|دينار(?:اً|ا)?|جنيه(?:اً|ا)?|ليرة|ر\.?\s?س))`,
  'giu',
);

const normalizeExactNumber = (value: string): string => {
  const asciiDigits = value
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');
  const compact = asciiDigits.replace(/[^\d.,]/g, '');
  if (!compact) return '';
  const withoutThousands = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)
    ? compact.replace(/,/g, '')
    : compact.includes('.')
      ? compact.replace(/,/g, '')
      : /^\d+,\d{1,2}$/.test(compact)
        ? compact.replace(',', '.')
        : compact.replace(/,/g, '');
  const [integerPart = '0', decimalPart = ''] = withoutThousands.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  const decimal = decimalPart.replace(/0+$/, '');
  return decimal ? `${integer}.${decimal}` : integer;
};

const normalizeDigitsInText = (value: string): string => value
  .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/\u066B/g, '.')
  .replace(/\u066C/g, ',');

const normalizeDurationUnit = (value: string): string => {
  const unit = value.toLocaleLowerCase();
  if (/^(?:hours?|ساعة|ساعات)$/.test(unit)) return 'hour';
  if (/^(?:days?|يوم(?:اً|ا)?|أيام)$/.test(unit)) return 'day';
  if (/^(?:months?|شهر|أشهر)$/.test(unit)) return 'month';
  return 'year';
};

const normalizeCurrency = (value: string): string => {
  const currency = value.trim().toLocaleUpperCase();
  if (currency === '$' || currency.startsWith('دولار')) return 'USD';
  if (currency === '€') return 'EUR';
  if (currency === '£' || currency.startsWith('جنيه')) return 'GBP';
  if (currency === '¥') return 'JPY';
  if (currency.startsWith('ريال') || /^ر\.?\s?س$/u.test(value.trim())) return 'SAR';
  if (currency.startsWith('درهم')) return 'AED';
  if (currency.startsWith('دينار')) return 'KWD';
  if (currency.startsWith('ليرة')) return 'TRY';
  return currency;
};

const collectExactClaimValueKeys = (value: string): string[] => {
  const textContent = normalizeDigitsInText(contentWritingMarkdownToPlainText(value));
  const percentMatches = Array.from(textContent.matchAll(EXACT_PERCENT_PATTERN));
  const durationMatches = Array.from(textContent.matchAll(EXACT_DURATION_PATTERN));
  const priceMatches = Array.from(textContent.matchAll(EXACT_PRICE_PATTERN));
  const occupiedRanges = [...percentMatches, ...durationMatches, ...priceMatches]
    .map(match => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  const yearMatches = Array.from(textContent.matchAll(EXACT_YEAR_PATTERN)).filter(match => (
    !occupiedRanges.some(range => match.index >= range.start && match.index < range.end)
  ));
  const keys = [
    ...percentMatches.map(match => (
      `percent:${normalizeExactNumber(match[1])}`
    )),
    ...yearMatches.map(match => (
      `year:${normalizeExactNumber(match[1])}`
    )),
    ...durationMatches.map(match => (
      `duration:${normalizeExactNumber(match[1])}:${normalizeDurationUnit(match[2])}`
    )),
    ...priceMatches.map(match => {
      const currency = normalizeCurrency(match[1] || match[4]);
      const amount = normalizeExactNumber(match[2] || match[3]);
      return `price:${amount}:${currency}`;
    }),
  ];
  return Array.from(new Set(keys.filter(key => !key.includes('::'))));
};

const collectExactPriceValueKeys = (value: string): string[] => (
  collectExactClaimValueKeys(value).filter(key => key.startsWith('price:'))
);

const formatExactClaimValueKey = (key: string): string => {
  const [kind, value, qualifier] = key.split(':');
  if (kind === 'percent') return `${value}%`;
  if (kind === 'year') return value;
  if (kind === 'duration') return `${value} ${qualifier}`;
  if (kind === 'price') return `${value} ${qualifier}`;
  return key;
};

export const auditContentWritingSourceAccuracy = (options: {
  markdown: string;
  sourceAccuracy?: ContentWritingSourceAccuracyInput;
}): ContentWritingSourceAccuracyAudit => {
  const numericValues = collectExactClaimValueKeys(options.markdown);
  const priceValues = collectExactPriceValueKeys(options.markdown);
  const knowledge = options.sourceAccuracy?.knowledge || null;
  const usedClaimIds = new Set(options.sourceAccuracy?.usedClaimIds || []);
  const primarySourceIds = new Set(knowledge?.sourceRegistry.primarySourceIds || []);
  const currentPrimarySourceIds = new Set(
    (knowledge?.sourceRegistry.sources || [])
      .filter(source => source.freshness === 'current' && primarySourceIds.has(source.id))
      .map(source => source.id),
  );
  const eligibleClaims = (knowledge?.claimLedger.claims || []).filter(claim => (
    usedClaimIds.has(claim.id)
    && claim.usagePolicy !== 'blocked'
    && claim.supportingSourceIds.some(sourceId => currentPrimarySourceIds.has(sourceId))
  ));
  const supportedNumericValues = new Set(
    eligibleClaims.flatMap(claim => collectExactClaimValueKeys(claim.statement)),
  );
  // Older sessions may not have a recoverable knowledge ledger. In that case
  // only values already present in the reviewed baseline are grandfathered;
  // a patch can never smuggle a different value through a global "some claim"
  // boolean.
  if (!knowledge && options.sourceAccuracy?.baselineMarkdown) {
    collectExactClaimValueKeys(options.sourceAccuracy.baselineMarkdown)
      .forEach(value => supportedNumericValues.add(value));
  }
  const financialClaimValues = new Set(
    eligibleClaims
      .filter(claim => ['statistic', 'time_sensitive', 'financial'].includes(claim.claimType))
      .flatMap(claim => collectExactPriceValueKeys(claim.statement)),
  );
  if (!knowledge && options.sourceAccuracy?.baselineMarkdown) {
    collectExactPriceValueKeys(options.sourceAccuracy.baselineMarkdown)
      .forEach(value => financialClaimValues.add(value));
  }
  const blockedClaimIds = (knowledge?.claimLedger.claims || [])
    .filter(claim => usedClaimIds.has(claim.id) && claim.usagePolicy === 'blocked')
    .map(claim => claim.id);
  return {
    numericValues,
    priceValues,
    supportedNumericValues: Array.from(supportedNumericValues),
    unsupportedNumericValues: numericValues.filter(value => !supportedNumericValues.has(value)),
    unsupportedPriceValues: priceValues.filter(value => !financialClaimValues.has(value)),
    blockedClaimIds,
    eligibleClaimIds: eligibleClaims.map(claim => claim.id),
  };
};

export const applyContentWritingSourceAccuracyGuard = (options: {
  report: ContentWritingQualityReport;
  markdown: string;
  sourceAccuracy?: ContentWritingSourceAccuracyInput;
}): ContentWritingQualityReport => {
  const audit = auditContentWritingSourceAccuracy(options);
  const criteria: ContentWritingQualityCriterionResult[] = [];
  if (audit.blockedClaimIds.length > 0) {
    criteria.push({
      id: 'source.blockedClaimUsage',
      title: 'سلامة الادعاءات المستخدمة',
      status: 'fail',
      severity: 'blocking',
      weight: 3,
      current: audit.blockedClaimIds.join(', '),
      required: 'صفر ادعاءات محظورة',
      violationCount: audit.blockedClaimIds.length,
      messages: audit.blockedClaimIds.map(
        id => `الادعاء ${id} محظور حتى يكتمل التحقق الخارجي.`,
      ),
    });
  }
  if (audit.priceValues.length > 0) {
    criteria.push({
      id: 'source.exactPrices',
      title: 'دقة الأسعار والقيم المالية',
      status: audit.unsupportedPriceValues.length === 0 ? 'pass' : 'fail',
      severity: 'blocking',
      weight: 3,
      current: audit.unsupportedPriceValues.length === 0
        ? 'كل قيمة مالية دقيقة مرتبطة بادعاء مناسب ومصدر أولي حالي'
        : audit.unsupportedPriceValues.map(formatExactClaimValueKey).join(', '),
      required: 'كل سعر يطابق قيمة الادعاء المستخدم الذي تدعمه مادة رسمية أو أولية حالية',
      violationCount: audit.unsupportedPriceValues.length,
      messages: audit.unsupportedPriceValues.slice(0, 12).map(
        value => `القيمة المالية ${formatExactClaimValueKey(value)} لا تطابق ادعاءً ماليًا مستخدمًا وموثقًا من مصدر أولي حالي.`,
      ),
    });
  }
  if (audit.numericValues.length > 0) {
    criteria.push({
      id: 'source.numericClaims',
      title: 'توثيق القيم الرقمية الدقيقة',
      status: audit.unsupportedNumericValues.length === 0 ? 'pass' : 'fail',
      severity: 'blocking',
      weight: 3,
      current: audit.unsupportedNumericValues.length === 0
        ? 'كل قيمة رقمية تطابق ادعاءً مستخدمًا وموثقًا'
        : audit.unsupportedNumericValues.map(formatExactClaimValueKey).join(', '),
      required: 'كل رقم أو نسبة أو تاريخ أو مدة يطابق قيمة في ادعاء مسموح مرتبط بمصدر أولي حالي',
      violationCount: audit.unsupportedNumericValues.length,
      messages: audit.unsupportedNumericValues.slice(0, 12).map(
        value => `القيمة الرقمية ${formatExactClaimValueKey(value)} لا تطابق أي ادعاء مستخدم ومسموح وموثق من مصدر أولي حالي.`,
      ),
    });
  }
  return criteria.length > 0
    ? addContentWritingQualityCriteria(options.report, criteria)
    : options.report;
};

export const buildContentWritingRepairPrompt = (options: {
  report: ContentWritingQualityReport;
  draft: string;
  qualityContract: string;
  language: 'ar' | 'en';
  documentTargetsJson?: string;
  template?: string;
}): string => {
  const failures = options.report.criteria
    .filter(criterion => criterion.status === 'fail' || criterion.status === 'warn')
    .sort((left, right) => {
      const severityOrder = { blocking: 0, important: 1, advisory: 2 };
      return severityOrder[left.severity] - severityOrder[right.severity]
        || right.weight - left.weight;
    })
    .slice(0, 40);
  const audit = failures.map((criterion, index) => [
    `${index + 1}. [${criterion.severity}] ${criterion.title}`,
    `   current=${String(criterion.current)} | required=${String(criterion.required)}`,
    ...criterion.messages.slice(0, 3).map(message => `   - ${message}`),
  ].join('\n')).join('\n');
  const languageInstruction = options.language === 'en'
    ? 'حافظ على المقالة كاملة باللغة الإنجليزية.'
    : 'حافظ على المقالة كاملة باللغة العربية.';
  const repairScopes = failures.map(criterion => ({
    criterionId: criterion.id,
    scope: getContentWritingCriterionRepairScope(criterion.id),
    title: criterion.title,
    severity: criterion.severity,
  }));
  return renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.qualityRepair),
    {
      language_instruction: languageInstruction,
      quality_score: options.report.score,
      minimum_score: options.report.minimumScore,
      quality_contract: options.qualityContract,
      machine_issues: audit || 'لم ينتج المحرك تفاصيل فردية؛ حسّن الالتزام بعقد الجودة كاملًا.',
      repair_scopes_json: JSON.stringify(repairScopes, null, 2),
      document_targets_json: options.documentTargetsJson || '[]',
      article_to_repair: options.draft,
    },
  );
};

export const getContentWritingCriterionRepairScope = (
  criterionId: string,
): 'local' | 'structural' | 'global' => {
  const id = String(criterionId || '');
  if (
    id === 'quality.targetWordRange'
    || id === 'wordCount'
    || id === 'keywordStuffing'
    || id.startsWith('keyword.')
  ) {
    return 'global';
  }
  if (
    id === 'quality.totalH2Count'
    || id === 'quality.faqIndependence'
    || id === 'h2Count'
    || id === 'h2Structure'
    || id === 'faqSection'
    || id === 'lastH2IsConclusion'
    || id === 'conclusionHasList'
    || id === 'conclusionHasNumber'
    || id.startsWith('callToAction')
    || id === 'tablesCount'
    || id.startsWith('product')
  ) {
    return 'structural';
  }
  return 'local';
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const normalizeContentWritingQualityReport = (value: unknown): ContentWritingQualityReport | null => {
  if (!isRecord(value) || !Array.isArray(value.criteria)) return null;
  const policyVersion = Number(value.policyVersion);
  const score = Number(value.score);
  const minimumScore = Number(value.minimumScore);
  if (!Number.isFinite(policyVersion) || !Number.isFinite(score) || !Number.isFinite(minimumScore)) return null;
  const criteria = value.criteria.flatMap((item): ContentWritingQualityCriterionResult[] => {
    if (!isRecord(item) || !toText(item.id) || !toText(item.title)) return [];
    const status = toText(item.status) as AnalysisStatus;
    const severity = toText(item.severity) as ContentWritingCriterionSeverity;
    if (!['pass', 'warn', 'fail', 'info'].includes(status)) return [];
    if (!['blocking', 'important', 'advisory'].includes(severity)) return [];
    return [{
      id: toText(item.id),
      title: toText(item.title),
      status,
      severity,
      weight: Math.max(1, Number(item.weight) || 1),
      current: typeof item.current === 'number' ? item.current : toText(item.current),
      required: typeof item.required === 'number' ? item.required : toText(item.required),
      violationCount: Math.max(0, Number(item.violationCount) || 0),
      messages: Array.isArray(item.messages) ? item.messages.map(toText).filter(Boolean).slice(0, 8) : [],
    }];
  });
  const summary = summarizeQualityCriteria(criteria);
  const normalizedMinimumScore = Math.max(0, Math.min(100, Math.round(minimumScore)));
  return {
    policyVersion: Math.max(1, Math.round(policyVersion)),
    minimumScore: normalizedMinimumScore,
    score: summary.score,
    // Persisted counters and `passed` are derived data. Recompute them from the
    // normalized criteria so an old or inconsistent report cannot bypass the
    // blocking-quality gate.
    passed: criteria.length > 0
      && summary.score >= normalizedMinimumScore
      && summary.blockingFailureCount === 0,
    blockingFailureCount: summary.blockingFailureCount,
    failedCount: summary.failedCount,
    warningCount: summary.warningCount,
    passedCount: summary.passedCount,
    wordCount: Math.max(0, Number(value.wordCount) || 0),
    repairPasses: Math.max(0, Number(value.repairPasses) || 0),
    criteria,
    generatedAt: toText(value.generatedAt) || new Date(0).toISOString(),
  };
};

export type ExternalReviewPatchApplicationReason =
  | 'patch_not_object'
  | 'unsupported_operation'
  | 'missing_target_text'
  | 'target_not_found'
  | 'target_not_unique'
  | 'missing_anchor_text'
  | 'anchor_not_found'
  | 'anchor_not_unique'
  | 'missing_content_markdown'
  | 'content_already_present'
  | 'merge_target_not_found'
  | 'merge_target_not_unique'
  | 'no_change';

export type ExternalReviewPatchApplicationItem = {
  index: number;
  operation: string;
  marker: string;
};

export type ExternalReviewPatchRejection = ExternalReviewPatchApplicationItem & {
  reason: ExternalReviewPatchApplicationReason;
};

export type ExternalReviewPatchApplication = {
  markdown: string;
  changed: boolean;
  applied: ExternalReviewPatchApplicationItem[];
  rejected: ExternalReviewPatchRejection[];
};

const EXTERNAL_REVIEW_REPLACE_OPERATIONS = new Set([
  'replace_block',
  'replace_text',
  'delete_block',
]);

const EXTERNAL_REVIEW_INSERT_OPERATIONS = new Set([
  'insert_after_heading',
  'insert_before_heading',
  'append_to_section',
  'insert_before_faq',
  'insert_before_conclusion',
  'append_to_article',
]);

const countLiteralOccurrences = (value: string, search: string): number => {
  if (!search) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - search.length) {
    const index = value.indexOf(search, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, search.length);
  }
  return count;
};

const joinMarkdownBlocks = (...values: string[]): string => values
  .map(value => value.trim())
  .filter(Boolean)
  .join('\n\n');

/**
 * Applies external-review patches without fuzzy matching. Every destructive
 * target and every insertion anchor must occur exactly once in the current
 * draft. A patch is preflighted in full (including its optional merge-delete)
 * before any part of that patch is committed.
 */
export const applyExternalReviewPatchesToContentWritingMarkdown = (options: {
  markdown: string;
  patches: readonly unknown[];
}): ExternalReviewPatchApplication => {
  const originalMarkdown = String(options.markdown || '').replace(/\r\n?/g, '\n');
  let markdown = originalMarkdown;
  const applied: ExternalReviewPatchApplicationItem[] = [];
  const rejected: ExternalReviewPatchRejection[] = [];

  const reject = (
    item: ExternalReviewPatchApplicationItem,
    reason: ExternalReviewPatchApplicationReason,
  ): void => {
    rejected.push({ ...item, reason });
  };

  (Array.isArray(options.patches) ? options.patches : []).forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      reject({ index, operation: '', marker: '' }, 'patch_not_object');
      return;
    }
    const operation = toText(candidate.operation);
    const item = {
      index,
      operation,
      marker: toText(candidate.marker ?? candidate.id) || `patch_${index + 1}`,
    };
    if (
      !EXTERNAL_REVIEW_REPLACE_OPERATIONS.has(operation)
      && !EXTERNAL_REVIEW_INSERT_OPERATIONS.has(operation)
    ) {
      reject(item, 'unsupported_operation');
      return;
    }

    const contentMarkdown = toText(
      candidate.contentMarkdown ?? candidate.content ?? candidate.text,
    ).replace(/\r\n?/g, '\n');
    const targetText = toText(candidate.targetText).replace(/\r\n?/g, '\n');
    const anchorText = toText(candidate.anchorText).replace(/\r\n?/g, '\n');
    const mergeDeleteTargetText = toText(candidate.mergeDeleteTargetText)
      .replace(/\r\n?/g, '\n');

    if (operation !== 'delete_block' && !contentMarkdown) {
      reject(item, 'missing_content_markdown');
      return;
    }
    if (contentMarkdown && countLiteralOccurrences(markdown, contentMarkdown) > 0) {
      reject(item, 'content_already_present');
      return;
    }

    if (EXTERNAL_REVIEW_REPLACE_OPERATIONS.has(operation)) {
      if (!targetText) {
        reject(item, 'missing_target_text');
        return;
      }
      const targetCount = countLiteralOccurrences(markdown, targetText);
      if (targetCount === 0) {
        reject(item, 'target_not_found');
        return;
      }
      if (targetCount !== 1) {
        reject(item, 'target_not_unique');
        return;
      }
    } else {
      if (!anchorText) {
        reject(item, 'missing_anchor_text');
        return;
      }
      const anchorCount = countLiteralOccurrences(markdown, anchorText);
      if (anchorCount === 0) {
        reject(item, 'anchor_not_found');
        return;
      }
      if (anchorCount !== 1) {
        reject(item, 'anchor_not_unique');
        return;
      }
    }

    if (mergeDeleteTargetText) {
      const mergeTargetCount = countLiteralOccurrences(markdown, mergeDeleteTargetText);
      if (mergeTargetCount === 0) {
        reject(item, 'merge_target_not_found');
        return;
      }
      if (mergeTargetCount !== 1 || mergeDeleteTargetText === targetText) {
        reject(item, 'merge_target_not_unique');
        return;
      }
    }

    let candidateMarkdown = markdown;
    if (EXTERNAL_REVIEW_REPLACE_OPERATIONS.has(operation)) {
      candidateMarkdown = operation === 'delete_block'
        ? candidateMarkdown.replace(targetText, '')
        : candidateMarkdown.replace(targetText, contentMarkdown);
    } else if (operation === 'append_to_article') {
      candidateMarkdown = joinMarkdownBlocks(candidateMarkdown, contentMarkdown);
    } else if (
      operation === 'insert_before_heading'
      || operation === 'insert_before_faq'
      || operation === 'insert_before_conclusion'
    ) {
      candidateMarkdown = candidateMarkdown.replace(
        anchorText,
        joinMarkdownBlocks(contentMarkdown, anchorText),
      );
    } else {
      candidateMarkdown = candidateMarkdown.replace(
        anchorText,
        joinMarkdownBlocks(anchorText, contentMarkdown),
      );
    }
    if (mergeDeleteTargetText) {
      candidateMarkdown = candidateMarkdown.replace(mergeDeleteTargetText, '');
    }
    candidateMarkdown = candidateMarkdown
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (candidateMarkdown === markdown) {
      reject(item, 'no_change');
      return;
    }
    markdown = candidateMarkdown;
    applied.push(item);
  });

  return {
    markdown,
    changed: markdown !== originalMarkdown,
    applied,
    rejected,
  };
};

export const reevaluateContentWritingQualityAfterExternalReview = (options: {
  markdown: string;
  patches: readonly unknown[];
  articleTitle: string;
  keywords: Keywords;
  goalContext: GoalContext;
  articleLanguage: 'ar' | 'en';
  configuration?: {
    policyVersion?: number;
    minimumScore?: number;
    maxRepairPasses?: number;
    policy?: unknown;
  };
  repairPasses?: number;
  sourceAccuracy?: ContentWritingSourceAccuracyInput;
}): {
  patchApplication: ExternalReviewPatchApplication;
  evaluation: ContentWritingQualityEvaluation;
} => {
  const patchApplication = applyExternalReviewPatchesToContentWritingMarkdown(options);
  const evaluation = evaluateContentWritingQuality({
    markdown: patchApplication.markdown,
    articleTitle: options.articleTitle,
    keywords: options.keywords,
    goalContext: options.goalContext,
    articleLanguage: options.articleLanguage,
    configuration: options.configuration,
    repairPasses: options.repairPasses,
  });
  return {
    patchApplication,
    evaluation: {
      ...evaluation,
      // External patches are evaluated against the same deterministic
      // source/claim guard as the original writing workflow. Re-running only
      // the generic score would silently drop every `source.*` blocker.
      report: applyContentWritingSourceAccuracyGuard({
        report: evaluation.report,
        markdown: patchApplication.markdown,
        sourceAccuracy: options.sourceAccuracy,
      }),
    },
  };
};
