import type { Keywords } from '../types';

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

export type CompetitorPhraseIntelligenceDecision =
    | 'must_cover'
    | 'supporting'
    | 'review'
    | 'low_priority'
    | 'ignore';

export type CompetitorPhraseIntelligenceSignal =
    | 'keyword_overlap'
    | 'shared_by_competitors'
    | 'all_available_competitors'
    | 'single_competitor_repetition'
    | 'low_keyword_relevance';

export type CompetitorPhraseIntelligenceItem = {
    text: string;
    normalizedText: string;
    size: number;
    totalCount: number;
    competitorCount: number;
    competitors: SharedCompetitorPhraseOccurrence[];
    matchedKeywordTerms: string[];
    score: number;
    decision: CompetitorPhraseIntelligenceDecision;
    signalTypes: CompetitorPhraseIntelligenceSignal[];
    rationale: string;
};

export type CompetitorPhraseIntelligenceResult = {
    enabled: boolean;
    analyzedCompetitorCount: number;
    keywordTerms: string[];
    mustCover: CompetitorPhraseIntelligenceItem[];
    supporting: CompetitorPhraseIntelligenceItem[];
    review: CompetitorPhraseIntelligenceItem[];
    lowPriority: CompetitorPhraseIntelligenceItem[];
    ignored: CompetitorPhraseIntelligenceItem[];
    items: CompetitorPhraseIntelligenceItem[];
};

export type CompetitorPhraseIntelligenceOptions = {
    sources: CompetitorPhraseSource[];
    keywords?: Partial<Keywords>;
    enabled?: boolean;
    maxItemsPerBucket?: number;
};

const COMPETITOR_PHRASE_LENGTHS = [3, 4, 5] as const;

type CompetitorPhraseToken = {
    text: string;
    normalized: string;
};

type CountedCompetitorPhrase = {
    text: string;
    size: number;
    count: number;
};

const normalizeCompetitorToken = (value: string): string => (
    value
        .normalize('NFKC')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .toLowerCase()
);

const COMPETITOR_STOP_WORDS_RAW = [
    'في', 'من', 'إلى', 'الى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'أو', 'او', 'أم', 'ام', 'بل', 'لا', 'نعم',
    'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'والى', 'وإلى', 'ومن', 'وعلى', 'وفي', 'عنها', 'عنه', 'منها', 'منه',
    'الذي', 'التي', 'الذين', 'اللذين', 'اللتين', 'اللاتي', 'اللواتي', 'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء', 'أولئك',
    'هو', 'هي', 'هما', 'هم', 'هن', 'أنا', 'انا', 'نحن', 'أنت', 'انت', 'أنتم', 'انتم', 'أنتن', 'انتن', 'أنتما', 'انتما',
    'كان', 'كانت', 'كانوا', 'يكون', 'تكون', 'يتم', 'تم', 'قد', 'لقد', 'إن', 'ان', 'أن', 'الى', 'كما', 'كل', 'أي', 'اي',
    'غير', 'سوى', 'ما', 'ماذا', 'لماذا', 'كيف', 'متى', 'أين', 'اين', 'إذا', 'اذا', 'لكن', 'لذلك', 'لذا',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'as', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'we', 'our',
] as const;

const COMPETITOR_STOP_WORDS = new Set(
    COMPETITOR_STOP_WORDS_RAW.map(normalizeCompetitorToken),
);

const tokenizeCompetitorPhraseSegments = (value: string): CompetitorPhraseToken[][] => (
    value
        // Punctuation, symbols, and line breaks are phrase boundaries. Splitting
        // before tokenization prevents an n-gram from joining separate clauses,
        // sentences, headings, or paragraphs.
        .split(/[\r\n]+|[\p{P}\p{S}]+/gu)
        .map(segment => (
            Array.from(segment.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu))
                .map(match => ({
                    text: match[0],
                    normalized: normalizeCompetitorToken(match[0]),
                }))
                .filter(token => token.normalized)
        ))
        .filter(segment => segment.length > 0)
);

export const tokenizeCompetitorPhraseText = (value: string): string[] => (
    tokenizeCompetitorPhraseSegments(value)
        .flat()
        .map(token => token.normalized)
);

const countCompetitorPhrases = (
    segments: CompetitorPhraseToken[][],
): Map<string, CountedCompetitorPhrase> => {
    const phraseCounts = new Map<string, CountedCompetitorPhrase>();

    segments.forEach(tokens => {
        COMPETITOR_PHRASE_LENGTHS.forEach(size => {
            for (let index = 0; index <= tokens.length - size; index += 1) {
                const phraseTokens = tokens.slice(index, index + size);
                const key = phraseTokens.map(token => token.normalized).join(' ');
                const current = phraseCounts.get(key);
                phraseCounts.set(key, {
                    text: current?.text || phraseTokens.map(token => token.text).join(' '),
                    size,
                    count: (current?.count || 0) + 1,
                });
            }
        });
    });

    return phraseCounts;
};

