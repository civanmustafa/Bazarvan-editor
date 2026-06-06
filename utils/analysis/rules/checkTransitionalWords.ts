import type { CheckResult } from '../../../types';
import { createCheckResult, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { TRANSITIONAL_WORDS } from '../../../constants';

const TRANSITION_BOUNDARY_PATTERN = /[.!?؟،,؛;:：…]/u;
const TRANSITION_OPENING_CHARS_PATTERN = /[\s"'“”‘’«»()[\]{}<>]+/u;

const escapeTransitionRegex = (value: string): string => value.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

const ARABIC_OPTIONAL_MARKS_PATTERN = '[\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u0640]*';

const createArabicTransitionPattern = (term: string): string => {
    const normalizedTerm = normalizeArabicText(term)
        .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '');

    return Array.from(normalizedTerm).map(char => {
        if (/\s/.test(char)) return '\\s+';
        const normalizedChar = normalizeArabicText(char);
        let pattern = escapeTransitionRegex(char);
        if (normalizedChar === '\u0627') pattern = '[\u0627\u0622\u0623\u0625\u0671]';
        else if (normalizedChar === '\u064A') pattern = '[\u064A\u0649\u0626]';
        else if (normalizedChar === '\u0648') pattern = '[\u0648\u0624]';
        else if (normalizedChar === '\u0647') pattern = '[\u0647\u0629]';
        return `${pattern}${ARABIC_OPTIONAL_MARKS_PATTERN}`;
    }).join('');
};

const getTransitionSegmentStarts = (value: string): number[] => {
    const starts = new Set<number>([0]);
    for (let index = 0; index < value.length; index++) {
        if (TRANSITION_BOUNDARY_PATTERN.test(value[index])) {
            starts.add(index + 1);
        }
    }
    return Array.from(starts).sort((a, b) => a - b);
};

const skipTransitionSegmentPrefix = (value: string, start: number): number => {
    let cursor = start;
    while (cursor < value.length && TRANSITION_OPENING_CHARS_PATTERN.test(value[cursor])) {
        cursor += 1;
    }
    return cursor;
};

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

    const transitionPatterns = Array.from(new Set(
        L_TRANSITIONAL_WORDS
            .map(term => term.trim())
            .filter(Boolean)
    ))
        .sort((a, b) => b.length - a.length)
        .map(term => {
            const pattern = articleLanguage === 'ar'
                ? createArabicTransitionPattern(term)
                : escapeTransitionRegex(term).replace(/\s+/g, '\\s+');
            return {
                term,
                regex: new RegExp(`^${pattern}(?![\\p{L}\\p{N}])`, articleLanguage === 'ar' ? 'u' : 'iu'),
            };
        });

    const findTransitionAtSegmentStart = (value: string, rawStart: number): { from: number; to: number; text: string } | null => {
        const from = skipTransitionSegmentPrefix(value, rawStart);
        if (from >= value.length) return null;
        const segment = value.slice(from);
        for (const item of transitionPatterns) {
            const match = item.regex.exec(segment);
            if (!match) continue;
            return {
                from,
                to: from + match[0].length,
                text: match[0],
            };
        }
        return null;
    };

    const details = uiLanguage === 'ar'
        ? `• أقل من 20% مخالفة وتظهر باللون الأحمر.\n• بين 20% و30% مقبولة.\n• أكثر من 30% ممتازة.\n• تُحسب الكلمة الانتقالية فقط إذا بدأت فقرة أو جاءت مباشرة بعد علامة ترقيم مثل الفاصلة أو النقطة أو علامة الاستفهام أو النقطتين.\n• أمثلة: ${L_TRANSITIONAL_WORDS.slice(0, 15).join('، ')}.\n• الهدف: تحسين تدفق الأفكار وسلاسة القراءة للقارئ البشري وخوارزميات معالجة اللغة.`
        : `• Less than 20% is a violation and appears in red.\n• 20% to 30% is acceptable.\n• More than 30% is excellent.\n• A transitional word is counted only when it starts a paragraph or appears directly after punctuation such as a comma, period, question mark, or colon.\n• Examples: ${L_TRANSITIONAL_WORDS.slice(0, 15).join(', ')}.\n• Goal: Improve idea flow and readability for both humans and NLP algorithms.`;

    let segmentCount = 0;
    let transitionalCount = 0;

    nonEmptyParagraphs.forEach(p => {
        const starts = getTransitionSegmentStarts(p.text)
            .filter(start => p.text.slice(skipTransitionSegmentPrefix(p.text, start)).trim().length > 0);
        segmentCount += starts.length;
        starts.forEach(start => {
            if (findTransitionAtSegmentStart(p.text, start)) {
                transitionalCount++;
            }
        });
    });
    
    if (segmentCount === 0) {
        const emptyResult = createCheckResult(title, 'fail', '0%', requiredText, 0, description, details);
        emptyResult.displayCountLabel = '0%';
        return emptyResult;
    }
    
    const percentage = transitionalCount / segmentCount;
    const percentageLabel = `${Math.round(percentage * 100)}%`;
    const status: CheckResult['status'] = percentage > 0.3 ? 'pass' : percentage >= 0.2 ? 'warn' : 'fail';
    const result = createCheckResult(title, status, percentageLabel, requiredText, Math.min(percentage / 0.3, 1), description, details);
    result.displayCountLabel = percentageLabel;
    const matches = nodes
        .filter(node => (node.type === 'paragraph' || node.type === 'heading') && node.text.trim().length > 0)
        .flatMap(node => getTransitionSegmentStarts(node.text)
            .map(start => findTransitionAtSegmentStart(node.text, start))
            .filter((match): match is { from: number; to: number; text: string } => Boolean(match))
            .map(match => ({
                from: node.pos + 1 + match.from,
                to: node.pos + 1 + match.to,
                text: match.text,
                message: articleLanguage === 'ar' ? `كلمة انتقالية: "${match.text}"` : `Transitional word: "${match.text}"`,
            }))
        )
        .sort((a, b) => a.from - b.from || a.to - b.to);
    if (matches.length > 0) result.violatingItems = matches;
    return result;
};
