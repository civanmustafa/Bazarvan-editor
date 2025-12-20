import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, countOccurrences } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { INTERACTIVE_WORDS } from '../../../constants';

export const checkInteractiveLanguage = (context: AnalysisContext): CheckResult => {
    const { textContent, totalWordCount, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['0.02% لغة تفاعلية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const ENGLISH_INTERACTIVE_WORDS = ['you can', 'you will find', 'you need', 'you want', 'discover', 'learn', 'try', 'choose', 'use', 'start', 'get', 'benefit', 'enjoy', 'read', 'watch', 'compare', 'check', 'did you know', 'have you ever', 'imagine', 'think about', 'explore', 'see how', 'your', 'unlock', 'uncover', 'consider', 'you', 'let\'s'];
    const L_INTERACTIVE_WORDS = articleLanguage === 'ar' ? INTERACTIVE_WORDS : ENGLISH_INTERACTIVE_WORDS;
    const details = L_INTERACTIVE_WORDS.join(', ');

    const count = L_INTERACTIVE_WORDS.reduce((sum, word) => sum + countOccurrences(textContent, word, articleLanguage), 0);
    const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
    const status = getStatus(percentage, 0.0002, 1);
    return createCheckResult(title, status, `${(percentage*100).toFixed(3)}%`, requiredText, Math.min(percentage / 0.0002, 1), description, details);
};