const mergeCompetitorPhraseCounts = (
    target: Map<string, CountedCompetitorPhrase>,
    source: Map<string, CountedCompetitorPhrase>,
): void => {
    source.forEach((value, key) => {
        const current = target.get(key);
        target.set(key, {
            text: current?.text || value.text,
            size: value.size,
            count: (current?.count || 0) + value.count,
        });
    });
};

const sortRepeatedPhrases = (
    left: CompetitorRepeatedPhrase,
    right: CompetitorRepeatedPhrase,
): number => (
    right.size - left.size
    || right.count - left.count
    || left.text.localeCompare(right.text)
);

const isMeaningfulPhraseToken = (token: CompetitorPhraseToken): boolean => (
    token.normalized.length > 1 && !COMPETITOR_STOP_WORDS.has(token.normalized)
);

const createKeywordTermMap = (keywords: Partial<Keywords> | undefined): Map<string, string> => {
    const keywordTerms = [
        keywords?.primary,
        ...(Array.isArray(keywords?.secondaries) ? keywords.secondaries : []),
        ...(Array.isArray(keywords?.lsi) ? keywords.lsi : []),
    ];
    const terms = new Map<string, string>();
    keywordTerms.forEach(term => {
        tokenizeCompetitorPhraseSegments(String(term || ''))
            .flat()
            .filter(isMeaningfulPhraseToken)
            .forEach(token => {
                if (!terms.has(token.normalized)) terms.set(token.normalized, token.text);
            });
    });
    return terms;
};

const createEmptyPhraseIntelligenceResult = (
    enabled: boolean,
    analyzedCompetitorCount = 0,
    keywordTerms: string[] = [],
): CompetitorPhraseIntelligenceResult => ({
    enabled,
    analyzedCompetitorCount,
    keywordTerms,
    mustCover: [],
    supporting: [],
    review: [],
    lowPriority: [],
    ignored: [],
    items: [],
});

const getPhraseKeywordMatches = (
    text: string,
    keywordTermsByToken: Map<string, string>,
): string[] => {
    if (keywordTermsByToken.size === 0) return [];
    const matches = new Set<string>();
    tokenizeCompetitorPhraseSegments(text)
        .flat()
        .filter(isMeaningfulPhraseToken)
        .forEach(token => {
            const term = keywordTermsByToken.get(token.normalized);
            if (term) matches.add(term);
        });
    return Array.from(matches).sort((left, right) => left.localeCompare(right));
};

const addPhraseSignal = (
    signals: CompetitorPhraseIntelligenceSignal[],
    signal: CompetitorPhraseIntelligenceSignal,
): void => {
    if (!signals.includes(signal)) signals.push(signal);
};

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const decideCompetitorPhraseImportance = (input: {
    score: number;
    competitorCount: number;
    totalCount: number;
    matchedKeywordCount: number;
}): CompetitorPhraseIntelligenceDecision => {
    if (input.matchedKeywordCount > 0 && input.competitorCount > 1) return 'must_cover';
    if (input.score >= 75) return 'must_cover';
    if (input.matchedKeywordCount > 0) return 'supporting';
    if (input.competitorCount > 1 && input.score >= 55) return 'supporting';
    if (input.competitorCount > 1) return 'review';
    if (input.totalCount > 1) return 'low_priority';
    return 'ignore';
};

const createCompetitorPhraseRationale = (item: {
    decision: CompetitorPhraseIntelligenceDecision;
    competitorCount: number;
    totalCount: number;
    matchedKeywordTerms: string[];
}): string => {
    if (item.decision === 'must_cover') {
        return item.matchedKeywordTerms.length > 0
            ? 'مشتركة بين المنافسين وتتقاطع مع الكلمات المستهدفة؛ حوّلها إلى فكرة تغطية لا إلى حشو لفظي.'
            : 'متكررة بقوة بين المنافسين؛ راجعها كفكرة أساسية محتملة قبل الكتابة.';
    }
    if (item.decision === 'supporting') {
        return item.matchedKeywordTerms.length > 0
            ? 'مرتبطة بالكلمات المستهدفة ويمكن استخدامها لدعم القسم المناسب.'
            : 'تظهر لدى أكثر من منافس وقد تصلح كإشارة مساندة عند وجود سياق مفيد.';
    }
    if (item.decision === 'review') {
        return 'مشتركة بين منافسين لكنها لا تتقاطع مع الكلمات المستهدفة؛ تحتاج مراجعة قبل اعتمادها.';
    }
    if (item.decision === 'low_priority') {
        return 'مكررة داخل منافس واحد ولا تتقاطع مع الكلمات المستهدفة؛ لا تُطاردها إلا إذا دعمت فكرة مهمة.';
    }
    return 'إشارة ضعيفة لا تكفي لتوجيه المقالة.';
};

