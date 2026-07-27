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

export type CallToActionSectionChecks = {
    callToActionHeading: CheckResult;
    callToActionWordCount: CheckResult;
    callToActionParagraphsSentences: CheckResult;
    callToActionBulletList: CheckResult;
    callToActionFinalSentence: CheckResult;
};

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
    const lastListIndex = sectionNodes
        .map((node, index) => (isListNode(node) ? index : -1))
        .filter(index => index !== -1)
        .pop() ?? -1;
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

const getCtaTerms = (articleLanguage: 'ar' | 'en'): string[] => (
    articleLanguage === 'ar'
        ? CALL_TO_ACTION_SECTION_KEYWORDS
        : ENGLISH_CALL_TO_ACTION_SECTION_KEYWORDS
);

const createNoH2Checks = (context: AnalysisContext): CallToActionSectionChecks => {
    const { t, articleLanguage } = context;
    const details = getCtaTerms(articleLanguage).join(', ');
    const fail = (key: keyof typeof t.structureAnalysis) => {
        const rule = t.structureAnalysis[key];
        return createCheckResult(rule.title, 'fail', t.common.noH2, rule.required, 0, rule.description, details);
    };

    return {
        callToActionHeading: fail('عنوان الإجراء'),
        callToActionWordCount: fail('طول دعوة اتخاذ اجراء'),
        callToActionParagraphsSentences: fail('فقرات وجمل دعوة اتخاذ اجراء'),
        callToActionBulletList: fail('قائمة نقطية'),
        callToActionFinalSentence: fail('فقرة إجراء'),
    };
};

