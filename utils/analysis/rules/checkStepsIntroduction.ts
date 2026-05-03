import type { CheckResult } from '../../../types';
import { createCheckResult, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkStepsIntroduction = (context: AnalysisContext): CheckResult => {
    const { nodes, t } = context;
    const tRule = t.structureAnalysis['تمهيد خطوات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const listIndices = nodes
        .map((node, index) => (node.type === 'bulletList' || node.type === 'orderedList' ? index : -1))
        .filter(index => index !== -1);
    
    if (listIndices.length === 0) {
        return createCheckResult(title, 'pass', t.common.noLists, requiredText, 1, description);
    }
    
    const violations: { from: number; to: number; message: string }[] = [];
    
    listIndices.forEach(listIndex => {
        const introNodeIndex = listIndex - 1;
        if (introNodeIndex < 0 || nodes[introNodeIndex].type !== 'paragraph') {
            violations.push({
                from: nodes[listIndex].pos,
                to: nodes[listIndex].pos + 1, // Highlight the start of the list
                message: t.violationMessages.noIntroParagraph
            });
            return;
        }

        const introNode = nodes[introNodeIndex];
        const wordCount = getWordCount(introNode.text);
        const sentenceCount = getSentenceCount(introNode.text);
        
        const wordsMet = wordCount >= 15 && wordCount <= 40;
        const sentencesMet = sentenceCount >= 1 && sentenceCount <= 2;

        if (!wordsMet || !sentencesMet) {
             violations.push({
                from: introNode.pos,
                to: introNode.pos + getNodeSizeFromJSON(introNode.node),
                message: t.violationMessages.currentWordsSentences(wordCount, sentenceCount)
            });
        }
    });
    
    const progress = listIndices.length > 0 ? (listIndices.length - violations.length) / listIndices.length : 1;
    
    if (violations.length > 0) {
        const currentText = `${violations.length} ${t.common.violations}`;
        const result = createCheckResult(title, 'fail', currentText, requiredText, progress, description);
        result.violatingItems = violations;
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, t.common.allIntrosCompliant, 1, description);
};
