import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeContentAsText, normalizeArabicText, DUPLICATE_WORDS_EXCLUSION_LIST } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const findDuplicateWords = (
    context: AnalysisContext,
    nodeType: 'paragraph' | 'heading',
): CheckResult => {
    const { nodes, keywords, articleLanguage, t } = context;
    const originalTitleKey = nodeType === 'paragraph' ? 'تكرار بالفقرة' : 'تكرار بالعنوان';
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const details = nodeType === 'paragraph' && articleLanguage === 'ar' ? DUPLICATE_WORDS_EXCLUSION_LIST.toString() : undefined;

    const exclusionSet = articleLanguage === 'ar' ? new Set(DUPLICATE_WORDS_EXCLUSION_LIST) : new Set();
    if (nodeType === 'paragraph' && keywords) {
        const addPhraseToExclusionSet = (phrase: string) => {
            if (!phrase) return;
            phrase.trim().split(/\s+/).forEach(word => {
                if (word) {
                    const normalizedWord = articleLanguage === 'ar' ? normalizeArabicText(word.toLowerCase()) : word.toLowerCase();
                    exclusionSet.add(normalizedWord);
                }
            });
        };

        addPhraseToExclusionSet(keywords.primary);
        keywords.secondaries.forEach(addPhraseToExclusionSet);
        keywords.lsi.forEach(addPhraseToExclusionSet);
    }

    const relevantNodes = nodes.filter(n => n.type === nodeType && n.text.trim().length > 0);
    
    if (relevantNodes.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, tRule.required, 1, description, details);
    }
    
    const violations: { from: number; to: number; message: string }[] = [];
    const violatingNodePositions = new Set<number>();

    relevantNodes.forEach(node => {
        const text = getNodeContentAsText(node.node);
        const wordsMap: Map<string, { text: string; index: number }[]> = new Map();
        
        const wordRegex = articleLanguage === 'ar' ? /\p{L}{3,}/gu : /[a-zA-Z]{3,}/g;
        let match;

        while ((match = wordRegex.exec(text)) !== null) {
            const wordText = match[0];
            const normalizedWord = articleLanguage === 'ar' ? normalizeArabicText(wordText.toLowerCase()) : wordText.toLowerCase();

            if (exclusionSet.has(normalizedWord)) continue;

            if (!wordsMap.has(normalizedWord)) wordsMap.set(normalizedWord, []);
            wordsMap.get(normalizedWord)!.push({ text: wordText, index: match.index });
        }

        wordsMap.forEach((occurrences, word) => {
            if (occurrences.length > 1) {
                violatingNodePositions.add(node.pos);
                occurrences.forEach(occurrence => {
                    const from = node.pos + 1 + occurrence.index;
                    const to = from + occurrence.text.length;
                    violations.push({ from, to, message: t.violationMessages.repeatedWord(word) });
                });
            }
        });
    });
    
    const progress = relevantNodes.length > 0 ? (relevantNodes.length - violatingNodePositions.size) / relevantNodes.length : 1;

    if (violatingNodePositions.size === 0) {
        return createCheckResult(title, 'pass', t.common.good, tRule.required, 1, description, details);
    }

    const currentText = `${violations.length} ${t.common.repetitions}`;
    const result = createCheckResult(title, 'fail', currentText, tRule.required, progress, description, details);
    result.violatingItems = violations;
    return result;
};

export const checkDuplicateWordsInParagraph = (context: AnalysisContext): CheckResult => {
    return findDuplicateWords(context, 'paragraph');
};

export const checkDuplicateWordsInHeading = (context: AnalysisContext): CheckResult => {
    return findDuplicateWords(context, 'heading');
};