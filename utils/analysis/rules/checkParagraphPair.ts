import type { CheckResult } from '../../../types';
import {
    createCheckResult,
    DUPLICATE_WORDS_EXCLUSION_LIST,
    getNodeSizeFromJSON,
    normalizeArabicText,
} from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

type ParagraphEntry = AnalysisContext['nonEmptyParagraphs'][number];

type ParagraphWordSet = {
    paragraph: ParagraphEntry;
    words: Map<string, string>;
};

type ParagraphPairMatch = {
    first: ParagraphWordSet;
    second: ParagraphWordSet;
    sharedWords: string[];
    sharedRatio: number;
};

const MIN_UNIQUE_WORDS_PER_PARAGRAPH = 8;
const FAIL_SHARED_RATIO = 0.30;
const WORDS_DISPLAY_LIMIT = 28;

const ARABIC_EXCLUSION_WORDS = new Set([
    'الذي', 'التي', 'الذين', 'اللذان', 'اللتان', 'هذا', 'هذه', 'ذلك', 'تلك', 'هناك',
    'هنا', 'يمكن', 'يجب', 'عند', 'قبل', 'بعد', 'كما', 'لكن', 'لذلك', 'حتى', 'اذا',
    'ايضا', 'ضمن', 'حول', 'خلال', 'بين', 'عبر', 'كل', 'بعض', 'غير', 'مثل', 'اكثر',
    'اقل', 'جدا', 'فقط', 'كان', 'كانت', 'يكون', 'تكون', 'لهذا', 'بهذا', 'منها',
    'فيها', 'عليه', 'عليها', 'اليه', 'اليها',
]);

const ENGLISH_EXCLUSION_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
    'has', 'have', 'had', 'not', 'but', 'about', 'into', 'over', 'after', 'before', 'between',
    'when', 'where', 'which', 'while', 'their', 'there', 'these', 'those', 'can', 'will',
    'should', 'would', 'could', 'also', 'than', 'then', 'more', 'most',
]);

const normalizeComparableWord = (word: string, articleLanguage: 'ar' | 'en'): string => {
    const normalized = articleLanguage === 'ar'
        ? normalizeArabicText(word.toLowerCase())
        : word.toLowerCase();

    if (articleLanguage !== 'ar') return normalized;

    return normalized
        .replace(/^(وال|فال|بال|كال|ولل|فلل|لل|ال)/u, '')
        .replace(/^[وفبكل](?=\p{L}{3,})/u, '');
};

const addPhraseWordsToExclusions = (
    phrase: string | undefined,
    exclusionSet: Set<string>,
    articleLanguage: 'ar' | 'en'
) => {
    if (!phrase) return;

    const wordRegex = articleLanguage === 'ar' ? /\p{L}{2,}/gu : /[a-zA-Z]{2,}/g;
    let match;
    while ((match = wordRegex.exec(phrase)) !== null) {
        const normalizedWord = normalizeComparableWord(match[0], articleLanguage);
        if (normalizedWord.length >= 2) {
            exclusionSet.add(normalizedWord);
        }
    }
};

const buildExclusionSet = (context: AnalysisContext): Set<string> => {
    const { articleLanguage, keywords } = context;
    const exclusionSet = articleLanguage === 'ar'
        ? new Set([
            ...Array.from(DUPLICATE_WORDS_EXCLUSION_LIST).map(word => normalizeComparableWord(word, articleLanguage)),
            ...Array.from(ARABIC_EXCLUSION_WORDS).map(word => normalizeComparableWord(word, articleLanguage)),
        ])
        : new Set(ENGLISH_EXCLUSION_WORDS);

    addPhraseWordsToExclusions(keywords.primary, exclusionSet, articleLanguage);
    keywords.secondaries.forEach(keyword => addPhraseWordsToExclusions(keyword, exclusionSet, articleLanguage));
    addPhraseWordsToExclusions(keywords.company, exclusionSet, articleLanguage);

    return exclusionSet;
};

