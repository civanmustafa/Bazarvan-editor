import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkIncludesExcludes = (context: AnalysisContext): CheckResult => {
    const { analysisGoal, headings, nodes, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['يشمل/لايشمل'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const includesKeywords = articleLanguage === 'ar' ? ['يشمل'] : ['includes', "what's included"];
    const excludesKeywords = articleLanguage === 'ar' ? ['لا يشمل'] : ['excludes', 'does not include', "what's not included"];

    if (analysisGoal !== 'برنامج سياحي') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }

    const h2IncludesHeadings = headings.filter(h => h.level === 2 && includesKeywords.some(kw => countOccurrences(h.text, kw, articleLanguage) > 0));

    if (h2IncludesHeadings.length === 0) {
        return createCheckResult(title, 'fail', t.violationMessages.noH2WithIncludes, requiredText, 0, description);
    }

    if (h2IncludesHeadings.length > 1) {
        const result = createCheckResult(title, 'fail', `${h2IncludesHeadings.length} H2s with 'includes'`, requiredText, 0, description);
        result.violatingItems = h2IncludesHeadings.map(h => ({
            from: h.pos, to: h.pos + getNodeSizeFromJSON(h.node), message: t.violationMessages.includesExcludes_multiple
        }));
        return result;
    }

    const targetH2 = h2IncludesHeadings[0];
    const targetH2Index = nodes.findIndex(n => n.pos === targetH2.pos);
    
    const nextH2Index = nodes.findIndex((n, index) => index > targetH2Index && n.type === 'heading' && n.level === 2);
    const sectionEndIndex = nextH2Index === -1 ? nodes.length : nextH2Index;
    const sectionNodes = nodes.slice(targetH2Index + 1, sectionEndIndex);
    
    const sectionH3s = sectionNodes.filter(n => n.type === 'heading' && n.level === 3);

    const hasIncludesH3 = sectionH3s.some(h3 => includesKeywords.some(kw => countOccurrences(h3.text, kw, articleLanguage) > 0));
    const hasExcludesH3 = sectionH3s.some(h3 => excludesKeywords.some(kw => countOccurrences(h3.text, kw, articleLanguage) > 0));

    const status = hasIncludesH3 && hasExcludesH3 ? 'pass' : 'fail';
    const current = `H3 'includes': ${hasIncludesH3 ? t.common.yes : t.common.no}, H3 'excludes': ${hasExcludesH3 ? t.common.yes : t.common.no}`;
    
    const result = createCheckResult(title, status, current, requiredText, status === 'pass' ? 1 : 0, description);
    if (status === 'fail') {
         result.violatingItems = [{
            from: targetH2.pos,
            to: targetH2.pos + getNodeSizeFromJSON(targetH2.node),
            message: t.violationMessages.includesExcludes_state(current)
         }];
    }
    return result;
};
