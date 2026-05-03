import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, getNodeContentAsText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSentenceLength = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['طول الجمل'];
    const title = tRule.title;
    const description = tRule.description;
    const MIN_WORDS = 6;
    const MAX_WORDS = 20;
    const requiredText = tRule.required
        .replace('{MIN_WORDS}', String(MIN_WORDS))
        .replace('{MAX_WORDS}', String(MAX_WORDS));

    const details = uiLanguage === 'ar'
        ? "• يجب أن يكون طول الجملة الواحدة بين 6 و20 كلمة.\n• يتم التنبيه على الجمل القصيرة جدًا أو الطويلة جدًا.\n• ضبط طول الجمل يحسن الوضوح وسهولة القراءة وتجربة المستخدم (UX)."
        : "• Each sentence should be between 6 and 20 words.\n• Very short or overly long sentences are flagged.\n• Balanced sentence length improves clarity, readability, and UX.";

    const violations: { from: number; to: number; message: string }[] = [];
    let totalSentences = 0;
    let invalidSentencesCount = 0;

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
            if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
                invalidSentencesCount++;
                const from = p.pos + 1 + (match.index || 0);
                const to = from + sentenceContent.length;
                violations.push({ from, to, message: t.violationMessages.currentWords(wordCount) });
            }
        }
    });

    if (totalSentences === 0) {
        return createCheckResult(title, 'pass', t.common.noSentences, requiredText, 1, description, details);
    }

    const invalidSentencesPercentage = invalidSentencesCount / totalSentences;
    const currentText = uiLanguage === 'ar'
        ? `${(invalidSentencesPercentage * 100).toFixed(0)}% من الجمل خارج النطاق`
        : `${(invalidSentencesPercentage * 100).toFixed(0)}% of sentences are outside range`;
    
    let status: AnalysisStatus;
    const progress = (totalSentences - invalidSentencesCount) / totalSentences;

    if (invalidSentencesPercentage > 0.19) status = 'fail';
    else if (invalidSentencesPercentage > 0) status = 'warn';
    else status = 'pass';
    
    const result = createCheckResult(title, status, currentText, requiredText, progress, description, details);
    if (violations.length > 0) result.violatingItems = violations;
    return result;
};
