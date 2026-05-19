import type { CheckResult } from '../../../types';
import { createCheckResult, findTermMatchesInNodes, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { TRANSITIONAL_WORDS } from '../../../constants';

export const checkTransitionalWords = (context: AnalysisContext): CheckResult => {
    const { nodes, nonEmptyParagraphs, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات إنتقالية'];
    const title = tRule.title;
    const description = uiLanguage === 'ar'
        ? 'يقيس نسبة الجمل التي تبدأ بكلمات انتقالية. أقل من 20% مخالفة، وبين 20% و30% مقبول، وأكثر من 30% ممتاز.'
        : 'Measures the percentage of sentences that start with transitional words. Less than 20% is a violation, 20% to 30% is acceptable, and more than 30% is excellent.';
    const requiredText = uiLanguage === 'ar' ? '20%-30% مقبول | >30% ممتاز' : '20%-30% acceptable | >30% excellent';
    const ENGLISH_TRANSITIONAL_WORDS = ['firstly', 'secondly', 'finally', 'in addition', 'furthermore', 'therefore', 'consequently', 'on the other hand', 'in contrast', 'also', 'as well as', 'moreover', 'in fact', 'actually', 'in other words', 'for example', 'specifically', 'in general', 'however', 'although', 'while', 'in summary', 'in conclusion'];
    const L_TRANSITIONAL_WORDS = articleLanguage === 'ar' ? TRANSITIONAL_WORDS : ENGLISH_TRANSITIONAL_WORDS;
    const normalizeTransitionText = (value: string): string => {
        const normalized = articleLanguage === 'ar'
            ? normalizeArabicText(value.toLowerCase())
            : value.toLowerCase();
        return normalized
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    };
    const normalizedTransitionWords = Array.from(new Set(
        L_TRANSITIONAL_WORDS
            .map(term => normalizeTransitionText(term))
            .filter(Boolean)
    )).sort((a, b) => b.length - a.length);
    const startsWithTransition = (sentence: string): boolean => {
        const normalizedSentence = normalizeTransitionText(sentence);
        if (!normalizedSentence) return false;
        return normalizedTransitionWords.some(term => (
            normalizedSentence === term ||
            normalizedSentence.startsWith(`${term} `)
        ));
    };

    const details = uiLanguage === 'ar'
        ? `• أقل من 20% مخالفة وتظهر باللون الأحمر.\n• بين 20% و30% مقبولة.\n• أكثر من 30% ممتازة.\n• أمثلة: ${L_TRANSITIONAL_WORDS.slice(0, 15).join('، ')}.\n• الهدف: تحسين تدفق الأفكار وسلاسة القراءة للقارئ البشري وخوارزميات معالجة اللغة.`
        : `• Less than 20% is a violation and appears in red.\n• 20% to 30% is acceptable.\n• More than 30% is excellent.\n• Examples: ${L_TRANSITIONAL_WORDS.slice(0, 15).join(', ')}.\n• Goal: Improve idea flow and readability for both humans and NLP algorithms.`;

    let sentenceCount = 0;
    let transitionalCount = 0;

    nonEmptyParagraphs.forEach(p => {
        const sentences = p.text.split(/[.!?؟]+/).filter(s => s.trim());
        sentenceCount += sentences.length;
        sentences.forEach(s => {
            if (startsWithTransition(s)) {
                transitionalCount++;
            }
        });
    });
    
    if (sentenceCount === 0) {
        const emptyResult = createCheckResult(title, 'fail', '0%', requiredText, 0, description, details);
        emptyResult.displayCountLabel = '0%';
        return emptyResult;
    }
    
    const percentage = transitionalCount / sentenceCount;
    const percentageLabel = `${Math.round(percentage * 100)}%`;
    const status: CheckResult['status'] = percentage > 0.3 ? 'pass' : percentage >= 0.2 ? 'warn' : 'fail';
    const result = createCheckResult(title, status, percentageLabel, requiredText, Math.min(percentage / 0.3, 1), description, details);
    result.displayCountLabel = percentageLabel;
    const matches = findTermMatchesInNodes(nodes, L_TRANSITIONAL_WORDS, articleLanguage, word =>
        articleLanguage === 'ar' ? `كلمة انتقالية: "${word}"` : `Transitional word: "${word}"`
    );
    if (matches.length > 0) result.violatingItems = matches;
    return result;
};