const getEligibleParagraphs = (context: AnalysisContext): ParagraphEntry[] => {
    const { nodes, nonEmptyParagraphs, conclusionSection } = context;
    const excludedParagraphPositions = new Set<number>();

    if (nonEmptyParagraphs[0]) {
        excludedParagraphPositions.add(nonEmptyParagraphs[0].pos);
    }

    const firstH2Index = nodes.findIndex(node => node.type === 'heading' && node.level === 2);
    if (firstH2Index !== -1) {
        nodes.slice(0, firstH2Index).forEach((node) => {
            if (node.type === 'paragraph' && node.text.trim().length > 0) {
                excludedParagraphPositions.add(node.pos);
            }
        });
    } else {
        nonEmptyParagraphs.slice(0, 2).forEach(paragraph => excludedParagraphPositions.add(paragraph.pos));
    }

    conclusionSection?.paragraphs.forEach((paragraph: ParagraphEntry) => {
        excludedParagraphPositions.add(paragraph.pos);
    });

    return nonEmptyParagraphs.filter(paragraph => !excludedParagraphPositions.has(paragraph.pos));
};

const getParagraphWordSet = (
    paragraph: ParagraphEntry,
    exclusionSet: Set<string>,
    articleLanguage: 'ar' | 'en'
): ParagraphWordSet => {
    const words = new Map<string, string>();
    const wordRegex = articleLanguage === 'ar' ? /\p{L}{3,}/gu : /[a-zA-Z]{3,}/g;
    let match;

    while ((match = wordRegex.exec(paragraph.text)) !== null) {
        const originalWord = match[0];
        const normalizedWord = normalizeComparableWord(originalWord, articleLanguage);

        if (normalizedWord.length < 3 || exclusionSet.has(normalizedWord)) continue;
        if (!words.has(normalizedWord)) {
            words.set(normalizedWord, originalWord);
        }
    }

    return { paragraph, words };
};

const findParagraphPairs = (paragraphWordSets: ParagraphWordSet[]): ParagraphPairMatch[] => {
    const pairs: ParagraphPairMatch[] = [];

    for (let i = 0; i < paragraphWordSets.length - 1; i += 1) {
        const first = paragraphWordSets[i];
        if (first.words.size < MIN_UNIQUE_WORDS_PER_PARAGRAPH) continue;

        for (let j = i + 1; j < paragraphWordSets.length; j += 1) {
            const second = paragraphWordSets[j];
            if (second.words.size < MIN_UNIQUE_WORDS_PER_PARAGRAPH) continue;

            const sharedNormalizedWords = Array.from(first.words.keys()).filter(word => second.words.has(word));
            if (sharedNormalizedWords.length === 0) continue;

            const smallerWordSetSize = Math.min(first.words.size, second.words.size);
            const sharedRatio = sharedNormalizedWords.length / Math.max(smallerWordSetSize, 1);
            const sharedWords = sharedNormalizedWords.map(word => first.words.get(word) || word);
            pairs.push({ first, second, sharedWords, sharedRatio });
        }
    }

    return pairs.sort((a, b) =>
        b.sharedRatio - a.sharedRatio ||
        b.sharedWords.length - a.sharedWords.length
    );
};

const formatSharedWords = (sharedWords: string[], articleLanguage: 'ar' | 'en'): string => {
    const shownWords = sharedWords.slice(0, WORDS_DISPLAY_LIMIT);
    const separator = articleLanguage === 'ar' ? '، ' : ', ';
    const suffix = sharedWords.length > WORDS_DISPLAY_LIMIT
        ? `${separator}+${sharedWords.length - WORDS_DISPLAY_LIMIT}`
        : '';
    return `${shownWords.join(separator)}${suffix}`;
};

const formatSharedPercentage = (sharedRatio: number): string => (
    (sharedRatio * 100).toFixed(1).replace(/\.0$/, '')
);

