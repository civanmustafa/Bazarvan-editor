import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { AMBIGUOUS_HEADING_WORDS } from '../../../constants';

export const checkAmbiguousHeadings = (context: AnalysisContext): CheckResult => {
    const { headings, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['عناوين مبهمة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const L_AMBIGUOUS_HEADING_WORDS = articleLanguage === 'ar' ? AMBIGUOUS_HEADING_WORDS : ['this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'its', 'their', 'the mentioned', 'the above', 'the former', 'the latter'];
    const details = L_AMBIGUOUS_HEADING_WORDS.join(', ');
    
    const h2s = headings.filter(h => h.level === 2);
    if (h2s.length === 0) {
        return createCheckResult(title, 'pass', t.common.noH2, requiredText, 1, description, details);
    }
    const violations = h2s.filter(h => L_AMBIGUOUS_HEADING_WORDS.some(word => countOccurrences(h.text, word, articleLanguage) > 0));
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.none, requiredText, 1, description, details);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / h2s.length), description, details);
    result.violatingItems = violations.map(v => ({
        from: v.pos,
        to: v.pos + getNodeSizeFromJSON(v.node),
        message: t.violationMessages.ambiguousHeading
    }));
    return result;
};
