
import React, { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useModal } from './ModalContext';
import type {
    AiAnalysisOptions,
    AiContentPatch,
    AiContentPatchOperation,
    AiPatchProvider,
    CheckResult,
    HeadingAnalysisResult,
    AIHistoryItem,
    BulkFixCriterionCheck,
    BulkFixCriterionSummary,
    BulkFixRelatedRule,
    BulkFixReviewItem,
    BulkFixReviewStats,
    BulkFixReviewVariant,
    GoalContext,
    ReadyCommandAnalysisBatchItem,
    ReadyCommandAnalysisHistoryMeta,
    StructureAnalysis,
} from '../types';
import { parseMarkdownToArticleHtml, parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { GEMINI_ANALYSIS_MODEL } from '../constants/aiModels';
import { CONTENT_SUMMARY_STORAGE_KEY, ENGINEERING_PROMPT_IDS, getEngineeringPrompt, renderEngineeringPrompt } from '../constants/engineeringPrompts';
import { COMMON_ENGLISH_TERMS, CONCLUSION_KEYWORDS, CTA_WORDS, FAQ_KEYWORDS, INTERACTIVE_WORDS, SLOW_WORDS, TRANSITIONAL_WORDS, WARNING_ADVICE_WORDS, WORDS_TO_DELETE } from '../constants';
import { countOccurrences, DUPLICATE_WORDS_EXCLUSION_LIST, normalizeArabicText } from '../utils/analysis/analysisUtils';
import { normalizeGoalContext } from '../utils/goalContext';

/*
 * AIContext owns all AI workflows:
 * prompt construction, Gemini/OpenAI calls, heading analysis, single-violation fixes,
 * bulk fix review items, insertion patches, and AI history.
 *
 * Edit here when changing AI behavior or prompt inputs.
 * Edit constants/engineeringPrompts.ts for user-editable prompt templates.
 * Edit api/* when changing server-side model calls or key handling.
 */
const GEMINI_MODEL = GEMINI_ANALYSIS_MODEL;
const OPENAI_MODEL = 'gpt-5.5';
const CHATGPT_TIMEOUT_MS = 300000;
const GEMINI_CHAT_STORAGE_PREFIX = 'bazarvan:gemini-chat';
const GEMINI_CHAT_MAX_MESSAGES = 8;
const GEMINI_CHAT_MAX_TOTAL_CHARS = 48000;
const GEMINI_CHAT_MESSAGE_CHAR_LIMIT = 12000;
const CHATGPT_CONVERSATION_STORAGE_PREFIX = 'bazarvan:chatgpt-conversation';

const GOAL_CONTEXT_LABELS: Record<string, string> = {
    pageType: 'نوع الصفحة',
    objective: 'هدف الصفحة',
    audienceScope: 'نطاق الجمهور',
    searchIntent: 'نية البحث',
};

const GOAL_CONTEXT_VALUE_LABELS: Record<string, string> = {
    article: 'مقالة/دليل',
    news: 'خبر',
    service: 'صفحة خدمة',
    category: 'صفحة تصنيف منتجات/خدمات',
    comparison: 'مقارنة',
    product: 'منتج',
    landing: 'صفحة هبوط',
    guide: 'دليل',
    educate: 'شرح وتثقيف',
    compare: 'مقارنة ومساعدة على الاختيار',
    convert: 'تحويل مباشر: شراء/حجز/تواصل',
    'category-support': 'محتوى داعم لصفحة تصنيف',
    trust: 'بناء الثقة وتقليل الاعتراضات',
    support: 'دعم بعد القرار أو الاستخدام',
    sell: 'تحويل مباشر: شراء/حجز/تواصل',
    bookings: 'تحويل مباشر: شراء/حجز/تواصل',
    leads: 'تحويل مباشر: شراء/حجز/تواصل',
    retention: 'دعم بعد القرار أو الاستخدام',
    local: 'مدينة أو منطقة محلية',
    global: 'عالمي دون سوق محدد',
    country: 'دولة واحدة محددة',
    regional: 'عدة دول أو إقليم',
    informational: 'شرح وتعلّم',
    commercial: 'مقارنة واختيار',
    'commercial-support': 'معلومات تجارية داعمة',
    transactional: 'تنفيذ إجراء/شراء',
    navigational: 'الوصول إلى علامة أو صفحة محددة',
    'support-intent': 'حل مشكلة أو معرفة طريقة الاستخدام',
    'local-intent': 'شرح وتعلّم',
};

const GOAL_CONTEXT_ALLOWED_VALUES = {
    pageType: ['article', 'news', 'service', 'category', 'comparison', 'product', 'landing', 'guide'],
    objective: ['educate', 'compare', 'convert', 'category-support', 'trust', 'support'],
    audienceScope: ['local', 'country', 'regional', 'global'],
    searchIntent: ['informational', 'commercial', 'commercial-support', 'transactional', 'navigational', 'support-intent'],
} as const;

const normalizeTokenForMatching = (value: string) => value.trim().toLowerCase();

const resolveGoalContextChoice = (
    rawValue: unknown,
    allowedValues: readonly string[],
    fallbackValue: string,
): string => {
    if (typeof rawValue !== 'string') return fallbackValue;
    const normalizedValue = normalizeTokenForMatching(rawValue);
    const matchedValue = allowedValues.find(value => normalizeTokenForMatching(value) === normalizedValue);
    if (matchedValue) return matchedValue;

    const matchedLabel = allowedValues.find(value => (
        normalizeTokenForMatching(GOAL_CONTEXT_VALUE_LABELS[value] || '') === normalizedValue
    ));
    return matchedLabel || fallbackValue;
};

const getFirstGeneratedValue = (record: Record<string, unknown>, keys: string[]): unknown => {
    return keys.map(key => record[key]).find(value => value != null);
};

const normalizeGeneratedGoalContext = (rawValue: unknown, currentContext: GoalContext): GoalContext | null => {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
    const root = rawValue as Record<string, unknown>;
    const nestedContext = root.context || root.goalContext || root.goal_context;
    const record = nestedContext && typeof nestedContext === 'object' && !Array.isArray(nestedContext)
        ? nestedContext as Record<string, unknown>
        : root;
    const normalizedCurrent = normalizeGoalContext(currentContext);

    return normalizeGoalContext({
        pageType: resolveGoalContextChoice(
            getFirstGeneratedValue(record, ['pageType', 'page_type', 'type']),
            GOAL_CONTEXT_ALLOWED_VALUES.pageType,
            normalizedCurrent.pageType,
        ),
        objective: resolveGoalContextChoice(
            getFirstGeneratedValue(record, ['objective', 'pageObjective', 'page_objective']),
            GOAL_CONTEXT_ALLOWED_VALUES.objective,
            normalizedCurrent.objective,
        ),
        audienceScope: resolveGoalContextChoice(
            getFirstGeneratedValue(record, ['audienceScope', 'audience_scope', 'scope']),
            GOAL_CONTEXT_ALLOWED_VALUES.audienceScope,
            normalizedCurrent.audienceScope,
        ),
        targetCountry: '',
        targetAudience: '',
        searchIntent: resolveGoalContextChoice(
            getFirstGeneratedValue(record, ['searchIntent', 'search_intent', 'intent']),
            GOAL_CONTEXT_ALLOWED_VALUES.searchIntent,
            normalizedCurrent.searchIntent,
        ),
    });
};

const formatGoalContext = (goalContext: GoalContext): string => {
    const normalizedContext = normalizeGoalContext(goalContext);
    return Object.entries(normalizedContext)
        .filter(([key, value]) => Boolean(GOAL_CONTEXT_LABELS[key]) && value.trim().length > 0)
        .map(([key, value]) => `- ${GOAL_CONTEXT_LABELS[key] || key}: ${GOAL_CONTEXT_VALUE_LABELS[value] || value}`)
        .join('\n');
};

type StructureCriteriaAttachment = {
    optionKey: keyof Pick<
        AiAnalysisOptions,
        'basicStructureCriteria' | 'headingsSequenceCriteria' | 'productPageCriteria' | 'interactionCtaCriteria' | 'conclusionCriteria'
    >;
    labelKey: 'basicStructure' | 'headingsSequence' | 'productPageCriteria' | 'interactionCta' | 'conclusion';
    ruleKeys: (keyof StructureAnalysis)[];
};

const STRUCTURE_CRITERIA_ATTACHMENTS: StructureCriteriaAttachment[] = [
    {
        optionKey: 'basicStructureCriteria',
        labelKey: 'basicStructure',
        ruleKeys: [
            'wordCount',
            'summaryParagraph',
            'secondParagraph',
            'paragraphLength',
            'paragraphPair',
            'sentenceLength',
            'stepsIntroduction',
            'keywordStuffing',
            'automaticLists',
        ],
    },
    {
        optionKey: 'headingsSequenceCriteria',
        labelKey: 'headingsSequence',
        ruleKeys: [
            'h2Structure',
            'h2Count',
            'h3Structure',
            'h4Structure',
            'betweenH2H3',
            'faqSection',
            'answerParagraph',
            'ambiguousHeadings',
            'headingLength',
        ],
    },
    {
        optionKey: 'productPageCriteria',
        labelKey: 'productPageCriteria',
        ruleKeys: [
            'productUsageHeading',
            'productTechnicalSpecsHeading',
            'productWarrantyContent',
            'tablesCount',
        ],
    },
    {
        optionKey: 'interactionCtaCriteria',
        labelKey: 'interactionCta',
        ruleKeys: [
            'ctaWords',
            'interactiveLanguage',
            'warningWords',
            'differentTransitionalWords',
            'slowWords',
        ],
    },
    {
        optionKey: 'conclusionCriteria',
        labelKey: 'conclusion',
        ruleKeys: [
            'lastH2IsConclusion',
            'conclusionParagraph',
            'conclusionWordCount',
            'conclusionHasNumber',
            'conclusionHasList',
        ],
    },
];

const CONTEXTUAL_CRITERIA_WORDS_NOTE = 'ملاحظة مهمة: الكلمات المذكورة داخل شروط وقواعد المعايير هي مؤشرات وسياقات مساعدة، وليست قائمة حصرية. عند التحليل أو الاقتراح، راعِ أيضًا الكلمات والعبارات الأخرى من نفس السياق والمعنى حتى لو لم تكن مذكورة حرفيًا في المعيار.';

const formatStructureCriteriaRules = (sectionTitle: string, rules: CheckResult[]): string => {
    const formattedRules = rules
        .filter(Boolean)
        .map((rule) => {
            const violationExamples = rule.violatingItems
                ?.slice(0, 3)
                .map(item => item.message)
                .filter(Boolean)
                .join(' | ');

            return [
                `### ${rule.title}`,
                `- الحالة الحالية: ${rule.status}`,
                `- القيمة الحالية: ${rule.current}`,
                `- المطلوب: ${rule.required}`,
                rule.description ? `- القاعدة: ${rule.description}` : '',
                rule.details ? `- الشروط والتفاصيل:\n${rule.details}` : '',
                violationExamples ? `- أمثلة من المخالفات الحالية: ${violationExamples}` : '',
            ].filter(Boolean).join('\n');
        })
        .join('\n\n');

    return `**${sectionTitle} وشروطها وقواعدها:**\n${CONTEXTUAL_CRITERIA_WORDS_NOTE}\n${formattedRules || '- لا توجد معايير متاحة لهذه المجموعة.'}`;
};

const formatBulkFixViolationPrompt = (
    rule: CheckResult,
    item: NonNullable<CheckResult['violatingItems']>[number],
    targetText: string,
    localContext?: Partial<BulkFixTargetContext>
): string => {
    return [
        'أصلح النص المحدد بناءً على بطاقة المعيار والمخالفة التالية.',
        '',
        formatAiReadOnlyLocalContext(localContext),
        '',
        '**بطاقة المعيار المخالف:**',
        `- اسم المعيار: ${rule.title}`,
        `- حالة المعيار: ${rule.status}`,
        `- رسالة المخالفة: ${item.message || 'غير محددة'}`,
        `- القيمة الحالية: ${rule.current}`,
        `- القيمة المطلوبة: ${rule.required}`,
        rule.description ? `- وصف المعيار: ${rule.description}` : '',
        rule.details ? `- الشروط التفصيلية:\n${rule.details}` : '',
        '',
        '**النص المراد إصلاحه فقط:**',
        `"""${targetText}"""`,
        '',
        '**تعليمات الإصلاح:**',
        '- أصلح سبب المخالفة المذكور فقط مع الحفاظ على معنى النص وسياقه.',
        '- اجعل النص الجديد مناسباً للقيمة المطلوبة والشروط التفصيلية إن وجدت.',
        '- لا تبدأ النص كأنه فقرة مستقلة إذا كان السياق السابق يمهد له، ولا تختمه كأنه نهاية قسم إذا كان النص اللاحق يكمل الفكرة.',
        '- تجنب تكرار المعلومات أو الكلمات المحورية الموجودة في النص السابق أو اللاحق، واجعل الربط طبيعياً ومختصراً.',
        '- لا تضف شرحاً، ولا تسميات مثل "النص المقترح" أو "الإجابة".',
        '- لا تعدّل خارج النص المحدد، ولا تضف معلومات غير موجودة في السياق.',
        '',
        'أرجع JSON حصراً بهذا الشكل:',
        '{ "suggestions": ["النص البديل الجاهز فقط"] }',
    ].filter(Boolean).join('\n');
};

type BulkFixViolationContext = {
    rule: CheckResult;
    item: NonNullable<CheckResult['violatingItems']>[number];
};

type BulkFixTextUnit = {
    from: number;
    to: number;
    unitType: 'paragraph' | 'heading' | 'section' | 'block';
};

type BulkFixTargetGroup = BulkFixTextUnit & {
    id: string;
    violations: BulkFixViolationContext[];
};

type BulkFixTargetContext = {
    isListIntro: boolean;
    currentBlockType?: string;
    nextBlockType?: string;
    articleTextBefore?: string;
    articleTextAfter?: string;
    sectionHeading?: string;
    previousTexts?: string[];
    nextTexts?: string[];
    targetRole?: string;
};

const BULK_FIX_PROTECTION_RULE_KEYS: (keyof StructureAnalysis)[] = [
    'sentenceLength',
    'paragraphLength',
    'punctuation',
    'immediateDuplicateWords',
    'duplicateWordsInParagraph',
    'ambiguousParagraphReferences',
    'wordsToDelete',
    'stepsIntroduction',
    'paragraphEndings',
    'sentenceBeginnings',
    'punctuationSpacing',
    'repeatedBigrams',
    'wordConsistency',
    'commonEnglishTerms',
];

const BULK_FIX_ARTICLE_LEVEL_RULE_KEYS: (keyof StructureAnalysis)[] = [
    'wordCount',
    'ctaWords',
    'interactiveLanguage',
    'warningWords',
    'differentTransitionalWords',
    'slowWords',
    'arabicOnly',
    'tablesCount',
    'productUsageHeading',
    'productTechnicalSpecsHeading',
    'productWarrantyContent',
];

const ENGLISH_TRANSITIONAL_WORDS = ['firstly', 'secondly', 'finally', 'in addition', 'furthermore', 'therefore', 'consequently', 'on the other hand', 'in contrast', 'also', 'as well as', 'moreover', 'in fact', 'actually', 'in other words', 'for example', 'specifically', 'in general', 'however', 'although', 'while', 'in summary', 'in conclusion'];
const ENGLISH_CTA_WORDS = ['start now', 'try now', 'sign up', 'book your spot', 'get', 'order now', 'contact us', 'join us', 'discover more', 'learn more', 'benefit now', 'subscribe', 'download', 'buy', 'shop', 'explore', 'request a quote', 'click here', 'submit', 'register', 'claim your', 'get started', 'find out more'];
const ENGLISH_INTERACTIVE_WORDS = ['you can', 'you will find', 'you need', 'you want', 'discover', 'learn', 'try', 'choose', 'use', 'start', 'get', 'benefit', 'enjoy', 'read', 'watch', 'compare', 'check', 'did you know', 'have you ever', 'imagine', 'think about', 'explore', 'see how', 'your', 'unlock', 'uncover', 'consider', 'you', "let's"];
const ENGLISH_WARNING_ADVICE_WORDS = ['warning', 'caution', 'be careful', 'note', 'important', 'recommendation', 'it is recommended', 'it is important', 'avoid', 'make sure', 'be aware', 'beware', 'take note', 'heads up', 'it is crucial', 'you should', 'remember to', 'pro tip', 'keep in mind'];
const ENGLISH_SLOW_WORDS = ['actually', 'basically', 'literally', 'in fact', 'in order to', 'just', 'really', 'very', 'quite', 'somewhat', 'in a way', 'so to speak', 'of course', 'as you know', 'essentially', 'practically', 'generally', 'in essence', 'regarding', 'in relation to', 'it seems that', 'apparently', 'it is considered', 'needless to say', 'it goes without saying', 'for the most part', 'it is important to note', 'in this context', 'furthermore', 'additionally'];
const ENGLISH_WORDS_TO_DELETE = ['synergy', 'leverage', 'paradigm shift', 'game-changer', 'out of the box', 'low-hanging fruit', 'circle back', 'deep dive', 'win-win', 'thought leader', 'value-added', 'next-gen', 'cutting-edge', 'robust', 'scalable', 'disrupt', 'pivot', 'actionable insights', 'growth hacking', 'core competency', 'ideation', 'seamless integration'];
const ARABIC_AMBIGUOUS_STARTS = [
    'كما ذكرنا سابقا', 'كما سبق', 'كما أشرنا', 'المذكور أعلاه', 'المذكور سابقا',
    'بناء على ذلك', 'وبناء على ذلك', 'نتيجة لذلك', 'بسبب ذلك', 'رغم ذلك',
    'مع ذلك', 'في هذا السياق', 'في هذا الصدد', 'ضمن هذا الإطار', 'لهذا السبب',
    'ولهذا السبب', 'لهذا', 'لذلك', 'لذا', 'من هنا', 'ومن هنا', 'وبهذا',
    'وبذلك', 'هذا الأمر', 'هذه المشكلة', 'هذه الطريقة', 'هذا الخيار',
    'هذه النتيجة', 'هذه الفكرة', 'هذه النقطة', 'هذا الحل', 'ذلك يعني',
    'هذا يعني', 'وهذا يعني', 'وبهذا الشكل', 'بهذه الطريقة', 'في هذه الحالة',
    'وهذا', 'فهذه', 'وذلك', 'فذلك', 'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء',
    'هو', 'هي', 'هم', 'له', 'لها', 'فيه', 'فيها', 'به', 'بها', 'عليه',
    'عليها', 'منه', 'منها', 'إليه', 'إليها',
];
const ENGLISH_AMBIGUOUS_STARTS = [
    'as mentioned earlier', 'as mentioned above', 'as noted earlier', 'as discussed',
    'the above', 'the aforementioned', 'previously mentioned', 'in this context',
    'for this reason', 'because of this', 'based on this', 'as a result',
    'therefore', 'thus', 'despite that', 'even so', 'this means', 'that means',
    'this approach', 'this method', 'this option', 'this problem', 'this issue',
    'this result', 'this service', 'this product', 'this process', 'this solution',
    'this', 'that', 'these', 'those', 'it', 'they', 'he', 'she', 'here', 'there',
];

const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

const countSentences = (value: string): number => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return 0;
    const matches = normalized.match(/[^.!؟?؛;:]+[.!؟?؛;:]*/g);
    return matches?.map(sentence => sentence.trim()).filter(Boolean).length || 1;
};

const getBulkFixStats = (value: string): BulkFixReviewStats => ({
    words: countWords(value),
    sentences: countSentences(value),
    paragraphs: value.split(/\n{2,}|\r?\n/).map(part => part.trim()).filter(Boolean).length || (value.trim() ? 1 : 0),
    characters: value.trim().length,
});

const getBulkFixTextUnit = (
    editor: any,
    item: NonNullable<CheckResult['violatingItems']>[number]
): BulkFixTextUnit | null => {
    if (!editor) return null;
    const docSize = editor.state.doc.content.size;
    const sectionFrom = item.sectionFrom;
    const sectionTo = item.sectionTo;
    if (
        Number.isFinite(sectionFrom) &&
        Number.isFinite(sectionTo) &&
        typeof sectionFrom === 'number' &&
        typeof sectionTo === 'number' &&
        sectionFrom >= 0 &&
        sectionTo <= docSize &&
        sectionTo > sectionFrom
    ) {
        return { from: sectionFrom, to: sectionTo, unitType: 'section' };
    }

    let bestMatch: BulkFixTextUnit | null = null;
    editor.state.doc.descendants((node: any, pos: number) => {
        const nodeTo = pos + node.nodeSize;
        if (pos > item.from || nodeTo < item.to) return true;
        if (!node.isBlock || !node.textContent?.trim()) return true;
        if (!['paragraph', 'heading', 'listItem'].includes(node.type.name)) return true;

        if (!bestMatch || (nodeTo - pos) < (bestMatch.to - bestMatch.from)) {
            bestMatch = {
                from: pos,
                to: nodeTo,
                unitType: node.type.name === 'heading' ? 'heading' : node.type.name === 'paragraph' ? 'paragraph' : 'block',
            };
        }
        return true;
    });

    if (bestMatch) return bestMatch;
    if (item.from >= 0 && item.to <= docSize && item.to > item.from) {
        return { from: item.from, to: item.to, unitType: 'block' };
    }
    return null;
};

const groupBulkFixViolationsByTextUnit = (
    editor: any,
    violations: BulkFixViolationContext[]
): BulkFixTargetGroup[] => {
    const groupMap = new Map<string, BulkFixTargetGroup>();

    violations.forEach((violation) => {
        const unit = getBulkFixTextUnit(editor, violation.item);
        if (!unit) return;
        const key = `${unit.from}:${unit.to}`;
        const existing = groupMap.get(key);
        if (existing) {
            existing.violations.push(violation);
            return;
        }

        groupMap.set(key, {
            ...unit,
            id: `bulk-group-${unit.from}-${unit.to}`,
            violations: [violation],
        });
    });

    const groups = Array.from(groupMap.values()).sort((a, b) => (b.to - b.from) - (a.to - a.from));
    const absorbedGroupIds = new Set<string>();

    groups.forEach((container) => {
        if (absorbedGroupIds.has(container.id)) return;
        groups.forEach((child) => {
            if (container.id === child.id || absorbedGroupIds.has(child.id)) return;
            const containsChild = container.from <= child.from && container.to >= child.to;
            if (!containsChild) return;
            container.violations.push(...child.violations);
            absorbedGroupIds.add(child.id);
        });
    });

    return groups
        .filter(group => !absorbedGroupIds.has(group.id))
        .sort((a, b) => a.from - b.from);
};

type AiContextBlock = { from: number; to: number; type: string; text: string; level?: number };

const getBulkFixTopLevelBlocks = (editor: any): AiContextBlock[] => {
    const blocks: AiContextBlock[] = [];
    if (!editor?.state?.doc?.forEach) return blocks;

    editor.state.doc.forEach((node: any, offset: number) => {
        blocks.push({
            from: offset,
            to: offset + node.nodeSize,
            type: node.type.name,
            text: node.textContent || '',
            level: node.attrs?.level,
        });
    });

    return blocks;
};

