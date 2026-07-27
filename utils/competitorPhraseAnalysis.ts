export type CompetitorRepeatedPhrase = {
    text: string;
    size: number;
    count: number;
};

export type CompetitorWordFrequency = {
    word: string;
    count: number;
};

export type CompetitorTextStats = {
    totalWords: number;
    uniqueWords: number;
    topWords: CompetitorWordFrequency[];
    repeatedPhrases: CompetitorRepeatedPhrase[];
};

export type CompetitorPhraseSource = {
    competitorNumber: number;
    text: string;
};

export type SharedCompetitorPhraseOccurrence = {
    competitorNumber: number;
    count: number;
};

export type SharedCompetitorPhrase = {
    text: string;
    size: number;
    totalCount: number;
    competitors: SharedCompetitorPhraseOccurrence[];
};

const COMPETITOR_PHRASE_LENGTHS = [3, 4, 5] as const;

const COMPETITOR_STOP_WORDS = new Set([
    'في', 'من', 'إلى', 'الى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'أو', 'او', 'أم', 'ام', 'بل', 'لا', 'نعم',
    'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'والى', 'وإلى', 'ومن', 'وعلى', 'وفي', 'عنها', 'عنه', 'منها', 'منه',
    'الذي', 'التي', 'الذين', 'اللذين', 'اللتين', 'اللاتي', 'اللواتي', 'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء', 'أولئك',
    'هو', 'هي', 'هما', 'هم', 'هن', 'أنا', 'انا', 'نحن', 'أنت', 'انت', 'أنتم', 'انتم', 'أنتن', 'انتن', 'أنتما', 'انتما',
    'كان', 'كانت', 'كانوا', 'يكون', 'تكون', 'يتم', 'تم', 'قد', 'لقد', 'إن', 'ان', 'أن', 'الى', 'كما', 'كل', 'أي', 'اي',
    'غير', 'سوى', 'ما', 'ماذا', 'لماذا', 'كيف', 'متى', 'أين', 'اين', 'إذا', 'اذا', 'لكن', 'لذلك', 'لذا',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'as', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'we', 'our',
]);

const normalizeCompetitorToken = (value: string): string => (
    value
        .normalize('NFKC')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .toLowerCase()
);

export const tokenizeCompetitorPhraseText = (value: string): string[] => (
    value
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .map(normalizeCompetitorToken)
        .filter(Boolean)
);

const countCompetitorPhrases = (
    words: string[],
): Map<string, { size: number; count: number }> => {
    const phraseCounts = new Map<string, { size: number; count: number }>();

    COMPETITOR_PHRASE_LENGTHS.forEach(size => {
        for (let index = 0; index <= words.length - size; index += 1) {
            const phrase = words.slice(index, index + size).join(' ');
            phraseCounts.set(phrase, {
                size,
                count: (phraseCounts.get(phrase)?.count || 0) + 1,
            });
        }
    });

    return phraseCounts;
};

const sortRepeatedPhrases = (
    left: CompetitorRepeatedPhrase,
    right: CompetitorRepeatedPhrase,
): number => (
    right.size - left.size
    || right.count - left.count
    || left.text.localeCompare(right.text)
);

export const createCompetitorTextStats = (texts: string[]): CompetitorTextStats => {
    const tokenizedTexts = texts.map(tokenizeCompetitorPhraseText).filter(words => words.length > 0);
    const words = tokenizedTexts.flat();
    const wordCounts = new Map<string, number>();
    const filteredWordCounts = new Map<string, number>();
    const phraseCounts = new Map<string, { size: number; count: number }>();

    words.forEach(word => {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        if (word.length > 1 && !COMPETITOR_STOP_WORDS.has(word)) {
            filteredWordCounts.set(word, (filteredWordCounts.get(word) || 0) + 1);
        }
    });

    tokenizedTexts.forEach(textWords => {
        countCompetitorPhrases(textWords).forEach((value, phrase) => {
            phraseCounts.set(phrase, {
                size: value.size,
                count: (phraseCounts.get(phrase)?.count || 0) + value.count,
            });
        });
    });

    const topWords = Array.from(filteredWordCounts.entries())
        .map(([word, count]) => ({ word, count }))
        .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word))
        .slice(0, 5);

    const repeatedPhrases = Array.from(phraseCounts.entries())
        .map(([text, value]) => ({ text, size: value.size, count: value.count }))
        .filter(item => item.count > 1)
        .sort(sortRepeatedPhrases);

    return {
        totalWords: words.length,
        uniqueWords: wordCounts.size,
        topWords,
        repeatedPhrases,
    };
};

export const createSharedCompetitorPhrases = (
    sources: CompetitorPhraseSource[],
): SharedCompetitorPhrase[] => {
    const phrases = new Map<string, {
        size: number;
        totalCount: number;
        competitors: Map<number, number>;
    }>();

    sources.forEach(source => {
        const words = tokenizeCompetitorPhraseText(source.text);
        countCompetitorPhrases(words).forEach((value, phrase) => {
            const current = phrases.get(phrase) || {
                size: value.size,
                totalCount: 0,
                competitors: new Map<number, number>(),
            };
            current.totalCount += value.count;
            current.competitors.set(source.competitorNumber, value.count);
            phrases.set(phrase, current);
        });
    });

    return Array.from(phrases.entries())
        .map(([text, value]): SharedCompetitorPhrase => ({
            text,
            size: value.size,
            totalCount: value.totalCount,
            competitors: Array.from(value.competitors.entries())
                .map(([competitorNumber, count]) => ({ competitorNumber, count }))
                .sort((left, right) => left.competitorNumber - right.competitorNumber),
        }))
        .filter(item => item.competitors.length > 1)
        .sort((left, right) => (
            right.size - left.size
            || right.competitors.length - left.competitors.length
            || right.totalCount - left.totalCount
            || left.text.localeCompare(right.text)
        ));
};
