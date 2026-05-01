import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkPunctuationSpacing = (context: AnalysisContext): CheckResult => {
    const { nodes, t } = context;
    const tRule = t.structureAnalysis['فراغات الترقيم'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: { from: number; to: number; message: string }[] = [];
    const punctuationSpacingRegex = /[ \t\u00A0]+\p{P}/gu;
    const textNodes = nodes.filter(node => (
        (node.type === 'paragraph' || node.type === 'heading') &&
        node.text.trim().length > 0
    ));
    const violatingNodePositions = new Set<number>();

    textNodes.forEach(node => {
        let match;
        while ((match = punctuationSpacingRegex.exec(node.text)) !== null) {
            const punctuationMark = match[0].trim();
            const from = node.pos + 1 + match.index;
            violations.push({
                from,
                to: from + match[0].length,
                message: t.violationMessages.punctuationSpacing(punctuationMark),
            });
            violatingNodePositions.add(node.pos);
        }
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const progress = textNodes.length > 0
        ? (textNodes.length - violatingNodePositions.size) / textNodes.length
        : 0;
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, progress, description);
    result.violatingItems = violations;
    return result;
};
