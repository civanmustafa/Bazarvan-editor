import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getStatus, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSecondParagraph = (context: AnalysisContext): CheckResult => {
    const { nodes, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['الفقرة الثانية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const details = uiLanguage === 'ar'
        ? "• تقع هذه الفقرة في المقدمة مباشرة بعد الفقرة التلخيصية.\n• يجب أن تتكون من 40 إلى 80 كلمة.\n• يجب أن تحتوي على 2 إلى 4 جمل.\n• الهدف: التمهيد للمحتوى الأساسي بشكل مباشر."
        : "• This paragraph sits in the intro right after the summary.\n• Must be between 40 and 80 words.\n• Must contain 2 to 4 sentences.\n• Goal: Transition directly to the main content.";

    const firstHeadingIndex = nodes.findIndex(n => n.type === 'heading');
    const introductionNodes = firstHeadingIndex === -1 ? nodes : nodes.slice(0, firstHeadingIndex);
    const introductionParagraphs = introductionNodes.filter(n => n.type === 'paragraph' && n.text.trim().length > 0);
    
    if (introductionParagraphs.length < 2) {
        return createCheckResult(title, 'fail', t.common.noSecondParagraph, requiredText, 0, description, details);
    }
    
    const p = introductionParagraphs[1];
    const wc = getWordCount(p.text);
    const sc = getSentenceCount(p.text);
    
    const wcStatus = getStatus(wc, 40, 80, 35, 85);
    const scMet = sc >= 2 && sc <= 4;

    let finalStatus: AnalysisStatus;
    if (!scMet) {
        finalStatus = 'fail';
    } else {
        finalStatus = wcStatus;
    }
    
    const progress = finalStatus === 'pass' ? 1 : (finalStatus === 'warn' ? 0.5 : 0);
    const currentText = `${wc} ${t.common.words}, ${sc} ${t.common.sentences}`;

    const result = createCheckResult(title, finalStatus, currentText, requiredText, progress, description, details);
    
    if (finalStatus !== 'pass') {
        result.violatingItems = [{
            from: p.pos,
            to: p.pos + getNodeSizeFromJSON(p.node),
            message: t.violationMessages.currentWordsSentences(wc, sc),
        }];
    }
    
    return result;
};
