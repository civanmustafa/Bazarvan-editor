import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkPunctuation = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['علامات الترقيم'];
    const title = tRule?.title || (uiLanguage === 'ar' ? 'علامات الترقيم' : 'Punctuation');
    const description = tRule?.description || '';
    const requiredText = tRule?.required || (uiLanguage === 'ar' ? 'إنهاء الفقرات بعلامة ترقيم' : 'End paragraphs with punctuation');
    const repeatedPunctuationRegex = /([.,!?;:،؛؟])\1+/gu;

    if (nonEmptyParagraphs.length === 0) {
        return createCheckResult(title, 'pass', t.common.none, requiredText, 1, description);
    }

    const missingEndPunctuationViolations = nonEmptyParagraphs
        .filter(p => !/[.!?؟:]\s*$/.test(p.text.trim()))
        .map(v => ({
            from: v.pos,
            to: v.pos + getNodeSizeFromJSON(v.node),
            message: t.violationMessages.noPunctuation,
        }));

    const repeatedPunctuationViolations = nonEmptyParagraphs.flatMap(p => {
        const paragraphViolations: { from: number; to: number; message: string }[] = [];
        let match: RegExpExecArray | null;
        repeatedPunctuationRegex.lastIndex = 0;

        while ((match = repeatedPunctuationRegex.exec(p.text)) !== null) {
            paragraphViolations.push({
                from: p.pos + 1 + match.index,
                to: p.pos + 1 + match.index + match[0].length,
                message: t.violationMessages.repeatedPunctuation(match[0]),
            });
        }

        return paragraphViolations;
    });

    const violations = [...missingEndPunctuationViolations, ...repeatedPunctuationViolations];

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const progress = Math.max(0, 1 - (violations.length / nonEmptyParagraphs.length));
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, progress, description);
    result.violatingItems = violations;
    return result;
};