const trimAiContextText = (value: string, maxLength = 520): string => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(maxLength - 3, 0)).trim()}...`;
};

const getMeaningfulContextBlocks = (blocks: AiContextBlock[], startIndex: number, direction: 'before' | 'after', limit = 2): AiContextBlock[] => {
    const result: AiContextBlock[] = [];
    const step = direction === 'before' ? -1 : 1;
    for (let index = startIndex; index >= 0 && index < blocks.length && result.length < limit; index += step) {
        const block = blocks[index];
        if (!block?.text?.trim()) continue;
        if (block.type === 'heading') continue;
        result.push(block);
    }
    return direction === 'before' ? result.reverse() : result;
};

const inferAiTargetRole = (
    currentBlock: AiContextBlock | undefined,
    previousBlocks: AiContextBlock[],
    nextBlocks: AiContextBlock[],
    sectionHeading?: string
): string | undefined => {
    if (!currentBlock) return undefined;
    if (currentBlock.type === 'heading') return 'عنوان داخل بنية المقال؛ يجب أن ينسجم مع ما قبله وما بعده.';
    if (currentBlock.type === 'paragraph' && (nextBlocks[0]?.type === 'bulletList' || nextBlocks[0]?.type === 'orderedList')) {
        return 'فقرة تمهيدية لقائمة؛ يجب أن تفتح القائمة دون تكرار عناصرها.';
    }
    if (previousBlocks.length === 0 && sectionHeading) {
        return 'افتتاح القسم؛ يجب أن يعرّف الفكرة دون إعادة صياغة العنوان حرفياً.';
    }
    if (nextBlocks.length === 0) {
        return 'خاتمة جزئية أو انتقال قبل نهاية القسم؛ يجب أن تغلق الفكرة دون إضافة موضوع جديد.';
    }
    return 'فقرة وسطية داخل القسم؛ يجب أن تكمل التدفق بين النص السابق واللاحق دون تكرار.';
};

const normalizeAiHeadingForCompare = (value?: string): string => {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
};

const getAiLocalTextContext = (editor: any, from: number, to: number, articleTitle?: string): BulkFixTargetContext => {
    const blocks = getBulkFixTopLevelBlocks(editor);
    const docSize = editor?.state?.doc?.content?.size || 0;
    const overlappingIndexes = blocks
        .map((block, index) => (block.to > from && block.from < to ? index : -1))
        .filter(index => index !== -1);
    const fallbackIndex = blocks.findIndex(block => block.from <= from && block.to >= from);
    const firstIndex = overlappingIndexes[0] ?? (fallbackIndex >= 0 ? fallbackIndex : 0);
    const lastIndex = overlappingIndexes[overlappingIndexes.length - 1] ?? firstIndex;
    const currentBlock = blocks[firstIndex];
    const nextBlock = blocks[lastIndex + 1];
    const normalizedArticleTitle = normalizeAiHeadingForCompare(articleTitle);
    const sectionHeadingBlock = blocks
        .slice(0, firstIndex + 1)
        .reverse()
        .find(block => {
            if (block.type !== 'heading' || block.text.trim().length === 0) return false;
            return normalizeAiHeadingForCompare(block.text) !== normalizedArticleTitle;
        });
    const previousBlocks = getMeaningfulContextBlocks(blocks, firstIndex - 1, 'before');
    const nextBlocks = getMeaningfulContextBlocks(blocks, lastIndex + 1, 'after');
    const sectionHeading = sectionHeadingBlock
        ? `H${sectionHeadingBlock.level || 2}: ${trimAiContextText(sectionHeadingBlock.text, 180)}`
        : undefined;
    const isListIntro = currentBlock?.type === 'paragraph' && (
        nextBlock?.type === 'bulletList' ||
        nextBlock?.type === 'orderedList'
    );

    return {
        isListIntro,
        currentBlockType: currentBlock?.type,
        nextBlockType: nextBlock?.type,
        articleTextBefore: docSize > 0 ? editor.state.doc.textBetween(0, from, ' ') : '',
        articleTextAfter: docSize > 0 ? editor.state.doc.textBetween(to, docSize, ' ') : '',
        sectionHeading,
        previousTexts: previousBlocks.map(block => trimAiContextText(block.text)),
        nextTexts: nextBlocks.map(block => trimAiContextText(block.text)),
        targetRole: inferAiTargetRole(currentBlock, previousBlocks, nextBlocks, sectionHeading),
    };
};

const formatAiReadOnlyLocalContext = (context?: Partial<BulkFixTargetContext>): string => {
    if (!context) return '';
    const lines = [
        '**سياق موضع التعديل للقراءة فقط:**',
        context.sectionHeading ? `- عنوان القسم الحالي: ${context.sectionHeading}` : '',
        context.targetRole ? `- دور النص المستهدف داخل القسم: ${context.targetRole}` : '',
        ...(context.previousTexts || []).map((textValue, index) => `- النص السابق ${index + 1}: """${textValue}"""`),
        ...(context.nextTexts || []).map((textValue, index) => `- النص اللاحق ${index + 1}: """${textValue}"""`),
        '',
        '**تعليمات استخدام السياق:**',
        '- استخدم السياق لفهم التدفق ومنع التكرار والركاكة فقط.',
        '- لا تكرر معلومة مذكورة في النص السابق أو اللاحق إلا عند الحاجة لجملة ربط قصيرة.',
        '- لا تعدل السياق السابق أو اللاحق ولا تدمجه داخل الإجابة؛ أعد النص المستهدف فقط.',
    ].filter(Boolean);
    return lines.length > 4 ? lines.join('\n') : '';
};

const getBulkFixTargetContext = (editor: any, group: BulkFixTargetGroup, articleTitle?: string): BulkFixTargetContext => {
    return getAiLocalTextContext(editor, group.from, group.to, articleTitle);
};

const collectBulkFixViolations = (structureAnalysis: StructureAnalysis): BulkFixViolationContext[] => {
    const violations: BulkFixViolationContext[] = [];
    Object.entries(structureAnalysis).forEach(([key, rule]) => {
        if (key === 'paragraphPair') return;
        if (rule.violatingItems?.length) {
            rule.violatingItems.forEach((item) => violations.push({ rule, item }));
        }
    });
    return violations;
};

const isSameBulkFixUnit = (a: BulkFixTextUnit, b: BulkFixTextUnit): boolean => a.from === b.from && a.to === b.to;

const isBulkFixUnitRelated = (selectedUnit: BulkFixTextUnit, candidateUnit: BulkFixTextUnit): boolean => {
    if (isSameBulkFixUnit(selectedUnit, candidateUnit)) return true;
    return selectedUnit.unitType === 'section' &&
        selectedUnit.from <= candidateUnit.from &&
        selectedUnit.to >= candidateUnit.to;
};

const getRelatedBulkFixViolations = (
    editor: any,
    allViolations: BulkFixViolationContext[],
    selectedRuleTitles: Set<string>
): BulkFixViolationContext[] => {
    if (!editor || selectedRuleTitles.size === 0) return [];

    const selectedViolations = allViolations.filter(violation => selectedRuleTitles.has(violation.rule.title));
    const selectedUnits = selectedViolations
        .map(violation => ({
            violation,
            unit: getBulkFixTextUnit(editor, violation.item),
        }))
        .filter((entry): entry is { violation: BulkFixViolationContext; unit: BulkFixTextUnit } => Boolean(entry.unit));

    const relatedKeys = new Set<string>();
    const relatedViolations: BulkFixViolationContext[] = [];

    allViolations.forEach((violation) => {
        if (selectedRuleTitles.has(violation.rule.title)) return;
        const candidateUnit = getBulkFixTextUnit(editor, violation.item);
        if (!candidateUnit) return;
        const isRelated = selectedUnits.some(({ unit }) => isBulkFixUnitRelated(unit, candidateUnit));
        if (!isRelated) return;

        const key = `${violation.rule.title}:${violation.item.from}:${violation.item.to}:${violation.item.message}`;
        if (relatedKeys.has(key)) return;
        relatedKeys.add(key);
        relatedViolations.push(violation);
    });

    return relatedViolations;
};

const summarizeRelatedBulkFixRules = (
    editor: any,
    allViolations: BulkFixViolationContext[],
    selectedRuleTitles: Set<string>
): BulkFixRelatedRule[] => {
    if (!editor || selectedRuleTitles.size === 0) return [];
    const selectedViolations = allViolations.filter(violation => selectedRuleTitles.has(violation.rule.title));
    const selectedUnits = selectedViolations
        .map(violation => ({
            sourceRuleTitle: violation.rule.title,
            unit: getBulkFixTextUnit(editor, violation.item),
        }))
        .filter((entry): entry is { sourceRuleTitle: string; unit: BulkFixTextUnit } => Boolean(entry.unit));

    const summary = new Map<string, BulkFixRelatedRule>();
    allViolations.forEach((violation) => {
        if (selectedRuleTitles.has(violation.rule.title)) return;
        const candidateUnit = getBulkFixTextUnit(editor, violation.item);
        if (!candidateUnit) return;
        const sourceRuleTitles = selectedUnits
            .filter(({ unit }) => isBulkFixUnitRelated(unit, candidateUnit))
            .map(({ sourceRuleTitle }) => sourceRuleTitle);
        if (sourceRuleTitles.length === 0) return;

        const current = summary.get(violation.rule.title) || {
            title: violation.rule.title,
            count: 0,
            sourceRuleTitles: [],
        };
        current.count += 1;
        current.sourceRuleTitles = Array.from(new Set([...current.sourceRuleTitles, ...sourceRuleTitles]));
        summary.set(violation.rule.title, current);
    });

    return Array.from(summary.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
};

const getUniqueBulkFixRules = (violations: BulkFixViolationContext[]): CheckResult[] => (
    violations.reduce<CheckResult[]>((acc, violation) => {
        if (!acc.some(rule => rule.title === violation.rule.title)) acc.push(violation.rule);
        return acc;
    }, [])
);

const isBulkFixStepsIntroductionRule = (rule: CheckResult | BulkFixCriterionSummary): boolean => {
    const text = `${rule.title} ${rule.required}`.toLowerCase();
    return text.includes('تمهيد خطوات') || text.includes('steps introduction');
};

const isBulkFixParagraphLengthRule = (rule: CheckResult | BulkFixCriterionSummary): boolean => {
    const text = `${rule.title} ${rule.required}`.toLowerCase();
    return text.includes('طول الفقرات') || text.includes('paragraph length');
};

const getBulkFixArticleLevelRules = (
    structureAnalysis: StructureAnalysis,
    selectedRuleTitles: Set<string>
): CheckResult[] => {
    const rules = BULK_FIX_ARTICLE_LEVEL_RULE_KEYS
        .map(ruleKey => structureAnalysis[ruleKey])
        .filter((rule): rule is CheckResult => Boolean(rule))
        .filter(rule => !selectedRuleTitles.has(rule.title))
        .filter(rule => rule.status !== 'pass');

    return rules.filter((rule, index) => rules.findIndex(item => item.title === rule.title) === index);
};

const formatBulkFixRuleCards = (rules: CheckResult[], group: BulkFixTargetGroup): string => (
    rules.map((rule) => {
        const messages = group.violations
            .filter(violation => violation.rule.title === rule.title)
            .map(violation => violation.item.message)
            .filter(Boolean);

        return [
            `### ${rule.title}`,
            `- حالة المعيار: ${rule.status}`,
            `- القيمة الحالية: ${rule.current}`,
            `- القيمة المطلوبة: ${rule.required}`,
            rule.description ? `- وصف المعيار: ${rule.description}` : '',
            rule.details ? `- الشروط التفصيلية:\n${rule.details}` : '',
            messages.length ? `- رسائل المخالفات في هذه الوحدة:\n${messages.map(message => `  - ${message}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n')
);

const getBulkFixProtectionRules = (
    structureAnalysis: StructureAnalysis,
    group: BulkFixTargetGroup,
    selectedRuleTitles: Set<string>,
    targetContext: BulkFixTargetContext
): CheckResult[] => {
    const protectionRules = new Map<string, CheckResult>();

    BULK_FIX_PROTECTION_RULE_KEYS.forEach((ruleKey) => {
        const rule = structureAnalysis[ruleKey];
        if (!rule || selectedRuleTitles.has(rule.title)) return;
        if (ruleKey === 'stepsIntroduction' && !targetContext.isListIntro) return;
        if (ruleKey === 'paragraphLength' && targetContext.isListIntro) return;
        protectionRules.set(rule.title, rule);
    });

    group.violations.forEach((violation) => {
        if (selectedRuleTitles.has(violation.rule.title)) return;
        if (isBulkFixStepsIntroductionRule(violation.rule) && !targetContext.isListIntro) return;
        if (isBulkFixParagraphLengthRule(violation.rule) && targetContext.isListIntro) return;
        protectionRules.set(violation.rule.title, violation.rule);
    });

    return Array.from(protectionRules.values());
};

const formatBulkFixGroupPrompt = (
    group: BulkFixTargetGroup,
    targetText: string,
    selectedRuleTitles: Set<string>,
    protectionRules: CheckResult[],
    targetContext: BulkFixTargetContext,
    articleLevelRules: CheckResult[] = []
): string => {
    const uniqueRules = getUniqueBulkFixRules(group.violations);
    const targetRules = uniqueRules.filter(rule => selectedRuleTitles.has(rule.title));
    const fallbackTargetRules = targetRules.length > 0 ? targetRules : uniqueRules.slice(0, 1);
    const targetRuleCards = formatBulkFixRuleCards(fallbackTargetRules, group);
    const protectionRuleCards = formatBulkFixRuleCards(
        protectionRules.filter(rule => !fallbackTargetRules.some(targetRule => targetRule.title === rule.title)),
        group
    );
    const articleRuleCards = formatBulkFixRuleCards(articleLevelRules, group);

    const unitLabel = group.unitType === 'section'
        ? 'قسم كامل'
        : group.unitType === 'heading'
            ? 'عنوان'
            : group.unitType === 'paragraph'
                ? 'فقرة'
                : 'وحدة نصية';
    const contextLine = targetContext.isListIntro
        ? 'سياق الموضع: هذه الفقرة تسبق قائمة تعداد آلية مباشرة، لذلك ينطبق عليها معيار تمهيد خطوات ولا ينطبق عليها معيار طول الفقرات العادية.'
        : 'سياق الموضع: هذه الوحدة لا تسبق قائمة تعداد آلية مباشرة، لذلك لا تعاملها كتمهيد خطوات ولا تطبق عليها شروط تمهيد الخطوات.';

    return [
        `هذه ${unitLabel} واحدة تحتاج إصلاحاً موجهاً دون كسر المعايير المرتبطة بها.`,
        contextLine,
        '',
        formatAiReadOnlyLocalContext(targetContext),
        '',
        '**أهداف الإصلاح الأساسية:**',
        targetRuleCards || '- لا توجد أهداف إصلاح محددة بوضوح.',
        '',
        '**قيود الحماية التي يجب عدم كسرها أثناء الإصلاح:**',
        protectionRuleCards || '- لا توجد قيود حماية إضافية متاحة.',
        '',
        '**أهداف إضافية على مستوى المقال عند وجود سكور عام مخالف:**',
        articleRuleCards || '- لا توجد أهداف عامة مخالفة على مستوى المقال.',
        '',
        '**النص المراد استبداله كوحدة واحدة:**',
        `"""${targetText}"""`,
        '',
        '**تعليمات مهمة:**',
        '- أصلح أهداف الإصلاح الأساسية فقط، واجعل قيود الحماية شروطاً ملزمة لا تكسرها أثناء التعديل.',
        '- لا تحول قيود الحماية إلى هدف توسعة أو إعادة كتابة زائدة؛ دورها منع ظهور مخالفات جديدة.',
        '- ارفق في تفكيرك قواعد وشروط أهداف الإصلاح وقيود الحماية عند صياغة البدائل.',
        '- حافظ على وظيفة النص داخل القسم كما يوضح سياق الموضع، ولا تجعله يكرر ما قبله أو يقفز فوق ما بعده.',
        '- لا تبدأ الاقتراح بمقدمة عامة إذا كان النص السابق بدأ الفكرة، ولا تعيد شرح معلومة ستأتي مباشرة في النص اللاحق.',
        '- قدم اقتراحين فقط مختلفين قابلين للتطبيق، وكل اقتراح يجب أن يكون نصاً نهائياً جاهزاً للاستبدال.',
        '- رتّب الاقتراحات بحيث يأتي أولاً الاقتراح الذي يجعل أكبر عدد من تدقيقات criteriaChecks بحالة pass، ثم الأقل كسراً للقيود.',
        '- إذا كان هدف الإصلاح هو تقصير فقرة أو ضبط طولها، فلا تطل الجمل ولا تضف شرحاً غير ضروري.',
        '- حافظ خصوصاً على قيود الحماية المعروضة فقط، ولا تضف كلمات بطيئة أو كلمات للحذف أو مخالفات ترقيم أو إحالات غامضة جديدة.',
        '- لا تضف كلمات حث أو كلمات تحذيرية أو كلمات انتقالية فقط لإرضاء معيار عام ما لم يكن هذا المعيار هدف الإصلاح الأساسي.',
        '- إذا ظهر معيار ضمن أهداف مستوى المقال، فاجعل status في criteriaChecks مبنياً على توافق النص المقترح نفسه مع شروط المعيار، ولا تجعله خارج الحد بسبب فقرات أخرى في المقال.',
        '- الوضع العام للمقال موجود في before/current؛ أما after/status فيجب أن يصفا النص المقترح نفسه. إذا لم يمكن الجزم من النص المقترح وحده فاستخدم unknown بدلاً من fail.',
        '- معيار تمهيد خطوات ينطبق فقط عندما تكون الفقرة الحالية قبل قائمة تعداد آلية مباشرة؛ غير ذلك لا تقيّمه ولا تذكره داخل criteriaChecks.',
        '- إذا كانت الوحدة فقرة تمهيد خطوات، فلا تطبق عليها شروط طول الفقرات العادية؛ قيّمها بمعيار تمهيد خطوات فقط.',
        '- حافظ على المعنى الأصلي وسياق الصفحة ولا تضف معلومات أو ادعاءات جديدة.',
        '- إذا كان النص يحتوي عناوين، فاستخدم Markdown للحفاظ على مستويات العناوين قدر الإمكان.',
        '- لا تكتب تسميات داخل fixedText مثل "النص المقترح" أو "الإجابة".',
        '- يجب أن يكون الرد JSON صالحاً فقط، دون Markdown fences ودون شرح خارج JSON.',
        '- المفتاح suggestions إلزامي، وكل عنصر داخله يجب أن يحتوي fixedText نصياً غير فارغ.',
        '- داخل كل اقتراح أضف criteriaChecks لكل هدف إصلاح ولكل قيد حماية ولكل هدف مستوى مقال ظاهر، وفيه: criterionTitle، before، after، required، و status بقيمة pass أو warn أو fail أو unknown.',
        '- إذا أصلح الاقتراح هدف الإصلاح لكنه كسر قيد حماية، فاعتبر status الخاص بهذا القيد fail ولا تعرضه كأنه ضمن الحد.',
        '',
        'أرجع JSON حصراً بهذا الشكل:',
        '{ "suggestions": [ { "label": "اقتراح 1", "fixedText": "...", "criteriaChecks": [ { "criterionTitle": "اسم المعيار", "before": "الحالة قبل الإصلاح", "after": "الحالة بعد التعديل", "required": "المطلوب", "status": "pass" } ] }, { "label": "اقتراح 2", "fixedText": "...", "criteriaChecks": [ { "criterionTitle": "اسم المعيار", "before": "الحالة قبل الإصلاح", "after": "الحالة بعد التعديل", "required": "المطلوب", "status": "pass" } ] } ] }',
    ].filter(Boolean).join('\n');
};

const normalizeCriteriaCheckStatus = (value: unknown): BulkFixCriterionCheck['status'] => {
    const status = asTrimmedString(value).toLowerCase();
    return status === 'pass' || status === 'warn' || status === 'fail' || status === 'unknown' ? status : 'unknown';
};

const getBulkFixCriterionStatusOrder = (status?: BulkFixCriterionCheck['status']): number => {
    if (status === 'pass') return 0;
    if (status === 'fail') return 1;
    if (status === 'warn') return 2;
    return 3;
};

const sortBulkFixCriteriaChecks = (checks: BulkFixCriterionCheck[]): BulkFixCriterionCheck[] => (
    checks
        .map((check, index) => ({ check, index }))
        .sort((a, b) => getBulkFixCriterionStatusOrder(a.check.status) - getBulkFixCriterionStatusOrder(b.check.status) || a.index - b.index)
        .map(({ check }) => check)
);

const normalizeBulkFixCriteriaChecks = (rawChecks: unknown, criteria: BulkFixCriterionSummary[]): BulkFixCriterionCheck[] => {
    const checksArray = Array.isArray(rawChecks)
        ? rawChecks
        : rawChecks && typeof rawChecks === 'object'
            ? Object.values(rawChecks as Record<string, unknown>)
            : [];

    const normalized = checksArray
        .map((check): BulkFixCriterionCheck | null => {
            const record = check && typeof check === 'object' ? check as Record<string, unknown> : {};
            const criterionTitle = asTrimmedString(record.criterionTitle || record.criterion || record.title || record.name || record['المعيار'] || record['اسم المعيار']);
            if (!criterionTitle) return null;
            return {
                criterionTitle,
                before: asTrimmedString(record.before || record.beforeStatus || record.current || record['قبل'] || record['الحالة قبل الإصلاح']) || 'غير متاح',
                after: asTrimmedString(record.after || record.afterStatus || record.result || record['بعد'] || record['الحالة بعد التعديل']) || 'غير متاح',
                required: asTrimmedString(record.required || record.target || record['المطلوب'] || record['الحالة المطلوبة']) || 'غير متاح',
                status: normalizeCriteriaCheckStatus(record.status || record['الحالة']),
                source: record.source === 'target' || record.source === 'protection' || record.source === 'article' ? record.source : undefined,
            };
        })
        .filter((check): check is BulkFixCriterionCheck => Boolean(check));

    if (normalized.length > 0) return sortBulkFixCriteriaChecks(normalized);

    return sortBulkFixCriteriaChecks(criteria.map((criterion) => ({
        criterionTitle: criterion.title,
        before: String(criterion.current),
        after: 'غير متاح',
        required: String(criterion.required),
        status: 'unknown',
        source: criterion.source,
    })));
};

const splitBulkFixParagraphs = (value: string): string[] => (
    value.split(/\n{2,}|\r?\n/).map(part => part.trim()).filter(Boolean)
);

const splitBulkFixSentences = (value: string): string[] => (
    value.replace(/\s+/g, ' ').trim().match(/[^.!؟?؛;:]+[.!؟?؛;:]*/g)?.map(sentence => sentence.trim()).filter(Boolean) || []
);

const toWesternDigits = (value: string): string => value.replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));

