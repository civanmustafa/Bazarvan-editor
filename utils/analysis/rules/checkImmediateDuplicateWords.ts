import type { CheckResult } from '../../../types';
import { createCheckResult, getAnalysisNodeContentText, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

type WordToken = {
    text: string;
    normalized: string;
    index: number;
    end: number;
};

const normalizeWordToken = (value: string, articleLanguage: 'ar' | 'en'): string => {
    const lower = value.toLowerCase();
    return articleLanguage === 'ar' ? normalizeArabicText(lower) : lower;
};

const getWordTokens = (text: string, articleLanguage: 'ar' | 'en'): WordToken[] => {
    const tokens: WordToken[] = [];
    const wordRegex = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
    let match: RegExpExecArray | null;

    while ((match = wordRegex.exec(text)) !== null) {
        const word = match[0];
        tokens.push({
            text: word,
            normalized: normalizeWordToken(word, articleLanguage),
            index: match.index,
            end: match.index + word.length,
        });
    }

    return tokens;
};

export const checkImmediateDuplicateWords = (context: AnalysisContext): CheckResult => {
    const { nodes, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['تكرار مباشر'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: { from: number; to: number; message: string; text: string }[] = [];

    const textBlocks = nodes.filter(node => (
        (node.type === 'paragraph' || node.type === 'heading') &&
        node.text.trim().length > 0
    ));

    textBlocks.forEach((node) => {
        const text = getAnalysisNodeContentText(node);
        const tokens = getWordTokens(text, articleLanguage);

        for (let index = 1; index < tokens.length; index++) {
            const previous = tokens[index - 1];
            const current = tokens[index];
            const separator = text.slice(previous.end, current.index);

            if (!previous.normalized || previous.normalized !== current.normalized || !/^\s+$/u.test(separator)) {
                continue;
            }

            const from = node.pos + 1 + previous.index;
            const to = node.pos + 1 + current.end;
            violations.push({
                from,
                to,
                message: t.violationMessages.immediateDuplicateWord(`${previous.text} ${current.text}`),
                text: text.slice(previous.index, current.end),
            });
        }
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
    }

    const result = createCheckResult(
        title,
        'fail',
        `${violations.length} ${t.common.violations}`,
        requiredText,
        Math.max(0, 1 - (violations.length / Math.max(textBlocks.length, 1))),
        description,
    );
    result.violatingItems = violations;
    return result;
};
