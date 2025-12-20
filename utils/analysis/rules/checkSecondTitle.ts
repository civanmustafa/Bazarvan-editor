import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSecondTitle = (context: AnalysisContext): CheckResult => {
    const { aiGoal, nodes, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['H2 الثاني'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const dayNightKeywords = articleLanguage === 'ar' ? ['أيام', 'ليالي'] : ['days', 'nights'];

    if (aiGoal !== 'برنامج سياحي') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }
    
    const firstH2Index = nodes.findIndex(n => n.type === 'heading' && n.level === 2);
    if (firstH2Index === -1) {
        return createCheckResult(title, 'fail', t.common.noH2, requiredText, 0, description);
    }
    const firstH2Node = nodes[firstH2Index];

    const textCondition = dayNightKeywords.some(kw => countOccurrences(firstH2Node.text, kw, articleLanguage) > 0);
    
    const nextH2Index = nodes.findIndex((n, index) => index > firstH2Index && n.type === 'heading' && n.level === 2);
    const sectionEndIndex = nextH2Index === -1 ? nodes.length : nextH2Index;
    const sectionNodes = nodes.slice(firstH2Index + 1, sectionEndIndex);
    const h3Count = sectionNodes.filter(n => n.type === 'heading' && n.level === 3).length;
    const h3Condition = h3Count >= 2;

    const status = textCondition && h3Condition ? 'pass' : 'fail';
    const current = `Text: ${textCondition ? t.common.yes : t.common.no}, H3s: ${h3Count}`;
    
    const result = createCheckResult(title, status, current, requiredText, status === 'pass' ? 1 : 0, description);
    if (status === 'fail') {
        result.violatingItems = [{
            from: firstH2Node.pos,
            to: firstH2Node.pos + getNodeSizeFromJSON(firstH2Node.node),
            message: t.violationMessages.secondTitle(textCondition, h3Count)
        }];
    }
    
    return result;
};
