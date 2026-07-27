import type { CheckResult } from '../../../types';
import { CALL_TO_ACTION_SECTION_KEYWORDS } from '../../../constants';
import {
    createCheckResult,
    getAnalysisNodeSize,
    getSentenceCount,
    getWordCount,
    normalizeArabicText,
} from '../analysisUtils';
import type { AnalysisContext, AnalysisDocumentNode } from '../analysisUtils';

const ENGLISH_CALL_TO_ACTION_SECTION_KEYWORDS = [
    'buy now', 'order now', 'book now', 'reserve now', 'shop now', 'request a quote',
    'get a quote', 'contact us', 'call us', 'talk to us', 'ask us', 'send a request',
    'start now', 'get started', 'try now', 'try it free', 'sign up', 'subscribe',
    'join now', 'learn more', 'discover more', 'explore now', 'view plans',
    'compare plans', 'choose your plan', 'download now', 'claim your offer',
];

type SectionEvaluation = {
    heading: AnalysisDocumentNode;
    sectionNodes: AnalysisDocumentNode[];
    sectionEnd: number;
    headingHasCta: boolean;
    headingHasPrimaryKeyword: boolean;
    headingPrimaryKeywordCount: number;
    preListParagraphCount: number;
    wordCount: number;
    sentenceCount: number;
    bulletListCount: number;
    orderedListCount: number;
    listItemCount: number;
    finalSentenceHasCta: boolean;
    finalSentenceCount: number;
    score: number;
};

const normalizeForSearch = (value: string, lang: 'ar' | 'en'): string => {
    const lower = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return lang === 'ar' ? normalizeArabicText(lower) : lower;
};

const escapeRegex = (value: string): string => value.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

const includesAnyTerm = (text: string, terms: string[], lang: 'ar' | 'en'): boolean => {
    const normalizedText = normalizeForSearch(text, lang);
    return terms.some(term => {
        const normalizedTerm = normalizeForSearch(term, lang);
        return normalizedTerm && normalizedText.includes(normalizedTerm);
    });
};

const countTermMatches = (text: string, term: string, lang: 'ar' | 'en'): number => {
    const normalizedText = normalizeForSearch(text, lang);
    const normalizedTerm = normalizeForSearch(term, lang);
    if (!normalizedText || !normalizedTerm) return 0;

    const pattern = escapeRegex(normalizedTerm).replace(/\s+/g, '\\s+');
    return normalizedText.match(new RegExp(pattern, 'gu'))?.length || 0;
};

const nodeRange = (node: AnalysisDocumentNode) => ({
    from: node.pos,
    to: node.pos + getAnalysisNodeSize(node),
});

const sectionRange = (evaluation: SectionEvaluation) => ({
    from: evaluation.heading.pos,
    to: Math.max(evaluation.heading.pos + getAnalysisNodeSize(evaluation.heading), evaluation.sectionEnd),
});

const isListNode = (node: AnalysisDocumentNode): boolean => (
    node.type === 'bulletList' || node.type === 'orderedList'
);

const getListItemCount = (node?: AnalysisDocumentNode): number => (
    Math.max(0, Math.round(Number(node?.listItemCount || 0)))
);

