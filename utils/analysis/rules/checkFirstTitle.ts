import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, getWordCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkFirstTitle = (context: AnalysisContext): CheckResult => {
    const { aiGoal, nodes, t } = context;
    const tRule = t.structureAnalysis['العنوان الاول'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    if (aiGoal !== 'برنامج سياحي') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }
    
    const h1Index = nodes.findIndex(n => n.type === 'heading' && n.level === 1);
    if (h1Index === -1) {
        return createCheckResult(title, 'fail', t.common.noH1, requiredText, 0, description);
    }

    const nextHeadingIndex = nodes.findIndex((n, index) => index > h1Index && n.type === 'heading');
    const endOfSectionIndex = nextHeadingIndex === -1 ? nodes.length : nextHeadingIndex;

    const sectionNodes = nodes.slice(h1Index + 1, endOfSectionIndex);
    const sectionText = sectionNodes.filter(n => n.type === 'paragraph').map(n => n.text).join(' ');
    const wordCount = getWordCount(sectionText);
    const status = getStatus(wordCount, 150, 200);

    const result = createCheckResult(title, status, wordCount, requiredText, Math.min(wordCount / 200, 1), description);
    
    if (status === 'fail') {
        const h1Node = nodes[h1Index];
        result.violatingItems = [{
            from: h1Node.pos,
            to: h1Node.pos + getNodeSizeFromJSON(h1Node.node),
            message: t.violationMessages.currentWords(wordCount),
        }];
    }
    
    return result;
};
