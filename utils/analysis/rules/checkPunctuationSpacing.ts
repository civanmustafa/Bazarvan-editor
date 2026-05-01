import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const noSpaceBeforeMarks = new Set(['.', '!', '؟', '?', ',', '،']);
const requireSpaceBeforeMarks = new Set(['"', '/', '(', '*', '-', '&', '%']);
const requireSpaceAfterMarks = new Set(['-', '%', '&', ')', '!']);
const punctuationAfterClosingParen = new Set(['،', ',', '.', '!']);
const whitespaceRegex = /[\s\u00A0]/u;
const digitRegex = /\p{N}/u;
const letterRegex = /\p{L}/u;

const isWhitespace = (value: string | undefined): boolean => !!value && whitespaceRegex.test(value);
const isDigit = (value: string | undefined): boolean => !!value && digitRegex.test(value);
const isLetter = (value: string | undefined): boolean => !!value && letterRegex.test(value);

const findPreviousNonSpaceIndex = (text: string, startIndex: number): number => {
    for (let index = startIndex; index >= 0; index--) {
        if (!isWhitespace(text[index])) return index;
    }
    return -1;
};

const findNextNonSpaceIndex = (text: string, startIndex: number): number => {
    for (let index = startIndex; index < text.length; index++) {
        if (!isWhitespace(text[index])) return index;
    }
    return -1;
};

const isNumericHyphen = (text: string, index: number): boolean => {
    if (text[index] !== '-') return false;
    const previousIndex = findPreviousNonSpaceIndex(text, index - 1);
    const nextIndex = findNextNonSpaceIndex(text, index + 1);
    return previousIndex !== -1 && nextIndex !== -1 && isDigit(text[previousIndex]) && isDigit(text[nextIndex]);
};

const hasSpacesAroundNumericHyphen = (text: string, index: number): boolean => {
    return isWhitespace(text[index - 1]) || isWhitespace(text[index + 1]);
};

const getSpaceRunBefore = (text: string, index: number): number => {
    let start = index - 1;
    while (start >= 0 && isWhitespace(text[start])) {
        start--;
    }
    return start + 1;
};

const getSpaceRunAfterEnd = (text: string, index: number): number => {
    let end = index + 1;
    while (end < text.length && isWhitespace(text[end])) {
        end++;
    }
    return end;
};

export const checkPunctuationSpacing = (context: AnalysisContext): CheckResult => {
    const { nodes, t } = context;
    const tRule = t.structureAnalysis['فراغات الترقيم'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const violations: { from: number; to: number; message: string }[] = [];
    const seenViolations = new Set<string>();
    const textNodes = nodes.filter(node => (
        (node.type === 'paragraph' || node.type === 'heading') &&
        node.text.trim().length > 0
    ));
    const violatingNodePositions = new Set<number>();

    const addViolation = (
        nodePos: number,
        fromIndex: number,
        toIndex: number,
        message: string,
    ) => {
        const from = nodePos + 1 + fromIndex;
        const to = nodePos + 1 + Math.max(toIndex, fromIndex + 1);
        const key = `${from}:${to}:${message}`;
        if (seenViolations.has(key)) return;
        seenViolations.add(key);
        violations.push({ from, to, message });
        violatingNodePositions.add(nodePos);
    };

    textNodes.forEach(node => {
        const text = node.text;

        for (let index = 0; index < text.length; index++) {
            const mark = text[index];
            const previousChar = text[index - 1];
            const nextChar = text[index + 1];

            if (mark === '-' && isNumericHyphen(text, index)) {
                if (hasSpacesAroundNumericHyphen(text, index)) {
                    const previousNumberIndex = findPreviousNonSpaceIndex(text, index - 1);
                    const nextNumberIndex = findNextNonSpaceIndex(text, index + 1);
                    addViolation(
                        node.pos,
                        previousNumberIndex + 1,
                        nextNumberIndex,
                        t.violationMessages.numericHyphenSpacing,
                    );
                }
                continue;
            }

            if (requireSpaceBeforeMarks.has(mark) && index > 0 && !isWhitespace(previousChar)) {
                addViolation(
                    node.pos,
                    index,
                    index + 1,
                    t.violationMessages.punctuationMissingSpace(mark),
                );
            }

            if (noSpaceBeforeMarks.has(mark) && isWhitespace(previousChar)) {
                const spaceStartIndex = getSpaceRunBefore(text, index);
                const previousNonSpaceIndex = spaceStartIndex - 1;
                const isClosingParenPunctuation =
                    previousNonSpaceIndex >= 0 &&
                    text[previousNonSpaceIndex] === ')' &&
                    punctuationAfterClosingParen.has(mark);

                if (!isClosingParenPunctuation) {
                    addViolation(
                        node.pos,
                        spaceStartIndex,
                        index + 1,
                        t.violationMessages.punctuationSpacing(mark),
                    );
                }
            }

            if (requireSpaceAfterMarks.has(mark) && index < text.length - 1) {
                const hasExactlyOneSpaceAfter =
                    isWhitespace(nextChar) &&
                    (index + 2 >= text.length || !isWhitespace(text[index + 2]));

                if (!hasExactlyOneSpaceAfter) {
                    const toIndex = isWhitespace(nextChar)
                        ? getSpaceRunAfterEnd(text, index)
                        : index + 1;
                    addViolation(
                        node.pos,
                        index,
                        toIndex,
                        t.violationMessages.punctuationMissingSpaceAfter(mark),
                    );
                }
            }
        }

        let index = 0;
        while (index < text.length) {
            if (!isDigit(text[index])) {
                index++;
                continue;
            }

            const start = index;
            while (index < text.length && isDigit(text[index])) {
                index++;
            }
            const end = index;

            if (isLetter(text[start - 1])) {
                addViolation(
                    node.pos,
                    start,
                    end,
                    t.violationMessages.numberMissingSpaceBefore,
                );
            }

            if (isLetter(text[end])) {
                addViolation(
                    node.pos,
                    start,
                    end,
                    t.violationMessages.numberMissingSpaceAfter,
                );
            }
        }
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, tRule.details);
    }

    const progress = textNodes.length > 0
        ? (textNodes.length - violatingNodePositions.size) / textNodes.length
        : 0;
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, progress, description, tRule.details);
    result.violatingItems = violations;
    return result;
};
