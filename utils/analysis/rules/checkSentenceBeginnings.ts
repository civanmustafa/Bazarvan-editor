import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON, getNodeContentAsText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSentenceBeginnings = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t } = context;
    const tRule = t.structureAnalysis['بدايات الجمل'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: {from: number, to: number, message: string}[] = [];

    nonEmptyParagraphs.forEach(p => {
        const text = getNodeContentAsText(p.node);
        const sentences = text.split(/[.!?؟]+/).filter(s => s.trim());
        if (sentences.length < 2) return;

        for (let i = 0; i < sentences.length - 1; i++) {
            const firstWord1 = sentences[i].trim().split(/\s+/)[0];
            const firstWord2 = sentences[i+1].trim().split(/\s+/)[0];
            if (firstWord1 && firstWord2 && firstWord1.toLowerCase() === firstWord2.toLowerCase()) {
                 violations.push({
                    from: p.pos, 
                    to: p.pos + getNodeSizeFromJSON(p.node), 
                    message: t.violationMessages.consecutiveSentences(firstWord1)
                });
            }
        }
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 0, description);
    result.violatingItems = violations;
    return result;
};