const extractBulkFixRange = (value: string, unitPattern: string): { min: number; max: number } | null => {
    const normalized = toWesternDigits(value);
    const rangeRegex = new RegExp(`(\\d+)\\s*(?:-|–|—|إلى|الى|to)\\s*(\\d+)\\s*(?:${unitPattern})`, 'i');
    const rangeMatch = normalized.match(rangeRegex);
    if (rangeMatch) {
        return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
    }
    const exactRegex = new RegExp(`(?:^|\\D)(\\d+)\\s*(?:${unitPattern})`, 'i');
    const exactMatch = normalized.match(exactRegex);
    if (exactMatch) {
        const exact = Number(exactMatch[1]);
        return { min: exact, max: exact };
    }
    return null;
};

const isWithinBulkFixRange = (values: number[], range: { min: number; max: number } | null): boolean | null => {
    if (!range) return null;
    if (values.length === 0) return false;
    return values.every(value => value >= range.min && value <= range.max);
};

const buildBulkFixCandidateArticleText = (fixedText: string, targetContext?: BulkFixTargetContext): string => (
    [
        targetContext?.articleTextBefore || '',
        fixedText,
        targetContext?.articleTextAfter || '',
    ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const getBulkFixLanguage = (value: string): 'ar' | 'en' => /[\u0600-\u06FF]/.test(value) ? 'ar' : 'en';

const countBulkFixTerms = (textValue: string, arabicTerms: string[], englishTerms: string[] = []): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const terms = language === 'ar' ? arabicTerms : englishTerms;
    return terms
        .map(term => ({ term, count: countOccurrences(textValue, term, language) }))
        .filter(item => item.count > 0);
};

const formatBulkFixMatchedTerms = (matches: { term: string; count: number }[], emptyLabel: string, foundLabel: string): string => {
    if (matches.length === 0) return emptyLabel;
    const total = matches.reduce((sum, item) => sum + item.count, 0);
    const examples = matches.slice(0, 5).map(item => `${item.term}${item.count > 1 ? ` (${item.count})` : ''}`).join('، ');
    return `${foundLabel}: ${total}${examples ? ` - ${examples}` : ''}`;
};

const getBulkFixTransitionStats = (textValue: string): { count: number; total: number; percentage: number } => {
    const language = getBulkFixLanguage(textValue);
    const words = language === 'ar' ? TRANSITIONAL_WORDS : ENGLISH_TRANSITIONAL_WORDS;
    const sentences = splitBulkFixSentences(textValue);
    const count = sentences.filter(sentence => words.some(word => sentence.trim().toLowerCase().startsWith(word.toLowerCase()))).length;
    return {
        count,
        total: sentences.length,
        percentage: sentences.length > 0 ? count / sentences.length : 0,
    };
};

const getBulkFixRepeatedBigrams = (textValue: string): { term: string; count: number }[] => {
    const tokens = textValue.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const counts = new Map<string, number>();
    for (let index = 0; index < tokens.length - 1; index++) {
        const bigram = `${tokens[index]} ${tokens[index + 1]}`;
        counts.set(bigram, (counts.get(bigram) || 0) + 1);
    }
    return Array.from(counts.entries())
        .filter(([, count]) => count > 2)
        .map(([term, count]) => ({ term, count }))
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
};

const normalizeBulkFixToken = (token: string, language: 'ar' | 'en'): string => (
    language === 'ar' ? normalizeArabicText(token.toLowerCase()) : token.toLowerCase()
);

const getBulkFixRepeatedWords = (textValue: string): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const exclusionSet = language === 'ar' ? DUPLICATE_WORDS_EXCLUSION_LIST : new Set<string>();
    const tokens = textValue.match(language === 'ar' ? /\p{L}{3,}/gu : /[a-zA-Z]{3,}/g) || [];
    const counts = new Map<string, number>();

    tokens.forEach((token) => {
        const normalized = normalizeBulkFixToken(token, language);
        if (exclusionSet.has(normalized)) return;
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
    });

    return Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([term, count]) => ({ term, count }))
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
};

const getBulkFixImmediateDuplicateWords = (textValue: string): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const tokens: { text: string; normalized: string; index: number; end: number }[] = [];
    const wordRegex = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
    let match: RegExpExecArray | null;

    while ((match = wordRegex.exec(textValue)) !== null) {
        const word = match[0];
        tokens.push({
            text: word,
            normalized: normalizeBulkFixToken(word, language),
            index: match.index,
            end: match.index + word.length,
        });
    }

    const counts = new Map<string, number>();
    for (let index = 1; index < tokens.length; index++) {
        const previous = tokens[index - 1];
        const current = tokens[index];
        const separator = textValue.slice(previous.end, current.index);
        if (!previous.normalized || previous.normalized !== current.normalized || !/^\s+$/u.test(separator)) continue;
        const phrase = `${previous.text} ${current.text}`;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([term, count]) => ({ term, count }));
};

