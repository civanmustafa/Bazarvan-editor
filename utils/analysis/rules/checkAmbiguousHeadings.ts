import type { CheckResult } from '../../../types';
import { createCheckResult, countOccurrences, getNodeSizeFromJSON, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { AMBIGUOUS_HEADING_WORDS, INTERROGATIVE_H2_KEYWORDS } from '../../../constants';

type ArabicHeadingToken = {
    text: string;
    ambiguousWord?: string;
};

const EXTRA_ARABIC_INTERROGATIVE_WORDS = ['ماذا', 'أي', 'أيهما'];
const ARABIC_AMBIGUOUS_PREFIXES = ['وال', 'فال', 'بال', 'كال', 'ولل', 'فلل', 'وبال', 'فبال', 'وب', 'فب', 'لل', 'و', 'ف', 'ب', 'ك', 'ل'];

const normalizeArabicHeadingWord = (word: string): string => normalizeArabicText(word.toLowerCase());

const ARABIC_INTERROGATIVE_WORDS = new Set(
    [...INTERROGATIVE_H2_KEYWORDS, ...EXTRA_ARABIC_INTERROGATIVE_WORDS].map(normalizeArabicHeadingWord)
);

const getArabicAmbiguousBase = (token: string, ambiguousWords: Set<string>): string | undefined => {
    if (ambiguousWords.has(token)) return token;

    for (const prefix of ARABIC_AMBIGUOUS_PREFIXES.map(normalizeArabicHeadingWord)) {
        if (!token.startsWith(prefix) || token.length <= prefix.length + 1) continue;
        const stripped = token.slice(prefix.length);
        if (ambiguousWords.has(stripped)) return stripped;
    }

    return undefined;
};

const getArabicHeadingTokens = (text: string, ambiguousWords: Set<string>): ArabicHeadingToken[] => {
    const normalizedText = normalizeArabicText(text.toLowerCase());
    const tokens: ArabicHeadingToken[] = [];
    const wordRegex = /\p{L}+/gu;
    let match;

    while ((match = wordRegex.exec(normalizedText)) !== null) {
        const token = match[0];
        tokens.push({
            text: token,
            ambiguousWord: getArabicAmbiguousBase(token, ambiguousWords),
        });
    }

    return tokens;
};

const isAllowedQuestionFormulaAmbiguity = (tokens: ArabicHeadingToken[], index: number): boolean => {
    if (index <= 0 || !ARABIC_INTERROGATIVE_WORDS.has(tokens[0]?.text)) return false;
    if (index > 2) return false;

    for (let i = 1; i < index; i += 1) {
        if (!tokens[i].ambiguousWord) return false;
    }

    return true;
};

const hasAmbiguousHeadingIssue = (
    headingText: string,
    ambiguousWords: string[],
    articleLanguage: 'ar' | 'en'
): boolean => {
    if (articleLanguage !== 'ar') {
        return ambiguousWords.some(word => countOccurrences(headingText, word, articleLanguage) > 0);
    }

    const normalizedAmbiguousWords = new Set(ambiguousWords.map(normalizeArabicHeadingWord));
    const tokens = getArabicHeadingTokens(headingText, normalizedAmbiguousWords);

    return tokens.some((token, index) =>
        Boolean(token.ambiguousWord) && !isAllowedQuestionFormulaAmbiguity(tokens, index)
    );
};

export const checkAmbiguousHeadings = (context: AnalysisContext): CheckResult => {
    const { headings, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['عناوين مبهمة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const L_AMBIGUOUS_HEADING_WORDS = articleLanguage === 'ar' ? AMBIGUOUS_HEADING_WORDS : ['this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'its', 'their', 'the mentioned', 'the above', 'the former', 'the latter'];
    const details = L_AMBIGUOUS_HEADING_WORDS.join(', ');
    
    const h2s = headings.filter(h => h.level === 2);
    if (h2s.length === 0) {
        return createCheckResult(title, 'pass', t.common.noH2, requiredText, 1, description, details);
    }
    const violations = h2s.filter(h => hasAmbiguousHeadingIssue(h.text, L_AMBIGUOUS_HEADING_WORDS, articleLanguage));
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.none, requiredText, 1, description, details);
    }

    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 1 - (violations.length / h2s.length), description, details);
    result.violatingItems = violations.map(v => ({
        from: v.pos,
        to: v.pos + getNodeSizeFromJSON(v.node),
        message: t.violationMessages.ambiguousHeading
    }));
    return result;
};
