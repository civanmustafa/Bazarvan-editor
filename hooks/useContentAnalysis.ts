
import { useMemo } from 'react';
import type { Keywords, FullAnalysis, StructureAnalysis } from '../types';
import { translations } from '../components/translations';
import { runDuplicateAnalysis } from '../utils/analysis/runDuplicateAnalysis';
import { runKeywordAnalysis } from '../utils/analysis/runKeywordAnalysis';
import type { AnalysisContext } from '../utils/analysis/analysisUtils';
import { getNodeSizeFromJSON, getNodeText } from '../utils/analysis/analysisUtils';

// Import all structure analysis rules
import { checkWordCount } from '../utils/analysis/rules/checkWordCount';
import { checkFirstTitle } from '../utils/analysis/rules/checkFirstTitle';
import { checkSecondTitle } from '../utils/analysis/rules/checkSecondTitle';
import { checkIncludesExcludes } from '../utils/analysis/rules/checkIncludesExcludes';
import { checkPreTravelH2 } from '../utils/analysis/rules/checkPreTravelH2';
import { checkPricingH2 } from '../utils/analysis/rules/checkPricingH2';
import { checkWhoIsItForH2 } from '../utils/analysis/rules/checkWhoIsItForH2';
import { checkSummaryParagraph } from '../utils/analysis/rules/checkSummaryParagraph';
import { checkSecondParagraph } from '../utils/analysis/rules/checkSecondParagraph';
import { checkParagraphLength } from '../utils/analysis/rules/checkParagraphLength';
import { checkH2Structure } from '../utils/analysis/rules/checkH2Structure';
import { checkH2Count } from '../utils/analysis/rules/checkH2Count';
import { checkSubHeadingStructure } from '../utils/analysis/rules/checkSubHeadingStructure';
import { checkBetweenH2H3 } from '../utils/analysis/rules/checkBetweenH2H3';
import { checkFaqSection } from '../utils/analysis/rules/checkFaqSection';
import { checkAnswerParagraph } from '../utils/analysis/rules/checkAnswerParagraph';
import { checkAmbiguousHeadings } from '../utils/analysis/rules/checkAmbiguousHeadings';
import { checkPunctuation } from '../utils/analysis/rules/checkPunctuation';
import { checkParagraphEndings } from '../utils/analysis/rules/checkParagraphEndings';
import { checkInterrogativeH2 } from '../utils/analysis/rules/checkInterrogativeH2';
import { checkTransitionalWords } from '../utils/analysis/rules/checkTransitionalWords';
import { checkDuplicateWordsInParagraph, checkDuplicateWordsInHeading } from '../utils/analysis/rules/checkDuplicateWords';
import { checkSentenceLength } from '../utils/analysis/rules/checkSentenceLength';
import { checkStepsIntroduction } from '../utils/analysis/rules/checkStepsIntroduction';
import { checkAutomaticLists } from '../utils/analysis/rules/checkAutomaticLists';
import { checkCtaWords } from '../utils/analysis/rules/checkCtaWords';
import { checkInteractiveLanguage } from '../utils/analysis/rules/checkInteractiveLanguage';
import { checkArabicOnly } from '../utils/analysis/rules/checkArabicOnly';
import { checkConclusion } from '../utils/analysis/rules/checkConclusion';
import { checkSentenceBeginnings } from '../utils/analysis/rules/checkSentenceBeginnings';
import { checkWarningWords } from '../utils/analysis/rules/checkWarningWords';
import { checkSpacing } from '../utils/analysis/rules/checkSpacing';
import { checkRepeatedBigrams } from '../utils/analysis/rules/checkRepeatedBigrams';
import { checkSlowWords } from '../utils/analysis/rules/checkSlowWords';
import { checkWordConsistency } from '../utils/analysis/rules/checkWordConsistency';
import { checkWordsToDelete } from '../utils/analysis/rules/checkWordsToDelete';
import { checkKeywordStuffing } from '../utils/analysis/rules/checkKeywordStuffing';
import { checkDeviceSaleMandatoryH2, checkDeviceSaleSupportingH2 } from '../utils/analysis/rules/checkDeviceSaleH2';
import { checkTablesCount } from '../utils/analysis/rules/checkTablesCount';
import { checkHeadingLength } from '../utils/analysis/rules/checkHeadingLength';
import { FAQ_KEYWORDS, CONCLUSION_KEYWORDS } from '../constants';