const getBulkFixSentenceBeginningRepeats = (textValue: string): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const sentences = splitBulkFixSentences(textValue);
    const counts = new Map<string, number>();

    for (let index = 0; index < sentences.length - 1; index++) {
        const first = normalizeBulkFixToken(sentences[index].trim().split(/\s+/)[0] || '', language);
        const next = normalizeBulkFixToken(sentences[index + 1].trim().split(/\s+/)[0] || '', language);
        if (!first || !next || first !== next) continue;
        counts.set(first, (counts.get(first) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([term, count]) => ({ term, count }));
};

const getBulkFixParagraphEndingRepeats = (textValue: string): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const endings = splitBulkFixParagraphs(textValue)
        .map(paragraph => paragraph.trim().split(/\s+/).pop()?.replace(/[.!?\u061F:]+$/g, '') || '')
        .map(term => normalizeBulkFixToken(term, language))
        .filter(Boolean);
    const counts = new Map<string, number>();

    for (let index = 0; index < endings.length - 1; index++) {
        if (endings[index] !== endings[index + 1]) continue;
        counts.set(endings[index], (counts.get(endings[index]) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([term, count]) => ({ term, count }));
};

const getBulkFixLatinWordStats = (textValue: string): { count: number; percentage: number; words: string[] } => {
    const latinWords = textValue.match(/[a-zA-Z]+/g) || [];
    const uniqueWords = Array.from(new Set(latinWords.map(word => word.toLowerCase()))).slice(0, 5);
    const wordCount = countWords(textValue);
    return {
        count: latinWords.length,
        percentage: wordCount > 0 ? latinWords.length / wordCount : 0,
        words: uniqueWords,
    };
};

const escapeCommonEnglishTermRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCommonEnglishTermRegex = (term: string): RegExp => {
    const parts = term.trim().split(/\s+/).map(escapeCommonEnglishTermRegex);
    return new RegExp(`(?<![A-Za-z0-9])${parts.join('[\\s_-]+')}(?![A-Za-z0-9])`, 'giu');
};

const getBulkFixCommonEnglishTermMatches = (textValue: string): { term: string; preferred: string; index: number; length: number }[] => {
    const candidates: { term: string; preferred: string; index: number; length: number }[] = [];

    COMMON_ENGLISH_TERMS.forEach(({ terms, preferred }) => {
        terms.forEach((term) => {
            const regex = buildCommonEnglishTermRegex(term);
            let match: RegExpExecArray | null;
            while ((match = regex.exec(textValue)) !== null) {
                candidates.push({
                    term: match[0],
                    preferred,
                    index: match.index,
                    length: match[0].length,
                });
            }
        });
    });

    return candidates
        .sort((a, b) => a.index - b.index || b.length - a.length)
        .reduce<{ term: string; preferred: string; index: number; length: number }[]>((selected, candidate) => {
            const overlaps = selected.some(item => candidate.index < item.index + item.length && candidate.index + candidate.length > item.index);
            return overlaps ? selected : [...selected, candidate];
        }, []);
};

const getBulkFixPunctuationSpacingIssues = (textValue: string): { label: string; count: number }[] => {
    const issues = [
        { label: 'فراغات زائدة', count: textValue.match(/ {2,}/g)?.length || 0 },
        { label: 'فراغ قبل علامة ترقيم', count: textValue.match(/\s+[.,!?\u061F\u060C]/g)?.length || 0 },
        { label: 'علامة ترقيم بلا فراغ بعدها', count: textValue.match(/[.,!?\u061F\u060C](?=\p{L}|\p{N})/gu)?.length || 0 },
        { label: 'رقم ملاصق لحرف', count: textValue.match(/(?:\p{L}\p{N}|\p{N}\p{L})/gu)?.length || 0 },
    ];
    return issues.filter(issue => issue.count > 0);
};

const escapeBulkFixRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getBulkFixAmbiguousStarts = (textValue: string): { term: string; count: number }[] => {
    const language = getBulkFixLanguage(textValue);
    const phrases = language === 'ar' ? ARABIC_AMBIGUOUS_STARTS : ENGLISH_AMBIGUOUS_STARTS;
    const counts = new Map<string, number>();

    splitBulkFixParagraphs(textValue).forEach((paragraph) => {
        const prefixMatch = paragraph.match(/^\s*["'“”«»()[\]{}]?\s*/u);
        const textAfterPrefix = paragraph.slice(prefixMatch?.[0].length ?? 0);
        const phrase = [...phrases]
            .sort((a, b) => b.length - a.length)
            .find(item => new RegExp(`^${escapeBulkFixRegex(item)}(?=$|[\\s\u060C,\u061B;:.!\u061F?])`, 'iu').test(textAfterPrefix));
        if (!phrase) return;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
    });

    return Array.from(counts.entries()).map(([term, count]) => ({ term, count }));
};

const getBulkFixTextualAudit = (
    textValue: string,
    criterionText: string,
    scope: 'local' | 'article' = 'local'
): { summary: string; passed: boolean } | null => {
    const haystack = criterionText.toLowerCase();
    const wordCount = countWords(textValue);

    if (haystack.includes('تكرار بالفقرة') || haystack.includes('repetition in paragraph')) {
        const repeated = getBulkFixRepeatedWords(textValue);
        return {
            summary: repeated.length === 0
                ? 'لا توجد كلمات مكررة مؤثرة داخل الفقرة'
                : `كلمات مكررة: ${repeated.slice(0, 5).map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: repeated.length === 0,
        };
    }

    if (haystack.includes('تكرار مباشر') || haystack.includes('direct repetition')) {
        const repeated = getBulkFixImmediateDuplicateWords(textValue);
        return {
            summary: repeated.length === 0
                ? 'لا توجد كلمات مكررة مباشرة'
                : `كلمات مكررة مباشرة: ${repeated.slice(0, 5).map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: repeated.length === 0,
        };
    }

    if (haystack.includes('بدايات الجمل') || haystack.includes('sentence beginnings')) {
        const repeated = getBulkFixSentenceBeginningRepeats(textValue);
        return {
            summary: repeated.length === 0
                ? 'لا توجد جمل متتالية تبدأ بالكلمة نفسها'
                : `بدايات متكررة: ${repeated.map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: repeated.length === 0,
        };
    }

    if (haystack.includes('نهايات الفقرات') || haystack.includes('paragraph endings')) {
        const repeated = getBulkFixParagraphEndingRepeats(textValue);
        return {
            summary: repeated.length === 0
                ? 'لا توجد نهايات فقرات متتالية بالكلمة نفسها'
                : `نهايات متكررة: ${repeated.map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: repeated.length === 0,
        };
    }

    if (haystack.includes('إحالات غامضة') || haystack.includes('ambiguous references')) {
        const ambiguousStarts = getBulkFixAmbiguousStarts(textValue);
        return {
            summary: ambiguousStarts.length === 0
                ? 'لا توجد بدايات فقرة بإحالة غامضة'
                : `إحالات غامضة في بداية الفقرة: ${ambiguousStarts.map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: ambiguousStarts.length === 0,
        };
    }

    if (haystack.includes('كلمات لاتينية') || haystack.includes('latin words')) {
        const stats = getBulkFixLatinWordStats(textValue);
        return {
            summary: `${stats.count} كلمة لاتينية من ${wordCount} كلمة (${(stats.percentage * 100).toFixed(2)}%)${stats.words.length ? ` - ${stats.words.join('، ')}` : ''}`,
            passed: stats.percentage <= 0.005,
        };
    }

    if (haystack.includes('مصطلحات إنجليزية شائعة') || haystack.includes('common english terms')) {
        const matches = getBulkFixCommonEnglishTermMatches(textValue);
        return {
            summary: matches.length === 0
                ? 'لا توجد مصطلحات إنجليزية شائعة تحتاج تعريبًا'
                : `مصطلحات تحتاج تعريبًا: ${matches.slice(0, 5).map(item => `${item.term} -> ${item.preferred}`).join('، ')}`,
            passed: matches.length === 0,
        };
    }

    if (haystack.includes('فراغات الترقيم') || haystack.includes('punctuation spacing')) {
        const issues = getBulkFixPunctuationSpacingIssues(textValue);
        return {
            summary: issues.length === 0
                ? 'لا توجد مشاكل واضحة في فراغات الترقيم'
                : `مشاكل فراغات الترقيم: ${issues.map(issue => `${issue.label} (${issue.count})`).join('، ')}`,
            passed: issues.length === 0,
        };
    }

    if (haystack.includes('كلمات للحذف') || haystack.includes('words to delete')) {
        const matches = countBulkFixTerms(textValue, WORDS_TO_DELETE, ENGLISH_WORDS_TO_DELETE);
        return {
            summary: formatBulkFixMatchedTerms(matches, 'لا توجد كلمات للحذف', 'كلمات للحذف موجودة'),
            passed: matches.length === 0,
        };
    }

    if (haystack.includes('كلمات بطيئة') || haystack.includes('slow words')) {
        const matches = countBulkFixTerms(textValue, SLOW_WORDS, ENGLISH_SLOW_WORDS);
        const total = matches.reduce((sum, item) => sum + item.count, 0);
        const percentage = wordCount > 0 ? total / wordCount : 0;
        const examples = matches.slice(0, 5).map(item => item.term).join('، ');
        return {
            summary: `${total} كلمة بطيئة من ${wordCount} كلمة (${(percentage * 100).toFixed(1)}%)${examples ? ` - ${examples}` : ''}`,
            passed: scope === 'article' ? percentage <= 0.02 : total === 0,
        };
    }

    if (haystack.includes('كلمات تحذيرية') || haystack.includes('warning words')) {
        const matches = countBulkFixTerms(textValue, WARNING_ADVICE_WORDS, ENGLISH_WARNING_ADVICE_WORDS);
        return {
            summary: formatBulkFixMatchedTerms(matches, 'لا توجد كلمات تحذيرية', 'كلمات تحذيرية موجودة'),
            passed: matches.reduce((sum, item) => sum + item.count, 0) >= 1,
        };
    }

    if (haystack.includes('كلمات الحث') || haystack.includes('cta words')) {
        const matches = countBulkFixTerms(textValue, CTA_WORDS, ENGLISH_CTA_WORDS);
        return {
            summary: formatBulkFixMatchedTerms(matches, 'لا توجد كلمات حث', 'كلمات حث موجودة'),
            passed: matches.reduce((sum, item) => sum + item.count, 0) >= 1,
        };
    }

    if (haystack.includes('لغة تفاعلية') || haystack.includes('interactive language')) {
        const matches = countBulkFixTerms(textValue, INTERACTIVE_WORDS, ENGLISH_INTERACTIVE_WORDS);
        const total = matches.reduce((sum, item) => sum + item.count, 0);
        const percentage = wordCount > 0 ? total / wordCount : 0;
        return {
            summary: `${total} كلمة تفاعلية من ${wordCount} كلمة (${(percentage * 100).toFixed(3)}%)`,
            passed: percentage >= 0.0002,
        };
    }

    if (haystack.includes('كلمات إنتقالية') || haystack.includes('كلمات انتقالية') || haystack.includes('transitional words')) {
        const stats = getBulkFixTransitionStats(textValue);
        return {
            summary: `${stats.count}/${stats.total} جملة تبدأ بكلمة انتقالية (${(stats.percentage * 100).toFixed(0)}%)`,
            passed: stats.total > 0 && stats.percentage >= 0.3,
        };
    }

    if (haystack.includes('ثنائيات مكررة') || haystack.includes('repeated bigrams')) {
        const repeated = getBulkFixRepeatedBigrams(textValue);
        return {
            summary: repeated.length === 0
                ? 'لا توجد ثنائيات مكررة أكثر من مرتين'
                : `ثنائيات مكررة: ${repeated.slice(0, 5).map(item => `${item.term} (${item.count})`).join('، ')}`,
            passed: repeated.length === 0,
        };
    }

    return null;
};

const isBulkFixArticlePresenceCriterion = (haystack: string): boolean => (
    haystack.includes('كلمات الحث') ||
    haystack.includes('cta words') ||
    haystack.includes('لغة تفاعلية') ||
    haystack.includes('interactive language') ||
    haystack.includes('كلمات تحذيرية') ||
    haystack.includes('warning words') ||
    haystack.includes('كلمات إنتقالية') ||
    haystack.includes('كلمات انتقالية') ||
    haystack.includes('transitional words')
);

const isBulkFixArticleOnlyCriterion = (haystack: string): boolean => (
    haystack.includes('عدد الكلمات') ||
    haystack.includes('word count') ||
    haystack.includes('جداول') ||
    haystack.includes('tables')
);

const summarizeBulkFixMeasuredState = (textValue: string, criterionText = '', targetContext?: BulkFixTargetContext): string => {
    const measuredText = textValue;
    const stats = getBulkFixStats(measuredText);
    const paragraphs = splitBulkFixParagraphs(measuredText);
    const sentences = splitBulkFixSentences(measuredText);
    const paragraphWords = paragraphs.map(countWords);
    const sentenceWords = sentences.map(countWords);
    const haystack = criterionText.toLowerCase();
    const isPunctuationSpacingCriterion = haystack.includes('فراغات الترقيم') || haystack.includes('punctuation spacing');
    const isPunctuationCriterion = (haystack.includes('علامات الترقيم') || haystack.includes('punctuation')) && !isPunctuationSpacingCriterion;
    if (haystack.includes('طول الجمل') || haystack.includes('sentence length')) {
        const min = sentenceWords.length ? Math.min(...sentenceWords) : 0;
        const max = sentenceWords.length ? Math.max(...sentenceWords) : 0;
        return sentenceWords.length ? `أطوال الجمل: ${min}-${max} كلمة` : 'لا توجد جمل قابلة للقياس';
    }
    if (haystack.includes('طول الفقرات') || haystack.includes('paragraph length')) {
        if (targetContext?.isListIntro) {
            return 'فقرة تمهيد خطوات منتهية بنقطتين؛ لا يطبق عليها معيار طول الفقرات العادية';
        }
        return `${stats.words} كلمة، ${stats.sentences} جملة، ${stats.paragraphs} فقرة`;
    }
    if (isPunctuationCriterion) {
        return /[.!؟?:]\s*$/.test(measuredText.trim()) ? 'علامة النهاية موجودة' : 'علامة النهاية غير موجودة';
    }
    if (haystack.includes('تمهيد خطوات') || haystack.includes('steps introduction')) {
        if (!targetContext?.isListIntro) {
            return 'لا ينطبق؛ الفقرة التالية ليست قائمة تعداد آلية';
        }
        const colonState = /[:：]\s*$/.test(measuredText.trim()) ? 'تنتهي بنقطتين' : 'لا تنتهي بنقطتين';
        return `${stats.words} كلمة، ${stats.sentences} جملة، ${colonState}`;
    }

    const textualAudit = getBulkFixTextualAudit(measuredText, criterionText, 'local');
    if (textualAudit) {
        return textualAudit.summary;
    }

    const parts: string[] = [];
    if (extractBulkFixRange(criterionText, 'كلمة|كلمات|word|words')) {
        parts.push(`${stats.words} كلمة`);
    }
    if (extractBulkFixRange(criterionText, 'جملة|جمل|sentence|sentences')) {
        parts.push(`${stats.sentences} جملة`);
    }
    if (extractBulkFixRange(criterionText, 'فقرة|فقرات|paragraph|paragraphs')) {
        parts.push(`${stats.paragraphs} فقرة`);
    }
    return parts.length > 0 ? parts.join('، ') : 'غير قابل للقياس الرقمي من النص المقترح';
};

const inferBulkFixCriterionCheck = (
    criterion: BulkFixCriterionSummary,
    originalText: string,
    fixedText: string,
    targetContext?: BulkFixTargetContext
): BulkFixCriterionCheck => {
    const criterionText = `${criterion.title} ${criterion.required} ${criterion.message || ''}`;
    const haystack = criterionText.toLowerCase();
    const wordRange = extractBulkFixRange(criterionText, 'كلمة|كلمات|word|words');
    const sentenceRange = extractBulkFixRange(criterionText, 'جملة|جمل|sentence|sentences');
    const paragraphRange = extractBulkFixRange(criterionText, 'فقرة|فقرات|paragraph|paragraphs');
    const paragraphs = splitBulkFixParagraphs(fixedText);
    const sentences = splitBulkFixSentences(fixedText);
    const afterStats = getBulkFixStats(fixedText);
    const checks: boolean[] = [];
    const isPunctuationSpacingCriterion = haystack.includes('فراغات الترقيم') || haystack.includes('punctuation spacing');
    const isPunctuationCriterion = (haystack.includes('علامات الترقيم') || haystack.includes('punctuation')) && !isPunctuationSpacingCriterion;
    const isArticleScope = criterion.source === 'article';
    const measuredText = fixedText;
    const measuredParagraphs = paragraphs;
    const measuredSentences = sentences;
    const measuredStats = afterStats;

    if (isArticleScope) {
        const textualAudit = getBulkFixTextualAudit(measuredText, criterionText, 'local');
        const after = textualAudit?.summary || summarizeBulkFixMeasuredState(fixedText, criterionText, targetContext);
        if (textualAudit) {
            return {
                criterionTitle: criterion.title,
                before: String(criterion.current),
                after,
                required: String(criterion.required),
                status: textualAudit.passed ? 'pass' : isBulkFixArticlePresenceCriterion(haystack) ? 'unknown' : 'fail',
                source: criterion.source,
            };
        }
        if (isBulkFixArticleOnlyCriterion(haystack)) {
            return {
                criterionTitle: criterion.title,
                before: String(criterion.current),
                after,
                required: String(criterion.required),
                status: 'unknown',
                source: criterion.source,
            };
        }
    }

    if (isArticleScope && criterion.status === 'pass') {
        return {
            criterionTitle: criterion.title,
            before: String(criterion.current),
            after: `محقق على مستوى المقال: ${criterion.current}`,
            required: String(criterion.required),
            status: 'pass',
            source: criterion.source,
        };
    }

    if (haystack.includes('طول الجمل') || haystack.includes('sentence length')) {
        const targetRange = wordRange || { min: 6, max: 20 };
        checks.push(isWithinBulkFixRange(measuredSentences.map(countWords), targetRange) === true);
    } else if (haystack.includes('طول الفقرات') || haystack.includes('paragraph length')) {
        if (targetContext?.isListIntro) {
            checks.push(true);
        } else {
            checks.push(isWithinBulkFixRange(measuredParagraphs.map(countWords), wordRange || { min: 30, max: 100 }) === true);
            checks.push(isWithinBulkFixRange(measuredParagraphs.map(countSentences), sentenceRange || { min: 1, max: 4 }) === true);
        }
    } else {
        const wordStatus = isWithinBulkFixRange([measuredStats.words], wordRange);
        const sentenceStatus = isWithinBulkFixRange([measuredStats.sentences], sentenceRange);
        const paragraphStatus = isWithinBulkFixRange([measuredStats.paragraphs], paragraphRange);
        [wordStatus, sentenceStatus, paragraphStatus].forEach(status => {
            if (status !== null) checks.push(status);
        });
    }

    if (isPunctuationCriterion) {
        checks.push(/[.!؟?:]\s*$/.test(measuredText.trim()));
    }
    if (haystack.includes('تمهيد خطوات') || haystack.includes('steps introduction')) {
        if (targetContext?.isListIntro) {
            checks.push(/[:：]\s*$/.test(measuredText.trim()));
        }
    }
    const textualAudit = getBulkFixTextualAudit(measuredText, criterionText, isArticleScope ? 'article' : 'local');
    if (textualAudit) {
        checks.push(textualAudit.passed);
    }

    return {
        criterionTitle: criterion.title,
        before: String(criterion.current),
        after: summarizeBulkFixMeasuredState(fixedText, criterionText, targetContext),
        required: String(criterion.required),
        status: checks.length === 0 ? 'unknown' : checks.every(Boolean) ? 'pass' : 'fail',
        source: criterion.source,
    };
};

const buildBulkFixCriteriaChecks = (
    rawChecks: unknown,
    criteria: BulkFixCriterionSummary[],
    originalText: string,
    fixedText: string,
    targetContext?: BulkFixTargetContext
): BulkFixCriterionCheck[] => {
    const aiChecks = normalizeBulkFixCriteriaChecks(rawChecks, criteria);
    if (criteria.length === 0) return aiChecks;
    return sortBulkFixCriteriaChecks(criteria.map((criterion) => {
        const inferred = inferBulkFixCriterionCheck(criterion, originalText, fixedText, targetContext);
        const matchingAiCheck = aiChecks.find(check => (
            check.criterionTitle === criterion.title ||
            check.criterionTitle.includes(criterion.title) ||
            criterion.title.includes(check.criterionTitle)
        ));
        const shouldUseAiAfter = inferred.source !== 'article' && inferred.status === 'unknown' && matchingAiCheck?.after && inferred.after.includes('غير قابل للقياس');
        const status = inferred.source === 'article'
            ? (inferred.status !== 'unknown' ? inferred.status : matchingAiCheck?.status === 'pass' ? 'pass' : 'unknown')
            : (inferred.status !== 'unknown' ? inferred.status : matchingAiCheck?.status || 'unknown');
        return {
            ...inferred,
            after: shouldUseAiAfter ? matchingAiCheck.after : inferred.after || matchingAiCheck?.after || 'غير متاح',
            status,
        };
    }));
};

const getBulkFixVariantQuality = (variant: BulkFixReviewVariant) => {
    const checks = variant.criteriaChecks || [];
    return {
        targetPass: checks.filter(check => check.source === 'target' && check.status === 'pass').length,
        targetFail: checks.filter(check => check.source === 'target' && check.status === 'fail').length,
        articlePass: checks.filter(check => check.source === 'article' && check.status === 'pass').length,
        articleFail: checks.filter(check => check.source === 'article' && check.status === 'fail').length,
        protectionFail: checks.filter(check => check.source === 'protection' && check.status === 'fail').length,
        pass: checks.filter(check => check.status === 'pass').length,
        fail: checks.filter(check => check.status === 'fail').length,
        warn: checks.filter(check => check.status === 'warn').length,
        unknown: checks.filter(check => check.status === 'unknown').length,
        total: checks.length,
    };
};

const compareBulkFixVariantsByQuality = (a: BulkFixReviewVariant, b: BulkFixReviewVariant): number => {
    const aQuality = getBulkFixVariantQuality(a);
    const bQuality = getBulkFixVariantQuality(b);
    return bQuality.targetPass - aQuality.targetPass ||
        aQuality.targetFail - bQuality.targetFail ||
        aQuality.articleFail - bQuality.articleFail ||
        bQuality.articlePass - aQuality.articlePass ||
        aQuality.protectionFail - bQuality.protectionFail ||
        bQuality.pass - aQuality.pass ||
        aQuality.fail - bQuality.fail ||
        aQuality.warn - bQuality.warn ||
        aQuality.unknown - bQuality.unknown ||
        bQuality.total - aQuality.total;
};

const isDefaultBulkFixVariantLabel = (label: string): boolean => (
    /^(?:اقتراح|الاقتراح|suggestion|option|variant)\s*\d+$/i.test(label.trim())
);

const formatDefaultBulkFixVariantLabel = (label: string, index: number): string => (
    /^(?:suggestion|option|variant)/i.test(label.trim()) ? `Suggestion ${index + 1}` : `اقتراح ${index + 1}`
);

const sortBulkFixVariantsByCriteria = (variants: BulkFixReviewVariant[]): BulkFixReviewVariant[] => (
    [...variants]
        .sort(compareBulkFixVariantsByQuality)
        .map((variant, index) => (
            isDefaultBulkFixVariantLabel(variant.label)
                ? { ...variant, label: formatDefaultBulkFixVariantLabel(variant.label, index) }
                : variant
        ))
);

const normalizeBulkFixVariants = (raw: unknown, originalText: string, criteria: BulkFixCriterionSummary[], targetContext?: BulkFixTargetContext): BulkFixReviewVariant[] => {
    const parsedRaw = typeof raw === 'string' ? (extractJson(raw) || raw) : raw;
    const record = parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw)
        ? parsedRaw as Record<string, unknown>
        : {};
    const listKeys = ['suggestions', 'variants', 'options', 'alternatives', 'اقتراحات', 'الاقتراحات', 'البدائل'];
    const textKeys = ['fixedText', 'fixed_text', 'text', 'content', 'contentMarkdown', 'replacement', 'suggestion', 'النص', 'النص المقترح', 'النص البديل', 'الاقتراح', 'المحتوى'];
    const labelKeys = ['label', 'title', 'name', 'العنوان', 'التسمية', 'اسم الاقتراح'];
    const firstValueByKeys = (source: Record<string, unknown>, keys: string[]) => {
        for (const key of keys) {
            if (source[key] != null) return source[key];
        }
        return undefined;
    };
    const looseTextVariants = (value: string): unknown[] => {
        const trimmed = value.trim();
        if (!trimmed) return [];
        const pattern = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:اقتراح|الاقتراح|Suggestion|Option|Variant)\s*\d+\s*[:：-]?\s*\n?([\s\S]*?)(?=(?:\n\s*(?:#{1,4}\s*)?(?:اقتراح|الاقتراح|Suggestion|Option|Variant)\s*\d+\s*[:：-]?)|$)/gi;
        const matches = Array.from(trimmed.matchAll(pattern))
            .map(match => match[1]?.trim())
            .filter(Boolean);
        return matches.length > 0
            ? matches.map((fixedText, index) => ({ label: `اقتراح ${index + 1}`, fixedText }))
            : [{ label: 'اقتراح 1', fixedText: trimmed }];
    };
    const rawListValue = firstValueByKeys(record, listKeys);
    const rawSuggestions = Array.isArray(parsedRaw)
        ? parsedRaw
        : Array.isArray(rawListValue)
            ? rawListValue
            : rawListValue && typeof rawListValue === 'object'
                ? Object.values(rawListValue as Record<string, unknown>)
                : firstValueByKeys(record, textKeys) != null
                    ? [{ label: 'اقتراح 1', fixedText: firstValueByKeys(record, textKeys) }]
                    : typeof parsedRaw === 'string'
                        ? looseTextVariants(parsedRaw)
                        : [];

    const statsBefore = getBulkFixStats(originalText);
    const variants = rawSuggestions
        .map((suggestion, index): BulkFixReviewVariant | null => {
            const suggestionRecord: Record<string, unknown> = suggestion && typeof suggestion === 'object'
                ? suggestion as Record<string, unknown>
                : { fixedText: suggestion };
            const fixedText = cleanAiPatchContentMarkdown(asTrimmedString(
                firstValueByKeys(suggestionRecord, textKeys)
            ));
            if (!fixedText) return null;
            return {
                id: `variant-${index + 1}-${Math.random().toString(36).slice(2)}`,
                label: asTrimmedString(firstValueByKeys(suggestionRecord, labelKeys)) || `اقتراح ${index + 1}`,
                fixedText,
                statsBefore,
                statsAfter: getBulkFixStats(fixedText),
                criteriaChecks: buildBulkFixCriteriaChecks(
                    suggestionRecord.criteriaChecks || suggestionRecord.criteria || suggestionRecord.checks || suggestionRecord['تدقيق المعايير'] || suggestionRecord['المعايير'],
                    criteria,
                    originalText,
                    fixedText,
                    targetContext
                ),
            };
        })
        .filter((variant): variant is BulkFixReviewVariant => Boolean(variant));

    return sortBulkFixVariantsByCriteria(variants).slice(0, 2);
};

const getGeminiErrorMessage = (error: unknown): string => {
    const rawMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'خطأ غير معروف';

    const jsonStart = rawMessage.indexOf('{');
    if (jsonStart !== -1) {
        try {
            const parsed = JSON.parse(rawMessage.slice(jsonStart));
            const apiError = parsed?.error;
            if (apiError?.code === 429 || apiError?.status === 'RESOURCE_EXHAUSTED') {
                return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${GEMINI_MODEL}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
            }
            if (typeof apiError?.message === 'string') {
                return apiError.message;
            }
        } catch {
            // Keep the original message if Google did not return JSON.
        }
    }

    if (/429|quota|RESOURCE_EXHAUSTED/i.test(rawMessage)) {
        return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${GEMINI_MODEL}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
    }

    return rawMessage;
};

const normalizeGeminiKeys = (keys?: string | string[]): string[] => {
    const keyList = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return keyList.map(key => key.trim()).filter(Boolean);
};

const randomizeApiKeyOrder = (keys: string[]): string[] => {
    const shuffled = [...keys];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
};

type GeminiChatMessage = {
    role: 'user' | 'model';
    text: string;
};

type GeminiAnalysisResult = {
    text: string;
    ok: boolean;
};

const getArticleChatStorageScope = (articleKey: string, title: string): string => {
    const rawScope = articleKey?.trim() || title?.trim() || 'draft';
    return rawScope.slice(0, 200);
};

const getGeminiChatStorageKey = (currentUser: string | null, articleScope: string): string => {
    const userPart = currentUser?.trim() || 'anonymous';
    const articlePart = articleScope?.trim() || 'draft';
    return `${GEMINI_CHAT_STORAGE_PREFIX}:${userPart}:${articlePart}`;
};

const truncateGeminiChatText = (value: string): string => {
    const normalizedValue = value.trim();
    if (normalizedValue.length <= GEMINI_CHAT_MESSAGE_CHAR_LIMIT) return normalizedValue;
    return `${normalizedValue.slice(0, GEMINI_CHAT_MESSAGE_CHAR_LIMIT)}\n\n[truncated]`;
};

const normalizeGeminiChatHistory = (value: unknown): GeminiChatMessage[] => {
    if (!Array.isArray(value)) return [];

    return value
        .map((item): GeminiChatMessage | null => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
            const record = item as Record<string, unknown>;
            const role = record.role === 'user' || record.role === 'model' ? record.role : null;
            const text = typeof record.text === 'string' ? truncateGeminiChatText(record.text) : '';
            if (!role || !text) return null;
            return { role, text };
        })
        .filter((item): item is GeminiChatMessage => Boolean(item));
};

const trimGeminiChatHistory = (history: GeminiChatMessage[]): GeminiChatMessage[] => {
    const recentMessages = history
        .map(message => ({ ...message, text: truncateGeminiChatText(message.text) }))
        .filter(message => message.text.length > 0)
        .slice(-GEMINI_CHAT_MAX_MESSAGES);

    const trimmedMessages: GeminiChatMessage[] = [];
    let totalChars = 0;
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
        const message = recentMessages[index];
        const nextTotal = totalChars + message.text.length;
        if (trimmedMessages.length > 0 && nextTotal > GEMINI_CHAT_MAX_TOTAL_CHARS) {
            break;
        }
        totalChars = nextTotal;
        trimmedMessages.unshift(message);
    }

    while (trimmedMessages.length > 0 && trimmedMessages[0].role !== 'user') {
        trimmedMessages.shift();
    }
    while (trimmedMessages.length > 0 && trimmedMessages[trimmedMessages.length - 1].role !== 'model') {
        trimmedMessages.pop();
    }

    return trimmedMessages;
};

const readStoredGeminiChatHistory = (currentUser: string | null, articleScope: string): GeminiChatMessage[] => {
    try {
        const value = localStorage.getItem(getGeminiChatStorageKey(currentUser, articleScope));
        return trimGeminiChatHistory(normalizeGeminiChatHistory(value ? JSON.parse(value) : []));
    } catch (error) {
        console.error('Could not read Gemini chat history from localStorage:', error);
        return [];
    }
};

const saveStoredGeminiChatHistory = (
    currentUser: string | null,
    articleScope: string,
    history: GeminiChatMessage[],
) => {
    try {
        localStorage.setItem(
            getGeminiChatStorageKey(currentUser, articleScope),
            JSON.stringify(trimGeminiChatHistory(history)),
        );
    } catch (error) {
        console.error('Could not save Gemini chat history to localStorage:', error);
    }
};

const appendGeminiChatExchange = (
    history: GeminiChatMessage[],
    prompt: string,
    response: string,
): GeminiChatMessage[] => trimGeminiChatHistory([
    ...history,
    { role: 'user', text: truncateGeminiChatText(prompt) },
    { role: 'model', text: truncateGeminiChatText(response) },
]);

const requestGeminiAnalysis = async (
    prompt: string,
    userKeys?: string | string[],
    history?: GeminiChatMessage[],
): Promise<GeminiAnalysisResult> => {
    const trimmedUserKeys = normalizeGeminiKeys(userKeys);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHATGPT_TIMEOUT_MS);

    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt,
            apiKeys: trimmedUserKeys.length > 0 ? randomizeApiKeyOrder(trimmedUserKeys) : undefined,
            history: history && history.length > 0 ? trimGeminiChatHistory(history) : undefined,
        }),
        signal: controller.signal,
      });

      window.clearTimeout(timeoutId);

      const rawBody = await response.text().catch(() => '');
      let data: Record<string, any> = {};
      try {
          data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
          // Some proxies return plain-text errors; use the raw response below.
      }

      if (response.status === 404) {
          throw new Error('Gemini API route is not enabled locally. Restart the Vite dev server so it can load the local API middleware.');
      }

      if (!response.ok) {
          const serverError = typeof data.error === 'string'
              ? data.error
              : typeof data.error?.message === 'string'
                ? data.error.message
                : rawBody.trim() && !rawBody.trim().startsWith('<')
                  ? rawBody.trim().slice(0, 500)
                  : '';
          throw new Error(serverError || `Gemini request failed with status ${response.status}`);
      }

      if (typeof data.text !== 'string') {
          throw new Error('Gemini server route did not return a valid text response.');
      }

      return { text: data.text, ok: true };
    } catch (error) {
      window.clearTimeout(timeoutId);
      console.error("Error calling Gemini API:", error);
      if (error instanceof Error && error.name === 'AbortError') {
          return {
              text: `انتهت مهلة الاتصال بـ Gemini (${GEMINI_MODEL}). حاول مرة أخرى أو استخدم مفتاحا آخر.`,
              ok: false,
          };
      }
      const errorMessage = getGeminiErrorMessage(error);
      return {
          text: `حدث خطأ أثناء الاتصال بـ Gemini: ${errorMessage}`,
          ok: false,
      };
    }
};

const callGeminiAnalysis = async (prompt: string, userKeys?: string | string[]): Promise<string> => {
    const result = await requestGeminiAnalysis(prompt, userKeys);
    return result.text;
};

const callGeminiArticleChatAnalysis = async (
    prompt: string,
    userKeys: string | string[] | undefined,
    currentUser: string | null,
    articleScope: string,
): Promise<string> => {
    const history = readStoredGeminiChatHistory(currentUser, articleScope);
    const result = await requestGeminiAnalysis(prompt, userKeys, history);
    if (result.ok) {
        saveStoredGeminiChatHistory(currentUser, articleScope, appendGeminiChatExchange(history, prompt, result.text));
    }
    return result.text;
};

const normalizeChatGptKeys = (keys?: string | string[]): string[] => {
    const keyList = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return keyList.map(key => key.trim()).filter(Boolean);
};

type ChatGptAnalysisResult = {
    text: string;
    conversationId?: string;
};

const getChatGptConversationStorageKey = (currentUser: string | null, articleKey: string): string => {
    const userPart = currentUser?.trim() || 'anonymous';
    const articlePart = articleKey?.trim() || 'default';
    return `${CHATGPT_CONVERSATION_STORAGE_PREFIX}:${userPart}:${articlePart}`;
};

const readStoredChatGptConversationId = (currentUser: string | null, articleKey: string): string | undefined => {
    try {
        const value = localStorage.getItem(getChatGptConversationStorageKey(currentUser, articleKey));
        return value?.trim() || undefined;
    } catch (error) {
        console.error('Could not read ChatGPT conversation id from localStorage:', error);
        return undefined;
    }
};

const saveStoredChatGptConversationId = (currentUser: string | null, articleKey: string, conversationId?: string) => {
    if (!conversationId?.trim()) return;
    try {
        localStorage.setItem(getChatGptConversationStorageKey(currentUser, articleKey), conversationId.trim());
    } catch (error) {
        console.error('Could not save ChatGPT conversation id to localStorage:', error);
    }
};

const callChatGptAnalysis = async (
    prompt: string,
    userKeys?: string | string[],
    conversationId?: string,
): Promise<ChatGptAnalysisResult> => {
    const trimmedUserKeys = normalizeChatGptKeys(userKeys);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHATGPT_TIMEOUT_MS);

    try {
        const response = await fetch('/api/chatgpt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                model: OPENAI_MODEL,
                apiKeys: trimmedUserKeys.length > 0 ? randomizeApiKeyOrder(trimmedUserKeys) : undefined,
                conversationId,
            }),
            signal: controller.signal,
        });

        window.clearTimeout(timeoutId);

        const isJson = response.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await response.json().catch(() => ({})) : {};

        if (response.status === 404) {
            throw new Error('مسار ChatGPT API غير مفعّل محليًا. أعد تشغيل خادم التطوير حتى يقرأ إعدادات Vite الجديدة.');
        }

        if (!response.ok) {
            throw new Error(data.error?.message || data.error || `ChatGPT request failed with status ${response.status}`);
        }

        if (typeof data.text !== 'string') {
            throw new Error('ChatGPT server route did not return a valid text response.');
        }

        return {
            text: data.text,
            conversationId: typeof data.conversationId === 'string' ? data.conversationId : conversationId,
        };
    } catch (error) {
        window.clearTimeout(timeoutId);
        console.error("Error calling ChatGPT API:", error);
        if (error instanceof Error && error.name === 'AbortError') {
            return {
                text: "انتهت مهلة الاتصال بـ ChatGPT (300 ثانية). إذا لم يظهر طلب في لوحة OpenAI فهذا يعني أن الخادم المحلي لم يصل إلى OpenAI.",
                conversationId,
            };
        }
        const message = error instanceof Error ? error.message : 'خطأ غير معروف';
        return {
            text: `حدث خطأ أثناء الاتصال بـ ChatGPT: ${message}`,
            conversationId,
        };
    }
};

const extractJson = (text: string): any | null => {
    if (!text) return null;
    const tryParse = (candidate: string): any | null => {
        try {
            return JSON.parse(candidate);
        } catch {
            return null;
        }
    };
    try {
        const trimmed = text.trim();
        const tryParsePossiblyEncoded = (candidate: string): any | null => {
            const parsed = tryParse(candidate.trim());
            if (typeof parsed === 'string' && parsed.trim() && parsed.trim() !== candidate.trim()) {
                return tryParse(parsed.trim()) || tryParseObjectBody(parsed.trim()) || parsed;
            }
            return parsed;
        };

        const tryParseObjectBody = (candidate: string): any | null => {
            const keyIndex = candidate.search(/"analysisMarkdown"\s*:/);
            if (keyIndex === -1) return null;

            const body = candidate
                .slice(keyIndex)
                .trim()
                .replace(/^[,{]\s*/, '');
            const endIndexes = [body.length - 1, body.lastIndexOf(']'), body.lastIndexOf('}')]
                .filter(index => index >= 0)
                .sort((a, b) => b - a);
            const fragments = Array.from(new Set(endIndexes.map(index => body.slice(0, index + 1))));

            for (const fragment of fragments) {
                const normalized = fragment.replace(/,\s*$/, '').trim();
                const parsed = tryParsePossiblyEncoded(`{${normalized}}`);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            }

            return null;
        };

        const directParsed = tryParsePossiblyEncoded(trimmed);
        if (directParsed != null) return directParsed;

        const objectBodyParsed = tryParseObjectBody(trimmed);
        if (objectBodyParsed != null) return objectBodyParsed;

        const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```|({[\s\S]*})/i);
        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            const candidate = jsonMatch[1] || jsonMatch[2];
            const parsed = tryParsePossiblyEncoded(candidate);
            if (parsed != null) return parsed;
            const objectBodyFromFence = tryParseObjectBody(candidate);
            if (objectBodyFromFence != null) return objectBodyFromFence;
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed = tryParsePossiblyEncoded(trimmed);
            if (parsed != null) return parsed;
        }
        const objectStart = trimmed.indexOf('{');
        const arrayStart = trimmed.indexOf('[');
        const starts = [objectStart, arrayStart].filter(index => index >= 0);
        if (starts.length > 0) {
            const start = Math.min(...starts);
            const endChar = trimmed[start] === '[' ? ']' : '}';
            const end = trimmed.lastIndexOf(endChar);
            if (end > start) {
                return tryParsePossiblyEncoded(trimmed.slice(start, end + 1));
            }
        }
        return null;
    } catch (e) {
        return null;
    }
};

const extractJsonStringProperty = (text: string, propertyName: string): string => {
    const match = new RegExp(`"${propertyName}"\\s*:\\s*"`).exec(text);
    if (!match) return '';

    let rawValue = '';
    let isEscaped = false;
    for (let index = match.index + match[0].length; index < text.length; index += 1) {
        const char = text[index];
        if (isEscaped) {
            rawValue += `\\${char}`;
            isEscaped = false;
            continue;
        }
        if (char === '\\') {
            isEscaped = true;
            continue;
        }
        if (char === '"') {
            try {
                return JSON.parse(`"${rawValue}"`).trim();
            } catch {
                return rawValue
                    .replace(/\\n/g, '\n')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .trim();
            }
        }
        rawValue += char;
    }

    return rawValue
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
};

const SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION = `

تعليمات تنفيذية للمحرر:
أرجع الرد بصيغة JSON فقط دون أي نص خارج JSON. يجب أن يكون محتوى التقرير العربي داخل analysisMarkdown، ويجب أن تكون أي إضافات جاهزة للتطبيق داخل patches.
هذه التعليمات لها أولوية على أي طلب سابق يطلب كتابة النصوص الجاهزة داخل التقرير نفسه.
مهم جداً: لا تكرر أي نص جاهز للإضافة داخل analysisMarkdown وداخل patches في الوقت نفسه.
اجعل analysisMarkdown للتشخيص المختصر، الحكم، الفجوة، سببها، ومكانها فقط.
اجعل patches هي المكان الوحيد الذي يحتوي النصوص الجاهزة للنسخ أو الإدراج داخل المقال.
إذا كان بند في التقرير يحتاج "الحل العملي الجاهز" أو "الإجابة المقترحة" أو "الجملة المقترحة"، فاكتب في analysisMarkdown سبب المشكلة ومكانها باختصار، ثم ضع علامة [[PATCH:patch_1]] مباشرة في موضع بطاقة التنفيذ.
استخدم هذا الشكل حصراً:
{
  "analysisMarkdown": "اكتب هنا التحليل العربي بنفس ترتيب الأمر المطلوب.",
  "patches": [
    {
      "marker": "patch_1",
      "operation": "insert_after_heading",
      "title": "عنوان قصير للتعديل",
      "anchorText": "العنوان أو الفقرة المرجعية داخل المقال",
      "targetText": "",
      "placementLabel": "بعد قسم كذا",
      "contentMarkdown": "النص المقترح الجاهز للإضافة فقط",
      "reason": "سبب مختصر",
      "confidence": 0.85
    }
  ]
}

القيم المسموحة لـ operation:
- replace_block
- replace_text
- insert_after_heading
- insert_before_heading
- append_to_section
- insert_before_faq
- insert_before_conclusion
- append_to_article

اجعل patches تشمل فقط النصوص المقترحة الجاهزة للإضافة أو الاستبدال الجزئي المذكورة في التحليل. لا تضف patches إذا لم يكن هناك نص جاهز قابل للتطبيق داخل المقال. لا تخترع معلومات جديدة.`;

const READY_COMMAND_PATCH_CARD_REQUIREMENT = `

تعليمات إلزامية إضافية للأوامر اليدوية الجاهزة:
أي أمر جاهز ينتج نصًا قابلًا للتطبيق داخل المقال يجب أن يضع هذا النص داخل patches فقط، مع علامة [[PATCH:...]] داخل analysisMarkdown في نفس موضع الحديث عن التعديل.

ينطبق ذلك على جميع الحالات التالية:
- تحسين أضعف قسم أو فقرة.
- الأقسام الأقل ملاءمة أو غير المناسبة.
- تحسين الخاتمة.
- اقتراح فقرة أو فكرة جديدة.
- تحويل فقرة إلى جدول أو قائمة أو خطوات.
- إضافة أسئلة شائعة أو إجابات أو جمل قابلة للاقتباس.
- أي صياغة بديلة أو نسخة محسنة أو نص جاهز للاستبدال أو الإضافة.

لكل patch يجب الالتزام بما يلي:
- إذا كان المطلوب استبدال قسم أو فقرة موجودة، استخدم operation بقيمة "replace_block".
- ضع في targetText النص الأصلي المراد استبداله حرفيًا من المقال، أو بداية الفقرة/القسم حرفيًا إذا كان النص طويلًا جدًا.
- لا تضع في targetText تسمية للمكان مثل "الفقرة الافتتاحية" أو "المقدمة"؛ ضع نص الفقرة الفعلي الموجود في المحرر.
- إذا كانت الفقرة المراد استبدالها قبل أول عنوان قسم، ضع نصها الحرفي في targetText ولا تربطها بعنوان قسم لاحق في anchorText.
- ضع في anchorText عنوان القسم أو الجملة المرجعية الأقرب داخل المقال.
- ضع في placementLabel وصفًا قصيرًا واضحًا لمكان التنفيذ مثل: داخل قسم كذا، بعد فقرة كذا، قبل الخاتمة.
- ضع في contentMarkdown النص الجديد الجاهز للتطبيق فقط دون شرح.
- لا تكتفِ بكتابة الصياغة البديلة داخل analysisMarkdown.
- لا تكتب عبارات مثل "الصياغة البديلة:" أو "النص المقترح:" داخل contentMarkdown.

بالنسبة لأمر الأقسام الأقل ملاءمة:
- أنشئ patch مستقل لكل قسم غير مناسب أو أقل ملاءمة.
- اجعل كل patch يستبدل القسم أو الفقرة الضعيفة بنسخة أكثر ملاءمة لهدف الصفحة والجمهور والكلمات الدلالية.
- يجب أن يظهر داخل analysisMarkdown سبب المشكلة ومكانها فقط، ثم علامة [[PATCH:patch_1]] أو [[PATCH:patch_2]] لعرض بطاقة الاستبدال.

بالنسبة لأمر أسئلة الناس People Also Ask:
- أنشئ patch مستقل لكل سؤال قابل للإضافة.
- استخدم operation بقيمة "insert_before_faq".
- اكتب contentMarkdown بهذا الشكل فقط:
### السؤال المقترح؟
الإجابة المختصرة المفيدة في فقرة واحدة.
- يجب أن يكون السؤال H3 باستخدام ###.
- يجب أن يحتوي كل patch على سؤال مع إجابة، وليس السؤال وحده.
- اجعل anchorText عنوان قسم الأسئلة الشائعة إن ظهر في المقال، أو اتركه عامًا مثل "الأسئلة الشائعة".
- اجعل placementLabel يوضح أن الإضافة تكون داخل قسم الأسئلة الشائعة، أو قبل الخاتمة إذا لم يوجد قسم أسئلة.
`;

const SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION = `

تعليمات أحدث لبطاقات التنفيذ داخل التقرير:
يجب أن يظهر خيار التنفيذ داخل analysisMarkdown نفسه، وليس في قسم منفصل في آخر التقرير.
لكل نص جاهز قابل للتطبيق، أنشئ patch واحداً فقط، ثم ضع داخل analysisMarkdown علامة مكانها بالضبط بهذا الشكل:
[[PATCH:patch_1]]
[[PATCH:patch_2]]

لكل patch استخدم marker مطابقاً للعلامة، مثل "patch_1". لا تكتب النص الجاهز داخل analysisMarkdown.

إذا كان المطلوب تعديل فقرة موجودة، استخدم operation بقيمة "replace_block"، ويجب أن يكون targetText نسخة حرفية من الفقرة الحالية داخل المقال لا تلخيصاً لها. ضع النص الجديد فقط في contentMarkdown.
لا تستخدم في targetText تسميات عامة مثل "الفقرة الافتتاحية" أو "المقدمة". عند تعديل فقرة افتتاحية قبل أول عنوان قسم، انسخ الفقرة نفسها حرفيًا في targetText واترك anchorText فارغًا إذا لم يوجد عنوان سابق لها.
إذا لم تستطع نسخ الفقرة الحالية حرفياً، فلا تستخدم replace_block، واستخدم عملية إضافة مناسبة بدلاً من ذلك.
إذا كان المطلوب إضافة فقرة أو سؤال أو جملة جديدة، استخدم عمليات الإضافة المناسبة مثل insert_after_heading أو insert_before_faq أو insert_before_conclusion أو append_to_section أو append_to_article.
مهم جداً: يجب أن يكون contentMarkdown محتوى نهائياً جاهزاً للإدراج في المقال فقط، دون أي تسميات تفسيرية مثل "السؤال:" أو "الإجابة:" أو "النص المقترح:" أو "الحل العملي الجاهز:" أو "مكان الإضافة:".
إذا كان المحتوى سؤالاً وجواباً، فاكتب السؤال كسطر عنوان Markdown مناسب ثم الجواب مباشرة تحته، دون كتابة كلمتي "السؤال" أو "الإجابة".

الشكل المطلوب لكل patch:
{
  "marker": "patch_1",
  "operation": "replace_block",
  "title": "عنوان قصير للتنفيذ",
  "targetText": "النص الحالي المراد استبداله عند وجود تعديل",
  "anchorText": "عنوان أو فقرة مرجعية عند وجود إضافة",
  "placementLabel": "مكان التنفيذ المختصر",
  "contentMarkdown": "النص الجاهز للتطبيق فقط",
  "reason": "سبب مختصر",
  "confidence": 0.85
}

عند تحويل فقرة أو مقطع موجود إلى جدول أو قائمة نقطية أو قائمة مرقمة أو قائمة تحقق أو خطوات، استخدم دائماً operation بقيمة "replace_block"، واجعل targetText نسخة حرفية من النص الحالي، واجعل contentMarkdown يحتوي النص البديل فقط. عند إنشاء جدول Markdown يجب أن يحتوي contentMarkdown على صفوف جدول كاملة، ويفضل إضافة صف الفاصل، ولا تكتف بصف عنوان واحد يبدأ وينتهي بعلامة | دون بيانات.

لا تستخدم عبارة "قسم التعديلات القابلة للتطبيق". استخدم فقط علامة [[PATCH:...]] في موضع التنفيذ داخل التقرير.`;

const buildSmartAnalysisFinalPrompt = (contextPrompt: string, options?: { skipPatchInstructions?: boolean }) => (
    options?.skipPatchInstructions
        ? contextPrompt
        : `${contextPrompt}\n\n${SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION}\n\n${READY_COMMAND_PATCH_CARD_REQUIREMENT}\n\n${SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION}`
);

const saveContentSummaryForCompetitors = (
    summary: string,
    provider: AiPatchProvider,
    historyMeta: ReadyCommandAnalysisHistoryMeta,
) => {
    const cleanSummary = summary.trim();
    if (!cleanSummary) return;

    const payload = {
        summary: cleanSummary,
        savedAt: new Date().toISOString(),
        provider,
        commandId: historyMeta.commandId,
        commandLabel: historyMeta.commandLabel,
        wordCount: cleanSummary.split(/\s+/).filter(Boolean).length,
    };

    try {
        localStorage.setItem(CONTENT_SUMMARY_STORAGE_KEY, JSON.stringify(payload));
        window.dispatchEvent(new CustomEvent('bazarvan:content-summary-updated', { detail: payload }));
    } catch (error) {
        console.error('Could not save content summary for competitors:', error);
    }
};

const isAiErrorResponseText = (value: string): boolean => (
    /^(?:حدث خطأ أثناء الاتصال|انتهت مهلة الاتصال|فشل التحليل|فشل تحليل|فشل التحليل المتعدد|Gemini API route|The Gemini API|Could not|تعذر)/i.test(value.trim())
);

const ALLOWED_PATCH_OPERATIONS = new Set<AiContentPatchOperation>([
    'replace_block',
    'replace_text',
    'insert_after_heading',
    'insert_before_heading',
    'append_to_section',
    'insert_before_faq',
    'insert_before_conclusion',
    'append_to_article',
]);

const asTrimmedString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const AI_PATCH_LABEL_PATTERN = /^(?:[-*]\s*)?(?:السؤال(?:\s+المقترح)?|الإجابة|الاجابة|الإجابة\s+المقترحة(?:\s+الجاهزة)?|الاجابة\s+المقترحة(?:\s+الجاهزة)?|الجملة\s+المقترحة|جمل\s+مقترحة\s+للإضافة\s+للنص|النص\s+المقترح(?:\s+لإضافة\s+الكيان)?|الصياغة\s+المقترحة(?:\s+بعد\s+التخفيف\s+أو\s+التوضيح)?|الحل\s+العملي\s+الجاهز(?:\s+[^:]*)?|مكان\s+الإضافة|مكان\s+إضافتها\s+المقترح|مكان\s+تطبيقه|الموضع\s+المقترح)\s*[:：]\s*/i;

const stripAiPatchLabelsFromLine = (line: string): string => line.replace(AI_PATCH_LABEL_PATTERN, '').trim();

const extractLabeledValue = (lines: string[], labels: RegExp[]): string => {
    for (const line of lines) {
        const trimmed = line.trim();
        for (const label of labels) {
            const match = trimmed.match(label);
            if (match?.[1]?.trim()) return match[1].trim();
        }
    }
    return '';
};

const cleanAiPatchContentMarkdown = (value: string): string => {
    const rawLines = value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (rawLines.length === 0) return '';

    const question = extractLabeledValue(rawLines, [
        /^(?:[-*]\s*)?السؤال(?:\s+المقترح)?\s*[:：]\s*(.+)$/i,
    ]);
    const answer = extractLabeledValue(rawLines, [
        /^(?:[-*]\s*)?(?:الإجابة|الاجابة)(?:\s+المقترحة(?:\s+الجاهزة)?)?\s*[:：]\s*(.+)$/i,
    ]);

    if (question && answer) {
        return `### ${question}\n${answer}`;
    }

    return rawLines
        .map(stripAiPatchLabelsFromLine)
        .filter(line => {
            const normalized = normalizeAnchorText(line);
            return normalized && ![
                'السؤال',
                'الاجابه',
                'الاجابة',
                'النص المقترح',
                'الحل العملي الجاهز',
                'مكان الاضافه',
                'مكان الاضافة',
            ].includes(normalized);
        })
        .join('\n')
        .trim();
};

const normalizePatchOperation = (value: unknown): AiContentPatchOperation => {
    const operation = asTrimmedString(value) as AiContentPatchOperation;
    if (operation === 'replace_text' || operation === 'replace_block') return operation;
    if (['replace', 'replace_paragraph', 'update_paragraph', 'rewrite_paragraph'].includes(operation)) return 'replace_block';
    return ALLOWED_PATCH_OPERATIONS.has(operation) ? operation : 'append_to_article';
};

const normalizeConfidence = (value: unknown): number | undefined => {
    const confidence = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(confidence)) return undefined;
    return Math.min(1, Math.max(0, confidence));
};

const normalizeAiPatches = (rawPatches: unknown, provider: AiPatchProvider): AiContentPatch[] => {
    if (!Array.isArray(rawPatches)) return [];

    return rawPatches
        .map((patch, index): AiContentPatch | null => {
            if (!patch || typeof patch !== 'object') return null;
            const record = patch as Record<string, unknown>;
            const contentMarkdown = cleanAiPatchContentMarkdown(asTrimmedString(record.contentMarkdown || record.content || record.text));
            if (!contentMarkdown) return null;

            return {
                id: `${provider}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
                provider,
                operation: normalizePatchOperation(record.operation || record.type),
                title: asTrimmedString(record.title) || `تعديل ${index + 1}`,
                marker: asTrimmedString(record.marker) || `patch_${index + 1}`,
                anchorText: asTrimmedString(record.anchorText || record.anchor || record.target),
                targetText: asTrimmedString(record.targetText || record.originalText || record.currentText || record.original || record.replaceTarget),
                placementLabel: asTrimmedString(record.placementLabel || record.placement || record.place),
                contentMarkdown,
                reason: asTrimmedString(record.reason),
                confidence: normalizeConfidence(record.confidence),
                status: 'pending',
            };
        })
        .filter((patch): patch is AiContentPatch => Boolean(patch))
        .slice(0, 20);
};

const stripDuplicatePatchTextFromAnalysis = (analysisMarkdown: string, patches: AiContentPatch[]): string => {
    let cleaned = analysisMarkdown;

    patches.forEach((patch) => {
        const content = patch.contentMarkdown.trim();
        if (content.length < 20) return;
        cleaned = cleaned.split(content).join(`[[PATCH:${patch.marker || patch.title}]]`);
    });

    return cleaned
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const parseSmartAnalysisResponse = (rawResponse: string, provider: AiPatchProvider): { displayText: string; patches: AiContentPatch[] } => {
    const parsed = extractJson(rawResponse);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const partialDisplayText = extractJsonStringProperty(rawResponse, 'analysisMarkdown');
        if (partialDisplayText) {
            return { displayText: partialDisplayText, patches: [] };
        }
        return { displayText: rawResponse, patches: [] };
    }

    const record = parsed as Record<string, unknown>;
    const displayText = asTrimmedString(
        record.analysisMarkdown ||
        record.analysis ||
        record.reportMarkdown ||
        record.report ||
        record.markdown
    );

    const patches = normalizeAiPatches(record.patches || record.insertions || record.contentPatches, provider);
    if (!displayText && patches.length === 0) {
        return { displayText: rawResponse, patches: [] };
    }

    return { displayText: patches.length ? stripDuplicatePatchTextFromAnalysis(displayText || rawResponse, patches) : displayText || rawResponse, patches };
};

type SmartAnalysisParsedResult = ReturnType<typeof parseSmartAnalysisResponse>;

const normalizePatchMarkerId = (value: string): string => {
    const normalized = value
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || 'patch';
};

const namespaceSmartAnalysisPatches = (
    parsedResult: SmartAnalysisParsedResult,
    namespace: string,
    titlePrefix?: string
): SmartAnalysisParsedResult => {
    let displayText = parsedResult.displayText;
    const patches = parsedResult.patches.map((patch, index) => {
        const originalMarker = patch.marker || patch.title || `patch_${index + 1}`;
        const marker = `${namespace}_${normalizePatchMarkerId(originalMarker)}`;
        displayText = displayText.split(`[[PATCH:${originalMarker}]]`).join(`[[PATCH:${marker}]]`);
        return {
            ...patch,
            marker,
            title: titlePrefix ? `${titlePrefix}: ${patch.title}` : patch.title,
        };
    });

    return { displayText, patches };
};

const normalizeFaqQuestionHeading = (line: string): string => line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+[\).\-\s]+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:السؤال|سؤال|س)\s*[:：-]\s*/i, '')
    .trim();

const normalizeFaqAnswerLine = (line: string): string => line
    .replace(/^(?:الإجابة|الاجابة|جواب|ج)\s*[:：-]\s*/i, '')
    .trim();

const ensureFaqQuestionContentMarkdown = (contentMarkdown: string): string => {
    const lines = contentMarkdown
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) return contentMarkdown.trim();

    const question = normalizeFaqQuestionHeading(lines[0]);
    const answer = lines
        .slice(1)
        .map(normalizeFaqAnswerLine)
        .filter(Boolean)
        .join('\n')
        .trim();

    if (!question) return contentMarkdown.trim();
    return answer ? `### ${question}\n${answer}` : `### ${question}`;
};

const applyReadyCommandPatchRules = (
    parsedResult: SmartAnalysisParsedResult,
    commandId?: string
): SmartAnalysisParsedResult => {
    if (commandId !== ENGINEERING_PROMPT_IDS.smartAnalysis.peopleQuestions) return parsedResult;

    return {
        displayText: parsedResult.displayText,
        patches: parsedResult.patches.map(patch => ({
            ...patch,
            operation: 'insert_before_faq',
            anchorText: patch.anchorText || 'الأسئلة الشائعة',
            targetText: '',
            placementLabel: patch.placementLabel || 'داخل قسم الأسئلة الشائعة',
            contentMarkdown: ensureFaqQuestionContentMarkdown(patch.contentMarkdown),
        })),
    };
};

const normalizeAnchorText = (value: string): string => value
    .normalize('NFKC')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[\u200c\u200d\u200e\u200f]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

type HeadingMatch = {
    pos: number;
    to: number;
    level: number;
    text: string;
    score: number;
};

const scoreHeadingMatch = (headingText: string, anchorText: string): number => {
    const heading = normalizeAnchorText(headingText);
    const anchor = normalizeAnchorText(anchorText);
    if (!heading || !anchor) return 0;
    if (heading === anchor) return 3;
    if (heading.includes(anchor) || anchor.includes(heading)) return 2;

    const anchorWords = anchor.split(' ').filter(word => word.length > 2);
    if (anchorWords.length === 0) return 0;
    const overlap = anchorWords.filter(word => heading.includes(word)).length / anchorWords.length;
    return overlap >= 0.6 ? overlap : 0;
};

const findHeadingMatch = (editor: any, anchorText: string): HeadingMatch | null => {
    if (!editor || !anchorText.trim()) return null;
    let bestMatch: HeadingMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name !== 'heading') return true;
        const score = scoreHeadingMatch(node.textContent, anchorText);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = {
                pos,
                to: pos + node.nodeSize,
                level: node.attrs.level || 2,
                text: node.textContent,
                score,
            };
        }
        return true;
    });

    return bestMatch;
};

const findHeadingByKeywords = (editor: any, keywords: string[]): HeadingMatch | null => {
    if (!editor) return null;
    let match: HeadingMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name !== 'heading') return true;
        const heading = normalizeAnchorText(node.textContent);
        const found = keywords.some(keyword => {
            const normalizedKeyword = normalizeAnchorText(keyword);
            return normalizedKeyword && heading.includes(normalizedKeyword);
        });
        if (found) {
            match = {
                pos,
                to: pos + node.nodeSize,
                level: node.attrs.level || 2,
                text: node.textContent,
                score: 2,
            };
            return false;
        }
        return true;
    });

    return match;
};

