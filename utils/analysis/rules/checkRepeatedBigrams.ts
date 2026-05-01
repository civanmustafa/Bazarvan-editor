import type { CheckResult } from '../../../types';
import { createCheckResult, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const tokenizeForComparison = (text: string, articleLanguage: 'ar' | 'en'): string[] => {
    const normalized = articleLanguage === 'ar'
        ? normalizeArabicText(text.toLowerCase())
        : text.toLowerCase();
    return normalized.match(/[\p{L}\p{N}]+/gu) || [];
};

const containsTokenSequence = (tokens: string[], sequence: string[]): boolean => {
    if (sequence.length === 0 || sequence.length > tokens.length) return false;

    for (let index = 0; index <= tokens.length - sequence.length; index++) {
        const isMatch = sequence.every((token, offset) => tokens[index + offset] === token);
        if (isMatch) return true;
    }

    return false;
};

export const checkRepeatedBigrams = (context: AnalysisContext): CheckResult => {
    const { duplicateAnalysis, nonEmptyParagraphs, t, articleLanguage, keywords } = context;
    const tRule = t.structureAnalysis['ثنائيات مكررة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const protectedKeywordTokens = [
        keywords.primary,
        ...keywords.secondaries,
        ...keywords.lsi,
        keywords.company,
    ]
        .map(term => tokenizeForComparison(term.trim(), articleLanguage))
        .filter(tokens => tokens.length > 0);

    const isProtectedBigram = (text: string): boolean => {
        const bigramTokens = tokenizeForComparison(text, articleLanguage);
        if (bigramTokens.length === 0) return false;

        return protectedKeywordTokens.some(keywordTokens => (
            containsTokenSequence(bigramTokens, keywordTokens) ||
            containsTokenSequence(keywordTokens, bigramTokens)
        ));
    };
    
    const bigrams = duplicateAnalysis[2];
    const repeatedBigrams = bigrams.filter(b => b.count > 2);
    const violations = repeatedBigrams.filter(b => !isProtectedBigram(b.text));

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }
    const result = createCheckResult(
        title,
        'fail',
        `${violations.length} ${t.common.violations}`,
        requiredText,
        1 - (violations.length / Math.max(repeatedBigrams.length, 1)),
        description,
    );
    result.violatingItems = violations.map(v => {
        const escapedText = v.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const target = articleLanguage === 'ar' ? escapedText.replace(/ا|أ|إ|آ/g, '[اأإآ]').replace(/ي|ى/g, '[يى]').replace(/ه|ة/g, '[هة]').replace(/و|ؤ/g, '[وؤ]').replace(/ء|ئ/g, '[ءئ]') : escapedText;
        const regex = new RegExp(target.replace(/\s+/g, '\\s+'), 'iu');
        const paragraph = nonEmptyParagraphs.find(p => regex.test(p.text));
        const match = paragraph?.text.match(regex);
        const from = paragraph && match?.index !== undefined ? paragraph.pos + 1 + match.index : 0;
        const matchedText = match?.[0] || v.text;
        return {
            from,
            to: from + matchedText.length,
            message: t.violationMessages.bigramRepetition(v.text, v.count)
        };
    }).filter(item => item.from > 0 && item.to > item.from);
    return result;
};