const sortCompetitorPhraseIntelligenceItems = (
    left: CompetitorPhraseIntelligenceItem,
    right: CompetitorPhraseIntelligenceItem,
): number => (
    right.score - left.score
    || right.competitorCount - left.competitorCount
    || right.totalCount - left.totalCount
    || right.size - left.size
    || left.text.localeCompare(right.text)
);

export const createCompetitorTextStats = (texts: string[]): CompetitorTextStats => {
    const tokenizedTexts = texts
        .map(tokenizeCompetitorPhraseSegments)
        .filter(segments => segments.length > 0);
    const words = tokenizedTexts.flat(2);
    const wordCounts = new Map<string, CompetitorWordFrequency>();
    const filteredWordCounts = new Map<string, CompetitorWordFrequency>();
    const phraseCounts = new Map<string, CountedCompetitorPhrase>();

    words.forEach(token => {
        const currentWord = wordCounts.get(token.normalized);
        wordCounts.set(token.normalized, {
            word: currentWord?.word || token.text,
            count: (currentWord?.count || 0) + 1,
        });
        if (token.normalized.length > 1 && !COMPETITOR_STOP_WORDS.has(token.normalized)) {
            const currentFilteredWord = filteredWordCounts.get(token.normalized);
            filteredWordCounts.set(token.normalized, {
                word: currentFilteredWord?.word || token.text,
                count: (currentFilteredWord?.count || 0) + 1,
            });
        }
    });

    tokenizedTexts.forEach(segments => {
        mergeCompetitorPhraseCounts(
            phraseCounts,
            countCompetitorPhrases(segments),
        );
    });

    const topWords = Array.from(filteredWordCounts.values())
        .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word))
        .slice(0, 5);

    const repeatedPhrases = Array.from(phraseCounts.values())
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
        text: string;
        size: number;
        totalCount: number;
        competitors: Map<number, number>;
    }>();

    sources.forEach(source => {
        const segments = tokenizeCompetitorPhraseSegments(source.text);
        countCompetitorPhrases(segments).forEach((value, key) => {
            const current = phrases.get(key) || {
                text: value.text,
                size: value.size,
                totalCount: 0,
                competitors: new Map<number, number>(),
            };
            current.totalCount += value.count;
            current.competitors.set(
                source.competitorNumber,
                (current.competitors.get(source.competitorNumber) || 0) + value.count,
            );
            phrases.set(key, current);
        });
    });

    return Array.from(phrases.values())
        .map((value): SharedCompetitorPhrase => ({
            text: value.text,
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

export const createCompetitorPhraseIntelligence = (
    options: CompetitorPhraseIntelligenceOptions,
): CompetitorPhraseIntelligenceResult => {
    const usableSources = options.sources
        .map(source => ({
            competitorNumber: source.competitorNumber,
            text: String(source.text || '').trim(),
        }))
        .filter(source => source.text);
    const keywordTermsByToken = createKeywordTermMap(options.keywords);
    const keywordTerms = Array.from(keywordTermsByToken.values())
        .sort((left, right) => left.localeCompare(right));

    if (options.enabled === false) {
        return createEmptyPhraseIntelligenceResult(false, usableSources.length, keywordTerms);
    }
    if (usableSources.length === 0) {
        return createEmptyPhraseIntelligenceResult(true, 0, keywordTerms);
    }

    const candidates = new Map<string, {
        text: string;
        size: number;
        totalCount: number;
        competitors: Map<number, number>;
    }>();

    usableSources.forEach(source => {
        const segments = tokenizeCompetitorPhraseSegments(source.text);
        countCompetitorPhrases(segments).forEach((value, key) => {
            const current = candidates.get(key) || {
                text: value.text,
                size: value.size,
                totalCount: 0,
                competitors: new Map<number, number>(),
            };
            current.totalCount += value.count;
            current.competitors.set(
                source.competitorNumber,
                (current.competitors.get(source.competitorNumber) || 0) + value.count,
            );
            candidates.set(key, current);
        });
    });

    const items = Array.from(candidates.entries())
        .map(([normalizedText, candidate]): CompetitorPhraseIntelligenceItem | null => {
            const competitors = Array.from(candidate.competitors.entries())
                .map(([competitorNumber, count]) => ({ competitorNumber, count }))
                .sort((left, right) => left.competitorNumber - right.competitorNumber);
            const competitorCount = competitors.length;
            if (competitorCount < 2 && candidate.totalCount < 2) return null;

            const matchedKeywordTerms = getPhraseKeywordMatches(candidate.text, keywordTermsByToken);
            const signalTypes: CompetitorPhraseIntelligenceSignal[] = [];
            if (matchedKeywordTerms.length > 0) addPhraseSignal(signalTypes, 'keyword_overlap');
            if (competitorCount > 1) addPhraseSignal(signalTypes, 'shared_by_competitors');
            if (competitorCount === usableSources.length && usableSources.length > 1) {
                addPhraseSignal(signalTypes, 'all_available_competitors');
            }
            if (competitorCount === 1 && candidate.totalCount > 1) {
                addPhraseSignal(signalTypes, 'single_competitor_repetition');
            }
            if (matchedKeywordTerms.length === 0) addPhraseSignal(signalTypes, 'low_keyword_relevance');

            const score = clampScore(
                10
                + Math.min(24, candidate.totalCount * 4)
                + Math.min(12, candidate.size * 2)
                + (matchedKeywordTerms.length > 0 ? 34 : 0)
                + (competitorCount > 1 ? 30 : 0)
                + (competitorCount === usableSources.length && usableSources.length > 1 ? 10 : 0)
                - (competitorCount === 1 && matchedKeywordTerms.length === 0 ? 35 : 0),
            );
            const decision = decideCompetitorPhraseImportance({
                score,
                competitorCount,
                totalCount: candidate.totalCount,
                matchedKeywordCount: matchedKeywordTerms.length,
            });

            return {
                text: candidate.text,
                normalizedText,
                size: candidate.size,
                totalCount: candidate.totalCount,
                competitorCount,
                competitors,
                matchedKeywordTerms,
                score,
                decision,
                signalTypes,
                rationale: createCompetitorPhraseRationale({
                    decision,
                    competitorCount,
                    totalCount: candidate.totalCount,
                    matchedKeywordTerms,
                }),
            };
        })
        .filter((item): item is CompetitorPhraseIntelligenceItem => Boolean(item))
        .sort(sortCompetitorPhraseIntelligenceItems);

    const maxItemsPerBucket = Math.max(5, Math.min(80, Math.round(options.maxItemsPerBucket || 40)));
    const mustCover = items.filter(item => item.decision === 'must_cover').slice(0, maxItemsPerBucket);
    const supporting = items.filter(item => item.decision === 'supporting').slice(0, maxItemsPerBucket);
    const review = items.filter(item => item.decision === 'review').slice(0, maxItemsPerBucket);
    const lowPriority = items.filter(item => item.decision === 'low_priority').slice(0, maxItemsPerBucket);
    const ignored = items.filter(item => item.decision === 'ignore').slice(0, maxItemsPerBucket);

    return {
        enabled: true,
        analyzedCompetitorCount: usableSources.length,
        keywordTerms,
        mustCover,
        supporting,
        review,
        lowPriority,
        ignored,
        items: [
            ...mustCover,
            ...supporting,
            ...review,
            ...lowPriority,
            ...ignored,
        ].slice(0, maxItemsPerBucket * 5),
    };
};

const serializePromptPhrase = (item: CompetitorPhraseIntelligenceItem) => ({
    text: item.text,
    decision: item.decision,
    score: item.score,
    matchedKeywordTerms: item.matchedKeywordTerms,
    competitorCount: item.competitorCount,
    totalCount: item.totalCount,
    competitors: item.competitors,
    rationale: item.rationale,
});

export const competitorPhraseIntelligenceToPromptJson = (
    result: CompetitorPhraseIntelligenceResult | null | undefined,
): string => JSON.stringify(
    result
        ? {
            enabled: result.enabled,
            rule: result.enabled
                ? 'Use must_cover/supporting phrases as topical coverage signals, not as copy-paste phrases or keyword stuffing. Treat low_priority/ignored phrases as do-not-chase signals unless the source chunks prove real value.'
                : 'Competitor phrase intelligence is disabled by the administrator.',
            analyzedCompetitorCount: result.analyzedCompetitorCount,
            keywordTerms: result.keywordTerms,
            mustCover: result.mustCover.slice(0, 25).map(serializePromptPhrase),
            supporting: result.supporting.slice(0, 25).map(serializePromptPhrase),
            review: result.review.slice(0, 20).map(serializePromptPhrase),
            lowPriority: result.lowPriority.slice(0, 20).map(serializePromptPhrase),
        }
        : {
            enabled: false,
            rule: 'Competitor phrase intelligence is not available for this session.',
            analyzedCompetitorCount: 0,
            keywordTerms: [],
            mustCover: [],
            supporting: [],
            review: [],
            lowPriority: [],
        },
    null,
    2,
)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
