import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkPunctuation = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t } = context;
    const tRule = t.structureAnalysis['علامات الترقيم'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    if (nonEmptyParagraphs.length === 0) {
        return createCheckResult(title, 'pass', t.common.none, requiredText, 1, description);
    }

    const violations = nonEmptyParagraphs.filter(p => !/[.!?؟:]\s*$/.test(p.text.trim()));
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / nonEmptyParagraphs.length), description);
    result.violatingItems = violations.map(v => ({
        from: v.pos,
        to: v.pos + getNodeSizeFromJSON(v.node),
        message: t.violationMessages.noPunctuation
    }));
    return result;
};
