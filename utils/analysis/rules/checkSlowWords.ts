import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, countOccurrences } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { SLOW_WORDS } from '../../../constants';

export const checkSlowWords = (context: AnalysisContext): CheckResult => {
    const { textContent, totalWordCount, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات بطيئة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const ENGLISH_SLOW_WORDS = ['actually', 'basically', 'literally', 'in fact', 'in order to', 'just', 'really', 'very', 'quite', 'somewhat', 'in a way', 'so to speak', 'of course', 'as you know', 'essentially', 'practically', 'generally', 'in essence', 'regarding', 'in relation to', 'it seems that', 'apparently', 'it is considered', 'needless to say', 'it goes without saying', 'for the most part', 'it is important to note', 'in this context', 'furthermore', 'additionally'];
    const L_SLOW_WORDS = articleLanguage === 'ar' ? SLOW_WORDS : ENGLISH_SLOW_WORDS;

    const details = uiLanguage === 'ar'
        ? `• الكلمات البطيئة هي كلمات حشو تضعف إيقاع النص.\n• يجب ألا تتجاوز نسبتها 2% من إجمالي الكلمات.\n• أمثلة: ${L_SLOW_WORDS.slice(0, 10).join('، ')}.\n• الهدف: جعل النص أكثر حيوية ومباشرة وديناميكية.`
        : `• Slow words are filler words that weaken text rhythm.\n• Should not exceed 2% of total word count.\n• Examples: ${L_SLOW_WORDS.slice(0, 10).join(', ')}.\n• Goal: Make the text more vivid, direct, and dynamic.`;

    const count = L_SLOW_WORDS.reduce((sum, word) => sum + countOccurrences(textContent, word, articleLanguage), 0);
    const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
    const status = getStatus(percentage, 0, 0.02);
    return createCheckResult(title, status, `${(percentage*100).toFixed(1)}%`, requiredText, 1 - Math.min(percentage / 0.02, 1), description, details);
};