const findHeadingByKeywordsAfter = (editor: any, keywords: string[], startPos: number): HeadingMatch | null => {
    if (!editor) return null;
    let match: HeadingMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (pos <= startPos) return true;
        if (node.type.name !== 'heading') return true;
        const heading = normalizeAnchorText(node.textContent);
        const found = keywords.some(keyword => {
            const normalizedKeyword = normalizeAnchorText(keyword);
            return normalizedKeyword && heading.includes(normalizedKeyword);
        });

        if (found) {
            match = {
                pos,
                to: pos + node.nodeSize,
                level: node.attrs.level || 2,
                text: node.textContent,
                score: 2,
            };
            return false;
        }

        return true;
    });

    return match;
};

const REPLACEABLE_BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem']);
const MAX_REPLACE_RANGE_BLOCKS = 12;

const scoreTextBlockMatch = (blockText: string, targetText: string): number => {
    const block = normalizeAnchorText(blockText);
    const target = normalizeAnchorText(targetText);
    if (!block || !target) return 0;
    if (block === target) return 4;
    if (block.includes(target) || target.includes(block)) return 3;

    const targetWords = target.split(' ').filter(word => word.length > 2);
    if (targetWords.length === 0) return 0;
    const overlap = targetWords.filter(word => block.includes(word)).length / targetWords.length;
    const requiredOverlap = targetWords.length >= 14 ? 0.45 : targetWords.length >= 8 ? 0.55 : 0.7;
    return overlap >= requiredOverlap ? overlap : 0;
};

type TextBlockMatch = {
    from: number;
    to: number;
    score: number;
    text?: string;
};

type TextBlockSearchBounds = {
    from?: number;
    to?: number;
};

type TextBlockCandidate = {
    from: number;
    to: number;
    text: string;
};

const getNodeSearchText = (node: any): string => {
    if (!node) return '';
    if (typeof node.textBetween === 'function') {
        return node.textBetween(0, node.content?.size || 0, '\n', '\n') || node.textContent || '';
    }
    return node.textContent || '';
};

