import type { Keywords, FullAnalysis, StructureAnalysis, GoalContext, DuplicateAnalysis, DuplicateStats } from '../../types';
import { translations } from '../../components/translations';
import { runDuplicateAnalysis } from './runDuplicateAnalysis';
import { runKeywordAnalysis } from './runKeywordAnalysis';
import type { AnalysisContext, AnalysisDocumentNode } from './analysisUtils';
import { countNodesByType, getAnalysisNodeSize, getNodeContentAsText, getNodeSizeFromJSON, getNodeText } from './analysisUtils';

import { checkWordCount } from './rules/checkWordCount';
import { checkFirstTitle } from './rules/checkFirstTitle';
import { checkSecondTitle } from './rules/checkSecondTitle';
import { checkIncludesExcludes } from './rules/checkIncludesExcludes';
import { checkPreTravelH2 } from './rules/checkPreTravelH2';
import { checkPricingH2 } from './rules/checkPricingH2';
import { checkWhoIsItForH2 } from './rules/checkWhoIsItForH2';
import { checkSummaryParagraph } from './rules/checkSummaryParagraph';
import { checkSecondParagraph } from './rules/checkSecondParagraph';
import { checkParagraphLength } from './rules/checkParagraphLength';
import { checkParagraphPair } from './rules/checkParagraphPair';
import { checkH2Structure } from './rules/checkH2Structure';
import { checkH2Count } from './rules/checkH2Count';
import { checkSubHeadingStructure } from './rules/checkSubHeadingStructure';
import { checkBetweenH2H3 } from './rules/checkBetweenH2H3';
import { checkFaqSection } from './rules/checkFaqSection';
import { checkAnswerParagraph } from './rules/checkAnswerParagraph';
import { checkAmbiguousHeadings } from './rules/checkAmbiguousHeadings';
import { checkAmbiguousParagraphReferences } from './rules/checkAmbiguousParagraphReferences';
import { checkPunctuation } from './rules/checkPunctuation';
import { checkParagraphEndings } from './rules/checkParagraphEndings';
import { checkInterrogativeH2 } from './rules/checkInterrogativeH2';
import { checkTransitionalWords } from './rules/checkTransitionalWords';
import { checkImmediateDuplicateWords } from './rules/checkImmediateDuplicateWords';
import { checkDuplicateWordsInParagraph, checkDuplicateWordsInHeading } from './rules/checkDuplicateWords';
import { checkSentenceLength } from './rules/checkSentenceLength';
import { checkStepsIntroduction } from './rules/checkStepsIntroduction';
import { checkAutomaticLists } from './rules/checkAutomaticLists';
import { checkCtaWords } from './rules/checkCtaWords';
import { checkInteractiveLanguage } from './rules/checkInteractiveLanguage';
import { checkArabicOnly } from './rules/checkArabicOnly';
import { checkConclusion } from './rules/checkConclusion';
import { checkSentenceBeginnings } from './rules/checkSentenceBeginnings';
import { checkWarningWords } from './rules/checkWarningWords';
import { checkPunctuationSpacing } from './rules/checkPunctuationSpacing';
import { checkRepeatedBigrams } from './rules/checkRepeatedBigrams';
import { checkSlowWords } from './rules/checkSlowWords';
import { checkWordConsistency } from './rules/checkWordConsistency';
import { checkCommonEnglishTerms } from './rules/checkCommonEnglishTerms';
import { checkWordsToDelete } from './rules/checkWordsToDelete';
import { checkKeywordStuffing } from './rules/checkKeywordStuffing';
import { checkDeviceSaleMandatoryH2, checkDeviceSaleSupportingH2, checkProductTechnicalSpecsHeading, checkProductUsageHeading, checkProductWarrantyContent } from './rules/checkDeviceSaleH2';
import { checkTablesCount } from './rules/checkTablesCount';
import { checkHeadingLength } from './rules/checkHeadingLength';
import { FAQ_KEYWORDS, CONCLUSION_KEYWORDS } from '../../constants';

export interface ContentAnalysisInput {
  editorState?: any;
  analysisNodes?: AnalysisDocumentNode[];
  textContent: string;
  keywords: Keywords;
  goalContext: GoalContext;
  articleLanguage: 'ar' | 'en';
  uiLanguage: 'ar' | 'en';
  tableCount?: number;
  updateDuplicateAnalysis?: boolean;
}

const getAnalysisGoal = (goalContext: GoalContext): string => {
  switch (goalContext.objective) {
    case 'educate':
      return 'اكاديمية';
    case 'compare':
    case 'category-support':
      return 'مقارنة';
    case 'convert':
      return 'البيع';
    default:
      return 'مدونة';
  }
};

const createEmptyDuplicateAnalysis = (): DuplicateAnalysis => ({
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
});

