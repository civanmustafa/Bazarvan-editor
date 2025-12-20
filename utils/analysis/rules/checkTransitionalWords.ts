import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { TRANSITIONAL_WORDS } from '../../../constants';

export const checkTransitionalWords = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات إنتقالية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const ENGLISH_TRANSITIONAL_WORDS = ['firstly', 'secondly', 'finally', 'in addition', 'furthermore', 'therefore', 'consequently', 'on the other hand', 'in contrast', 'also', 'as well as', 'moreover', 'in fact', 'actually', 'in other words', 'for example', 'specifically', 'in general', 'however', 'although', 'while', 'in summary', 'in conclusion'];
    const L_TRANSITIONAL_WORDS = articleLanguage === 'ar' ? TRANSITIONAL_WORDS : ENGLISH_TRANSITIONAL_WORDS;

    const details = uiLanguage === 'ar'
        ? `• يجب أن تبدأ 30% من جمل المقال بكلمات انتقالية.\n• أمثلة: ${L_TRANSITIONAL_WORDS.slice(0, 15).join('، ')}.\n• الهدف: تحسين تدفق الأفكار وسلاسة القراءة للقارئ البشري وخوارزميات معالجة اللغة.`
        : `• At least 30% of sentences should start with transitional words.\n• Examples: ${L_TRANSITIONAL_WORDS.slice(0, 15).join(', ')}.\n• Goal: Improve idea flow and readability for both humans and NLP algorithms.`;

    let sentenceCount = 0;
    let transitionalCount = 0;

    nonEmptyParagraphs.forEach(p => {
        const sentences = p.text.split(/[.!?؟]+/).filter(s => s.trim());
        sentenceCount += sentences.length;
        sentences.forEach(s => {
            const firstWord = s.trim().split(/\s+/)[0];
            if (firstWord && L_TRANSITIONAL_WORDS.some(tw => tw.toLowerCase() === firstWord.toLowerCase())) {
                transitionalCount++;
            }
        });
    });
    
    if (sentenceCount === 0) {
        return createCheckResult(title, 'fail', '0%', requiredText, 0, description, details);
    }
    
    const percentage = transitionalCount / sentenceCount;
    const status = getStatus(percentage, 0.3, 1);
    return createCheckResult(title, status, `${(percentage*100).toFixed(0)}%`, requiredText, Math.min(percentage / 0.3, 1), description, details);
};