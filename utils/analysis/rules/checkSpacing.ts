import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSpacing = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t } = context;
    const tRule = t.structureAnalysis['الفراغات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: {from: number, to: number, message: string}[] = [];
    const doubleSpaceRegex = / {2,}/g;

    nonEmptyParagraphs.forEach(p => {
        let match;
        while ((match = doubleSpaceRegex.exec(p.text)) !== null) {
            violations.push({
                from: p.pos + 1 + match.index,
                to: p.pos + 1 + match.index + match[0].length,
                message: t.violationMessages.extraSpaces
            });
        }
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 0, description);
    result.violatingItems = violations;
    return result;
};
