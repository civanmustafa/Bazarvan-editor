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
const FAIL_SHARED_WORDS = 8;
const WARN_SHARED_WORDS = 5;
const FAIL_SHARED_RATIO = 0.35;
const WARN_SHARED_RATIO = 0.25;
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

const findStrongestParagraphPair = (paragraphWordSets: ParagraphWordSet[]): ParagraphPairMatch | null => {
    let strongestPair: ParagraphPairMatch | null = null;

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
            const candidate: ParagraphPairMatch = { first, second, sharedWords, sharedRatio };

            if (!strongestPair) {
                strongestPair = candidate;
                continue;
            }

            if (
                candidate.sharedWords.length > strongestPair.sharedWords.length ||
                (
                    candidate.sharedWords.length === strongestPair.sharedWords.length &&
                    candidate.sharedRatio > strongestPair.sharedRatio
                )
            ) {
                strongestPair = candidate;
            }
        }
    }

    return strongestPair;
};

const formatSharedWords = (sharedWords: string[], articleLanguage: 'ar' | 'en'): string => {
    const shownWords = sharedWords.slice(0, WORDS_DISPLAY_LIMIT);
    const separator = articleLanguage === 'ar' ? '، ' : ', ';
    const suffix = sharedWords.length > WORDS_DISPLAY_LIMIT
        ? `${separator}+${sharedWords.length - WORDS_DISPLAY_LIMIT}`
        : '';
    return `${shownWords.join(separator)}${suffix}`;
};

export const checkParagraphPair = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, articleLanguage, uiLanguage, t } = context;
    const tRule = t.structureAnalysis['زوج فقرات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = uiLanguage === 'ar'
        ? 'يبحث عن أقوى زوج فقرات من حيث الكلمات المشتركة بعد استثناء الكلمات العامة وكلمات العبارة المفتاحية الأساسية والصيغ البديلة واسم الشركة. يصبح خارج الحد عند وجود 8 كلمات مشتركة أو أكثر، أو عند بلوغ التشارك 35% من أصغر الفقرتين.'
        : 'Finds the strongest paragraph pair by shared meaningful words after excluding common words, the primary keyword, alternate keyword forms, and the company name. It fails at 8+ shared words or 35% overlap of the smaller paragraph.';

    if (nonEmptyParagraphs.length < 2) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const exclusionSet = buildExclusionSet(context);
    const paragraphWordSets = nonEmptyParagraphs.map(paragraph =>
        getParagraphWordSet(paragraph, exclusionSet, articleLanguage)
    );
    const strongestPair = findStrongestParagraphPair(paragraphWordSets);

    if (!strongestPair) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const sharedCount = strongestPair.sharedWords.length;
    const sharedRatio = strongestPair.sharedRatio;
    const percentage = Math.round(sharedRatio * 100);
    const isFail = sharedCount >= FAIL_SHARED_WORDS || sharedRatio >= FAIL_SHARED_RATIO;
    const isWarn = sharedCount >= WARN_SHARED_WORDS || sharedRatio >= WARN_SHARED_RATIO;
    const currentText = articleLanguage === 'ar'
        ? `${sharedCount} كلمة مشتركة (${percentage}%)`
        : `${sharedCount} shared words (${percentage}%)`;

    if (!isFail && !isWarn) {
        return createCheckResult(title, 'pass', currentText, requiredText, 1, description, details);
    }

    const status = isFail ? 'fail' : 'warn';
    const sharedWordsText = formatSharedWords(strongestPair.sharedWords, articleLanguage);
    const message = articleLanguage === 'ar'
        ? `أقوى زوج فقرات يتشارك ${sharedCount} كلمة (${percentage}%). الكلمات المشتركة: ${sharedWordsText}`
        : `Strongest paragraph pair shares ${sharedCount} words (${percentage}%). Shared words: ${sharedWordsText}`;
    const progressPressure = Math.max(sharedCount / FAIL_SHARED_WORDS, sharedRatio / FAIL_SHARED_RATIO);
    const progress = Math.max(0, 1 - Math.min(progressPressure, 1));

    const result = createCheckResult(title, status, currentText, requiredText, progress, description, details);
    result.violatingItems = [strongestPair.first.paragraph, strongestPair.second.paragraph].map(paragraph => ({
        from: paragraph.pos,
        to: paragraph.pos + getNodeSizeFromJSON(paragraph.node),
        message,
    }));

    return result;
};
