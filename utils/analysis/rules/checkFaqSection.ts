import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkFaqSection = (context: AnalysisContext): CheckResult => {
    const { faqSections, t } = context;
    const tRule = t.structureAnalysis['الأسئلة والاجوبة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    if (faqSections.length > 0) {
        return createCheckResult(title, 'pass', t.common.found, requiredText, 1, description);
    }
    return createCheckResult(title, 'fail', t.common.notFound, requiredText, 0, description);
};