const isInsideTextBlockSearchBounds = (from: number, to: number, bounds?: TextBlockSearchBounds): boolean => {
    if (!bounds) return true;
    if (typeof bounds.from === 'number' && from < bounds.from) return false;
    if (typeof bounds.to === 'number' && to > bounds.to) return false;
    return true;
};

const isBetterTextBlockMatch = (next: TextBlockMatch, current: TextBlockMatch | null, targetText: string): boolean => {
    if (!current) return true;
    if (Math.abs(next.score - current.score) > 0.001) return next.score > current.score;

    const targetLength = normalizeAnchorText(targetText).length;
    if (targetLength > 0 && next.text && current.text) {
        const nextDistance = Math.abs(normalizeAnchorText(next.text).length - targetLength);
        const currentDistance = Math.abs(normalizeAnchorText(current.text).length - targetLength);
        if (nextDistance !== currentDistance) return nextDistance < currentDistance;
    }

    return (next.to - next.from) > (current.to - current.from);
};

const findTextBlockMatch = (editor: any, targetText: string, bounds?: TextBlockSearchBounds): TextBlockMatch | null => {
    if (!editor || !targetText.trim()) return null;
    let bestMatch: TextBlockMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (!REPLACEABLE_BLOCK_TYPES.has(node.type.name)) return true;
        if (!isInsideTextBlockSearchBounds(pos, pos + node.nodeSize, bounds)) return true;
        const textContent = getNodeSearchText(node);
        if (!textContent.trim()) return true;
        const score = scoreTextBlockMatch(textContent, targetText);
        const match = {
            from: pos,
            to: pos + node.nodeSize,
            score,
            text: textContent,
        };
        if (score > 0 && isBetterTextBlockMatch(match, bestMatch, targetText)) {
            bestMatch = match;
        }
        return true;
    });

    return bestMatch;
};

const collectTopLevelTextBlocks = (editor: any, bounds?: TextBlockSearchBounds): TextBlockCandidate[] => {
    if (!editor?.state?.doc) return [];
    const blocks: TextBlockCandidate[] = [];

    editor.state.doc.forEach((node: any, offset: number) => {
        if (!node.isBlock) return;
        if (!isInsideTextBlockSearchBounds(offset, offset + node.nodeSize, bounds)) return;
        const text = getNodeSearchText(node);
        if (!text.trim()) return;
        blocks.push({
            from: offset,
            to: offset + node.nodeSize,
            text,
        });
    });

    return blocks;
};

const findTextBlockRangeMatch = (editor: any, targetText: string, bounds?: TextBlockSearchBounds): TextBlockMatch | null => {
    if (!editor || !targetText.trim()) return null;
    const blocks = collectTopLevelTextBlocks(editor, bounds);
    let bestMatch: TextBlockMatch | null = null;

    blocks.forEach((startBlock, startIndex) => {
        let combinedText = '';
        const maxEndIndex = Math.min(blocks.length, startIndex + MAX_REPLACE_RANGE_BLOCKS);

        for (let endIndex = startIndex; endIndex < maxEndIndex; endIndex += 1) {
            const endBlock = blocks[endIndex];
            combinedText = combinedText ? `${combinedText}\n${endBlock.text}` : endBlock.text;
            const score = scoreTextBlockMatch(combinedText, targetText);
            const match = {
                from: startBlock.from,
                to: endBlock.to,
                score,
                text: combinedText,
            };

            if (score > 0 && isBetterTextBlockMatch(match, bestMatch, targetText)) {
                bestMatch = match;
            }
            if (score >= 4) break;
        }
    });

    return bestMatch;
};

const findBestTextBlockMatch = (editor: any, candidates: string[], bounds?: TextBlockSearchBounds): TextBlockMatch | null => {
    let bestMatch: TextBlockMatch | null = null;

    candidates
        .map(candidate => candidate.trim())
        .filter(candidate => candidate.length > 0)
        .forEach(candidate => {
            const singleBlockMatch = findTextBlockMatch(editor, candidate, bounds);
            const rangeMatch = findTextBlockRangeMatch(editor, candidate, bounds);
            [singleBlockMatch, rangeMatch].forEach(match => {
                if (match && isBetterTextBlockMatch(match, bestMatch, candidate)) {
                    bestMatch = match;
                }
            });
        });

    return bestMatch;
};

const normalizePatchLocationCandidate = (value?: string): string => (value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:بعد|قبل|داخل|ضمن|في)\s+(?:قسم|عنوان|فقرة|جزء)\s+/i, '')
    .trim();

const getPatchLocationCandidates = (patch: AiContentPatch): string[] => {
    const candidates = [
        patch.targetText,
        patch.anchorText,
        patch.placementLabel,
    ].map(normalizePatchLocationCandidate);
    const seen = new Set<string>();

    return candidates.filter(candidate => {
        const normalized = normalizeAnchorText(candidate);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
    });
};

const isConfidentLocationMatch = (match: TextBlockMatch | null, candidate: string): match is TextBlockMatch => {
    if (!match) return false;
    if (match.score >= 3) return true;

    const candidateWordCount = normalizeAnchorText(candidate).split(' ').filter(Boolean).length;
    if (candidateWordCount < 4) return false;
    if (candidateWordCount >= 12) return match.score >= 0.5;
    if (candidateWordCount >= 8) return match.score >= 0.58;
    return match.score >= 0.68;
};

const findPatchLocationBlockMatch = (
    editor: any,
    patch: AiContentPatch,
    bounds?: TextBlockSearchBounds,
): TextBlockMatch | null => {
    let bestMatch: TextBlockMatch | null = null;

    getPatchLocationCandidates(patch).forEach(candidate => {
        const match = findBestTextBlockMatch(editor, [candidate], bounds);
        if (!isConfidentLocationMatch(match, candidate)) return;
        if (isBetterTextBlockMatch(match, bestMatch, candidate)) {
            bestMatch = match;
        }
    });

    return bestMatch;
};

const isConfidentReplacementMatch = (match: TextBlockMatch | null, targetText: string): match is TextBlockMatch => {
    if (!match) return false;
    if (match.score >= 3) return true;

    const targetWordCount = normalizeAnchorText(targetText).split(' ').filter(Boolean).length;
    if (targetWordCount < 6) return false;
    if (targetWordCount >= 14) return match.score >= 0.72;
    if (targetWordCount >= 8) return match.score >= 0.78;
    return match.score >= 0.9;
};

const INTRODUCTION_TARGET_KEYWORDS = [
    'الفقرة الافتتاحية',
    'فقرة افتتاحية',
    'المقدمة',
    'مقدمة المقال',
    'افتتاحية المقال',
    'opening paragraph',
    'introduction',
    'intro',
];

const findIntroductionReplacementTarget = (editor: any, patch: AiContentPatch): TextBlockMatch | null => {
    const locationHint = normalizeAnchorText([
        patch.title,
        patch.placementLabel,
        patch.anchorText,
        patch.targetText,
    ].filter(Boolean).join(' '));
    const refersToIntroduction = INTRODUCTION_TARGET_KEYWORDS.some(keyword => (
        locationHint.includes(normalizeAnchorText(keyword))
    ));
    if (!refersToIntroduction || !editor?.state?.doc) return null;

    let firstParagraph: TextBlockMatch | null = null;
    editor.state.doc.forEach((node: any, offset: number) => {
        if (firstParagraph || node.type.name !== 'paragraph' || !node.textContent?.trim()) return;
        firstParagraph = {
            from: offset,
            to: offset + node.nodeSize,
            score: 1,
            text: node.textContent,
        };
    });

    return firstParagraph;
};

const normalizeBulkFixRangeMatchText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const findExactBulkFixTextUnitMatch = (editor: any, targetText: string, preferredFrom: number): TextBlockMatch | null => {
    if (!editor || !targetText.trim()) return null;
    const normalizedTarget = normalizeBulkFixRangeMatchText(targetText);
    if (!normalizedTarget) return null;
    const candidates: TextBlockMatch[] = [];

    editor.state.doc.descendants((node: any, pos: number) => {
        if (!node.isBlock || !['paragraph', 'heading', 'listItem'].includes(node.type.name)) return true;
        const textContent = node.textContent || '';
        if (normalizeBulkFixRangeMatchText(textContent) !== normalizedTarget) return true;
        candidates.push({ from: pos, to: pos + node.nodeSize, score: 4 });
        return true;
    });

    return candidates.sort((a, b) => Math.abs(a.from - preferredFrom) - Math.abs(b.from - preferredFrom))[0] || null;
};

const findSectionEnd = (editor: any, heading: HeadingMatch): number => {
    let sectionEnd = editor.state.doc.content.size;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (pos <= heading.pos) return true;
        if (node.type.name === 'heading' && (node.attrs.level || 2) <= heading.level) {
            sectionEnd = pos;
            return false;
        }
        return true;
    });

    return sectionEnd;
};

const FAQ_SECTION_HEADING_KEYWORDS = [
    ...FAQ_KEYWORDS,
    'الأسئلة الشائعة',
    'اسئلة شائعة',
    'faq',
    'faqs',
    'frequently asked questions',
];

const CONCLUSION_HEADING_KEYWORDS = [
    ...CONCLUSION_KEYWORDS,
    'ختام',
    'conclusion',
    'summary',
];

const findFaqAppendTarget = (editor: any, docEnd: number): PatchTarget => {
    const faqHeading = findHeadingByKeywords(editor, FAQ_SECTION_HEADING_KEYWORDS);

    if (!faqHeading) {
        const conclusionHeading = findHeadingByKeywords(editor, CONCLUSION_HEADING_KEYWORDS);
        const fallbackPos = conclusionHeading?.pos ?? docEnd;
        return {
            from: fallbackPos,
            to: fallbackPos,
            selectFrom: conclusionHeading?.pos ?? docEnd,
            selectTo: conclusionHeading?.to ?? docEnd,
            mode: 'insert',
        };
    }

    const sectionEnd = findSectionEnd(editor, faqHeading);
    const conclusionHeading = findHeadingByKeywordsAfter(editor, CONCLUSION_HEADING_KEYWORDS, faqHeading.pos);
    const insertBeforeConclusion = conclusionHeading && conclusionHeading.pos <= sectionEnd
        ? conclusionHeading.pos
        : null;
    const insertionPos = insertBeforeConclusion ?? sectionEnd;

    return {
        from: insertionPos,
        to: insertionPos,
        selectFrom: faqHeading.pos,
        selectTo: faqHeading.to,
        mode: 'insert',
    };
};

type PatchTarget = {
    from: number;
    to: number;
    selectFrom: number;
    selectTo: number;
    mode: 'insert' | 'replace';
};

const resolveAiPatchTarget = (editor: any, patch: AiContentPatch): PatchTarget | { error: string } => {
    if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
    const docEnd = editor.state.doc.content.size;

    if (patch.operation === 'replace_block' || patch.operation === 'replace_text') {
        const targetText = patch.targetText?.trim() ? patch.targetText : patch.anchorText || '';
        const replaceCandidates = [targetText];
        const anchorHeading = patch.anchorText?.trim() ? findHeadingMatch(editor, patch.anchorText) : null;

        if (anchorHeading && patch.targetText?.trim()) {
            const sectionEnd = findSectionEnd(editor, anchorHeading);
            const sectionMatch = findBestTextBlockMatch(editor, replaceCandidates, {
                from: anchorHeading.pos,
                to: sectionEnd,
            });
            if (isConfidentReplacementMatch(sectionMatch, targetText)) {
                return { from: sectionMatch.from, to: sectionMatch.to, selectFrom: sectionMatch.from, selectTo: sectionMatch.to, mode: 'replace' };
            }
        }

        const match = findBestTextBlockMatch(editor, replaceCandidates);
        if (isConfidentReplacementMatch(match, targetText)) {
            return { from: match.from, to: match.to, selectFrom: match.from, selectTo: match.to, mode: 'replace' };
        }

        const introductionTarget = findIntroductionReplacementTarget(editor, patch);
        if (introductionTarget) {
            return { from: introductionTarget.from, to: introductionTarget.to, selectFrom: introductionTarget.from, selectTo: introductionTarget.to, mode: 'replace' };
        }

        return { error: `لم يتم العثور على النص المراد استبداله: ${patch.targetText || patch.anchorText || patch.title}` };
    }

    if (patch.targetText) {
        const match = findBestTextBlockMatch(editor, [patch.targetText]);
        if (match && match.score >= 3) {
            return { from: match.from, to: match.to, selectFrom: match.from, selectTo: match.to, mode: 'replace' };
        }
    }

    if (patch.operation === 'append_to_article') {
        return { from: docEnd, to: docEnd, selectFrom: docEnd, selectTo: docEnd, mode: 'insert' };
    }

    if (patch.operation === 'insert_before_faq') {
        return findFaqAppendTarget(editor, docEnd);
    }

    if (patch.operation === 'insert_before_conclusion') {
        const conclusionHeading = findHeadingByKeywords(editor, CONCLUSION_HEADING_KEYWORDS);
        return conclusionHeading
            ? { from: conclusionHeading.pos, to: conclusionHeading.pos, selectFrom: conclusionHeading.pos, selectTo: conclusionHeading.to, mode: 'insert' }
            : { from: docEnd, to: docEnd, selectFrom: docEnd, selectTo: docEnd, mode: 'insert' };
    }

    const heading = findHeadingMatch(editor, patch.anchorText || '');
    const anchorBlock = heading
        ? null
        : findPatchLocationBlockMatch(editor, patch) || findIntroductionReplacementTarget(editor, patch);

    if (!heading && !anchorBlock) {
        return { error: `لم يتم العثور على الموضع المرجعي: ${patch.anchorText || patch.placementLabel || patch.title}` };
    }

    if (patch.operation === 'insert_before_heading') {
        if (!heading && anchorBlock) {
            return { from: anchorBlock.from, to: anchorBlock.from, selectFrom: anchorBlock.from, selectTo: anchorBlock.to, mode: 'insert' };
        }
        return { from: heading.pos, to: heading.pos, selectFrom: heading.pos, selectTo: heading.to, mode: 'insert' };
    }

    if (patch.operation === 'append_to_section') {
        if (!heading && anchorBlock) {
            return { from: anchorBlock.to, to: anchorBlock.to, selectFrom: anchorBlock.from, selectTo: anchorBlock.to, mode: 'insert' };
        }
        const sectionEnd = findSectionEnd(editor, heading);
        return { from: sectionEnd, to: sectionEnd, selectFrom: heading.pos, selectTo: heading.to, mode: 'insert' };
    }

    if (!heading && anchorBlock) {
        return { from: anchorBlock.to, to: anchorBlock.to, selectFrom: anchorBlock.from, selectTo: anchorBlock.to, mode: 'insert' };
    }

    return { from: heading.to, to: heading.to, selectFrom: heading.pos, selectTo: heading.to, mode: 'insert' };
};

type SuggestionState = {
  original?: string;
  suggestions: string[];
  action: 'replace-text' | 'replace-title' | 'copy-meta';
  from?: number;
  to?: number;
  historyItemId?: string;
};

type FixAllProgress = {
    current: number;
    total: number;
    running: boolean;
    failed: number;
    errors: string[];
};

interface AIContextType {
    aiResults: { gemini: string; chatgpt: string };
    aiInsertionPatches: Record<AiPatchProvider, AiContentPatch[]>;
    isAiLoading: { gemini: boolean; chatgpt: boolean };
    isAiCommandLoading: boolean;
    aiFixingInfo: { title: string; from: number } | null;
    suggestion: SuggestionState | null;
    setSuggestion: React.Dispatch<React.SetStateAction<SuggestionState | null>>;
    headingsAnalysis: HeadingAnalysisResult[] | null;
    setHeadingsAnalysis: React.Dispatch<React.SetStateAction<HeadingAnalysisResult[] | null>>;
    isHeadingsAnalysisMinimized: boolean;
    setIsHeadingsAnalysisMinimized: React.Dispatch<React.SetStateAction<boolean>>;
    aiHistory: AIHistoryItem[];
    bulkFixReviewItems: BulkFixReviewItem[];
    fixAllProgress: FixAllProgress;
    handleAiRequest: (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => Promise<void>;
    handleAnalyzeHeadings: () => Promise<void>;
    handleAiAnalyze: (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => Promise<void>;
    handleChatGptAnalyze: (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => Promise<void>;
    handleGeminiReadyCommandsAnalyze: (items: ReadyCommandAnalysisBatchItem[]) => Promise<void>;
    parseAiPatchResponse: (
        rawResponse: string,
        provider: AiPatchProvider,
        options?: { namespace?: string; titlePrefix?: string; commandId?: string }
    ) => SmartAnalysisParsedResult;
    generateSemanticKeywords: () => Promise<{ secondaries: string[]; lsi: string[]; error?: string }>;
    generateGoalContext: () => Promise<{ context?: GoalContext; error?: string }>;
    handleAiFix: (rule: CheckResult, item: NonNullable<CheckResult['violatingItems']>[0]) => Promise<void>;
    handleFixAllViolations: (rulesToFix: string[], options?: { includeRelatedRules?: boolean }) => Promise<void>;
    getRelatedBulkFixRules: (rulesToFix: string[]) => BulkFixRelatedRule[];
    applyBulkFixReviewItem: (itemId: string, variantId?: string) => void;
    applySelectedBulkFixReviewItems: (itemIds: string[]) => void;
    selectBulkFixReviewItemTarget: (itemId: string) => void;
    skipBulkFixReviewItem: (itemId: string) => void;
    clearBulkFixReviewItems: () => void;
    applySuggestionFromHistory: (historyItemId: string, suggestionText: string) => void;
    applyAiInsertionPatch: (provider: AiPatchProvider, patchId: string) => void;
    applyAllAiInsertionPatches: (provider: AiPatchProvider) => void;
    selectAiInsertionPatchTarget: (provider: AiPatchProvider, patchId: string) => void;
    applyAiContentPatch: (patch: AiContentPatch) => { status: 'applied' | 'failed'; error?: string };
    selectAiContentPatchTarget: (patch: AiContentPatch) => { error?: string };
    markHistorySuggestionApplied: (historyItemId: string, suggestionText: string) => void;
    removeFromAiHistory: (historyItemId: string) => void;
    generateContextAwarePrompt: (userPrompt: string, options: any) => string;
    openGoogleSearch: (query: string) => void;
}

const AIContext = createContext<AIContextType | null>(null);

export const useAI = () => {
  const context = useContext(AIContext);
  if (!context) throw new Error("useAI must be used within an AIProvider");
  return context;
};

export const AIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { t, uiLanguage, apiKeys, engineeringPrompts, currentUser } = useUser();
    const { editor, title, text, keywords, analysisResults, goalContext, articleLanguage, articleKey } = useEditor();
    const { openModal } = useModal();
    
    const [aiResults, setAiResults] = useState({ gemini: '', chatgpt: '' });
    const [aiInsertionPatches, setAiInsertionPatches] = useState<Record<AiPatchProvider, AiContentPatch[]>>({ gemini: [], chatgpt: [] });
    const [isAiLoading, setIsAiLoading] = useState({ gemini: false, chatgpt: false });
    const [isAiCommandLoading, setIsAiCommandLoading] = useState(false);
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [headingsAnalysis, setHeadingsAnalysis] = useState<HeadingAnalysisResult[] | null>(null);
    const [isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized] = useState(false);
    const [aiFixingInfo, setAiFixingInfo] = useState<{ title: string; from: number } | null>(null);
    const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);
    const [bulkFixReviewItems, setBulkFixReviewItems] = useState<BulkFixReviewItem[]>([]);
    const bulkFixReviewItemsRef = useRef<BulkFixReviewItem[]>([]);
    const [fixAllProgress, setFixAllProgress] = useState<FixAllProgress>({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    
    const isInitialMount = useRef(true);

    const replaceBulkFixReviewItems = useCallback((items: BulkFixReviewItem[]) => {
        bulkFixReviewItemsRef.current = items;
        setBulkFixReviewItems(items);
    }, []);

    const updateBulkFixReviewItems = useCallback((updater: (items: BulkFixReviewItem[]) => BulkFixReviewItem[]) => {
        const nextItems = updater(bulkFixReviewItemsRef.current);
        bulkFixReviewItemsRef.current = nextItems;
        setBulkFixReviewItems(nextItems);
        return nextItems;
    }, []);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setAiHistory([]);
        replaceBulkFixReviewItems([]);
        setAiInsertionPatches({ gemini: [], chatgpt: [] });
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    }, [articleKey, replaceBulkFixReviewItems]);

    useEffect(() => {
        bulkFixReviewItemsRef.current = bulkFixReviewItems;
    }, [bulkFixReviewItems]);

    const logToAiHistory = useCallback((item: Omit<AIHistoryItem, 'id'>) => {
        const newItem: AIHistoryItem = { ...item, id: `${Date.now()}-${Math.random()}` };
        setAiHistory(prev => [newItem, ...prev]);
        return newItem.id;
    }, []);

    const normalizeRangeText = useCallback((value: string) => value.replace(/\s+/g, ' ').trim(), []);

    const getSafeRangeText = useCallback((from: number, to: number): string | null => {
        if (!editor) return null;
        const docSize = editor.state.doc.content.size;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > docSize || from >= to) {
            return null;
        }
        return editor.state.doc.textBetween(from, to, ' ');
    }, [editor]);

    const resolveBulkFixReviewRange = useCallback((item: Pick<BulkFixReviewItem, 'from' | 'to' | 'originalText'>): { from: number; to: number; currentText: string } | null => {
        const currentText = getSafeRangeText(item.from, item.to);
        if (currentText !== null && normalizeRangeText(currentText) === normalizeRangeText(item.originalText)) {
            return { from: item.from, to: item.to, currentText };
        }

        const exactMatch = findExactBulkFixTextUnitMatch(editor, item.originalText, item.from);
        if (!exactMatch) return null;

        const matchedText = getSafeRangeText(exactMatch.from, exactMatch.to);
        if (matchedText === null || normalizeRangeText(matchedText) !== normalizeRangeText(item.originalText)) {
            return null;
        }

        return { from: exactMatch.from, to: exactMatch.to, currentText: matchedText };
    }, [editor, getSafeRangeText, normalizeRangeText]);

    useEffect(() => {
        if (suggestion) openModal('suggestion');
    }, [suggestion, openModal]);
    
    useEffect(() => {
        if (headingsAnalysis && !isHeadingsAnalysisMinimized) openModal('headingsAnalysis');
    }, [headingsAnalysis, isHeadingsAnalysisMinimized, openModal]);

