import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkRepeatedBigrams = (context: AnalysisContext): CheckResult => {
    const { duplicateAnalysis, nonEmptyParagraphs, t, articleLanguage } = context;
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
    result.violatingItems = violations.map(v => {
        const escapedText = v.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const target = articleLanguage === 'ar' ? escapedText.replace(/ا|أ|إ|آ/g, '[اأإآ]').replace(/ي|ى/g, '[يى]').replace(/ه|ة/g, '[هة]').replace(/و|ؤ/g, '[وؤ]').replace(/ء|ئ/g, '[ءئ]') : escapedText;
        const regex = new RegExp(target.replace(/\s+/g, '\\s+'), 'iu');
        const paragraph = nonEmptyParagraphs.find(p => regex.test(p.text));
        const match = paragraph?.text.match(regex);
        const from = paragraph && match?.index !== undefined ? paragraph.pos + 1 + match.index : 0;
        const matchedText = match?.[0] || v.text;
        return {
            from,
            to: from + matchedText.length,
            message: t.violationMessages.bigramRepetition(v.text, v.count)
        };
    }).filter(item => item.from > 0 && item.to > item.from);
    return result;
};
