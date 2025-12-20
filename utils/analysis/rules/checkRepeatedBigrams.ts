import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkRepeatedBigrams = (context: AnalysisContext): CheckResult => {
    const { duplicateAnalysis, t } = context;
    const tRule = t.structureAnalysis['ثنائيات مكررة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    
    const bigrams = duplicateAnalysis[2];
    const violations = bigrams.filter(b => b.count > 2);

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / bigrams.length), description);
    result.violatingItems = violations.map(v => ({
        from: v.locations[0], to: v.locations[0] + v.text.length, message: t.violationMessages.bigramRepetition(v.text, v.count)
    }));
    return result;
};