    const buildComprehensivePrompt = (
        basePrompt: string,
        sectionHeading?: string,
        options: { includeArticleTitle?: boolean; includeArticleToc?: boolean } = {}
    ) => {
        const { includeArticleTitle = true, includeArticleToc = true } = options;
        const professionalRoleAndGoal = `أنت كاتب محتوى خبير في موضوع "${keywords.primary || 'المحتوى العام'}". هدفك إنتاج محتوى متوافق مع SEO و AEO و GEO.`;
        let contextParts: string[] = [];
        if (includeArticleTitle && title.trim()) contextParts.push(`**عنوان المقال الحالي:** ${title.trim()}`);
        contextParts.push(`**لغة المقال:** ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`);
        const keywordContext = [
            `- الأساسية: ${keywords.primary || 'لم تحدد'}`,
            `- المرادفة: ${keywords.secondaries.filter(Boolean).join(', ') || 'لم تحدد'}`,
            `- العلامة التجارية: ${keywords.company || 'لم تحدد'}`,
            `- LSI: ${keywords.lsi.filter(Boolean).join(', ') || 'لم تحدد'}`,
        ].join('\n');
        contextParts.push(`**الكلمات والعلامة المستهدفة:**\n${keywordContext}`);
        const goalContextText = formatGoalContext(goalContext);
        if (goalContextText) contextParts.push(`**سياق هدف الصفحة والجمهور:**\n${goalContextText}`);
        if (sectionHeading) contextParts.push(`**عنوان القسم الحالي:** "${sectionHeading}"`);
        const tocString = includeArticleToc ? generateToc(editor) : '';
        if (tocString) contextParts.push(`**هيكل المقال:**\n${tocString}`);
        return `${professionalRoleAndGoal}\n\n${contextParts.join('\n\n')}\n\n**المطلوب:**\n${basePrompt}`;
    };

    const generateContextAwarePrompt = useCallback((userPrompt: string, options: any) => {
        const {
            manualCommand,
            articleTitle,
            articleToc,
            currentConclusion,
            editorText,
            targetKeywords,
            companyName,
            goalContext: includeGoalContext,
            keywordCriteria,
        } = options;
        let parts: string[] = [];
        const pageObjective = GOAL_CONTEXT_VALUE_LABELS[goalContext.objective] || goalContext.objective || 'لم يحدد';
        parts.push(includeGoalContext
            ? `أنت خبير SEO وكاتب محتوى محترف. هدف الصفحة هو "${pageObjective}".`
            : 'أنت خبير SEO وكاتب محتوى محترف.'
        );
        if (articleTitle && title.trim()) {
            parts.push(`**عنوان المقال الحالي:** ${title.trim()}`);
        }
        parts.push(`**لغة المقال:** ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`);
        const goalContextText = formatGoalContext(goalContext);
        if (includeGoalContext && goalContextText) {
            parts.push(`**سياق هدف الصفحة والجمهور لاستخدامه في التقييم والتحليل:**\n${goalContextText}`);
        }
        if (targetKeywords) {
            parts.push(`**الكلمات المستهدفة:** الأساسية: ${keywords.primary || 'لم تحدد'}، المرادفات: ${keywords.secondaries.filter(Boolean).join(', ') || 'لم تحدد'}، LSI: ${keywords.lsi.filter(Boolean).join(', ') || 'لم تحدد'}`);
        }
        if (companyName) {
            parts.push(`**اسم الشركة / العلامة التجارية:** ${keywords.company || 'لم تحدد'}`);
        }
        if (keywordCriteria) {
            const keywordSummary: string[] = [];
            const kw = analysisResults.keywordAnalysis;
            keywordSummary.push(`- الأساسية: الحالي ${kw.primary.count}، المطلوب ${kw.primary.requiredCount.join('-')}، الحالة ${kw.primary.status}.`);
            const unmetPrimaryChecks = kw.primary.checks.filter(check => !check.isMet).map(check => check.text);
            if (unmetPrimaryChecks.length) keywordSummary.push(`- شروط أساسية غير محققة: ${unmetPrimaryChecks.join('، ')}.`);
            if (kw.secondariesDistribution.status !== 'info') {
                keywordSummary.push(`- المرادفات إجمالاً: الحالي ${kw.secondariesDistribution.count}، المطلوب ${kw.secondariesDistribution.requiredCount.join('-')}، الحالة ${kw.secondariesDistribution.status}.`);
            }
            kw.secondaries.forEach((secondary, index) => {
                const term = keywords.secondaries[index]?.trim();
                if (!term) return;
                const unmetChecks = secondary.checks.filter(check => !check.isMet).map(check => check.text);
                keywordSummary.push(`- المرادف "${term}": الحالي ${secondary.count}، المطلوب ${secondary.requiredCount.join('-')}، الحالة ${secondary.status}${unmetChecks.length ? `، غير محقق: ${unmetChecks.join('، ')}` : ''}.`);
            });
            if (kw.company.status !== 'info') {
                keywordSummary.push(`- اسم الشركة: الحالي ${kw.company.count}، المطلوب ${kw.company.requiredCount.join('-')}، الحالة ${kw.company.status}.`);
            }
            if (kw.lsi.distribution.status !== 'info') {
                keywordSummary.push(`- LSI: الحالي ${kw.lsi.distribution.count}، المطلوب ${kw.lsi.distribution.requiredCount.join('-')}، الحالة ${kw.lsi.distribution.status}.`);
                keywordSummary.push(`- توازن LSI: ${kw.lsi.balance.current}، المطلوب ${kw.lsi.balance.required}.`);
            }
            parts.push(`**معايير الكلمات الحالية:**\n${keywordSummary.join('\n') || '- لا توجد كلمات مستهدفة مدخلة.'}`);
        }
        if (editorText) {
            parts.push(`**نص المقال الحالي من المحرر:**\n---\n${text}\n---`);
        }
        STRUCTURE_CRITERIA_ATTACHMENTS.forEach((attachment) => {
            if (!options[attachment.optionKey]) return;

            const sectionTitle = t.structureTab[attachment.labelKey];
            const rules = attachment.ruleKeys
                .map(ruleKey => analysisResults.structureAnalysis[ruleKey])
                .filter(Boolean) as CheckResult[];

            parts.push(formatStructureCriteriaRules(sectionTitle, rules));
        });

        if (manualCommand && userPrompt.trim()) {
            parts.push(`**الأمر المطلوب:**\n${userPrompt}`);
        } else if (userPrompt.trim()) {
             parts.push(userPrompt);
        }
        return parts.join('\n\n');
    }, [editor, title, keywords, text, goalContext, articleLanguage, analysisResults, t]);

