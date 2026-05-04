import type { CheckResult } from '../../../types';
import { createCheckResult, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkStepsIntroduction = (context: AnalysisContext): CheckResult => {
    const { nodes, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['تمهيد خطوات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = uiLanguage === 'ar'
        ? '• يجب أن تسبق كل قائمة فقرة تمهيدية مرتبطة بعنوان القسم مباشرة.\n• طول الفقرة التمهيدية: 15-40 كلمة و1-2 جملة.\n• يجب أن تنتهي الفقرة التمهيدية بعلامة نقطتين (:) لأنها تفتح التعداد التالي.'
        : '• Each list must be preceded by an introductory paragraph directly tied to the section heading.\n• Intro length: 15-40 words and 1-2 sentences.\n• The intro paragraph must end with a colon (:) because it introduces the following list.';

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
        const colonMet = /[:：]\s*$/.test(introNode.text.trim());

        if (!wordsMet || !sentencesMet || !colonMet) {
            const messageParts = [];
            if (!wordsMet || !sentencesMet) {
                messageParts.push(t.violationMessages.currentWordsSentences(wordCount, sentenceCount));
            }
            if (!colonMet) {
                messageParts.push(t.violationMessages.noIntroColon);
            }
             violations.push({
                from: introNode.pos,
                to: introNode.pos + getNodeSizeFromJSON(introNode.node),
                message: messageParts.join(' | ')
            });
        }
    });
    
    const progress = listIndices.length > 0 ? (listIndices.length - violations.length) / listIndices.length : 1;
    
    if (violations.length > 0) {
        const currentText = `${violations.length} ${t.common.violations}`;
        const result = createCheckResult(title, 'fail', currentText, requiredText, progress, description, details);
        result.violatingItems = violations;
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, t.common.allIntrosCompliant, 1, description, details);
};
