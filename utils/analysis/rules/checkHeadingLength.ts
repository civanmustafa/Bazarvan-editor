import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkHeadingLength = (context: AnalysisContext): CheckResult => {
    const { headings, t } = context;
    const tRule = t.structureAnalysis['طول العناوين'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const rules = {
        2: { min: 40, max: 70 }, // H2
        3: { min: 30, max: 60 }, // H3
        4: { min: 20, max: 50 }, // H4
    };

    const relevantHeadings = headings.filter(h => h.level && (h.level === 2 || h.level === 3 || h.level === 4));
    
    if (relevantHeadings.length === 0) {
        return createCheckResult(title, 'pass', t.common.noHeadings, requiredText, 1, description);
    }

    const violations: { from: number; to: number; message: string }[] = [];
    
    relevantHeadings.forEach(heading => {
        const level = heading.level as 2 | 3 | 4;
        const rule = rules[level];
        const length = heading.text.length;

        if (length < rule.min || length > rule.max) {
            violations.push({
                from: heading.pos,
                to: heading.pos + getNodeSizeFromJSON(heading.node),
                message: t.violationMessages.headingLength(level, length, rule.min, rule.max)
            });
        }
    });

    const progress = (relevantHeadings.length - violations.length) / relevantHeadings.length;

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.compliant, requiredText, 1, description);
    }

    const currentText = `${violations.length} ${t.common.violations}`;
    const result = createCheckResult(title, 'fail', currentText, requiredText, progress, description);
    result.violatingItems = violations;
    return result;
};