    const generateSemanticKeywords = useCallback(async (): Promise<{ secondaries: string[]; lsi: string[]; error?: string }> => {
        const primary = keywords.primary.trim();
        if (!primary) {
            return { secondaries: [], lsi: [], error: 'أدخل الكلمة المفتاحية الأساسية أولًا.' };
        }

        const prompt = [
            'أنت خبير SEO دلالي وLLM SEO.',
            '',
            'مهمتك توليد صيغ بديلة طبيعية للكلمة المفتاحية الأساسية وكلمات LSI مرتبطة بنية البحث وسياق هدف الصفحة والجمهور، ثم إرجاعها بصيغة JSON فقط لتوزيعها تلقائيًا داخل لوحة الكلمات.',
            '',
            `الكلمة المفتاحية الأساسية: ${primary}`,
            keywords.company.trim() ? `اسم الشركة: ${keywords.company.trim()}` : '',
            title.trim() ? `عنوان المقال: ${title.trim()}` : '',
            `لغة المقال: ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`,
            '',
            'سياق هدف الصفحة والجمهور:',
            formatGoalContext(goalContext) || '- لم يحدد',
            '',
            'الشروط:',
            '- لا تكتب المقالة.',
            '- لا تستخدم حشوًا مفتاحيًا.',
            '- لا تقترح كلمات بعيدة عن نية البحث.',
            '- اجعل كل الاقتراحات طبيعية وقابلة للاستخدام داخل محتوى حقيقي.',
            '- راعِ هدف المقالة والجمهور المستهدف في كل اقتراح.',
            '- لا تكرر الكلمة المفتاحية الأساسية نفسها ضمن الصيغ البديلة.',
            '- أخرج 4 إلى 6 صيغ بديلة قصيرة.',
            '- أخرج 10 إلى 16 كلمة أو عبارة LSI.',
            '',
            'أرجع JSON فقط بهذا الشكل دون Markdown ودون شرح:',
            '{ "secondaries": ["صيغة بديلة 1", "صيغة بديلة 2"], "lsi": ["كلمة LSI 1", "كلمة LSI 2"] }',
        ].filter(Boolean).join('\n');

        const result = await callGeminiAnalysis(prompt, apiKeys.gemini);
        if (/^حدث خطأ أثناء الاتصال بـ Gemini/.test(result)) {
            return { secondaries: [], lsi: [], error: result };
        }

        const parsed = extractJson(result);
        const normalizeTerms = (value: unknown): string[] => {
            if (!Array.isArray(value)) return [];
            const seen = new Set<string>();
            return value
                .map(item => typeof item === 'string' ? item.replace(/[.،,;؛]+$/g, '').trim() : '')
                .filter(Boolean)
                .filter(item => item !== primary)
                .filter(item => {
                    const key = item.toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        };

        const secondaries = normalizeTerms(parsed?.secondaries).slice(0, 6);
        const lsi = normalizeTerms(parsed?.lsi).slice(0, 16);
        if (secondaries.length === 0 && lsi.length === 0) {
            return { secondaries, lsi, error: 'لم يرجع الذكاء الاصطناعي صيغا قابلة للتوزيع. حاول مرة أخرى.' };
        }

        return { secondaries, lsi };
    }, [apiKeys.gemini, articleLanguage, goalContext, keywords.company, keywords.primary, title]);

    const generateGoalContext = useCallback(async (): Promise<{ context?: GoalContext; error?: string }> => {
        const primary = keywords.primary.trim();
        const secondaries = keywords.secondaries.map(term => term.trim()).filter(Boolean);
        const articleTitle = title.trim();

        if (!primary && secondaries.length === 0 && !articleTitle) {
            return { error: 'أدخل الكلمة المفتاحية الأساسية أو عنوان المقالة أولًا.' };
        }

        const prompt = [
            'أنت خبير SEO واستراتيجية محتوى.',
            '',
            'استنتج سياق هدف الصفحة والجمهور من نمط الكلمة المفتاحية الأساسية والصيغ البديلة وعنوان المقالة فقط.',
            'املأ حقول سياق الصفحة بحيث تكون مناسبة للتحليل وكتابة المحتوى، ولا تكتب مقالة أو شرحًا.',
            '',
            `عنوان المقالة: ${articleTitle || 'غير محدد'}`,
            `الكلمة المفتاحية الأساسية: ${primary || 'غير محددة'}`,
            `الصيغ البديلة: ${secondaries.length > 0 ? secondaries.join(', ') : 'غير محددة'}`,
            `لغة المقال: ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`,
            '',
            'القيم المسموحة:',
            `- pageType: ${GOAL_CONTEXT_ALLOWED_VALUES.pageType.join(', ')}`,
            `- objective: ${GOAL_CONTEXT_ALLOWED_VALUES.objective.join(', ')}`,
            `- audienceScope: ${GOAL_CONTEXT_ALLOWED_VALUES.audienceScope.join(', ')}`,
            `- searchIntent: ${GOAL_CONTEXT_ALLOWED_VALUES.searchIntent.join(', ')}`,
            '',
            'قواعد الاستنتاج:',
            '- اختر pageType من نية العنوان والكلمات: category لصفحة تصنيف تضم منتجات أو خدمات ويكتب فيها محتوى داعم، service للخدمات، product للمنتجات، comparison للمقارنات، guide للأدلة، article للمقالات العامة.',
            '- اختر objective بحسب نية المستخدم: category-support عندما يكون المحتوى داعماً لصفحة تصنيف منتجات/خدمات، educate للشرح والتعلّم، compare للمقارنة، convert للحجز/الشراء/التواصل، trust لبناء الثقة، support للدعم والاستخدام.',
            '- اختر searchIntent بحسب ما يوحي به العنوان والكلمات.',
            '- إذا كانت الصفحة تصنيف منتجات أو خدمات والمحتوى هدفه شرح الخيارات أو توجيه المستخدم داخل التصنيف، فغالباً اختر pageType بقيمة category وobjective بقيمة category-support وsearchIntent بقيمة commercial-support.',
            '- اختر audienceScope بحسب وضوح نطاق الاستهداف من العنوان والكلمات، وإذا لم يظهر نطاق واضح فاختر global.',
            '',
            'أرجع JSON فقط دون Markdown ودون شرح بهذا الشكل:',
            '{ "pageType": "service", "objective": "convert", "audienceScope": "global", "searchIntent": "transactional" }',
        ].join('\n');

        const result = await callGeminiAnalysis(prompt, apiKeys.gemini);
        const parsed = extractJson(result);
        const context = normalizeGeneratedGoalContext(parsed, goalContext);

        if (!context) {
            const looksLikeApiError = /Gemini|API|خطأ|مهلة|فشل/i.test(result);
            return {
                error: looksLikeApiError
                    ? result
                    : 'لم يرجع الذكاء الاصطناعي سياقًا قابلًا للتعبئة. حاول مرة أخرى.',
            };
        }

        return { context };
    }, [apiKeys.gemini, articleLanguage, goalContext, keywords.primary, keywords.secondaries, title]);
    
    const logReadyCommandAnalysis = useCallback((
        provider: AiPatchProvider,
        parsedResult: SmartAnalysisParsedResult,
        historyMeta?: ReadyCommandAnalysisHistoryMeta
    ) => {
        const displayText = parsedResult.displayText.trim();
        if (!historyMeta || !displayText) return;

        if (
            !isAiErrorResponseText(displayText) &&
            (
                historyMeta.savesContentSummary ||
                historyMeta.commandId === ENGINEERING_PROMPT_IDS.smartAnalysis.contentSummaryForCompetitors
            )
        ) {
            saveContentSummaryForCompetitors(displayText, provider, historyMeta);
        }

        logToAiHistory({
            type: 'manual-analysis',
            ruleTitle: historyMeta.commandLabel,
            originalText: '',
            suggestions: [],
            from: 0,
            to: 0,
            analysisResult: displayText,
            analysisPatches: parsedResult.patches,
            provider,
            commandId: historyMeta.commandId,
        });
    }, [logToAiHistory]);

    const handleGeminiReadyCommandsAnalyze = useCallback(async (items: ReadyCommandAnalysisBatchItem[]) => {
        if (!editor || items.length === 0) return;
        const geminiKeys = normalizeGeminiKeys(apiKeys.gemini);
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        setAiResults(prev => ({ ...prev, gemini: '' }));
        setAiInsertionPatches(prev => ({ ...prev, gemini: [] }));

        try {
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const results: {
                item: ReadyCommandAnalysisBatchItem;
                parsedResult: SmartAnalysisParsedResult;
                keyIndex?: number;
            }[] = [];
            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                const assignedKey = geminiKeys.length > 0 ? geminiKeys[index % geminiKeys.length] : undefined;
                const finalPrompt = buildSmartAnalysisFinalPrompt(
                    generateContextAwarePrompt(item.userPrompt, item.options),
                    { skipPatchInstructions: item.skipPatchInstructions },
                );
                const result = await callGeminiArticleChatAnalysis(finalPrompt, assignedKey ? [assignedKey] : undefined, currentUser, articleScope);
                const parsedResult = item.skipPatchInstructions
                    ? { displayText: result, patches: [] }
                    : namespaceSmartAnalysisPatches(
                        applyReadyCommandPatchRules(parseSmartAnalysisResponse(result, 'gemini'), item.commandId),
                        `cmd_${index + 1}`,
                        item.commandLabel
                    );
                logReadyCommandAnalysis('gemini', parsedResult, item);
                results.push({
                    item,
                    parsedResult,
                    keyIndex: assignedKey ? (index % geminiKeys.length) + 1 : undefined,
                });
            }

            const keyReuseNote = geminiKeys.length > 0 && items.length > geminiKeys.length
                ? `\n\n> ملاحظة: تم توزيع ${items.length} أوامر على ${geminiKeys.length} مفاتيح Gemini متاحة، لذلك تمت إعادة استخدام بعض المفاتيح.`
                : '';
            const displayText = results.map((result, index) => {
                const keyLabel = result.keyIndex ? `\n\n> Gemini API #${result.keyIndex}` : '';
                return `## ${index + 1}. ${result.item.commandLabel}${keyLabel}\n\n${result.parsedResult.displayText}`;
            }).join('\n\n---\n\n') + keyReuseNote;

            setAiResults(prev => ({ ...prev, gemini: displayText }));
            setAiInsertionPatches(prev => ({
                ...prev,
                gemini: results.flatMap(result => result.parsedResult.patches),
            }));
        } catch (e) {
            setAiResults(prev => ({ ...prev, gemini: "فشل التحليل المتعدد." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [apiKeys.gemini, editor, generateContextAwarePrompt, logReadyCommandAnalysis, currentUser, articleKey, title]);

    const handleAiAnalyze = useCallback(async (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        setAiInsertionPatches(prev => ({ ...prev, gemini: [] }));
        try {
            const finalPrompt = buildSmartAnalysisFinalPrompt(
                generateContextAwarePrompt(userPrompt, options),
                { skipPatchInstructions: historyMeta?.skipPatchInstructions },
            );
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const result = await callGeminiArticleChatAnalysis(finalPrompt, apiKeys.gemini, currentUser, articleScope);
            const parsedResult = historyMeta?.skipPatchInstructions
                ? { displayText: result, patches: [] }
                : applyReadyCommandPatchRules(parseSmartAnalysisResponse(result, 'gemini'), historyMeta?.commandId);
            setAiResults(prev => ({ ...prev, gemini: parsedResult.displayText }));
            setAiInsertionPatches(prev => ({ ...prev, gemini: parsedResult.patches }));
            logReadyCommandAnalysis('gemini', parsedResult, historyMeta);
        } catch (e) {
            setAiResults(prev => ({ ...prev, gemini: "فشل التحليل." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.gemini, editor, logReadyCommandAnalysis, currentUser, articleKey, title]);

    const handleChatGptAnalyze = useCallback(async (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, chatgpt: true }));
        setAiResults(prev => ({ ...prev, chatgpt: '' }));
        setAiInsertionPatches(prev => ({ ...prev, chatgpt: [] }));
        try {
            const finalPrompt = buildSmartAnalysisFinalPrompt(
                generateContextAwarePrompt(userPrompt, options),
                { skipPatchInstructions: historyMeta?.skipPatchInstructions },
            );
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const storedConversationId = readStoredChatGptConversationId(currentUser, articleScope);
            const result = await callChatGptAnalysis(finalPrompt, apiKeys.chatgpt, storedConversationId);
            saveStoredChatGptConversationId(currentUser, articleScope, result.conversationId);
            const parsedResult = historyMeta?.skipPatchInstructions
                ? { displayText: result.text, patches: [] }
                : applyReadyCommandPatchRules(parseSmartAnalysisResponse(result.text, 'chatgpt'), historyMeta?.commandId);
            setAiResults(prev => ({ ...prev, chatgpt: parsedResult.displayText }));
            setAiInsertionPatches(prev => ({ ...prev, chatgpt: parsedResult.patches }));
            logReadyCommandAnalysis('chatgpt', parsedResult, historyMeta);
        } catch (e) {
            setAiResults(prev => ({ ...prev, chatgpt: "فشل تحليل ChatGPT." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, chatgpt: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.chatgpt, editor, logReadyCommandAnalysis, currentUser, articleKey, title]);
    
    const handleAiRequest = useCallback(async (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => {
        if (isAiCommandLoading || isAiLoading.gemini || !editor) return;
        setIsAiCommandLoading(true);
        try {
            let textToProcess = "";
            let originalText = "";
            let localContext: BulkFixTargetContext | undefined;
            let from, to;
            if (action === 'replace-text' || action === 'copy-meta') {
                const { from: f, to: t } = editor.state.selection;
                from = f; to = t;
                textToProcess = editor.state.doc.textBetween(f, t, ' ');
                originalText = action === 'copy-meta' ? 'Meta Description' : textToProcess;
                localContext = getAiLocalTextContext(editor, f, t, title);
            } else {
                textToProcess = text;
                originalText = action === 'replace-title' ? title : 'Meta Description';
            }
            const prompt = renderEngineeringPrompt(promptTemplate, {
                selectedText: textToProcess,
                fullArticleText: text,
            });
            const toolbarGuardRuleKeys: (keyof StructureAnalysis)[] = [
                'paragraphLength',
                'sentenceLength',
                'summaryParagraph',
                'secondParagraph',
                'keywordStuffing',
                'stepsIntroduction',
                'punctuation',
                'punctuationSpacing',
                'immediateDuplicateWords',
                'ambiguousParagraphReferences',
                'commonEnglishTerms',
                'wordsToDelete',
                'slowWords',
                'differentTransitionalWords',
                'h2Structure',
                'headingLength',
            ];
            const toolbarGuardRules = toolbarGuardRuleKeys
                .map(ruleKey => analysisResults.structureAnalysis[ruleKey])
                .filter(Boolean) as CheckResult[];
            const toolbarCommandGuard = [
                '**معايير إلزامية لأوامر شريط الأدوات:**',
                '- قبل إخراج أي اقتراح، افحصه داخلياً مقابل معايير تبويب المعايير، خصوصاً طول الفقرات، طول الجمل، الحشو المفتاحي، الكلمات الضعيفة، علامات الترقيم، وترابط الفقرة مع القسم.',
                '- لا ترسل فقرة طويلة أو جملة طويلة. إن احتاج المعنى إلى تفصيل، قسّمه إلى جمل قصيرة أو قائمة/جدول حسب الأمر.',
                '- التزم بسياق عنوان القسم والنص السابق والنص اللاحق المرفقين للقراءة فقط، ولا تعيد فتح الموضوع من البداية إذا كان النص داخل منتصف القسم.',
                '- استخدم الكلمة الأساسية والصيغ المرادفة وLSI واسم الشركة بشكل طبيعي فقط عند الحاجة، ولا تجمع الكلمة الأساسية مع مرادفاتها داخل نفس الفقرة إذا كان ذلك يسبب حشواً أو مخالفة.',
                '- راعِ نوع الصفحة وهدفها والجمهور ونية البحث في النبرة، مستوى التفصيل، والعبارات المقترحة.',
                formatStructureCriteriaRules('معايير يجب احترامها عند توليد اقتراح شريط الأدوات', toolbarGuardRules),
            ].join('\n\n');
            const usesSelectedTextContext = Boolean(localContext && textToProcess.trim());
            const boundedPrompt = usesSelectedTextContext
                ? [
                    formatAiReadOnlyLocalContext(localContext),
                    toolbarCommandGuard,
                    action === 'replace-text'
                        ? '**الأمر المطلوب على النص المستهدف فقط:**'
                        : '**الأمر المطلوب اعتمادًا على النص المحدد والسياق:**',
                    prompt,
                    '',
                    action === 'replace-text'
                        ? '**النص المستهدف المسموح باستبداله فقط:**'
                        : '**النص المحدد المرجعي:**',
                    `"""${textToProcess}"""`,
                    '',
                    action === 'replace-text'
                        ? [
                            '**قواعد الحفاظ على السياق:**',
                            '- أعد النص المستهدف فقط، ولا تكتب النص السابق أو اللاحق ضمن الاقتراح.',
                            '- حافظ على اتصال الفقرة بما قبلها وما بعدها، وتجنب إعادة المعلومة نفسها أو افتتاح الموضوع من جديد بلا حاجة.',
                            '- إذا كان النص السابق يمهد للفكرة، ابدأ مباشرة بالتكملة. وإذا كان النص اللاحق يكمل الفكرة، لا تختم الاقتراح كأنه نهاية القسم.',
                        ].join('\n')
                        : [
                            '**قواعد استخدام السياق لوصف الميتا:**',
                            '- استخدم عنوان القسم والفقرة السابقة والفقرة التالية لفهم السياق فقط.',
                            '- لا تنقل النص السابق أو اللاحق حرفيًا داخل وصف الميتا.',
                            '- أخرج وصفي ميتا مختلفين مناسبين للنص المحدد وسياقه.',
                        ].join('\n'),
                ].filter(Boolean).join('\n\n')
                : prompt;
            const finalPrompt = `${buildComprehensivePrompt(boundedPrompt, localContext?.sectionHeading, { includeArticleTitle: !usesSelectedTextContext, includeArticleToc: !usesSelectedTextContext })}\n\nأرجع النتيجة بتنسيق JSON حصراً وباقتراحين مختلفين بالضبط، حتى إذا طلب نص الأمر اقتراحًا واحدًا: { "suggestions": ["الاقتراح الأول", "الاقتراح الثاني"] }`;
            const resultJson = await callGeminiAnalysis(finalPrompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions
                    .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
                    .slice(0, 2);
                if (suggestions.length > 0) {
                    let historyItemId: string | undefined;
                    if (action === 'replace-text' && from != null && to != null) {
                        historyItemId = logToAiHistory({
                            type: 'user-command',
                            originalText,
                            suggestions,
                            from,
                            to,
                        });
                    }
                    setSuggestion({ original: originalText, suggestions, action, from, to, historyItemId });
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsAiCommandLoading(false);
        }
    }, [editor, title, text, analysisResults, buildComprehensivePrompt, apiKeys.gemini, logToAiHistory]);

    const handleAnalyzeHeadings = useCallback(async () => {
        if (isAiLoading.gemini || !editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        try {
            const headings: any[] = [];
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'heading') headings.push({ level: node.attrs.level, text: node.textContent, from: pos, to: pos + node.nodeSize });
            });
            const headingsText = headings.map(h => {
                const localContext = getAiLocalTextContext(editor, h.from, h.to, title);
                return [
                    `[H${h.level}] ${h.text}`,
                    localContext.sectionHeading ? `عنوان القسم للاطلاع فقط: ${localContext.sectionHeading}` : '',
                    localContext.previousTexts?.[0] ? `الفقرة السابقة للاطلاع فقط: """${localContext.previousTexts[0]}"""` : '',
                    localContext.nextTexts?.[0] ? `الفقرة التالية للاطلاع فقط: """${localContext.nextTexts[0]}"""` : '',
                ].filter(Boolean).join('\n');
            }).join('\n\n---\n\n');
            const promptTemplate = getEngineeringPrompt(engineeringPrompts, ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings);
            const prompt = `${buildComprehensivePrompt(promptTemplate)}\n\n${headingsText}\n\nأرجع مصفوفة JSON حصراً: [ { "original": "...", "level": 2, "flaws": [], "suggestions": [] } ]`;
            const resultJson = await callGeminiAnalysis(prompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (Array.isArray(parsed)) {
                const usedHeadingIndexes = new Set<number>();
                const mappedAnalysis = parsed
                    .map((item, parsedIndex): HeadingAnalysisResult | null => {
                        const original = asTrimmedString(item?.original);
                        const requestedLevel = Number(item?.level);
                        const preferredFrom = headings[parsedIndex]?.from ?? 0;
                        let bestMatch: { heading: any; index: number; score: number } | null = null;

                        headings.forEach((heading, headingIndex) => {
                            if (usedHeadingIndexes.has(headingIndex)) return;
                            const baseScore = scoreHeadingMatch(heading.text, original);
                            if (baseScore <= 0) return;
                            const levelScore = Number.isFinite(requestedLevel)
                                ? (Number(heading.level) === requestedLevel ? 0.25 : -0.25)
                                : 0;
                            const score = baseScore + levelScore;
                            if (!bestMatch || score > bestMatch.score) {
                                bestMatch = { heading, index: headingIndex, score };
                                return;
                            }
                            if (Math.abs(score - bestMatch.score) <= 0.001) {
                                const nextDistance = Math.abs(heading.from - preferredFrom);
                                const currentDistance = Math.abs(bestMatch.heading.from - preferredFrom);
                                if (nextDistance < currentDistance) {
                                    bestMatch = { heading, index: headingIndex, score };
                                }
                            }
                        });

                        if (!bestMatch) return null;
                        usedHeadingIndexes.add(bestMatch.index);
                        const flaws = Array.isArray(item?.flaws)
                            ? item.flaws.filter((flaw: unknown): flaw is string => typeof flaw === 'string' && flaw.trim().length > 0)
                            : [];
                        const suggestions = Array.isArray(item?.suggestions)
                            ? item.suggestions.filter((suggestion: unknown): suggestion is string => typeof suggestion === 'string' && suggestion.trim().length > 0)
                            : [];
                        if (suggestions.length === 0) return null;

                        return {
                            original: bestMatch.heading.text,
                            level: bestMatch.heading.level,
                            from: bestMatch.heading.from,
                            to: bestMatch.heading.to,
                            flaws,
                            suggestions,
                        };
                    })
                    .filter((item): item is HeadingAnalysisResult => Boolean(item));

                setHeadingsAnalysis(mappedAnalysis.length > 0 ? mappedAnalysis : null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [editor, buildComprehensivePrompt, apiKeys.gemini, engineeringPrompts]);

    const handleAiFix = useCallback(async (rule: CheckResult, item: any) => {
        if (!editor) return;
        setAiFixingInfo({ title: rule.title, from: item.from });
        try {
            const originalText = editor.state.doc.textBetween(item.from, item.to, ' ');
            const localContext = getAiLocalTextContext(editor, item.from, item.to, title);
            const prompt = buildComprehensivePrompt(
                formatBulkFixViolationPrompt(rule, item, originalText, localContext),
                localContext.sectionHeading,
                { includeArticleTitle: false, includeArticleToc: false }
            );
            const resultJson = await callGeminiAnalysis(prompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
                if (suggestions.length > 0) {
                    const historyItemId = logToAiHistory({
                        type: 'fix-violation',
                        ruleTitle: rule.title,
                        originalText,
                        suggestions,
                        from: item.from,
                        to: item.to,
                    });
                    setSuggestion({ original: originalText, suggestions, action: 'replace-text', from: item.from, to: item.to, historyItemId });
                }
            }
        } finally {
            setAiFixingInfo(null);
        }
    }, [editor, buildComprehensivePrompt, apiKeys.gemini, logToAiHistory]);

    const getRelatedBulkFixRules = useCallback((rulesToFix: string[]): BulkFixRelatedRule[] => {
        if (!editor || !analysisResults.structureAnalysis || rulesToFix.length === 0) return [];
        const selectedRuleTitles = new Set(rulesToFix);
        const allViolations = collectBulkFixViolations(analysisResults.structureAnalysis);
        return summarizeRelatedBulkFixRules(editor, allViolations, selectedRuleTitles);
    }, [editor, analysisResults.structureAnalysis]);

    const handleFixAllViolations = useCallback(async (rulesToFix: string[], options: { includeRelatedRules?: boolean } = {}) => {
        if (!editor || !analysisResults.structureAnalysis) return;
        replaceBulkFixReviewItems([]);
        setFixAllProgress({ current: 0, total: 0, running: true, failed: 0, errors: [] });
        const selectedRuleTitles = new Set(rulesToFix);
        const allViolations = collectBulkFixViolations(analysisResults.structureAnalysis);
        const selectedViolations = allViolations.filter(violation => selectedRuleTitles.has(violation.rule.title));
        const relatedViolations = options.includeRelatedRules
            ? getRelatedBulkFixViolations(editor, allViolations, selectedRuleTitles)
            : [];
        const groupedViolations = groupBulkFixViolationsByTextUnit(editor, [...selectedViolations, ...relatedViolations]);
        setFixAllProgress(p => ({ ...p, total: groupedViolations.length }));

        const proposedItems: BulkFixReviewItem[] = [];
        for (let i = 0; i < groupedViolations.length; i++) {
            const group = groupedViolations[i];
            setFixAllProgress(p => ({ ...p, current: i + 1 }));
            try {
                const targetText = getSafeRangeText(group.from, group.to);
                if (targetText === null) {
                    throw new Error('Target range is no longer valid.');
                }
                const targetContext = getBulkFixTargetContext(editor, group, title);
                const protectionRules = getBulkFixProtectionRules(analysisResults.structureAnalysis, group, selectedRuleTitles, targetContext);
                const articleLevelRules = getBulkFixArticleLevelRules(analysisResults.structureAnalysis, selectedRuleTitles);
                const prompt = buildComprehensivePrompt(
                    formatBulkFixGroupPrompt(group, targetText, selectedRuleTitles, protectionRules, targetContext, articleLevelRules),
                    targetContext.sectionHeading,
                    { includeArticleTitle: false, includeArticleToc: false }
                );
                const res = await callGeminiAnalysis(prompt, apiKeys.gemini);
                const parsed = extractJson(res);
                const uniqueRules = getUniqueBulkFixRules(group.violations);
                const targetRules = uniqueRules.filter(rule => selectedRuleTitles.has(rule.title));
                const fallbackTargetRules = targetRules.length > 0 ? targetRules : uniqueRules.slice(0, 1);
                const criteriaRuleEntries = [
                    ...fallbackTargetRules.map(rule => ({ rule, source: 'target' as const })),
                    ...protectionRules
                        .filter(rule => !fallbackTargetRules.some(targetRule => targetRule.title === rule.title))
                        .map(rule => ({ rule, source: 'protection' as const })),
                    ...articleLevelRules
                        .filter(rule => !fallbackTargetRules.some(targetRule => targetRule.title === rule.title))
                        .filter(rule => !protectionRules.some(protectionRule => protectionRule.title === rule.title))
                        .map(rule => ({ rule, source: 'article' as const })),
                ];
                const criteria: BulkFixCriterionSummary[] = criteriaRuleEntries.map(({ rule, source }) => ({
                    title: rule.title,
                    current: rule.current,
                    required: rule.required,
                    status: rule.status,
                    source,
                    isListIntroContext: targetContext.isListIntro,
                    message: group.violations
                        .filter(violation => violation.rule.title === rule.title)
                        .map(violation => violation.item.message)
                        .filter(Boolean)
                        .join(' | '),
                }));
                let variants = normalizeBulkFixVariants(parsed, targetText, criteria, targetContext);
                if (variants.length === 0) {
                    variants = normalizeBulkFixVariants(res, targetText, criteria, targetContext);
                }
                const primaryVariant = variants[0];
                const ruleTitles = fallbackTargetRules.map(rule => rule.title);
                if (primaryVariant) {
                    proposedItems.push({
                        id: `bulk-fix-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
                        ruleTitle: ruleTitles.length > 1 ? `${ruleTitles.length} معايير: ${ruleTitles.join('، ')}` : ruleTitles[0],
                        ruleTitles,
                        criteria,
                        originalText: targetText,
                        fixedText: primaryVariant.fixedText,
                        variants,
                        from: group.from,
                        to: group.to,
                        message: group.violations
                            .map(violation => `${violation.rule.title}: ${violation.item.message}`)
                            .filter(Boolean)
                            .join(' | '),
                        status: 'pending',
                    });
                } else {
                    throw new Error('AI did not return usable suggestions.');
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Unknown fix error';
                console.error('Fix all proposal failed:', group.id, e);
                setFixAllProgress(p => ({
                    ...p,
                    failed: p.failed + 1,
                    errors: [...p.errors, `${group.violations.map(violation => violation.rule.title).join(', ')}: ${message}`].slice(-3),
                }));
            }
        }
        replaceBulkFixReviewItems(proposedItems);
        proposedItems.forEach(item => {
            logToAiHistory({
                type: 'fix-violation',
                ruleTitle: item.ruleTitle,
                originalText: item.originalText,
                suggestions: (item.variants && item.variants.length > 0
                    ? item.variants.map(variant => variant.fixedText)
                    : [item.fixedText]
                ).filter(Boolean),
                from: item.from,
                to: item.to,
                bulkFixReviewItem: item,
            });
        });
        setFixAllProgress(p => ({ ...p, running: false }));
    }, [editor, analysisResults, buildComprehensivePrompt, apiKeys.gemini, getSafeRangeText, logToAiHistory, replaceBulkFixReviewItems]);

    const updateBulkFixReviewItem = useCallback((itemId: string, updates: Partial<BulkFixReviewItem>) => {
        updateBulkFixReviewItems(items => items.map(item => (
            item.id === itemId ? { ...item, ...updates } : item
        )));
    }, [updateBulkFixReviewItems]);

    const markBulkFixAppliedAndShiftRanges = useCallback((appliedItem: BulkFixReviewItem, delta: number, appliedText: string, appliedVariantId?: string) => {
        updateBulkFixReviewItems(items => items.map(item => {
            if (item.id === appliedItem.id) {
                return {
                    ...item,
                    from: appliedItem.from,
                    to: appliedItem.to + delta,
                    fixedText: appliedText,
                    status: 'applied',
                    applyError: undefined,
                    appliedVariantId,
                };
            }

            if (item.to <= appliedItem.from) {
                return item;
            }

            if (item.from >= appliedItem.to) {
                return {
                    ...item,
                    from: item.from + delta,
                    to: item.to + delta,
                };
            }

            if (item.status !== 'pending') {
                return item;
            }

            return {
                ...item,
                status: 'failed',
                applyError: 'يتداخل هذا الاقتراح مع تعديل تم تطبيقه سابقاً. أعد إنشاء قائمة الإصلاحات لمراجعته من جديد.',
            };
        }));
    }, [updateBulkFixReviewItems]);

    const selectBulkFixReviewItemTarget = useCallback((itemId: string) => {
        if (!editor) return;
        const item = bulkFixReviewItems.find(reviewItem => reviewItem.id === itemId);
        if (!item) return;
        const resolvedRange = resolveBulkFixReviewRange(item);
        if (!resolvedRange) {
            updateBulkFixReviewItem(itemId, { status: 'failed', applyError: 'تعذر تحديد الموضع لأن نطاق النص لم يعد صالحاً.' });
            return;
        }
        if (resolvedRange.from !== item.from || resolvedRange.to !== item.to) {
            updateBulkFixReviewItem(itemId, { from: resolvedRange.from, to: resolvedRange.to });
        }
        editor.chain().focus().setTextSelection({ from: resolvedRange.from, to: resolvedRange.to }).scrollIntoView().run();
    }, [bulkFixReviewItems, editor, resolveBulkFixReviewRange, updateBulkFixReviewItem]);

    const applySelectedBulkFixReviewItems = useCallback((itemIds: string[], variantSelections: Record<string, string> = {}) => {
        if (!editor) return;
        const selectedIds = new Set(itemIds);
        const itemsToApply = bulkFixReviewItemsRef.current
            .filter(item => selectedIds.has(item.id) && item.status === 'pending')
            .sort((a, b) => b.from - a.from);

        itemsToApply.forEach(plannedItem => {
            const item = bulkFixReviewItemsRef.current.find(reviewItem => reviewItem.id === plannedItem.id) || plannedItem;
            if (item.status !== 'pending') return;
            const selectedVariantId = variantSelections[item.id];
            const selectedVariant = selectedVariantId
                ? item.variants?.find(variant => variant.id === selectedVariantId)
                : item.variants?.[0];
            const fixedText = selectedVariant?.fixedText || item.fixedText;
            const resolvedRange = resolveBulkFixReviewRange(item);
            if (!resolvedRange) {
                updateBulkFixReviewItem(item.id, {
                    status: 'failed',
                    applyError: 'النص الأصلي تغير داخل المحرر. أعد إنشاء قائمة الإصلاحات قبل تطبيق هذا الاقتراح.',
                });
                return;
            }

            try {
                const beforeDocSize = editor.state.doc.content.size;
                const applied = editor
                    .chain()
                    .focus()
                    .insertContentAt({ from: resolvedRange.from, to: resolvedRange.to }, parseMarkdownToArticleHtml(fixedText, articleLanguage), { updateSelection: true })
                    .scrollIntoView()
                    .run();
                if (!applied) {
                    throw new Error('تعذر تطبيق التعديل داخل المحرر.');
                }
                const delta = editor.state.doc.content.size - beforeDocSize;
                markBulkFixAppliedAndShiftRanges({ ...item, from: resolvedRange.from, to: resolvedRange.to }, delta, fixedText, selectedVariant?.id);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'تعذر تطبيق التعديل داخل المحرر.';
                updateBulkFixReviewItem(item.id, { status: 'failed', applyError: message });
            }
        });
    }, [editor, markBulkFixAppliedAndShiftRanges, resolveBulkFixReviewRange, updateBulkFixReviewItem]);

    const applyBulkFixReviewItem = useCallback((itemId: string, variantId?: string) => {
        applySelectedBulkFixReviewItems([itemId], variantId ? { [itemId]: variantId } : {});
    }, [applySelectedBulkFixReviewItems]);

    const skipBulkFixReviewItem = useCallback((itemId: string) => {
        updateBulkFixReviewItem(itemId, { status: 'skipped', applyError: undefined });
    }, [updateBulkFixReviewItem]);

    const clearBulkFixReviewItems = useCallback(() => {
        replaceBulkFixReviewItems([]);
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    }, [replaceBulkFixReviewItems]);

    const updateAiInsertionPatch = useCallback((provider: AiPatchProvider, patchId: string, updates: Partial<AiContentPatch>) => {
        setAiInsertionPatches(prev => ({
            ...prev,
            [provider]: prev[provider].map(patch => (
                patch.id === patchId ? { ...patch, ...updates } : patch
            )),
        }));
    }, []);

    const selectAiContentPatchTarget = useCallback((patch: AiContentPatch): { error?: string } => {
        if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
        const target = resolveAiPatchTarget(editor, patch);
        if ('error' in target) {
            return { error: target.error };
        }

        editor
            .chain()
            .focus()
            .setTextSelection(target.selectFrom === target.selectTo ? target.from : { from: target.selectFrom, to: target.selectTo })
            .scrollIntoView()
            .run();

        return {};
    }, [editor]);

    const selectAiInsertionPatchTarget = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch) return;
        const result = selectAiContentPatchTarget(patch);
        if (result.error) {
            updateAiInsertionPatch(provider, patchId, { status: 'failed', applyError: result.error });
        }
    }, [aiInsertionPatches, selectAiContentPatchTarget, updateAiInsertionPatch]);

    const applyAiContentPatch = useCallback((patch: AiContentPatch): { status: 'applied' | 'failed'; error?: string } => {
        if (!editor) return { status: 'failed', error: 'المحرر غير جاهز حالياً.' };
        if (patch.status !== 'pending') return { status: 'failed', error: patch.applyError };
        const target = resolveAiPatchTarget(editor, patch);
        if ('error' in target) {
            return { status: 'failed', error: target.error };
        }

        try {
            const applied = editor
                .chain()
                .focus()
                .insertContentAt(
                    target.mode === 'replace' ? { from: target.from, to: target.to } : target.from,
                    parseMarkdownToArticleHtml(patch.contentMarkdown, articleLanguage),
                    { updateSelection: true }
                )
                .scrollIntoView()
                .run();
            if (!applied) throw new Error('تعذر تطبيق التعديل داخل المحرر.');
            return { status: 'applied' };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'تعذر تطبيق التعديل داخل المحرر.';
            return { status: 'failed', error: message };
        }
    }, [articleLanguage, editor]);

    const applyAiInsertionPatch = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch || patch.status !== 'pending') return;
        const result = applyAiContentPatch(patch);
        updateAiInsertionPatch(provider, patchId, {
            status: result.status,
            applyError: result.status === 'failed' ? result.error : undefined,
        });
    }, [aiInsertionPatches, applyAiContentPatch, updateAiInsertionPatch]);

    const applyAllAiInsertionPatches = useCallback((provider: AiPatchProvider) => {
        aiInsertionPatches[provider]
            .filter(patch => patch.status === 'pending')
            .forEach(patch => applyAiInsertionPatch(provider, patch.id));
    }, [aiInsertionPatches, applyAiInsertionPatch]);

    const markHistorySuggestionApplied = (id: string, text: string) => {
        setAiHistory(history => history.map(historyItem => (
            historyItem.id === id ? { ...historyItem, appliedSuggestion: text, applyError: undefined } : historyItem
        )));
    };

    const applySuggestionFromHistory = (id: string, text: string) => {
        if (!editor) return;
        const item = aiHistory.find(historyItem => historyItem.id === id);
        if (!item || item.appliedSuggestion) return;
        const resolvedRange = resolveBulkFixReviewRange(item);
        if (!resolvedRange) {
            setAiHistory(history => history.map(historyItem => (
                historyItem.id === id
                    ? { ...historyItem, applyError: 'Original text changed. Recreate this suggestion before applying it.' }
                    : historyItem
            )));
            return;
        }
        editor.chain().focus().insertContentAt({ from: resolvedRange.from, to: resolvedRange.to }, parseMarkdownToArticleHtml(text, articleLanguage)).run();
        markHistorySuggestionApplied(id, text);
    };

    const openGoogleSearch = (query: string) => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
    };

    const parseAiPatchResponse = useCallback((
        rawResponse: string,
        provider: AiPatchProvider,
        options?: { namespace?: string; titlePrefix?: string; commandId?: string }
    ): SmartAnalysisParsedResult => {
        let parsedResult = applyReadyCommandPatchRules(parseSmartAnalysisResponse(rawResponse, provider), options?.commandId);
        if (options?.namespace) {
            parsedResult = namespaceSmartAnalysisPatches(parsedResult, options.namespace, options.titlePrefix);
        }
        return parsedResult;
    }, []);

    const value = {
        aiResults, aiInsertionPatches, isAiLoading, isAiCommandLoading, aiFixingInfo, suggestion, setSuggestion,
        headingsAnalysis, setHeadingsAnalysis, isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized,
        aiHistory, bulkFixReviewItems, fixAllProgress, handleAiRequest, handleAnalyzeHeadings, handleAiAnalyze,
        parseAiPatchResponse, generateSemanticKeywords, generateGoalContext,
        handleChatGptAnalyze, handleGeminiReadyCommandsAnalyze, handleAiFix, handleFixAllViolations, getRelatedBulkFixRules, applyBulkFixReviewItem,
        applySelectedBulkFixReviewItems, selectBulkFixReviewItemTarget, skipBulkFixReviewItem,
        clearBulkFixReviewItems, applySuggestionFromHistory,
        applyAiInsertionPatch, applyAllAiInsertionPatches, selectAiInsertionPatchTarget,
        applyAiContentPatch, selectAiContentPatchTarget,
        markHistorySuggestionApplied,
        removeFromAiHistory: (id: string) => setAiHistory(h => h.filter(x => x.id !== id)),
        generateContextAwarePrompt, openGoogleSearch
    };

    return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};
