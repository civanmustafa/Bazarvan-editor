import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, getNodeContentAsText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSentenceLength = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['طول الجمل'];
    const title = tRule.title;
    const description = tRule.description;
    const MAX_WORDS = 20;
    const requiredText = tRule.required.replace('{MAX_WORDS}', String(MAX_WORDS));

    const details = uiLanguage === 'ar'
        ? "• يجب ألا يتجاوز طول الجملة الواحدة 20 كلمة.\n• يتم التسامح مع نسبة بسيطة (أقل من 20%) من الجمل الطويلة في المقال.\n• الجمل الطويلة تجعل النص صعب الفهم وتؤثر سلباً على تجربة المستخدم (UX)."
        : "• Each sentence should not exceed 20 words.\n• A small tolerance (less than 20%) of long sentences is allowed across the article.\n• Long sentences make text hard to process and negatively impact UX.";

    const violations: { from: number; to: number; message: string }[] = [];
    let totalSentences = 0;
    let longSentencesCount = 0;

    nonEmptyParagraphs.forEach(p => {
        const text = getNodeContentAsText(p.node);
        if (!text.trim()) return;

        const sentenceRegex = /([^\s.!?؟][^.!?؟]*[.!?؟]+|\S.*$)/g;
        const matches = [...text.matchAll(sentenceRegex)];
        totalSentences += matches.length;
        
        for (const match of matches) {
            const sentenceContent = (match[0] || '').trim();
            if (sentenceContent.length === 0) {
                totalSentences--;
                continue;
            }

            const wordCount = getWordCount(sentenceContent);
            if (wordCount > MAX_WORDS) {
                longSentencesCount++;
                const from = p.pos + 1 + (match.index || 0);
                const to = from + sentenceContent.length;
                violations.push({ from, to, message: t.violationMessages.currentWords(wordCount) });
            }
        }
    });

    if (totalSentences === 0) {
        return createCheckResult(title, 'pass', t.common.noSentences, requiredText, 1, description, details);
    }

    const longSentencesPercentage = longSentencesCount / totalSentences;
    const currentText = uiLanguage === 'ar' ? `${(longSentencesPercentage * 100).toFixed(0)}% من الجمل طويلة` : `${(longSentencesPercentage * 100).toFixed(0)}% of sentences are long`;
    
    let status: AnalysisStatus;
    const progress = (totalSentences - longSentencesCount) / totalSentences;

    if (longSentencesPercentage > 0.19) status = 'fail';
    else if (longSentencesPercentage > 0) status = 'warn';
    else status = 'pass';
    
    const result = createCheckResult(title, status, currentText, requiredText, progress, description, details);
    if (violations.length > 0) result.violatingItems = violations;
    return result;
};