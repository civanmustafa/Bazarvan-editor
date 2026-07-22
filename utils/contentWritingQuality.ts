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

const isListLine = (value: string): boolean => /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(value);

const isBlockStart = (value: string): boolean => (
  /^\s{0,3}#{1,6}\s+\S/.test(value)
  || isListLine(value)
  || isTableRow(value)
);

const createNode = (
  type: string,
  text: string,
  pos: number,
  level?: number,
): AnalysisDocumentNode => ({
  type,
  text,
  contentText: text,
  pos,
  nodeSize: Math.max(2, text.length + 2),
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
        values.push(lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ''));
        index += 1;
      }
      pushNode(/^\s*\d+[.)]\s+/.test(line) ? 'orderedList' : 'bulletList', values.join(' '));
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

    const paragraphLines = [line.replace(/^\s*>\s?/, '')];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].replace(/^\s*>\s?/, ''));
      index += 1;
    }
    pushNode('paragraph', paragraphLines.join(' '));
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
): ContentWritingQualityCriterionResult[] => {
  const targetWords = configuration.policy.targetWords;
  const targetH2Count = configuration.policy.outlineSections.min + 2;
  const currentH2Count = Number(analysis.structureAnalysis.h2Count?.current) || 0;
  const policyCriteria = [
    normalizeCriterion('quality.targetWordRange', {
      title: 'نطاق طول المقالة المعتمد',
      status: analysis.wordCount >= targetWords.min && analysis.wordCount <= targetWords.max ? 'pass' : 'fail',
      current: analysis.wordCount,
      required: `${targetWords.min}-${targetWords.max}`,
      progress: analysis.wordCount >= targetWords.min && analysis.wordCount <= targetWords.max ? 1 : 0,
      violationCount: analysis.wordCount >= targetWords.min && analysis.wordCount <= targetWords.max ? 0 : 1,
    }, configuration),
    normalizeCriterion('quality.totalH2Count', {
      title: 'العدد الدقيق لعناوين H2',
      status: currentH2Count === targetH2Count ? 'pass' : 'fail',
      current: currentH2Count,
      required: targetH2Count,
      progress: currentH2Count === targetH2Count ? 1 : 0,
      violationCount: currentH2Count === targetH2Count ? 0 : 1,
    }, configuration),
  ];
  const structure = Object.entries(analysis.structureAnalysis)
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

export const evaluateContentWritingQuality = (options: {
  markdown: string;
  articleTitle: string;
  keywords: Keywords;
  goalContext: GoalContext;
  articleLanguage: 'ar' | 'en';
  configuration?: Partial<ContentWritingQualityConfiguration> & {
    policyVersion?: number;
    minimumScore?: number;
    maxRepairPasses?: number;
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
  const criteria = collectCriteria(analysis, configuration);
  const scoredCriteria = criteria.flatMap(criterion => {
    const value = criterionScoreValue(criterion.status);
    return value === null ? [] : [{ criterion, value }];
  });
  const totalWeight = scoredCriteria.reduce((sum, item) => sum + item.criterion.weight, 0);
  const earnedWeight = scoredCriteria.reduce((sum, item) => sum + item.criterion.weight * item.value, 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  const blockingFailureCount = criteria.filter(criterion => (
    criterion.severity === 'blocking' && criterion.status === 'fail'
  )).length;
  const failedCount = criteria.filter(criterion => criterion.status === 'fail').length;
  const warningCount = criteria.filter(criterion => criterion.status === 'warn').length;
  const passedCount = criteria.filter(criterion => criterion.status === 'pass').length;
  return {
    analysis,
    report: {
      policyVersion: configuration.policyVersion,
      minimumScore: configuration.minimumScore,
      score,
      passed: blockingFailureCount === 0 && score >= configuration.minimumScore,
      blockingFailureCount,
      failedCount,
      warningCount,
      passedCount,
      wordCount: analysis.wordCount,
      repairPasses: Math.max(0, Math.round(options.repairPasses || 0)),
      criteria,
      generatedAt: new Date().toISOString(),
    },
  };
};

export const buildContentWritingRepairPrompt = (options: {
  report: ContentWritingQualityReport;
  draft: string;
  qualityContract: string;
  language: 'ar' | 'en';
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
    ? 'Keep the complete article in English.'
    : 'حافظ على المقالة كاملة باللغة العربية.';
  return `Execute a focused quality repair of the complete article.

${languageInstruction}
The deterministic quality engine scored the draft ${options.report.score}/100; the required score is ${options.report.minimumScore}/100.
Fix every blocking failure first, then important failures and warnings. Preserve accurate useful content, search intent, and natural keyword use. Do not invent facts, prices, statistics, or claims. Return the complete corrected article only as Markdown with exactly one H1.

Quality contract:
${options.qualityContract}

Machine-detected issues:
${audit || 'No individual issue details were produced; improve compliance with the full quality contract.'}

<article_to_repair>
${options.draft}
</article_to_repair>`;
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
  return {
    policyVersion: Math.max(1, Math.round(policyVersion)),
    minimumScore: Math.max(0, Math.min(100, Math.round(minimumScore))),
    score: Math.max(0, Math.min(100, Math.round(score))),
    passed: value.passed === true,
    blockingFailureCount: Math.max(0, Number(value.blockingFailureCount) || 0),
    failedCount: Math.max(0, Number(value.failedCount) || 0),
    warningCount: Math.max(0, Number(value.warningCount) || 0),
    passedCount: Math.max(0, Number(value.passedCount) || 0),
    wordCount: Math.max(0, Number(value.wordCount) || 0),
    repairPasses: Math.max(0, Number(value.repairPasses) || 0),
    criteria,
    generatedAt: toText(value.generatedAt) || new Date(0).toISOString(),
  };
};
