import type { CheckResult } from '../../../types';
import { createCheckResult, getWordCount, countOccurrences, getStatus, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const createH2KeywordAndWordCountCheck = (
    context: AnalysisContext,
    originalTitleKey: string,
    keywords: string[],
): CheckResult => {
    const { nodes, headings, articleLanguage, t } = context;
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const targetH2s = headings.filter(h => h.level === 2 && keywords.some(k => countOccurrences(h.text, k, articleLanguage) > 0));

    if (targetH2s.length === 0) {
        return createCheckResult(title, 'fail', t.common.notFound, requiredText, 0, description);
    }
    
    const targetH2 = targetH2s[0]; 
    const targetH2Index = nodes.findIndex(n => n.pos === targetH2.pos);

    const nextHeadingIndex = nodes.findIndex((n, index) => index > targetH2Index && n.type === 'heading');
    const endOfSectionIndex = nextHeadingIndex === -1 ? nodes.length : nextHeadingIndex;

    const sectionNodes = nodes.slice(targetH2Index + 1, endOfSectionIndex);
    const sectionText = sectionNodes.filter(n => n.type === 'paragraph').map(n => n.text).join(' ');
    const wordCount = getWordCount(sectionText);
    
    const status = getStatus(wordCount, 150, 180);

    const result = createCheckResult(title, status, `${wordCount} ${t.common.words}`, requiredText, Math.min(wordCount / 180, 1), description);
    
    if (status === 'fail') {
        result.violatingItems = [{
            from: targetH2.pos,
            to: targetH2.pos + getNodeSizeFromJSON(targetH2.node),
            message: t.violationMessages.currentWords(wordCount),
        }];
    }
    
    return result;
};

export const checkPreTravelH2 = (context: AnalysisContext): CheckResult => {
    const { analysisGoal, t } = context;
    const originalTitleKey = "H2 قبل السفر";
    const tRule = t.structureAnalysis[originalTitleKey];
    const keywords = context.articleLanguage === 'ar' ? ["معلومات", "ما قبل السفر", "ما عليك معرفته"] : ["information", "before you travel", "what to know"];
    
    if (analysisGoal !== 'برنامج سياحي') {
        return createCheckResult(tRule.title, 'pass', t.common.notApplicable, tRule.required, 1, tRule.description);
    }
    
    return createH2KeywordAndWordCountCheck(context, originalTitleKey, keywords);
};