const createEmptyDuplicateStats = (totalWordCount: number): DuplicateStats => ({
  totalWords: totalWordCount,
  uniqueWords: 0,
  keywordDuplicatesCount: 0,
  totalDuplicates: 0,
  commonDuplicatesCount: 0,
});

export const createAnalysisNodesFromEditorState = (editorState: any): AnalysisDocumentNode[] => {
  if (!editorState?.content) {
    return [];
  }

  const nodes: AnalysisDocumentNode[] = [];
  let pos = 0;

  editorState.content.forEach((node: any) => {
    if (!node || typeof node !== 'object') return;
    const nodeSize = getNodeSizeFromJSON(node);
    const text = getNodeText(node);
    const contentText = getNodeContentAsText(node);
    nodes.push({
      type: node.type,
      level: node.attrs?.level,
      text,
      ...(contentText !== text ? { contentText } : {}),
      nodeSize,
      pos,
    });
    pos += nodeSize;
  });

  return nodes;
};

export const runContentAnalysis = ({
  editorState,
  analysisNodes,
  textContent,
  keywords,
  goalContext,
  articleLanguage,
  uiLanguage,
  tableCount,
  updateDuplicateAnalysis = true,
}: ContentAnalysisInput): FullAnalysis => {
  const t = translations[uiLanguage] || translations.ar;
  const analysisGoal = getAnalysisGoal(goalContext);

  const totalWordCount = textContent.trim().split(/\s+/).filter(Boolean).length;
  const nodes: AnalysisDocumentNode[] = analysisNodes?.length
    ? analysisNodes
    : createAnalysisNodesFromEditorState(editorState);
  const totalDocSize = nodes.reduce((size, node) => size + getAnalysisNodeSize(node), 0);
  const totalTableCount = tableCount ?? countNodesByType(editorState, 'table');

  const paragraphs = nodes.filter(n => n.type === 'paragraph');
  const nonEmptyParagraphs = paragraphs.filter(p => p.text.trim().length > 0);
  const headings = nodes.filter(n => n.type === 'heading');

  const L_FAQ_KEYWORDS = articleLanguage === 'ar' ? FAQ_KEYWORDS : ['questions', 'faq', 'frequently asked questions'];
  const L_CONCLUSION_KEYWORDS = articleLanguage === 'ar' ? CONCLUSION_KEYWORDS : ['conclusion', 'summary', 'in conclusion', 'in summary', 'finally', 'to sum up', 'lastly', 'in the end'];

  const faqSections: { startPos: number; endPos: number }[] = [];
  const faqH2Indices = nodes
    .map((node, index) => (
      node.type === 'heading' &&
      node.level === 2 &&
      L_FAQ_KEYWORDS.some(k => node.text.toLowerCase().includes(k.toLowerCase()))
        ? index
        : -1
    ))
    .filter(index => index !== -1);

  faqH2Indices.forEach(startIndex => {
    const startPos = nodes[startIndex].pos;
    let endIndex = -1;
    for (let i = startIndex + 1; i < nodes.length; i++) {
      if (nodes[i].type === 'heading' && nodes[i].level === 2) {
        endIndex = i;
        break;
      }
    }
    const endPos = endIndex === -1 ? totalDocSize : nodes[endIndex].pos;
    faqSections.push({ startPos, endPos });
  });

  const isPosInFaqSection = (pos: number) => faqSections.some(section => pos >= section.startPos && pos < section.endPos);

  const conclusionSection = (() => {
    const lastH2Index = nodes.map((n, i) => (n.type === 'heading' && n.level === 2 ? i : -1)).filter(i => i !== -1).pop();
    if (lastH2Index === undefined) return null;
    const lastH2Node = nodes[lastH2Index];
    const isConclusion = L_CONCLUSION_KEYWORDS.some(k => lastH2Node.text.toLowerCase().includes(k.toLowerCase()));
    if (!isConclusion) return null;
    const sectionNodes = nodes.slice(lastH2Index + 1);
    const sectionText = sectionNodes.map(n => n.text).join(' ');
    const sectionParagraphs = sectionNodes.filter(n => n.type === 'paragraph' && n.text.trim().length > 0);
    const hasList = sectionNodes.some(n => n.type === 'bulletList' || n.type === 'orderedList');
    const hasNumber = /\d/.test(sectionText);
    return {
      text: sectionText,
      nodes: sectionNodes,
      paragraphs: sectionParagraphs,
      hasList,
      hasNumber,
      wordCount: sectionText.trim().split(/\s+/).filter(Boolean).length,
    };
  })();

  const { duplicateAnalysis, duplicateStats } = updateDuplicateAnalysis
    ? runDuplicateAnalysis(textContent, keywords, totalWordCount, articleLanguage)
    : {
        duplicateAnalysis: createEmptyDuplicateAnalysis(),
        duplicateStats: createEmptyDuplicateStats(totalWordCount),
      };

  const analysisContext: AnalysisContext = {
    editorState,
    nodes,
    headings,
    paragraphs,
    nonEmptyParagraphs,
    textContent,
    totalWordCount,
    keywords,
    goalContext,
    analysisGoal,
    articleLanguage,
    uiLanguage,
    t,
    totalDocSize,
    tableCount: totalTableCount,
    faqSections,
    isPosInFaqSection,
    conclusionSection,
    duplicateAnalysis,
  };

  const keywordAnalysis = runKeywordAnalysis(analysisContext);
  const conclusionChecks = checkConclusion(analysisContext);

  const structureAnalysis: StructureAnalysis = {
    wordCount: checkWordCount(analysisContext),
    firstTitle: checkFirstTitle(analysisContext),
    secondTitle: checkSecondTitle(analysisContext),
    includesExcludes: checkIncludesExcludes(analysisContext),
    preTravelH2: checkPreTravelH2(analysisContext),
    pricingH2: checkPricingH2(analysisContext),
    whoIsItForH2: checkWhoIsItForH2(analysisContext),
    summaryParagraph: checkSummaryParagraph(analysisContext),
    secondParagraph: checkSecondParagraph(analysisContext),
    paragraphLength: checkParagraphLength(analysisContext),
    paragraphPair: checkParagraphPair(analysisContext),
    h2Structure: checkH2Structure(analysisContext),
    h2Count: checkH2Count(analysisContext),
    h3Structure: checkSubHeadingStructure(analysisContext, 3),
    h4Structure: checkSubHeadingStructure(analysisContext, 4),
    betweenH2H3: checkBetweenH2H3(analysisContext),
    sentenceLength: checkSentenceLength(analysisContext),
    stepsIntroduction: checkStepsIntroduction(analysisContext),
    duplicateWordsInParagraph: checkDuplicateWordsInParagraph(analysisContext),
    duplicateWordsInHeading: checkDuplicateWordsInHeading(analysisContext),
    headingLength: checkHeadingLength(analysisContext),
    faqSection: checkFaqSection(analysisContext),
    answerParagraph: checkAnswerParagraph(analysisContext),
    ambiguousHeadings: checkAmbiguousHeadings(analysisContext),
    ambiguousParagraphReferences: checkAmbiguousParagraphReferences(analysisContext),
    punctuation: checkPunctuation(analysisContext),
    paragraphEndings: checkParagraphEndings(analysisContext),
    interrogativeH2: checkInterrogativeH2(analysisContext),
    differentTransitionalWords: checkTransitionalWords(analysisContext),
    immediateDuplicateWords: checkImmediateDuplicateWords(analysisContext),
    automaticLists: checkAutomaticLists(analysisContext),
    ctaWords: checkCtaWords(analysisContext),
    interactiveLanguage: checkInteractiveLanguage(analysisContext),
    arabicOnly: checkArabicOnly(analysisContext),
    lastH2IsConclusion: conclusionChecks.lastH2IsConclusion,
    conclusionParagraph: conclusionChecks.conclusionParagraph,
    conclusionWordCount: conclusionChecks.conclusionWordCount,
    conclusionHasNumber: conclusionChecks.conclusionHasNumber,
    conclusionHasList: conclusionChecks.conclusionHasList,
    sentenceBeginnings: checkSentenceBeginnings(analysisContext),
    warningWords: checkWarningWords(analysisContext),
    punctuationSpacing: checkPunctuationSpacing(analysisContext),
    repeatedBigrams: checkRepeatedBigrams(analysisContext),
    slowWords: checkSlowWords(analysisContext),
    wordConsistency: checkWordConsistency(analysisContext),
    commonEnglishTerms: checkCommonEnglishTerms(analysisContext),
    wordsToDelete: checkWordsToDelete(analysisContext),
    keywordStuffing: checkKeywordStuffing(analysisContext),
    productUsageHeading: checkProductUsageHeading(analysisContext),
    productTechnicalSpecsHeading: checkProductTechnicalSpecsHeading(analysisContext),
    productWarrantyContent: checkProductWarrantyContent(analysisContext),
    mandatoryH2Sections: checkDeviceSaleMandatoryH2(analysisContext),
    supportingH2Sections: checkDeviceSaleSupportingH2(analysisContext),
    tablesCount: checkTablesCount(analysisContext),
  };

  const violatingCriteriaCount = Object.values(structureAnalysis).filter(c => c.status === 'fail').length;
  const totalErrorsCount = Object.values(structureAnalysis).reduce((sum, c) => sum + (c.violationCount ?? c.violatingItems?.length ?? 0), 0);

  return {
    keywordAnalysis,
    structureAnalysis,
    structureStats: {
      violatingCriteriaCount,
      totalErrorsCount,
      paragraphCount: nonEmptyParagraphs.length,
      headingCount: headings.length,
    },
    duplicateAnalysis,
    duplicateStats,
    wordCount: totalWordCount,
  };
};