// --- Main Hook ---

export const useContentAnalysis = (editorState: any, textContent: string, keywords: Keywords, aiGoal: string, articleLanguage: 'ar' | 'en', uiLanguage: 'ar' | 'en'): FullAnalysis => {
  return useMemo(() => {
    const t = translations[uiLanguage];
    
    // --- 1. Prepare Analysis Context ---
    const totalWordCount = textContent.trim().split(/\s+/).filter(Boolean).length;
    let nodes: { type: string; level?: number; text: string; node: any; pos: number }[] = [];
    let totalDocSize = 0;
    if (editorState?.content) {
      let pos = 0; // The document starts at position 0.
      editorState.content.forEach((node: any) => {
        if (!node || typeof node !== 'object') return;
        const nodeSize = getNodeSizeFromJSON(node);
        nodes.push({ 
            type: node.type, 
            level: node.attrs?.level, 
            text: getNodeText(node), 
            node,
            pos
        });
        pos += nodeSize;
        totalDocSize += nodeSize;
      });
    }

    const paragraphs = nodes.filter(n => n.type === 'paragraph');
    const nonEmptyParagraphs = paragraphs.filter(p => p.text.trim().length > 0);
    const headings = nodes.filter(n => n.type === 'heading');
    
    const L_FAQ_KEYWORDS = articleLanguage === 'ar' ? FAQ_KEYWORDS : ['questions', 'faq', 'frequently asked questions'];
    const L_CONCLUSION_KEYWORDS = articleLanguage === 'ar' ? CONCLUSION_KEYWORDS : ['conclusion', 'summary', 'in conclusion', 'in summary', 'finally', 'to sum up', 'lastly', 'in the end'];

    const faqSections: { startPos: number; endPos: number }[] = [];
    const faqH2Indices = nodes
        .map((node, index) => (node.type === 'heading' && node.level === 2 && L_FAQ_KEYWORDS.some(k => node.text.toLowerCase().includes(k.toLowerCase())) ? index : -1))
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
        return { text: sectionText, paragraphs: sectionParagraphs, hasList, hasNumber, wordCount: sectionText.trim().split(/\s+/).filter(Boolean).length };
    })();

    // --- 2. Run Prerequisite Analyses ---
    const { duplicateAnalysis, duplicateStats } = runDuplicateAnalysis(textContent, keywords, totalWordCount, articleLanguage);

    const analysisContext: AnalysisContext = {
      editorState,
      nodes,
      headings,
      paragraphs,
      nonEmptyParagraphs,
      textContent,
      totalWordCount,
      keywords,
      aiGoal,
      articleLanguage,
      uiLanguage,
      t,
      totalDocSize,
      faqSections,
      isPosInFaqSection,
      conclusionSection,
      duplicateAnalysis
    };
    
    // --- 3. Run All Analysis Rules ---
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
        punctuation: checkPunctuation(analysisContext),
        paragraphEndings: checkParagraphEndings(analysisContext),
        interrogativeH2: checkInterrogativeH2(analysisContext),
        differentTransitionalWords: checkTransitionalWords(analysisContext),
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
        spacing: checkSpacing(analysisContext),
        repeatedBigrams: checkRepeatedBigrams(analysisContext),
        slowWords: checkSlowWords(analysisContext),
        wordConsistency: checkWordConsistency(analysisContext),
        wordsToDelete: checkWordsToDelete(analysisContext),
        keywordStuffing: checkKeywordStuffing(analysisContext),
        mandatoryH2Sections: checkDeviceSaleMandatoryH2(analysisContext),
        supportingH2Sections: checkDeviceSaleSupportingH2(analysisContext),
        tablesCount: checkTablesCount(analysisContext),
    };
    
    // --- 4. Calculate Final Stats & Assemble Result ---
    const violatingCriteriaCount = Object.values(structureAnalysis).filter(c => c.status === 'fail').length;
    const totalErrorsCount = Object.values(structureAnalysis).reduce((sum, c) => sum + (c.violatingItems?.length || 0), 0);

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
  }, [editorState, textContent, keywords, aiGoal, articleLanguage, uiLanguage]);
};
