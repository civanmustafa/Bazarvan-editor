import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkParagraphEndings = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t } = context;
    const tRule = t.structureAnalysis['نهايات الفقرات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: {from: number, to: number, message: string}[] = [];

    if (nonEmptyParagraphs.length < 2) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    for (let i = 0; i < nonEmptyParagraphs.length - 1; i++) {
        const p1 = nonEmptyParagraphs[i];
        const p2 = nonEmptyParagraphs[i+1];
        const lastWord1 = p1.text.trim().split(/\s+/).pop()?.replace(/[.!?؟:]/g, '');
        const lastWord2 = p2.text.trim().split(/\s+/).pop()?.replace(/[.!?؟:]/g, '');
        if (lastWord1 && lastWord2 && lastWord1 === lastWord2) {
            violations.push({
                from: p2.pos,
                to: p2.pos + getNodeSizeFromJSON(p2.node),
                message: t.violationMessages.repeatedEnding(lastWord1)
            });
        }
    }
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / nonEmptyParagraphs.length), description);
    result.violatingItems = violations;
    return result;
};