export const checkCallToActionSection = (context: AnalysisContext): CallToActionSectionChecks => {
    const { nodes, t, articleLanguage, totalDocSize } = context;
    const ctaTerms = getCtaTerms(articleLanguage);
    const details = ctaTerms.join(', ');
    const h2Indices = nodes
        .map((node, index) => (node.type === 'heading' && node.level === 2 ? index : -1))
        .filter(index => index !== -1);

    if (h2Indices.length === 0) {
        return createNoH2Checks(context);
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
    const best = evaluations
        .sort((first, second) => second.score - first.score || second.heading.pos - first.heading.pos)[0];
    const targetRange = sectionRange(best);

    const headingRule = t.structureAnalysis['عنوان الإجراء'];
    const headingStatus = best.headingHasCta && best.headingHasPrimaryKeyword ? 'pass' : 'fail';
    const headingResult = createCheckResult(
        headingRule.title,
        headingStatus,
        best.headingHasCta && best.headingHasPrimaryKeyword
            ? t.common.found
            : articleLanguage === 'ar'
                ? `كلمة إجراء: ${best.headingHasCta ? 'نعم' : 'لا'} | الكلمة الأساسية: ${best.headingPrimaryKeywordCount}`
                : `CTA term: ${best.headingHasCta ? 'Yes' : 'No'} | primary keyword: ${best.headingPrimaryKeywordCount}`,
        headingRule.required,
        headingStatus === 'pass' ? 1 : 0,
        headingRule.description,
        details
    );
    if (headingStatus === 'fail') {
        headingResult.violationCount = 1;
        headingResult.violatingItems = [{
            ...nodeRange(best.heading),
            message: articleLanguage === 'ar'
                ? 'عنوان H2 يجب أن يتضمن كلمة دعوة لاتخاذ إجراء من قائمة المعيار، والكلمة المفتاحية الأساسية مرة واحدة ضمن سياق طبيعي.'
                : 'The H2 heading must include a CTA term from the criterion list and the primary keyword once in a natural context.',
        }];
    }

    const wordCountRule = t.structureAnalysis['طول دعوة اتخاذ اجراء'];
    const wordCountStatus = best.wordCount >= 70 && best.wordCount <= 125 ? 'pass' : 'fail';
    const wordCountResult = createCheckResult(
        wordCountRule.title,
        wordCountStatus,
        best.wordCount,
        wordCountRule.required,
        wordCountStatus === 'pass' ? 1 : 0,
        wordCountRule.description,
        details
    );
    if (wordCountStatus === 'fail') {
        wordCountResult.violationCount = 1;
        wordCountResult.violatingItems = [{
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `قسم دعوة اتخاذ الاجراء يجب أن يكون 70-125 كلمة. الحالي: ${best.wordCount}`
                : `The call-to-action section must be 70-125 words. Current: ${best.wordCount}`,
        }];
    }

    const paragraphRule = t.structureAnalysis['فقرات وجمل دعوة اتخاذ اجراء'];
    const paragraphsSentencesStatus = (
        best.preListParagraphCount >= 1 &&
        best.preListParagraphCount <= 2 &&
        best.sentenceCount >= 3 &&
        best.sentenceCount <= 4
    ) ? 'pass' : 'fail';
    const paragraphResult = createCheckResult(
        paragraphRule.title,
        paragraphsSentencesStatus,
        articleLanguage === 'ar'
            ? `${best.preListParagraphCount} فقرات قبل القائمة، ${best.sentenceCount} جمل`
            : `${best.preListParagraphCount} paragraphs before list, ${best.sentenceCount} sentences`,
        paragraphRule.required,
        paragraphsSentencesStatus === 'pass' ? 1 : 0,
        paragraphRule.description,
        details
    );
    if (paragraphsSentencesStatus === 'fail') {
        paragraphResult.violationCount = 1;
        paragraphResult.violatingItems = [{
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `قبل القائمة يجب وجود 1-2 فقرة، والقسم يجب أن يتضمن 3-4 جمل خارج بنود القائمة. الحالي: ${best.preListParagraphCount} فقرات و${best.sentenceCount} جمل`
                : `Before the list there must be 1-2 paragraphs, and the section must include 3-4 sentences outside list items. Current: ${best.preListParagraphCount} paragraphs and ${best.sentenceCount} sentences`,
        }];
    }

    const listRule = t.structureAnalysis['قائمة نقطية'];
    const listStatus = best.bulletListCount === 1 && best.orderedListCount === 0 && best.listItemCount >= 3 && best.listItemCount <= 4
        ? 'pass'
        : 'fail';
    const listResult = createCheckResult(
        listRule.title,
        listStatus,
        articleLanguage === 'ar'
            ? `${best.listItemCount || 0} نقاط`
            : `${best.listItemCount || 0} items`,
        listRule.required,
        listStatus === 'pass' ? 1 : 0,
        listRule.description,
        details
    );
    if (listStatus === 'fail') {
        listResult.violationCount = 1;
        listResult.violatingItems = [{
            ...targetRange,
            message: articleLanguage === 'ar'
                ? `يجب استخدام قائمة نقطية آلية واحدة من 3-4 نقاط فقط. الحالي: ${best.listItemCount || 0}`
                : `Use exactly one automatic bullet list with 3-4 items. Current: ${best.listItemCount || 0}`,
        }];
    }

    const finalRule = t.structureAnalysis['فقرة إجراء'];
    const finalStatus = best.finalSentenceHasCta ? 'pass' : 'fail';
    const finalResult = createCheckResult(
        finalRule.title,
        finalStatus,
        best.finalSentenceHasCta ? t.common.yes : t.common.no,
        finalRule.required,
        finalStatus === 'pass' ? 1 : 0,
        finalRule.description,
        details
    );
    if (finalStatus === 'fail') {
        finalResult.violationCount = 1;
        finalResult.violatingItems = [{
            ...targetRange,
            message: articleLanguage === 'ar'
                ? 'بعد القائمة يجب وجود جملة تفاعلية واحدة تشجع على اتخاذ الاجراء وتتضمن كلمة من قائمة المعيار.'
                : 'After the list, add one interactive sentence that encourages action and includes a term from the criterion list.',
        }];
    }

    return {
        callToActionHeading: headingResult,
        callToActionWordCount: wordCountResult,
        callToActionParagraphsSentences: paragraphResult,
        callToActionBulletList: listResult,
        callToActionFinalSentence: finalResult,
    };
};