const evaluateSection = (
    heading: AnalysisDocumentNode,
    sectionNodes: AnalysisDocumentNode[],
    sectionEnd: number,
    context: AnalysisContext,
): SectionEvaluation => {
    const { articleLanguage, keywords } = context;
    const ctaTerms = articleLanguage === 'ar'
        ? CALL_TO_ACTION_SECTION_KEYWORDS
        : ENGLISH_CALL_TO_ACTION_SECTION_KEYWORDS;
    const primaryKeyword = String(keywords.primary || '').trim();
    const headingPrimaryKeywordCount = primaryKeyword
        ? countTermMatches(heading.text, primaryKeyword, articleLanguage)
        : 0;
    const headingHasCta = includesAnyTerm(heading.text, ctaTerms, articleLanguage);
    const headingHasPrimaryKeyword = headingPrimaryKeywordCount === 1;
    const firstListIndex = sectionNodes.findIndex(isListNode);
    const lastListIndex = sectionNodes.map((node, index) => (isListNode(node) ? index : -1)).filter(index => index !== -1).pop() ?? -1;
    const preListNodes = firstListIndex >= 0 ? sectionNodes.slice(0, firstListIndex) : sectionNodes;
    const preListParagraphs = preListNodes.filter(node => node.type === 'paragraph' && node.text.trim().length > 0);
    const paragraphText = sectionNodes
        .filter(node => node.type === 'paragraph' && node.text.trim().length > 0)
        .map(node => node.text)
        .join(' ');
    const bulletLists = sectionNodes.filter(node => node.type === 'bulletList');
    const orderedLists = sectionNodes.filter(node => node.type === 'orderedList');
    const postListParagraph = lastListIndex >= 0
        ? sectionNodes
            .slice(lastListIndex + 1)
            .find(node => node.type === 'paragraph' && node.text.trim().length > 0)
        : undefined;
    const finalSentenceCount = postListParagraph ? getSentenceCount(postListParagraph.text) : 0;
    const finalSentenceHasCta = Boolean(
        postListParagraph &&
        finalSentenceCount === 1 &&
        includesAnyTerm(postListParagraph.text, ctaTerms, articleLanguage)
    );
    const listItemCount = getListItemCount(bulletLists[0]);
    const wordCount = getWordCount(sectionNodes.map(node => node.text).join(' '));
    const sentenceCount = getSentenceCount(paragraphText);
    const checks = [
        headingHasCta,
        headingHasPrimaryKeyword,
        preListParagraphs.length >= 1 && preListParagraphs.length <= 2,
        wordCount >= 70 && wordCount <= 125,
        sentenceCount >= 3 && sentenceCount <= 4,
        bulletLists.length === 1 && orderedLists.length === 0 && listItemCount >= 3 && listItemCount <= 4,
        finalSentenceHasCta,
    ];
    const score = checks.reduce((sum, passed, index) => sum + (passed ? (index < 2 ? 3 : 1) : 0), 0);

    return {
        heading,
        sectionNodes,
        sectionEnd,
        headingHasCta,
        headingHasPrimaryKeyword,
        headingPrimaryKeywordCount,
        preListParagraphCount: preListParagraphs.length,
        wordCount,
        sentenceCount,
        bulletListCount: bulletLists.length,
        orderedListCount: orderedLists.length,
        listItemCount,
        finalSentenceHasCta,
        finalSentenceCount,
        score,
    };
};

