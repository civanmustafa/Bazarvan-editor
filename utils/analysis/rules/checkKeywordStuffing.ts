import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkKeywordStuffing = (context: AnalysisContext): CheckResult => {
    const { keywords, nonEmptyParagraphs, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['حشو استهداف'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: {from: number, to: number, message: string}[] = [];
    
    if (keywords.primary && keywords.secondaries.some(s => s.trim())) {
        nonEmptyParagraphs.forEach(p => {
            const hasPrimary = countOccurrences(p.text, keywords.primary, articleLanguage) > 0;
            if (hasPrimary) {
                const foundSecondary = keywords.secondaries.find(s => s.trim() && countOccurrences(p.text, s, articleLanguage) > 0);
                if (foundSecondary) {
                    violations.push({
                        from: p.pos,
                        to: p.pos + getNodeSizeFromJSON(p.node),
                        message: t.violationMessages.keywordStuffing(keywords.primary, foundSecondary)
                    });
                }
            }
        });
    }
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 0, description);
    result.violatingItems = violations;
    return result;
};
