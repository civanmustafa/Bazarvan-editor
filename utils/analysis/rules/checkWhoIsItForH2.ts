import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkWhoIsItForH2 = (context: AnalysisContext): CheckResult => {
    const { analysisGoal, headings, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['H2 المرشح'];
    const title = tRule.title;
    const description = tRule.description;
    const keywords = articleLanguage === 'ar' ? ["مناسب", "مرشح", "يناسب"] : ["suitable for", "who is this for", "ideal for"];
    const requiredText = tRule.required;

    if (analysisGoal !== 'برنامج سياحي') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }
    
    const targetH2s = headings.filter(h => h.level === 2 && keywords.some(k => countOccurrences(h.text, k, articleLanguage) > 0));

    if (targetH2s.length > 0) {
        const result = createCheckResult(title, 'pass', t.common.found, requiredText, 1, description);
        result.violatingItems = targetH2s.map(h => ({
            from: h.pos,
            to: h.pos + getNodeSizeFromJSON(h.node),
            message: `${t.common.foundHeading}: ${h.text}`
        }));
        return result;
    }

    return createCheckResult(title, 'fail', t.common.notFound, requiredText, 0, description);
};