export const checkCallToActionSection = (context: AnalysisContext): CheckResult => {
    const { nodes, headings, t, articleLanguage, totalDocSize } = context;
    const tRule = t.structureAnalysis['دعوة اتخاذ اجراء'];
    const ctaTerms = articleLanguage === 'ar'
        ? CALL_TO_ACTION_SECTION_KEYWORDS
        : ENGLISH_CALL_TO_ACTION_SECTION_KEYWORDS;
    const h2Indices = nodes
        .map((node, index) => (node.type === 'heading' && node.level === 2 ? index : -1))
        .filter(index => index !== -1);

    const baseResult = createCheckResult(
        tRule.title,
        'fail',
        t.common.noH2,
        tRule.required,
        0,
        tRule.description,
        ctaTerms.join(', ')
    );

    if (h2Indices.length === 0) {
        return baseResult;
    }

    const evaluations = h2Indices.map((headingIndex, index) => {
        const nextHeadingIndex = h2Indices[index + 1] ?? -1;
        const sectionEnd = nextHeadingIndex === -1 ? totalDocSize : nodes[nextHeadingIndex].pos;
        return evaluateSection(
            nodes[headingIndex],
            nodes.slice(headingIndex + 1, nextHeadingIndex === -1 ? nodes.length : nextHeadingIndex),
            sectionEnd,
            context
        );
    });

    const passed = evaluations.find(evaluation => (
        evaluation.headingHasCta &&
        evaluation.headingHasPrimaryKeyword &&
        evaluation.preListParagraphCount >= 1 &&
        evaluation.preListParagraphCount <= 2 &&
        evaluation.wordCount >= 70 &&
        evaluation.wordCount <= 125 &&
        evaluation.sentenceCount >= 3 &&
        evaluation.sentenceCount <= 4 &&
        evaluation.bulletListCount === 1 &&
        evaluation.orderedListCount === 0 &&
        evaluation.listItemCount >= 3 &&
        evaluation.listItemCount <= 4 &&
        evaluation.finalSentenceHasCta
    ));

    if (passed) {
        return createCheckResult(
            tRule.title,
            'pass',
            t.common.good,
            tRule.required,
            1,
            tRule.description,
            ctaTerms.join(', ')
        );
    }

    const best = evaluations
        .sort((first, second) => second.score - first.score || second.heading.pos - first.heading.pos)[0];
    const violations: NonNullable<CheckResult['violatingItems']> = [];
    const targetRange = sectionRange(best);

    if (!best.headingHasCta) {
        violations.push({
            ...nodeRange(best.heading),
            message: articleLanguage === 'ar'
                ? 'عنوان H2 يجب أن يتضمن كلمة دعوة لاتخاذ إجراء من قائمة المعيار.'
                : 'The H2 heading must include a call-to-action term from the criterion list.',
        });
    }
    if (!best.headingHasPrimaryKeyword) {
        violations.push({
            ...nodeRange(best.heading),
            message: articleLanguage === 'ar'
                ? `عنوان H2 يجب أن يتضمن الكلمة المفتاحية الأساسية مرة واحدة وضمن سياق طبيعي. الحالي: ${best.headingPrimaryKeywordCount}`
                : `The H2 heading must include the primary keyword once in a natural context. Current: ${best.headingPrimaryKeywordCount}`,
        });
    }
    if (best.preListParagraphCount < 1 || best.preListParagraphCount > 2) {
        violations.push({
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `قبل القائمة يجب وجود 1-2 فقرة فقط. الحالي: ${best.preListParagraphCount}`
                : `Before the list there must be 1-2 paragraphs. Current: ${best.preListParagraphCount}`,
        });
    }
    if (best.wordCount < 70 || best.wordCount > 125) {
        violations.push({
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `قسم دعوة اتخاذ الاجراء يجب أن يكون 70-125 كلمة. الحالي: ${best.wordCount}`
                : `The call-to-action section must be 70-125 words. Current: ${best.wordCount}`,
        });
    }
    if (best.sentenceCount < 3 || best.sentenceCount > 4) {
        violations.push({
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `قسم دعوة اتخاذ الاجراء يجب أن يتضمن 3-4 جمل خارج بنود القائمة. الحالي: ${best.sentenceCount}`
                : `The call-to-action section must include 3-4 sentences outside list items. Current: ${best.sentenceCount}`,
        });
    }
    if (best.bulletListCount !== 1 || best.orderedListCount !== 0 || best.listItemCount < 3 || best.listItemCount > 4) {
        violations.push({
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `يجب استخدام قائمة نقطية آلية واحدة من 3-4 نقاط فقط. الحالي: ${best.listItemCount || 0}`
                : `Use exactly one automatic bullet list with 3-4 items. Current: ${best.listItemCount || 0}`,
        });
    }
    if (!best.finalSentenceHasCta) {
        violations.push({
            ...targetRange,
            message: articleLanguage === 'ar'
                ? 'بعد القائمة يجب وجود جملة تفاعلية واحدة تشجع على اتخاذ الاجراء وتتضمن كلمة من قائمة المعيار.'
                : 'After the list, add one interactive sentence that encourages action and includes a term from the criterion list.',
        });
    }

    const result = createCheckResult(
        tRule.title,
        'fail',
        `${violations.length} ${t.common.violations}`,
        tRule.required,
        Math.max(0, best.score / 11),
        tRule.description,
        ctaTerms.join(', ')
    );
    result.violationCount = violations.length;
    result.violatingItems = violations;

    if (headings.length === 0) {
        result.current = t.common.noHeadings;
    }

    return result;
};
