import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getStatus, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSummaryParagraph = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['الفقرة التلخيصية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const details = uiLanguage === 'ar'
        ? "• يجب أن تتكون الفقرة من 30 إلى 60 كلمة.\n• يجب أن تحتوي على 2 إلى 4 جمل.\n• الهدف: تقديم ملخص موجز وجذاب للمقال في البداية."
        : "• Paragraph must be between 30 and 60 words.\n• Must contain 2 to 4 sentences.\n• Goal: Provide a concise and engaging summary at the start.";

    if (nonEmptyParagraphs.length === 0) return createCheckResult(title, 'fail', t.common.none, requiredText, 0, description, details);
    
    const p = nonEmptyParagraphs[0];
    const wc = getWordCount(p.text);
    const sc = getSentenceCount(p.text);

    const wcStatus = getStatus(wc, 30, 60, 25, 65);
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