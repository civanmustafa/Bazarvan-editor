import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkAutomaticLists = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t } = context;
    const tRule = t.structureAnalysis['التعداد الآلي'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    
    const violations = nonEmptyParagraphs.filter(p => /^\s*(\d+\.|-|\*)\s+/.test(p.text));
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / nonEmptyParagraphs.length), description);
    result.violatingItems = violations.map(v => ({
        from: v.pos,
        to: v.pos + getNodeSizeFromJSON(v.node),
        message: t.violationMessages.manualList
    }));
    return result;
};