export const checkParagraphPair = (context: AnalysisContext): CheckResult => {
    const { articleLanguage, uiLanguage, t } = context;
    const tRule = t.structureAnalysis['زوج فقرات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = uiLanguage === 'ar'
        ? 'يفحص جميع أزواج الفقرات داخل المتن فقط، مع استثناء فقرة المقدمة والفقرة التلخيصية والخاتمة، وبعد استثناء الكلمات العامة وكلمات العبارة المفتاحية الأساسية والصيغ البديلة واسم الشركة. يصبح المعيار خطأ عند وجود أي زوج فقرات تتجاوز نسبة التشابه بينهما 30% من أصغر الفقرتين، ويعرض رقم الخطأ عدد الأزواج المتجاوزة لهذا الحد.'
        : 'Checks all body paragraph pairs, excluding intro, summary, and conclusion paragraphs, then excluding common words, the primary keyword, alternate keyword forms, and the company name. The criterion fails when any paragraph pair exceeds 30% overlap of the smaller paragraph, and the error count shows the number of pairs above that limit.';

    const eligibleParagraphs = getEligibleParagraphs(context);

    if (eligibleParagraphs.length < 2) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const exclusionSet = buildExclusionSet(context);
    const paragraphWordSets = eligibleParagraphs.map(paragraph =>
        getParagraphWordSet(paragraph, exclusionSet, articleLanguage)
    );
    const paragraphPairs = findParagraphPairs(paragraphWordSets);
    const violatingPairs = paragraphPairs.filter(pair => pair.sharedRatio > FAIL_SHARED_RATIO);
    const strongestPair = paragraphPairs[0] || null;

    if (!strongestPair) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    if (violatingPairs.length === 0) {
        const sharedCount = strongestPair.sharedWords.length;
        const percentage = formatSharedPercentage(strongestPair.sharedRatio);
        const currentText = articleLanguage === 'ar'
            ? `${sharedCount} كلمة مشتركة (${percentage}%)`
            : `${sharedCount} shared words (${percentage}%)`;
        return createCheckResult(title, 'pass', currentText, requiredText, 1, description, details);
    }

    const strongestViolationPair = violatingPairs[0];
    const strongestPercentage = formatSharedPercentage(strongestViolationPair.sharedRatio);
    const currentText = articleLanguage === 'ar'
        ? `${violatingPairs.length} أزواج أعلى من 30% (الأعلى ${strongestPercentage}%)`
        : `${violatingPairs.length} pairs above 30% (highest ${strongestPercentage}%)`;

    const result = createCheckResult(title, 'fail', currentText, requiredText, 0, description, details);
    result.violationCount = violatingPairs.length;
    result.violatingItems = violatingPairs.flatMap((pair) => {
        const sharedCount = pair.sharedWords.length;
        const percentage = formatSharedPercentage(pair.sharedRatio);
        const sharedWordsText = formatSharedWords(pair.sharedWords, articleLanguage);
        const message = articleLanguage === 'ar'
            ? `زوج فقرات يتشارك ${sharedCount} كلمة (${percentage}%). الكلمات المشتركة: ${sharedWordsText}`
            : `Paragraph pair shares ${sharedCount} words (${percentage}%). Shared words: ${sharedWordsText}`;
        const firstParagraph = pair.first.paragraph;
        const secondParagraph = pair.second.paragraph;
        const firstTo = firstParagraph.pos + getNodeSizeFromJSON(firstParagraph.node);
        const secondTo = secondParagraph.pos + getNodeSizeFromJSON(secondParagraph.node);

        return [
            {
                from: firstParagraph.pos,
                to: firstTo,
                message,
                pairedFrom: secondParagraph.pos,
                pairedTo: secondTo,
                pairedText: secondParagraph.text,
            },
            {
                from: secondParagraph.pos,
                to: secondTo,
                message,
                pairedFrom: firstParagraph.pos,
                pairedTo: firstTo,
                pairedText: firstParagraph.text,
            },
        ];
    });

    return result;
};
