
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createContext, useContext, useContextSelector } from 'use-context-selector';
import { useUser } from './UserContext';
import { useEditorSelector } from './EditorContext';
import { useModal } from './ModalContext';
import type {
    AiAnalysisOptions,
    AiContentPatch,
    AiContentPatchOperation,
    AiPatchResolvedTarget,
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
    BulkFixTargetFingerprint,
    GoalContext,
    ReadyCommandAnalysisBatchItem,
    ReadyCommandAnalysisHistoryMeta,
    StructureAnalysis,
} from '../types';
import { getArticleReplacementContent, parseMarkdownToArticleHtml, parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { GEMINI_ANALYSIS_MODEL, GEMINI_FREE_MODEL_VALUES, GEMINI_PAID_ANALYSIS_MODEL } from '../constants/aiModels';
import { CONTENT_SUMMARY_STORAGE_KEY, ENGINEERING_PROMPT_IDS, getEngineeringPrompt, renderEngineeringPrompt } from '../constants/engineeringPrompts';
import { COMMON_ENGLISH_TERMS, CONCLUSION_KEYWORDS, CTA_WORDS, FAQ_KEYWORDS, INTERACTIVE_WORDS, SLOW_WORDS, TRANSITIONAL_WORDS, WARNING_ADVICE_WORDS, WORDS_TO_DELETE } from '../constants';
import { countOccurrences, DUPLICATE_WORDS_EXCLUSION_LIST, normalizeArabicText } from '../utils/analysis/analysisUtils';
import { normalizeGoalContext } from '../utils/goalContext';
import { saveRemoteArticleAiResult } from '../utils/supabaseArticles';
import { getSelectedGeminiFreeModel, isGeminiFreeModelFallbackEnabled } from '../utils/geminiModelPreference';
import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from '../utils/authenticatedApi';
import {
    cancelGeminiAnalysisEngine,
    runGeminiAnalysisEngine,
    type GeminiProgressCallback,
    type GeminiProgressSnapshot,
} from '../utils/geminiAnalysisEngine';

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
const GEMINI_PAID_MODEL = GEMINI_PAID_ANALYSIS_MODEL;
const OPENAI_MODEL = 'gpt-5.4';
const CHATGPT_TIMEOUT_MS = 300000;
const GEMINI_CHAT_STORAGE_PREFIX = 'bazarvan:gemini-chat';
const GEMINI_CHAT_MAX_MESSAGES = 8;
const GEMINI_CHAT_MAX_TOTAL_CHARS = 48000;
const GEMINI_CHAT_MESSAGE_CHAR_LIMIT = 12000;
const CHATGPT_CONVERSATION_STORAGE_PREFIX = 'bazarvan:chatgpt-conversation';
const ARTICLE_AI_RUNTIME_STORAGE_PREFIX = 'bazarvan:article-ai-runtime:';
const ARTICLE_AI_CLEAR_REQUEST_EVENT = 'bazarvan:article-ai-clear-request';
const ARTICLE_AI_RESULTS_RESTORE_EVENT = 'bazarvan:article-ai-results-restored';
const AI_CONTEXT_NOTICE_TIMEOUT_MS = 8000;
type GeminiPatchProvider = Extract<AiPatchProvider, 'gemini' | 'geminiPaid'>;

const getGeminiModelForProvider = (provider: GeminiPatchProvider = 'gemini'): string => (
    provider === 'geminiPaid' ? GEMINI_PAID_MODEL : getSelectedGeminiFreeModel()
);

const GOAL_CONTEXT_LABELS: Record<string, string> = {
    pageType: 'نوع الصفحة',
    objective: 'هدف الصفحة',
    audienceScope: 'نطاق الجمهور',
    targetCountry: 'المدينة/الدولة/الإقليم المستهدف',
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
    regional: 'إقليم',
    informational: 'شرح وتعلّم',
    commercial: 'مقارنة واختيار',
    'commercial-support': 'معلومات تجارية داعمة',
    transactional: 'تنفيذ إجراء/شراء',
    navigational: 'الوصول إلى علامة أو صفحة محددة',
    'support-intent': 'حل مشكلة أو معرفة طريقة الاستخدام',
    'local-intent': 'شرح وتعلّم',
};

const GOAL_CONTEXT_LOCATION_SCOPES = new Set(['local', 'country', 'regional']);

const hasRequiredTerm = (value: string | undefined | null): boolean => (
    Boolean(String(value || '').trim())
);

const hasRequiredTermList = (values: string[] | undefined | null): boolean => (
    Array.isArray(values) && values.some(value => hasRequiredTerm(value))
);

const getMissingRequiredArticleAiFields = (
    title: string,
    keywords: { primary?: string; secondaries?: string[]; company?: string; lsi?: string[] },
    goalContext: Partial<GoalContext>,
): string[] => {
    const missingFields: string[] = [];

    if (!hasRequiredTerm(title)) missingFields.push('عنوان المقالة');
    if (!hasRequiredTerm(keywords.primary)) missingFields.push('الكلمة المفتاحية الأساسية');
    if (!hasRequiredTermList(keywords.secondaries)) missingFields.push('الصيغ البديلة');
    if (!hasRequiredTerm(keywords.company)) missingFields.push('اسم الشركة');
    if (!hasRequiredTermList(keywords.lsi)) missingFields.push('كلمات LSI');

    const rawAudienceScope = String(goalContext.audienceScope || '').trim();
    const goalContextMissing = (
        !hasRequiredTerm(goalContext.pageType) ||
        !hasRequiredTerm(goalContext.objective) ||
        !hasRequiredTerm(goalContext.audienceScope) ||
        !hasRequiredTerm(goalContext.searchIntent) ||
        (GOAL_CONTEXT_LOCATION_SCOPES.has(rawAudienceScope) && !hasRequiredTerm(goalContext.targetCountry))
    );

    if (goalContextMissing) missingFields.push('سياق وهدف الصفحة');

    return missingFields;
};

const GOAL_CONTEXT_ALLOWED_VALUES = {
    pageType: ['article', 'news', 'service', 'category', 'comparison', 'product', 'landing', 'guide'],
    objective: ['educate', 'compare', 'convert', 'category-support', 'trust', 'support'],
    audienceScope: ['local', 'country', 'regional', 'global'],
    searchIntent: ['informational', 'commercial', 'commercial-support', 'transactional', 'navigational', 'support-intent'],
} as const;

const getArticleLanguageLabel = (articleLanguage: string): string => (
    articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'
);

const buildAiOutputLanguageInstruction = (articleLanguage: string): string => (
    articleLanguage === 'en'
        ? [
            '**قاعدة لغة الإخراج الإلزامية:**',
            '- لغة المقال هي الإنجليزية.',
            '- اكتب كل الشروحات والتحليل والتقييم وأسباب الاقتراح ومواضع التنفيذ وعناوين البطاقات والملاحظات باللغة العربية.',
            '- اكتب فقط النصوص المقترحة الجاهزة للإدراج أو الاستبدال أو النسخ داخل المقال باللغة الإنجليزية.',
            '- في JSON الأزرار السريعة: عناصر suggestions هي نصوص مقترحة جاهزة للمقال، لذلك يجب أن تكون بالإنجليزية فقط ودون شرح عربي داخلها.',
            '- في JSON الأوامر الجاهزة: اجعل analysisMarkdown وtitle وreason وplacementLabel بالعربية، واجعل contentMarkdown فقط باللغة الإنجليزية لأنه النص المقترح للمقال.',
            '- أبقِ targetText وanchorText وmergeDeleteTargetText وmergeDeleteAnchorText نصوصاً حرفية كما تظهر في المحرر دون ترجمة، حتى يعمل التحديد والاستبدال بدقة.',
            '- في تحليل العناوين: اجعل flaws بالعربية، واجعل suggestions عناوين مقترحة بالإنجليزية فقط.',
            '- لا تخلط العربية داخل النص الإنجليزي المقترح إلا إذا كان اسماً أو علامة تجارية يجب نقلها كما هي.',
        ].join('\n')
        : [
            '**قاعدة لغة الإخراج الإلزامية:**',
            '- لغة المقال هي العربية.',
            '- اكتب الشروحات والتحليل والتقييم وأسباب الاقتراح ومواضع التنفيذ باللغة العربية.',
            '- اكتب النصوص المقترحة الجاهزة للإدراج أو الاستبدال أو النسخ داخل المقال باللغة العربية.',
        ].join('\n')
);

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

const getFirstGeneratedTextValue = (record: Record<string, unknown>, keys: string[]): string => {
    const value = getFirstGeneratedValue(record, keys);
    return typeof value === 'string' ? value.trim() : '';
};

const normalizeGeneratedGoalContext = (rawValue: unknown, currentContext: GoalContext): GoalContext | null => {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
    const root = rawValue as Record<string, unknown>;
    const nestedContext = root.context || root.goalContext || root.goal_context;
    const record = nestedContext && typeof nestedContext === 'object' && !Array.isArray(nestedContext)
        ? nestedContext as Record<string, unknown>
        : root;
    const normalizedCurrent = normalizeGoalContext(currentContext);

    const audienceScope = resolveGoalContextChoice(
        getFirstGeneratedValue(record, ['audienceScope', 'audience_scope', 'scope']),
        GOAL_CONTEXT_ALLOWED_VALUES.audienceScope,
        normalizedCurrent.audienceScope,
    );
    const generatedTargetLocation = getFirstGeneratedTextValue(record, [
        'targetCountry',
        'target_country',
        'targetLocation',
        'target_location',
        'location',
        'market',
        'country',
        'region',
        'city',
    ]);

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
        audienceScope,
        targetCountry: audienceScope === 'global'
            ? ''
            : generatedTargetLocation || normalizedCurrent.targetCountry,
        targetAudience: normalizedCurrent.targetAudience,
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

const BULK_FIX_MAX_VIOLATIONS_PER_RULE = 10;

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

const normalizeBulkFixFingerprintText = (value: string): string => (
    normalizeArabicText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const getBulkFixFingerprintTokens = (value: string): string[] => (
    normalizeBulkFixFingerprintText(value)
        .split(/\s+/)
        .filter(token => token.length > 1)
);

const getBulkFixTextSimilarity = (a = '', b = ''): number => {
    const aTokens = Array.from(new Set(getBulkFixFingerprintTokens(a)));
    const bTokens = Array.from(new Set(getBulkFixFingerprintTokens(b)));
    if (aTokens.length === 0 || bTokens.length === 0) {
        return normalizeBulkFixFingerprintText(a) && normalizeBulkFixFingerprintText(a) === normalizeBulkFixFingerprintText(b) ? 1 : 0;
    }

    const bSet = new Set(bTokens);
    const intersection = aTokens.filter(token => bSet.has(token)).length;
    const union = new Set([...aTokens, ...bTokens]).size || 1;
    const jaccard = intersection / union;
    const containment = intersection / Math.min(aTokens.length, bTokens.length);

    return Math.max(jaccard, containment * 0.82);
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

const getBulkFixRangeFingerprint = (
    editor: any,
    from: number,
    to: number,
    unitType?: BulkFixTargetFingerprint['unitType'],
    originalText?: string
): BulkFixTargetFingerprint | undefined => {
    if (!editor?.state?.doc) return undefined;
    const blocks = getBulkFixTopLevelBlocks(editor);
    if (blocks.length === 0) return undefined;

    const overlappingIndexes = blocks
        .map((block, index) => (block.to > from && block.from < to ? index : -1))
        .filter(index => index !== -1);
    const fallbackIndex = blocks.findIndex(block => block.from <= from && block.to >= from);
    const firstBlockIndex = overlappingIndexes[0] ?? (fallbackIndex >= 0 ? fallbackIndex : 0);
    const lastBlockIndex = overlappingIndexes[overlappingIndexes.length - 1] ?? firstBlockIndex;
    const firstBlock = blocks[firstBlockIndex];
    const lastBlock = blocks[lastBlockIndex];
    const previousBlock = getMeaningfulContextBlocks(blocks, firstBlockIndex - 1, 'before', 1)[0];
    const nextBlock = getMeaningfulContextBlocks(blocks, lastBlockIndex + 1, 'after', 1)[0];
    const sectionHeadingBlock = blocks
        .slice(0, firstBlockIndex + 1)
        .reverse()
        .find(block => block.type === 'heading' && block.text.trim().length > 0);
    const docSize = editor.state.doc.content.size;
    const safeText = originalText ?? (
        Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to <= docSize && to > from
            ? editor.state.doc.textBetween(from, to, ' ')
            : ''
    );
    const normalizedText = safeText.replace(/\s+/g, ' ').trim();

    return {
        unitType,
        firstBlockIndex,
        lastBlockIndex,
        blockCount: Math.max(1, lastBlockIndex - firstBlockIndex + 1),
        firstBlockType: firstBlock?.type,
        lastBlockType: lastBlock?.type,
        sectionHeading: sectionHeadingBlock ? trimAiContextText(sectionHeadingBlock.text, 180) : undefined,
        previousText: previousBlock ? trimAiContextText(previousBlock.text, 260) : undefined,
        nextText: nextBlock ? trimAiContextText(nextBlock.text, 260) : undefined,
        originalStart: trimAiContextText(normalizedText.slice(0, 260), 260),
        originalEnd: trimAiContextText(normalizedText.slice(Math.max(0, normalizedText.length - 260)), 260),
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
        if (rule.status !== 'fail') return;
        if (rule.violatingItems?.length) {
            rule.violatingItems.forEach((item) => violations.push({ rule, item }));
        }
    });
    return violations;
};

const limitBulkFixViolationsPerRule = (
    violations: BulkFixViolationContext[],
    maxPerRule = BULK_FIX_MAX_VIOLATIONS_PER_RULE
): BulkFixViolationContext[] => {
    const countsByRuleTitle = new Map<string, number>();

    return violations.filter((violation) => {
        const currentCount = countsByRuleTitle.get(violation.rule.title) || 0;
        if (currentCount >= maxPerRule) return false;
        countsByRuleTitle.set(violation.rule.title, currentCount + 1);
        return true;
    });
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
        '- يجب أن يكون fixedText بلغة المقال فقط؛ إذا كانت لغة المقال الإنجليزية فاكتب fixedText بالإنجليزية، واجعل label وcriteriaChecks بالعربية.',
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
    const normalizeTransitionText = (value: string): string => (
        (language === 'ar' ? normalizeArabicText(value.toLowerCase()) : value.toLowerCase())
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
    const normalizedWords = Array.from(new Set(words.map(normalizeTransitionText).filter(Boolean)))
        .sort((a, b) => b.length - a.length);
    const segments = textValue
        .split(/[.!?؟،,؛;:：…]+/u)
        .map(segment => normalizeTransitionText(segment))
        .filter(Boolean);
    const count = segments.filter(segment => normalizedWords.some(word => segment === word || segment.startsWith(`${word} `))).length;
    return {
        count,
        total: segments.length,
        percentage: segments.length > 0 ? count / segments.length : 0,
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
            return 'فقرة تمهيد خطوات منتهية بنقطتين أو علامة استفهام؛ لا يطبق عليها معيار طول الفقرات العادية';
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
        const introEndingState = /[:：?؟？]\s*$/u.test(measuredText.trim()) ? 'نهاية التمهيد صحيحة' : 'لا تنتهي بنقطتين أو علامة استفهام';
        return `${stats.words} كلمة، ${stats.sentences} جملة، ${introEndingState}`;
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
            checks.push(/[:：?؟？]\s*$/u.test(measuredText.trim()));
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

const getBulkFixVariantViolationScore = (variant: BulkFixReviewVariant) => {
    const checks = variant.criteriaChecks || [];
    const violationCount = checks.filter(check => check.status === 'fail' || check.status === 'warn').length;
    const unknownCount = checks.filter(check => check.status === 'unknown').length;
    const passCount = checks.filter(check => check.status === 'pass').length;

    return {
        violationCount,
        unknownCount,
        passCount,
        total: checks.length,
    };
};

const selectLeastViolatingBulkFixVariant = (item: BulkFixReviewItem): BulkFixReviewVariant | undefined => {
    if (!item.variants || item.variants.length === 0) return undefined;

    return [...item.variants].sort((a, b) => {
        const aScore = getBulkFixVariantViolationScore(a);
        const bScore = getBulkFixVariantViolationScore(b);

        return aScore.violationCount - bScore.violationCount ||
            aScore.unknownCount - bScore.unknownCount ||
            bScore.passCount - aScore.passCount ||
            bScore.total - aScore.total ||
            compareBulkFixVariantsByQuality(a, b);
    })[0];
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

const getGeminiErrorMessage = (error: unknown, modelForMessage: string = GEMINI_MODEL): string => {
    const displayModel = modelForMessage.trim() || GEMINI_MODEL;
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
                return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${displayModel}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
            }
            if (typeof apiError?.message === 'string') {
                return apiError.message;
            }
        } catch {
            // Keep the original message if Google did not return JSON.
        }
    }

    if (/تمت تجربة|فشل طلب .*Gemini|آخر حالة مسجلة|هذا لا يؤكد|attempted .*key/i.test(rawMessage)) {
        return rawMessage;
    }

    if (/504|gateway timeout|timeout/i.test(rawMessage)) {
        return `انتهت مهلة طلب Gemini أو أعاد الخادم 504 للنموذج الحالي (${displayModel}). أعد المحاولة بدفعة أصغر أو اختر موديلا آخر.`;
    }

    if (/429|quota|RESOURCE_EXHAUSTED/i.test(rawMessage)) {
        return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${displayModel}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
    }

    return rawMessage;
};

type GeminiChatMessage = {
    role: 'user' | 'model';
    text: string;
};

type GeminiAnalysisResult = {
    text: string;
    ok: boolean;
    cancelled?: boolean;
    keyFingerprint?: string;
    keySuffix?: string;
    provider?: GeminiPatchProvider;
    model?: string;
};

class GeminiAnalysisCancelledError extends Error {
    constructor() {
        super('تم إيقاف التحليل يدويًا.');
        this.name = 'GeminiAnalysisCancelledError';
    }
}

const isGeminiAnalysisCancelledError = (error: unknown): error is GeminiAnalysisCancelledError => (
    error instanceof GeminiAnalysisCancelledError
);

type AiApiUsageContext = {
    source?: string;
    articleId?: string;
    articleTitle?: string;
    articleKey?: string;
    commandId?: string;
    commandLabel?: string;
    action?: string;
    batchIndex?: number;
    batchTotal?: number;
    ruleTitle?: string;
    rules?: string[];
};

type AiRequestProgress = GeminiProgressSnapshot & {
    source?: string;
    active?: boolean;
};

const getArticleChatStorageScope = (articleKey: string, title: string): string => {
    const rawScope = articleKey?.trim() || title?.trim() || 'draft';
    return rawScope.slice(0, 200);
};

const getGeminiChatStorageKey = (
    currentUser: string | null,
    articleScope: string,
    provider: GeminiPatchProvider = 'gemini',
): string => {
    const userPart = currentUser?.trim() || 'anonymous';
    const articlePart = articleScope?.trim() || 'draft';
    return `${GEMINI_CHAT_STORAGE_PREFIX}:${provider}:${userPart}:${articlePart}`;
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

const readStoredGeminiChatHistory = (
    currentUser: string | null,
    articleScope: string,
    provider: GeminiPatchProvider = 'gemini',
): GeminiChatMessage[] => {
    try {
        const value = localStorage.getItem(getGeminiChatStorageKey(currentUser, articleScope, provider));
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
    provider: GeminiPatchProvider = 'gemini',
) => {
    try {
        localStorage.setItem(
            getGeminiChatStorageKey(currentUser, articleScope, provider),
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
    history?: GeminiChatMessage[],
    model: string = getSelectedGeminiFreeModel(),
    usageContext: AiApiUsageContext = {},
    progressCallback?: GeminiProgressCallback,
    provider: GeminiPatchProvider = 'gemini',
): Promise<GeminiAnalysisResult> => {
    // Every UI workflow uses the server-side engine so proxy timeouts cannot
    // interrupt key/model rotation and browser code never handles secret keys.
    try {
      const engineResult = await runGeminiAnalysisEngine({
          request: {
              prompt,
              history: history && history.length > 0 ? trimGeminiChatHistory(history) : undefined,
              model,
              provider,
              allowModelFallback: provider === 'gemini' && isGeminiFreeModelFallbackEnabled(),
              fallbackModels: provider === 'gemini' ? [...GEMINI_FREE_MODEL_VALUES] : undefined,
              telemetry: usageContext,
          },
          onProgress: progressCallback,
      });
      const { status, data, rawBody, progress } = engineResult;

      if (status === 404) {
          throw new Error('Gemini API route is not enabled locally. Restart the Vite dev server so it can load the local API middleware.');
      }

      if (status === 499 || data.cancelled === true) {
          progressCallback?.({
              ...(progress || {}),
              stage: 'cancelled',
              provider: progress?.provider || (data.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini'),
              model: progress?.model || (typeof data.model === 'string' ? data.model : model),
              requestedModel: progress?.requestedModel || model,
              keyCount: progress?.keyCount || (typeof data.keyCount === 'number' ? data.keyCount : undefined),
              attemptedKeyCount: progress?.attemptedKeyCount || (typeof data.attemptedKeyCount === 'number' ? data.attemptedKeyCount : undefined),
              status: 499,
              message: 'تم إيقاف التحليل يدويًا.',
              completed: true,
          });
          return {
              text: '',
              ok: false,
              cancelled: true,
              provider: data.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini',
              model: typeof data.model === 'string' ? data.model : undefined,
          };
      }

      if (status < 200 || status >= 300) {
          const serverError = typeof data.error === 'string'
              ? data.error
              : typeof data.error?.message === 'string'
                ? data.error.message
                : rawBody.trim() && !rawBody.trim().startsWith('<')
                  ? rawBody.trim().slice(0, 500)
                  : '';
          const attemptSuffix = typeof data.attemptedKeyCount === 'number' && typeof data.keyCount === 'number' && !/تمت تجربة|attempted/i.test(serverError)
              ? ` تمت تجربة ${data.attemptedKeyCount} من ${data.keyCount} مفتاح.`
              : '';
          const fallbackError = status === 504
              ? `انتهت مهلة طلب Gemini أو أعاد الخادم 504 للنموذج الحالي (${model}). أعد المحاولة بدفعة أصغر أو اختر موديلا آخر.`
              : `Gemini request failed with status ${status}`;
          const finalErrorMessage = serverError || fallbackError;
          progressCallback?.({
              ...(progress || {}),
              stage: 'failed',
              provider: progress?.provider || (data.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini'),
              model: progress?.model || (typeof data.model === 'string' ? data.model : model),
              requestedModel: progress?.requestedModel || (typeof data.requestedModel === 'string' ? data.requestedModel : model),
              keyCount: progress?.keyCount || (typeof data.keyCount === 'number' ? data.keyCount : undefined),
              attemptedKeyCount: progress?.attemptedKeyCount || (typeof data.attemptedKeyCount === 'number' ? data.attemptedKeyCount : undefined),
              status,
              message: finalErrorMessage,
              completed: true,
          });
          throw new Error(`${finalErrorMessage}${attemptSuffix}`);
      }

      if (typeof data.text !== 'string') {
          throw new Error('Gemini server route did not return a valid text response.');
      }

      progressCallback?.({
          ...(progress || {}),
          stage: 'success',
          provider: data.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini',
          model: typeof data.model === 'string' ? data.model : model,
          requestedModel: typeof data.requestedModel === 'string' ? data.requestedModel : model,
          keyCount: typeof data.keyCount === 'number' ? data.keyCount : undefined,
          attemptedKeyCount: typeof data.attemptedKeyCount === 'number' ? data.attemptedKeyCount : undefined,
          keySuffix: typeof data.keySuffix === 'string' ? data.keySuffix : undefined,
          status,
          message: typeof data.keySuffix === 'string'
              ? `تم تلقي رد Gemini بنجاح من مفتاح ينتهي بـ ...${data.keySuffix}.`
              : 'تم تلقي رد Gemini بنجاح.',
          completed: true,
      });

      return {
          text: data.text,
          ok: true,
          keyFingerprint: typeof data.keyFingerprint === 'string' ? data.keyFingerprint : undefined,
          keySuffix: typeof data.keySuffix === 'string' ? data.keySuffix : undefined,
          provider: data.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini',
          model: typeof data.model === 'string' ? data.model : undefined,
      };
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const errorMessage = getGeminiErrorMessage(error, model);
      progressCallback?.({
          stage: 'failed',
          provider,
          model,
          requestedModel: model,
          message: errorMessage,
          completed: true,
      });
      return {
          text: `حدث خطأ أثناء الاتصال بـ Gemini: ${errorMessage}`,
          ok: false,
      };
    }
};

const callGeminiAnalysis = async (
    prompt: string,
    model: string = getSelectedGeminiFreeModel(),
    onResult?: (result: GeminiAnalysisResult) => void,
    usageContext?: AiApiUsageContext,
    progressCallback?: GeminiProgressCallback,
    provider: GeminiPatchProvider = 'gemini',
): Promise<string> => {
    const result = await requestGeminiAnalysis(prompt, undefined, model, usageContext, progressCallback, provider);
    onResult?.(result);
    if (result.cancelled) throw new GeminiAnalysisCancelledError();
    return result.text;
};

const callGeminiArticleChatAnalysis = async (
    prompt: string,
    currentUser: string | null,
    articleScope: string,
    provider: GeminiPatchProvider = 'gemini',
    onResult?: (result: GeminiAnalysisResult) => void,
    usageContext?: AiApiUsageContext,
    model?: string,
    progressCallback?: GeminiProgressCallback,
): Promise<string> => {
    const history = readStoredGeminiChatHistory(currentUser, articleScope, provider);
    const selectedModel = provider === 'geminiPaid'
        ? GEMINI_PAID_MODEL
        : model?.trim() || getGeminiModelForProvider(provider);
    const result = await requestGeminiAnalysis(prompt, history, selectedModel, usageContext, progressCallback, provider);
    if (result.ok) {
        saveStoredGeminiChatHistory(currentUser, articleScope, appendGeminiChatExchange(history, prompt, result.text), provider);
    }
    onResult?.(result);
    if (result.cancelled) throw new GeminiAnalysisCancelledError();
    return result.text;
};

type ChatGptAnalysisResult = {
    text: string;
    conversationId?: string;
    keyFingerprint?: string;
    keySuffix?: string;
    provider?: 'openai';
    model?: string;
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

const clearStoredArticleAiConversations = (currentUser: string | null, articleScope: string) => {
    if (!articleScope.trim()) return;
    try {
        localStorage.removeItem(getGeminiChatStorageKey(currentUser, articleScope, 'gemini'));
        localStorage.removeItem(getGeminiChatStorageKey(currentUser, articleScope, 'geminiPaid'));
        localStorage.removeItem(getChatGptConversationStorageKey(currentUser, articleScope));
    } catch (error) {
        console.error('Could not clear article AI conversation history:', error);
    }
};

const readStoredStringList = (storageKey: string): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed)
            ? parsed.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
            : [];
    } catch {
        return [];
    }
};

type StoredArticleAiRuntime = {
    aiResults: Record<AiPatchProvider, string>;
    aiHistory: AIHistoryItem[];
    bulkFixReviewItems: BulkFixReviewItem[];
    aiInsertionPatches: Record<AiPatchProvider, AiContentPatch[]>;
};

const EMPTY_AI_RESULTS: Record<AiPatchProvider, string> = { gemini: '', geminiPaid: '', chatgpt: '' };
const EMPTY_AI_INSERTION_PATCHES: Record<AiPatchProvider, AiContentPatch[]> = { gemini: [], geminiPaid: [], chatgpt: [] };

const getArticleAiRuntimeStorageKey = (currentUser: string | null, articleScope: string): string => {
    const userPart = currentUser?.trim() || 'anonymous';
    const articlePart = articleScope.trim() || 'default';
    return `${ARTICLE_AI_RUNTIME_STORAGE_PREFIX}${userPart}:${articlePart}`;
};

const readStoredArticleAiRuntime = (currentUser: string | null, articleScope: string): StoredArticleAiRuntime | null => {
    if (!articleScope.trim()) return null;
    try {
        const parsed = JSON.parse(localStorage.getItem(getArticleAiRuntimeStorageKey(currentUser, articleScope)) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            aiResults: {
                gemini: typeof parsed.aiResults?.gemini === 'string' ? parsed.aiResults.gemini : '',
                geminiPaid: typeof parsed.aiResults?.geminiPaid === 'string' ? parsed.aiResults.geminiPaid : '',
                chatgpt: typeof parsed.aiResults?.chatgpt === 'string' ? parsed.aiResults.chatgpt : '',
            },
            aiHistory: Array.isArray(parsed.aiHistory) ? parsed.aiHistory : [],
            bulkFixReviewItems: Array.isArray(parsed.bulkFixReviewItems) ? parsed.bulkFixReviewItems : [],
            aiInsertionPatches: {
                gemini: Array.isArray(parsed.aiInsertionPatches?.gemini) ? parsed.aiInsertionPatches.gemini : [],
                geminiPaid: Array.isArray(parsed.aiInsertionPatches?.geminiPaid) ? parsed.aiInsertionPatches.geminiPaid : [],
                chatgpt: Array.isArray(parsed.aiInsertionPatches?.chatgpt) ? parsed.aiInsertionPatches.chatgpt : [],
            },
        };
    } catch (error) {
        console.error('Could not read article AI runtime state:', error);
        return null;
    }
};

const saveStoredArticleAiRuntime = (
    currentUser: string | null,
    articleScope: string,
    runtime: StoredArticleAiRuntime,
) => {
    if (!articleScope.trim()) return;
    try {
        localStorage.setItem(
            getArticleAiRuntimeStorageKey(currentUser, articleScope),
            JSON.stringify(runtime),
        );
    } catch (error) {
        console.error('Could not save article AI runtime state:', error);
    }
};

const removeStoredArticleAiRuntime = (currentUser: string | null, articleScope: string) => {
    if (!articleScope.trim()) return;
    try {
        localStorage.removeItem(getArticleAiRuntimeStorageKey(currentUser, articleScope));
    } catch (error) {
        console.error('Could not remove article AI runtime state:', error);
    }
};

const getArticleMarkerKey = (prefix: string, articleId: string): string => `${prefix}${articleId}`;

const hasLocalMarker = (prefix: string, articleId: string): boolean => {
    if (!articleId.trim()) return false;
    try {
        const key = getArticleMarkerKey(prefix, articleId);
        const value = sessionStorage.getItem(key) || localStorage.getItem(key) || '';
        return Boolean(value && !value.startsWith('failed:'));
    } catch {
        return false;
    }
};

const writeLocalMarker = (prefix: string, articleId: string, value = new Date().toISOString()) => {
    if (!articleId.trim()) return;
    try {
        localStorage.setItem(getArticleMarkerKey(prefix, articleId), value);
    } catch (error) {
        console.error('Could not save article automation marker:', error);
    }
};

const hasCompleteGoalContext = (context: GoalContext): boolean => Boolean(
    context.pageType?.trim() &&
    context.objective?.trim() &&
    context.audienceScope?.trim() &&
    context.searchIntent?.trim()
);

const countPromptWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const truncatePromptText = (value: string, maxLength = 9000): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, maxLength).trim()}\n\n[The rest of the competitor text was shortened to keep the API request light.]`;
};

const formatCompetitorEvidenceParagraphs = (value: string): string => {
    const paragraphs = truncatePromptText(value)
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);

    return paragraphs
        .map((paragraph, index) => `[Paragraph ${index + 1}] ${paragraph}`)
        .join('\n\n');
};

const stripExtractionLabels = (value: string): string => (
    value
        .split('\n')
        .map(line => line.replace(/^\s*(?:H[1-6]|title|description|paragraph|list item|العنوان|الوصف|فقرة|قائمة)\s*[:：-]\s*/i, '').trim())
        .filter(Boolean)
        .join('\n')
        .trim()
);

const buildAutomaticReadyCommandCompetitorBlocks = (plainTexts: string[], urls: string[]): string => {
    const blocks = plainTexts
        .map((value, index) => {
            const text = stripExtractionLabels(value);
            if (!text) return '';

            return `### Competitor ${index + 1} - plain text
URL: ${urls[index]?.trim() || 'not provided'}
Word count: ${countPromptWords(text)}
Citation format when using an idea from this text: source: competitor ${index + 1}; evidence paragraph: [Paragraph number] short excerpt.

Numbered evidence text:
---
${formatCompetitorEvidenceParagraphs(text)}
---`;
        })
        .filter(Boolean);

    return blocks.join('\n\n');
};

const mergeUniqueTerms = (existing: string[], incoming: string[], maxItems: number): string[] => {
    const seen = new Set<string>();
    return [...existing, ...incoming]
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxItems);
};

const isPlaceholderArticleTitle = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();
    return !normalized || normalized === '(untitled)' || normalized === 'untitled' || normalized === 'بدون عنوان' || normalized === 'مسودة';
};

const callChatGptAnalysis = async (
    prompt: string,
    conversationId?: string,
    usageContext: AiApiUsageContext = {},
): Promise<ChatGptAnalysisResult> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHATGPT_TIMEOUT_MS);
    const requestId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

    try {
        const accessToken = await getAuthenticatedApiToken();
        const response = await fetch('/api/chatgpt', {
            method: 'POST',
            headers: getAuthenticatedApiHeaders(accessToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                prompt,
                model: OPENAI_MODEL,
                conversationId,
                requestId,
                telemetry: usageContext,
            }),
            signal: controller.signal,
        });

        window.clearTimeout(timeoutId);

        const isJson = response.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await response.json().catch(() => ({})) : {};
        window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));

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
            keyFingerprint: typeof data.keyFingerprint === 'string' ? data.keyFingerprint : undefined,
            keySuffix: typeof data.keySuffix === 'string' ? data.keySuffix : undefined,
            provider: 'openai',
            model: typeof data.model === 'string' ? data.model : OPENAI_MODEL,
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
التزم بقاعدة لغة الإخراج المرفقة في سياق الطلب: عند لغة المقال الإنجليزية اجعل الشرح والحقول الوصفية بالعربية، واجعل النصوص المقترحة داخل contentMarkdown بالإنجليزية فقط، واترك targetText وanchorText نصوصاً حرفية من المحرر دون ترجمة.
هذه التعليمات لها أولوية على أي طلب سابق يطلب كتابة النصوص الجاهزة داخل التقرير نفسه.
مهم جداً: لا تكرر أي نص جاهز للإضافة داخل analysisMarkdown وداخل patches في الوقت نفسه.
اجعل analysisMarkdown للتشخيص العام المختصر فقط. عند وجود بطاقة تنفيذ، لا تكرر عنوانها أو سببها أو موضعها أو نصها داخل analysisMarkdown.
اجعل patches هي المكان الوحيد الذي يحتوي النصوص الجاهزة للنسخ أو الإدراج داخل المقال.
إذا كانت فكرة أو توصية أو تضارب مبنيًا على محتوى منافس مرفق، فيجب ذكر رقم المنافس وفقرة الدليل. عند وجود patch ضع ذلك داخل reason فقط مثل: "المصدر: المنافس 2؛ فقرة الدليل: [فقرة 4] ...". إذا لم توجد بطاقة تنفيذ، اذكر المصدر داخل السطر التحليلي نفسه.
إذا كانت فكرة جديدة منشأة من الذكاء الاصطناعي وليست موجودة في المحتوى الحالي أو المنافسين، فاكتب داخل reason أو السطر التحليلي: "مصدر الفكرة: الذكاء الاصطناعي".
إذا كان بند في التقرير يحتاج "الحل العملي الجاهز" أو "الإجابة المقترحة" أو "الجملة المقترحة"، فلا تكتب السؤال أو العنوان أو الموضع أو سبب الاقتراح خارج البطاقة. ضع علامة [[PATCH:patch_1]] فقط في موضع بطاقة التنفيذ.
لا تعرض النص الجاهز داخل analysisMarkdown.
لا تستخدم عناوين "الفكرة" أو "سبب أهميتها" أو "سبب أهمية إضافتها" عند وجود بطاقة تنفيذ؛ استخدم علامة البطاقة فقط.
لا تستخدم الخط العريض داخل analysisMarkdown أو contentMarkdown نهائيًا: لا تستخدم **نص** أو __نص__ أو وسوم <strong>/<b>.
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
      "reason": "سبب مختصر. المصدر: المنافس 1؛ فقرة الدليل: [فقرة 3] ... أو مصدر الفكرة: الذكاء الاصطناعي",
      "confidence": 0.85
    }
  ]
}

القيم المسموحة لـ operation:
- replace_block
- replace_text
- delete_block
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
- إذا كان المطلوب تعديل أو تحسين أو توسيع أو إعادة صياغة أو تصحيح قسم أو فقرة أو جملة موجودة أصلًا في النص، استخدم operation بقيمة "replace_block" وليس أي عملية إضافة.
- إذا كان المطلوب حذف فقرة أو قسم حشو/تكرار دون نص بديل، استخدم operation بقيمة "delete_block"، وضع النص المراد حذفه حرفيًا في targetText، واترك contentMarkdown فارغًا.
- استخدم عمليات الإضافة فقط عندما يكون النص المقترح جديدًا وغير موجود في المقال أصلًا.
- إذا كان المطلوب استبدال قسم أو فقرة موجودة، استخدم operation بقيمة "replace_block".
- ضع في targetText النص الأصلي المراد استبداله حرفيًا من المقال، أو بداية الفقرة/القسم حرفيًا إذا كان النص طويلًا جدًا.
- لا تضع في targetText تسمية للمكان مثل "الفقرة الافتتاحية" أو "المقدمة"؛ ضع نص الفقرة الفعلي الموجود في المحرر.
- إذا كانت الفقرة المراد استبدالها قبل أول عنوان قسم، ضع نصها الحرفي في targetText ولا تربطها بعنوان قسم لاحق في anchorText.
- ضع في anchorText عنوان القسم أو الجملة المرجعية الأقرب داخل المقال.
- ضع في placementLabel وصفًا قصيرًا واضحًا لمكان التنفيذ مثل: داخل قسم كذا، بعد فقرة كذا، قبل الخاتمة.
- ضع في contentMarkdown النص الجديد الجاهز للتطبيق فقط دون شرح.
- ضع في reason سببًا مختصرًا لإضافة النص أو استبداله.
- إذا كان الاقتراح مستندًا إلى محتوى منافس، يجب أن يتضمن reason رقم المنافس وفقرة الدليل. إذا كان الاقتراح من الذكاء الاصطناعي وليس من المنافسين، يجب أن يتضمن reason عبارة "مصدر الفكرة: الذكاء الاصطناعي".
- ضع في title اسم البند أو عنوان القسم فقط؛ واجهة البطاقة ستعرض نوع العملية إضافة أو استبدال.
- إذا كان contentMarkdown يبدأ بعنوان H3 مثل "### عنوان فرعي" وكان anchorText هو قسم H2، استخدم operation بقيمة "append_to_section" حتى يضاف H3 في نهاية قسم H2 وقبل بداية H2 التالي، وليس مباشرة بعد عنوان H2.
- لا تكتفِ بكتابة الصياغة البديلة داخل analysisMarkdown.
- لا تكتب عبارات مثل "الصياغة البديلة:" أو "النص المقترح:" داخل contentMarkdown.
- لا تستخدم الخط العريض داخل analysisMarkdown أو contentMarkdown نهائيًا.

شكل بطاقة النص المقترح الذي يجب تغذيته بالحقول:
- عنوان البطاقة في الواجهة سيكون نوع العملية إضافة/استبدال مع title.
- reason هو سبب إضافة النص المقترح أو استبداله.
- يجب أن يتضمن reason مصدر الاقتراح عند الحاجة: رقم المنافس وفقرة الدليل، أو "مصدر الفكرة: الذكاء الاصطناعي".
- placementLabel هو مكان النص في المحرر نصيًا.
- contentMarkdown هو النص المقترح الجاهز فقط.
- عند الدمج، استخدم patch واحدًا للنص المدمج النهائي، وضع بيانات حذف الفقرة المدمجة من موضعها القديم في mergeDeleteTargetText وmergeDeleteAnchorText وmergeDeletePlacementLabel عند الحاجة.
- داخل analysisMarkdown ضع علامة [[PATCH:...]] فقط دون تكرار title أو reason أو placementLabel أو contentMarkdown قبل البطاقة أو بعدها.
- لا تعرض نوع التنفيذ "إضافة/استبدال/دمج" أو سبب التنفيذ أو الموضع كنص خارج البطاقة؛ هذه البيانات تظهر داخل البطاقة وأزرارها.
- لا تعرض "الفكرة" و"سبب أهميتها" كبنود منفصلة في التقرير؛ لا سيما في أوامر المقارنة والمحتوى الجاهز.
- لا تعرض السؤال مرة خارج البطاقة ومرة داخلها. إذا كان السؤال داخل contentMarkdown أو title، فلا تكتبه داخل analysisMarkdown.

بالنسبة لأمر الأقسام الأقل ملاءمة:
- أنشئ patch مستقل لكل قسم غير مناسب أو أقل ملاءمة.
- اجعل كل patch يستبدل القسم أو الفقرة الضعيفة بنسخة أكثر ملاءمة لهدف الصفحة والجمهور والكلمات الدلالية.
- يجب أن يظهر داخل analysisMarkdown علامة [[PATCH:patch_1]] أو [[PATCH:patch_2]] فقط لعرض بطاقة الاستبدال، دون تكرار سبب المشكلة أو مكانها خارج البطاقة.

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
لا تكتب قبل علامة [[PATCH:...]] السؤال أو الموضع أو نوع التحويل أو سبب الاقتراح إذا كانت هذه المعلومات موجودة في title أو reason أو placementLabel. ضع علامة البطاقة فقط.
لا تستخدم عناوين "الفكرة" أو "سبب أهميتها" أو "سبب أهمية إضافتها" عند وجود بطاقة تنفيذ.

إذا كان المطلوب تعديل فقرة موجودة، استخدم operation بقيمة "replace_block"، ويجب أن يكون targetText نسخة حرفية من الفقرة الحالية داخل المقال لا تلخيصاً لها. ضع النص الجديد فقط في contentMarkdown.
إذا كان المطلوب حذف فقرة أو قسم بسبب حشو أو تكرار دون نص بديل، استخدم operation بقيمة "delete_block"، واجعل targetText نسخة حرفية من النص المراد حذفه، واترك contentMarkdown فارغًا.
إذا كان المطلوب تعديل أو تحسين أو توسيع أو إعادة صياغة أو تصحيح قسم أو فقرة أو جملة موجودة أصلًا في النص، فهذا استبدال وليس إضافة. استخدم replace_block دائمًا مع targetText للنص الحالي.
استخدم عمليات الإضافة فقط عند إضافة نص جديد غير موجود أصلًا في المقال.
إذا كان contentMarkdown يبدأ بعنوان H3 ويجب إدخاله داخل قسم H2 قائم، استخدم append_to_section مع anchorText لعنوان H2 حتى يظهر في نهاية القسم قبل H2 التالي.
لا تستخدم في targetText تسميات عامة مثل "الفقرة الافتتاحية" أو "المقدمة". عند تعديل فقرة افتتاحية قبل أول عنوان قسم، انسخ الفقرة نفسها حرفيًا في targetText واترك anchorText فارغًا إذا لم يوجد عنوان سابق لها.
عند استهداف الفقرة الافتتاحية أو الفقرة الثانية، اعلم أن الفقرة الافتتاحية هي أول فقرة نصية في المحرر، والفقرة الثانية هي ثاني فقرة نصية في المحرر. اكتب ذلك بوضوح في placementLabel مثل: "الفقرة الافتتاحية - أول فقرة في المحرر" أو "الفقرة الثانية - ثاني فقرة في المحرر".
إذا لم تستطع نسخ targetText حرفيًا للفقرة الافتتاحية أو الثانية، اترك targetText فارغًا واستخدم placementLabel الواضح أعلاه حتى يتمكن المحرر من تحديد الموضع.
في غير حالتي الفقرة الافتتاحية والفقرة الثانية، إذا لم تستطع نسخ الفقرة الحالية حرفياً، فلا تستخدم replace_block، واستخدم عملية إضافة مناسبة بدلاً من ذلك.
إذا كان المطلوب إضافة فقرة أو سؤال أو جملة جديدة، استخدم عمليات الإضافة المناسبة مثل insert_after_heading أو insert_before_faq أو insert_before_conclusion أو append_to_section أو append_to_article.
مهم جداً: يجب أن يكون contentMarkdown محتوى نهائياً جاهزاً للإدراج في المقال فقط، دون أي تسميات تفسيرية مثل "السؤال:" أو "الإجابة:" أو "النص المقترح:" أو "الحل العملي الجاهز:" أو "مكان الإضافة:".
لا تستخدم الخط العريض أو علامات Markdown للخط العريض داخل أي تقرير أو نص مقترح.
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
  "reason": "سبب مختصر. المصدر: المنافس 1؛ فقرة الدليل: [فقرة 3] ... أو مصدر الفكرة: الذكاء الاصطناعي",
  "mergeDeleteTargetText": "اختياري: النص الحرفي للفقرة الثانية التي يجب حذفها بعد الدمج",
  "mergeDeleteAnchorText": "اختياري: عنوان أو فقرة مرجعية لموضع الحذف بعد الدمج",
  "mergeDeletePlacementLabel": "اختياري: وصف مختصر لموضع الحذف بعد الدمج",
  "confidence": 0.85
}

عند تحويل فقرة أو مقطع موجود إلى جدول أو قائمة نقطية أو قائمة مرقمة أو قائمة تحقق أو خطوات، استخدم دائماً operation بقيمة "replace_block"، واجعل targetText نسخة حرفية من النص الحالي، واجعل contentMarkdown يحتوي النص البديل فقط. عند إنشاء جدول Markdown يجب أن يحتوي contentMarkdown على صفوف جدول كاملة، ويفضل إضافة صف الفاصل، ولا تكتف بصف عنوان واحد يبدأ وينتهي بعلامة | دون بيانات.

لا تستخدم عبارة "قسم التعديلات القابلة للتطبيق". استخدم فقط علامة [[PATCH:...]] في موضع التنفيذ داخل التقرير.
لا تكرر بيانات البطاقة خارجها: title وreason وplacementLabel وcontentMarkdown يجب أن تظهر مرة واحدة داخل البطاقة فقط.
يجب أن تظهر البطاقات بهذا المعنى: عنوان العملية مع اسم البند، ثم سبب الاقتراح من reason، ثم موضع التنفيذ النصي من placementLabel، ثم النص المقترح من contentMarkdown، ثم أزرار الموضع والنسخ والإضافة أو الاستبدال.`;

const READY_COMMAND_H2_SECTION_REQUIREMENT = `

قاعدة خاصة عند اقتراح قسم H2 جديد:
- إذا كان contentMarkdown يبدأ بعنوان H2 مثل "## عنوان القسم" أو وسم <h2>، فهذا يعني إدخال قسم مستقل جديد.
- لا تستخدم replace_block أو replace_text لهذا النوع من الإدخال، ولا تصفه كاستبدال أو إدراج داخل قسم موجود.
- عند إضافة قسم H2 جديد، لا تضعه داخل قسم H2 موجود ولا مباشرة بعد عنوان H2 فقط.
- استخدم insert_before_conclusion أو insert_before_heading أو append_to_article عند عدم وجود موضع مرجعي واضح.
- إذا كان هناك anchorText لقسم H2 مرجعي، اجعل الموضع المقصود بعد نهاية ذلك القسم بالكامل كقسم مستقل، وليس داخل محتواه.`;

const READY_COMMAND_SINGLE_SECTION_CARD_REQUIREMENT = `

Hard rule for ready command patch cards:
- Each patch/card must contain only one independent H2 section.
- If a proposal contains more than one H2 heading, split it into separate patches/cards.
- H3/H4 subsections may stay inside their parent H2 card, but a second H2 must start a new card.`;

const SITE_OWNER_PUBLISHING_VOICE_GUARD = `**قاعدة صوت صاحب الموقع للنصوص الجاهزة للنشر:**
- أي نص داخل suggestions أو contentMarkdown أو وصف ميتا أو عنوان أو فقرة مقترحة يجب أن يبدو كأنه صادر عن صاحب الموقع/البائع الذي يعرف المنتج والخدمة والسياسات، وليس كمراجع خارجي يطلب من القارئ التحقق.
- ممنوع إدراج عبارات جاهزة للنشر توحي بعدم معرفة صاحب الموقع بالتفاصيل، مثل: تحقق من التوفر، قبل الطلب تحقق، اطلب قائمة، قد تشمل الخيارات، تختلف حسب البلد، تذكر إحدى الصفحات، يبدو أن، ربما، لا يعني وجود كذا، أو أي صياغة تنقل عبء التحقق إلى الزائر.
- إذا كانت معلومة مثل التوفر أو وسائل الدفع أو القياسات أو الرسوم أو إصدار المنتج غير مؤكدة في السياق، فلا تحولها إلى نص داخل المقال. ضعها كملاحظة تحريرية أو سبب داخل التحليل/reason فقط، مثل: يلزم تأكيد وسائل الدفع قبل كتابة فقرة الدفع.
- عند وجود معلومة مؤكدة في السياق، اكتبها بثقة وبصوت الموقع: نوفر، يأتي الجهاز، يدعم المنتج، تظهر الخيارات، بدلا من: تحقق من، اطلب، تذكر الصفحة، قد يكون.
- عند شرح حدود تقنية أو شروط استخدام مهمة، صغها كمعلومة موثوقة تفيد الزائر ولا تجعل الكاتب يبدو غير ملم بالمنتج. مثال: تساعد مؤشرات نوع المعدن في توجيه قرار الحفر، مع بقاء الدقة مرتبطة بعمق الهدف وطبيعة التربة.
- إذا لم تستطع كتابة نص آمن وجاهز للنشر من منظور صاحب الموقع، فلا تنشئ patch أو suggestion جاهزا؛ اكتب ملاحظة تحليلية فقط.`;

const appendSiteOwnerPublishingVoiceGuard = (prompt: string): string => (
    prompt.includes('قاعدة صوت صاحب الموقع للنصوص الجاهزة للنشر')
        ? prompt
        : `${prompt}\n\n${SITE_OWNER_PUBLISHING_VOICE_GUARD}`
);

const buildSmartAnalysisFinalPrompt = (contextPrompt: string, options?: { skipPatchInstructions?: boolean }) => {
    const guardedContextPrompt = appendSiteOwnerPublishingVoiceGuard(contextPrompt);
    return options?.skipPatchInstructions
        ? guardedContextPrompt
        : `${guardedContextPrompt}\n\n${SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION}\n\n${READY_COMMAND_PATCH_CARD_REQUIREMENT}\n\n${READY_COMMAND_H2_SECTION_REQUIREMENT}\n\n${READY_COMMAND_SINGLE_SECTION_CARD_REQUIREMENT}\n\n${SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION}`;
};

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
    /^(?:حدث خطأ أثناء الاتصال|انتهت مهلة الاتصال|فشل التحليل|فشل تحليل|فشل التحليل المتعدد|خطأ من|Gemini API route|The Gemini API|Could not|تعذر|Error\b|Request failed)/i.test(value.trim())
);

const ALLOWED_PATCH_OPERATIONS = new Set<AiContentPatchOperation>([
    'replace_block',
    'replace_text',
    'delete_block',
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

const removeMarkdownBold = (value: string): string => (
    value
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/<\/?(?:strong|b)\b[^>]*>/gi, '')
);

const isManualRecommendationPatchContent = (value: string): boolean => {
    const trimmed = value.trim().replace(/^[([{]\s*/, '').replace(/\s*[)\]}]$/, '');
    const normalized = normalizeAnchorText(trimmed);
    if (!normalized) return false;

    const startsAsNote = /^(?:ملاحظة|تنبيه|توصية|توجيه|إرشاد|ارشاد|مهم)\s*[:：-]/i.test(trimmed);
    const manualReviewIntent = [
        'مراجعة يدوية',
        'يتطلب مراجعة',
        'تتطلب مراجعة',
        'يتطلب التأكد',
        'تتطلب التأكد',
        'يجب التأكد',
        'ينبغي التأكد',
        'يجب فحص',
        'ينبغي فحص',
        'تحقق من',
        'راجع',
        'ليست نصا جاهزا',
        'ليس نصا جاهزا',
        'توصية توضيحية',
        'manual review',
        'requires review',
        'make sure',
        'verify',
    ].some(keyword => normalized.includes(normalizeAnchorText(keyword)));

    return (startsAsNote && manualReviewIntent) || normalized.includes('هذا التعديل يتطلب مراجعة يدوية');
};

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
    if (isManualRecommendationPatchContent(value)) return '';

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
        return removeMarkdownBold(`### ${question}\n${answer}`);
    }

    const cleaned = rawLines
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

    return isManualRecommendationPatchContent(cleaned) ? '' : removeMarkdownBold(cleaned);
};

const normalizePatchOperation = (value: unknown): AiContentPatchOperation => {
    const operation = asTrimmedString(value) as AiContentPatchOperation;
    if (operation === 'replace_text' || operation === 'replace_block' || operation === 'delete_block') return operation;
    if (['replace', 'replace_paragraph', 'update_paragraph', 'rewrite_paragraph'].includes(operation)) return 'replace_block';
    if (['delete', 'remove', 'delete_paragraph', 'remove_paragraph', 'حذف', 'حذف فقرة'].includes(operation)) return 'delete_block';
    return ALLOWED_PATCH_OPERATIONS.has(operation) ? operation : 'append_to_article';
};

const isIndependentH2SectionContent = (value: string): boolean => (
    /^(?:##(?!#)\s+\S|<h2(?:\s|>|\/))/i.test(value.trim())
);

const isH3SubsectionContent = (value: string): boolean => (
    /^(?:###(?!#)\s+\S|<h3(?:\s|>|\/))/i.test(value.trim())
);

const normalizeIndependentH2SectionOperation = (
    operation: AiContentPatchOperation,
    contentMarkdown: string,
): AiContentPatchOperation => {
    if (isH3SubsectionContent(contentMarkdown) && operation === 'insert_after_heading') return 'append_to_section';
    if (!isIndependentH2SectionContent(contentMarkdown)) return operation;
    if (
        operation === 'insert_before_heading' ||
        operation === 'insert_before_conclusion' ||
        operation === 'append_to_article'
    ) {
        return operation;
    }
    return 'append_to_section';
};

const PATCH_REPLACEMENT_INTENT_KEYWORDS = [
    'استبدال',
    'بدل',
    'تعديل',
    'تحسين',
    'توسيع',
    'اعادة صياغة',
    'إعادة صياغة',
    'صياغة بديلة',
    'تصحيح',
    'تخفيف',
    'تحديث',
    'تنقيح',
    'معالجة',
    'تحويل',
    'نسخة محسنة',
    'نسخة بديلة',
    'replace',
    'rewrite',
    'update',
    'revise',
    'improve',
    'expand',
    'correct',
    'convert',
];

const PATCH_ADDITION_INTENT_KEYWORDS = [
    'اضافة',
    'إضافة',
    'اضف',
    'أضف',
    'فقرة جديدة',
    'سؤال جديد',
    'غير موجودة',
    'ناقصة',
    'insert',
    'add',
    'append',
    'new paragraph',
];

const getNormalizedWordCount = (value: string): number => normalizeAnchorText(value).split(' ').filter(Boolean).length;

const hasPatchIntentKeyword = (value: string, keywords: string[]): boolean => {
    const normalizedValue = normalizeAnchorText(value);
    if (!normalizedValue) return false;

    return keywords.some(keyword => {
        const normalizedKeyword = normalizeAnchorText(keyword);
        return normalizedKeyword && normalizedValue.includes(normalizedKeyword);
    });
};

const inferPatchOperation = (
    requestedOperation: AiContentPatchOperation,
    record: Record<string, unknown>,
    targetText: string,
): AiContentPatchOperation => {
    if (requestedOperation === 'delete_block') return requestedOperation;
    if (requestedOperation === 'replace_block' || requestedOperation === 'replace_text') return requestedOperation;
    const hasExplicitReplacementTarget = Boolean(
        asTrimmedString(record.targetText) ||
        asTrimmedString(record.originalText) ||
        asTrimmedString(record.currentText) ||
        asTrimmedString(record.original) ||
        asTrimmedString(record.replaceTarget)
    );
    const intentText = [
        asTrimmedString(record.title),
        asTrimmedString(record.reason),
        asTrimmedString(record.placementLabel || record.placement || record.place),
        asTrimmedString(record.anchorText || record.anchor || record.target),
        asTrimmedString(record.operation || record.type),
    ].join(' ');
    const additionIntent = hasPatchIntentKeyword(intentText, PATCH_ADDITION_INTENT_KEYWORDS);
    const replacementIntent = hasPatchIntentKeyword(intentText, PATCH_REPLACEMENT_INTENT_KEYWORDS);
    const targetLooksLikeExistingText = getNormalizedWordCount(targetText) >= 6 || isOrdinalParagraphLocationText(targetText);
    const intentTargetsOrdinalParagraph = hasOrdinalParagraphReference(intentText);

    if (!targetText) {
        return replacementIntent && intentTargetsOrdinalParagraph && !additionIntent ? 'replace_block' : requestedOperation;
    }

    if (hasExplicitReplacementTarget && targetLooksLikeExistingText && (replacementIntent || !additionIntent)) {
        return 'replace_block';
    }

    return requestedOperation;
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
            const requestedOperation = normalizePatchOperation(record.operation || record.type);
            const contentMarkdown = cleanAiPatchContentMarkdown(asTrimmedString(record.contentMarkdown || record.content || record.text));
            if (!contentMarkdown && requestedOperation !== 'delete_block') return null;

            const operation = normalizeIndependentH2SectionOperation(
                requestedOperation,
                contentMarkdown,
            );
            const targetText = asTrimmedString(record.targetText || record.originalText || record.currentText || record.original || record.replaceTarget);
            const mergeDeleteTargetText = asTrimmedString(
                record.mergeDeleteTargetText ||
                record.deleteTargetText ||
                record.secondaryDeleteTargetText ||
                record.secondaryTargetText ||
                record.mergedDeleteTargetText ||
                record.textToDelete ||
                record.deleteText
            );

            return {
                id: `${provider}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
                provider,
                operation: inferPatchOperation(operation, record, targetText),
                title: asTrimmedString(record.title) || `تعديل ${index + 1}`,
                marker: asTrimmedString(record.marker) || `patch_${index + 1}`,
                anchorText: asTrimmedString(record.anchorText || record.anchor || record.target),
                targetText,
                placementLabel: asTrimmedString(record.placementLabel || record.placement || record.place),
                contentMarkdown,
                reason: asTrimmedString(record.reason),
                confidence: normalizeConfidence(record.confidence),
                mergeDeleteTargetText,
                mergeDeleteAnchorText: asTrimmedString(
                    record.mergeDeleteAnchorText ||
                    record.deleteAnchorText ||
                    record.secondaryAnchorText ||
                    record.mergedDeleteAnchorText
                ),
                mergeDeletePlacementLabel: asTrimmedString(
                    record.mergeDeletePlacementLabel ||
                    record.deletePlacementLabel ||
                    record.secondaryPlacementLabel ||
                    record.mergedDeletePlacementLabel ||
                    record.deleteLocation ||
                    record.deletePlace
                ),
                status: 'pending',
            };
        })
        .filter((patch): patch is AiContentPatch => Boolean(patch))
        .slice(0, 20);
};

const findJsonArrayPropertyText = (text: string, propertyName: string): string => {
    const match = new RegExp(`"${propertyName}"\\s*:\\s*\\[`, 'i').exec(text);
    if (!match) return '';

    const start = text.indexOf('[', match.index);
    if (start === -1) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '[') depth += 1;
        if (char === ']') {
            depth -= 1;
            if (depth === 0) return text.slice(start, index + 1);
        }
    }

    return '';
};

const collectJsonObjectFragments = (text: string): string[] => {
    const fragments: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') {
            if (depth === 0) start = index;
            depth += 1;
            continue;
        }
        if (char === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                fragments.push(text.slice(start, index + 1));
                start = -1;
            }
        }
    }

    return fragments;
};

const parseLooseJson = (value: string): unknown => {
    const candidates = [
        value,
        value.replace(/,\s*([}\]])/g, '$1'),
    ];

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next lightly-normalized candidate.
        }
    }

    return null;
};

const extractLooseAiPatchesFromText = (rawResponse: string, provider: AiPatchProvider): AiContentPatch[] => {
    const rawPatchRecords: unknown[] = [];

    ['patches', 'insertions', 'contentPatches'].forEach(propertyName => {
        const arrayText = findJsonArrayPropertyText(rawResponse, propertyName);
        if (!arrayText) return;

        const parsedArray = parseLooseJson(arrayText);
        if (Array.isArray(parsedArray)) {
            rawPatchRecords.push(...parsedArray);
            return;
        }

        collectJsonObjectFragments(arrayText).forEach(fragment => {
            const parsedObject = parseLooseJson(fragment);
            if (parsedObject && typeof parsedObject === 'object' && !Array.isArray(parsedObject)) {
                rawPatchRecords.push(parsedObject);
            }
        });
    });

    if (rawPatchRecords.length === 0) return [];

    return normalizeAiPatches(rawPatchRecords, provider);
};

const stripDuplicatePatchTextFromAnalysis = (analysisMarkdown: string, patches: AiContentPatch[]): string => {
    let cleaned = analysisMarkdown;

    patches.forEach((patch) => {
        const content = patch.contentMarkdown.trim();
        if (content.length < 20) return;
        cleaned = cleaned.split(content).join(`[[PATCH:${patch.marker || patch.title}]]`);
    });

    cleaned = stripDuplicatePatchMetadataFromAnalysis(cleaned, patches);

    return cleaned
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const normalizePatchMarkerForComparison = (value?: string): string => (
    (value || '')
        .normalize('NFKC')
        .replace(/^\s*\[\[PATCH:/i, '')
        .replace(/\]\]\s*$/i, '')
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '')
);

const stripOrphanPatchMarkers = (analysisMarkdown: string, patches: AiContentPatch[]): string => {
    const validMarkers = new Set(
        patches
            .flatMap(patch => [patch.marker, patch.title])
            .map(value => normalizePatchMarkerForComparison(value))
            .filter(Boolean)
    );

    return analysisMarkdown
        .replace(/\[\[PATCH:([^\]]+)\]\]/g, (match, marker) => (
            validMarkers.has(normalizePatchMarkerForComparison(String(marker))) ? match : ''
        ))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const parseSmartAnalysisResponse = (rawResponse: string, provider: AiPatchProvider): { displayText: string; patches: AiContentPatch[] } => {
    if (isAiErrorResponseText(rawResponse)) {
        return { displayText: rawResponse.trim(), patches: [] };
    }

    const parsed = extractJson(rawResponse);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const partialDisplayText = extractJsonStringProperty(rawResponse, 'analysisMarkdown');
        const loosePatches = extractLooseAiPatchesFromText(rawResponse, provider);
        if (partialDisplayText) {
            const cleanDisplayText = removeMarkdownBold(stripOrphanPatchMarkers(partialDisplayText, loosePatches));
            return {
                displayText: loosePatches.length ? stripDuplicatePatchTextFromAnalysis(cleanDisplayText, loosePatches) : cleanDisplayText,
                patches: loosePatches,
            };
        }
        const cleanDisplayText = removeMarkdownBold(stripOrphanPatchMarkers(rawResponse, loosePatches));
        return {
            displayText: loosePatches.length ? stripDuplicatePatchTextFromAnalysis(cleanDisplayText, loosePatches) : cleanDisplayText,
            patches: loosePatches,
        };
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
    const resolvedPatches = patches.length ? patches : extractLooseAiPatchesFromText(rawResponse, provider);
    if (!displayText && patches.length === 0) {
        if (resolvedPatches.length === 0) return { displayText: rawResponse, patches: [] };
    }

    const cleanDisplayText = removeMarkdownBold(stripOrphanPatchMarkers(displayText || rawResponse, resolvedPatches));

    return {
        displayText: resolvedPatches.length ? stripDuplicatePatchTextFromAnalysis(cleanDisplayText, resolvedPatches) : cleanDisplayText,
        patches: resolvedPatches,
    };
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

const normalizePatchMetadataLine = (value: string): string => normalizeAnchorText(
    value
        .replace(/^#{1,6}\s*/, '')
        .replace(/^(?:[-*]|\d+[.)])\s*/, '')
        .replace(/^(?:السؤال(?:\s+المقترح)?|الإجابة|الاجابة|مكان(?:\s+\S+){0,4}|الموضع(?:\s+\S+){0,4}|نوع\s+التحويل(?:\s+\S+){0,3}|سبب(?:\s+\S+){0,4}|العنوان(?:\s+\S+){0,3}|عنوان(?:\s+\S+){0,3}|الفكرة(?:\s+\S+){0,3}|النص\s+المقترح(?:\s+\S+){0,4}|الإجراء\s+المقترح|ماذا\s+أفعل|أين\s+أطبقه|لماذا(?:\s+\S+){0,2})\s*[:：-]\s*/i, '')
);

const PATCH_ANALYSIS_METADATA_LABEL_PATTERN = /^(?:[-*]\s*)?(?:#{1,6}\s*)?(?:السؤال(?:\s+المقترح)?|الإجابة|الاجابة|مكان(?:\s+\S+){0,4}|الموضع(?:\s+\S+){0,4}|نوع\s+التحويل(?:\s+\S+){0,3}|سبب(?:\s+\S+){0,4}|العنوان(?:\s+\S+){0,3}|عنوان(?:\s+\S+){0,3}|الفكرة(?:\s+\S+){0,3}|النص\s+المقترح(?:\s+\S+){0,4}|الإجراء\s+المقترح|ماذا\s+أفعل|أين\s+أطبقه|لماذا(?:\s+\S+){0,2})\s*[:：-]/i;

const getPatchMetadataComparisonValues = (patch: AiContentPatch): string[] => {
    const firstContentLine = patch.contentMarkdown
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || '';
    const values = [
        patch.title,
        patch.reason,
        patch.placementLabel,
        patch.anchorText,
        patch.targetText,
        patch.mergeDeletePlacementLabel,
        patch.mergeDeleteAnchorText,
        patch.mergeDeleteTargetText,
        normalizeFaqQuestionHeading(firstContentLine),
        stripAiPatchLabelsFromLine(firstContentLine),
    ];
    const seen = new Set<string>();

    return values
        .map(value => normalizePatchMetadataLine(value || ''))
        .filter(value => {
            if (!value || seen.has(value)) return false;
            seen.add(value);
            return true;
        });
};

const isDuplicatePatchAnalysisLine = (line: string, patch: AiContentPatch): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('[[PATCH:')) return false;
    const normalizedLine = normalizePatchMetadataLine(trimmed);
    if (!normalizedLine) return false;

    const comparisonValues = getPatchMetadataComparisonValues(patch);
    const matchesPatchValue = comparisonValues.some(value => (
        normalizedLine === value ||
        (value.length >= 12 && (normalizedLine.includes(value) || value.includes(normalizedLine)))
    ));
    if (matchesPatchValue) return true;

    return PATCH_ANALYSIS_METADATA_LABEL_PATTERN.test(trimmed) && normalizedLine.split(' ').filter(Boolean).length <= 28;
};

const stripDuplicatePatchMetadataFromAnalysis = (analysisMarkdown: string, patches: AiContentPatch[]): string => {
    const markerPattern = /\[\[PATCH:([^\]]+)\]\]/g;
    let cleaned = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = markerPattern.exec(analysisMarkdown)) !== null) {
        const marker = match[1].trim();
        const patch = patches.find(item => item.marker === marker || item.title === marker);
        let chunk = analysisMarkdown.slice(lastIndex, match.index);

        if (patch) {
            const lines = chunk.replace(/\r\n/g, '\n').split('\n');
            let removedMetadata = false;

            for (let index = lines.length - 1; index >= 0 && lines.length - index <= 10; index -= 1) {
                const line = lines[index];
                if (!line.trim()) {
                    if (removedMetadata) {
                        lines.splice(index, 1);
                    }
                    continue;
                }
                if (!isDuplicatePatchAnalysisLine(line, patch)) break;
                lines.splice(index, 1);
                removedMetadata = true;
            }

            chunk = lines.join('\n');
        }

        cleaned += chunk + match[0];
        lastIndex = markerPattern.lastIndex;
    }

    cleaned += analysisMarkdown.slice(lastIndex);
    return cleaned;
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

const isCombinedCommandFaqPatch = (patch: AiContentPatch): boolean => {
    const firstContentLine = patch.contentMarkdown
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || '';
    const combinedText = normalizeAnchorText([
        patch.title,
        patch.reason,
        patch.placementLabel,
        patch.anchorText,
        firstContentLine,
    ].filter(Boolean).join(' '));

    return (
        /[؟?]/.test(firstContentLine) ||
        combinedText.includes('اسئلة الناس') ||
        combinedText.includes('اسئله الناس') ||
        combinedText.includes('الاسئلة الشائعة') ||
        combinedText.includes('الاسئله الشائعه') ||
        combinedText.includes('people also ask') ||
        combinedText.includes('faq')
    );
};

const normalizeCombinedCommandPatch = (patch: AiContentPatch): AiContentPatch => {
    if (isCombinedCommandFaqPatch(patch)) {
        return {
            ...patch,
            operation: 'insert_before_faq',
            anchorText: patch.anchorText || 'الأسئلة الشائعة',
            targetText: '',
            placementLabel: patch.placementLabel || 'داخل قسم الأسئلة الشائعة',
            contentMarkdown: ensureFaqQuestionContentMarkdown(patch.contentMarkdown),
        };
    }

    const intentText = [
        patch.title,
        patch.reason,
        patch.placementLabel,
        patch.anchorText,
    ].filter(Boolean).join(' ');
    const normalizedIntent = normalizeAnchorText(intentText);
    const hasReplacementTarget = Boolean(patch.targetText?.trim());
    const conversionIntent = [
        'تحويل',
        'جدول',
        'قائمة',
        'قائمه',
        'خطوات',
        'تحسين اضعف قسم',
        'اضعف قسم',
        'اقل ملاءمة',
        'اقل ملاءمه',
        'صياغة بديلة',
        'صياغه بديله',
    ].some(keyword => normalizedIntent.includes(normalizeAnchorText(keyword)));

    if (hasReplacementTarget && conversionIntent) {
        return {
            ...patch,
            operation: 'replace_block',
        };
    }

    return patch;
};

const findTopLevelH2SectionStarts = (value: string): number[] => {
    const text = value.replace(/\r\n/g, '\n');
    const starts: number[] = [];
    const pattern = /(^|\n)(?=(?:##(?!#)\s+\S|<h2(?:\s|>|\/)))/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        starts.push(match.index + (match[1] ? 1 : 0));
        if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }

    return starts.filter((start, index) => index === 0 || start !== starts[index - 1]);
};

const splitContentMarkdownByH2Sections = (value: string): string[] => {
    const text = value.replace(/\r\n/g, '\n').trim();
    if (!text) return [];

    const starts = findTopLevelH2SectionStarts(text);
    if (starts.length <= 1) return [text];

    return starts
        .map((start, index) => {
            const from = index === 0 && start > 0 ? 0 : start;
            const to = starts[index + 1] ?? text.length;
            return text.slice(from, to).trim();
        })
        .filter(Boolean);
};

const getLeadingPatchHeadingTitle = (value: string): string => {
    const firstHeadingLine = value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .find(line => /^(?:##(?!#)\s+\S|<h2(?:\s|>|\/))/i.test(line));
    if (!firstHeadingLine) return '';

    const markdownHeading = firstHeadingLine.match(/^##(?!#)\s+(.+)$/);
    if (markdownHeading?.[1]) return markdownHeading[1].trim();

    const htmlHeading = firstHeadingLine.match(/^<h2[^>]*>(.*?)<\/h2>/i);
    if (htmlHeading?.[1]) return htmlHeading[1].replace(/<[^>]+>/g, '').trim();

    return '';
};

const splitReadyCommandH2SectionPatches = (patches: AiContentPatch[]): AiContentPatch[] => (
    patches.flatMap((patch) => {
        const sections = splitContentMarkdownByH2Sections(patch.contentMarkdown);
        if (sections.length <= 1) return [patch];

        const baseMarker = patch.marker || patch.title || patch.id;
        return sections.map((contentMarkdown, index) => ({
            ...patch,
            id: index === 0 ? patch.id : `${patch.id}-h2-${index + 1}`,
            marker: baseMarker,
            title: getLeadingPatchHeadingTitle(contentMarkdown) || patch.title,
            contentMarkdown,
            operation: normalizeIndependentH2SectionOperation(patch.operation, contentMarkdown),
            status: 'pending' as const,
            applyError: undefined,
            resolvedTarget: undefined,
            mergeDeleteStatus: patch.mergeDeleteStatus,
            mergeDeleteApplyError: patch.mergeDeleteApplyError,
        }));
    })
);

const applyReadyCommandPatchRules = (
    parsedResult: SmartAnalysisParsedResult,
    commandId?: string
): SmartAnalysisParsedResult => {
    let nextResult = parsedResult;

    if (commandId === ENGINEERING_PROMPT_IDS.smartAnalysis.peopleQuestions) {
        nextResult = {
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
    }

    if (commandId === ENGINEERING_PROMPT_IDS.smartAnalysis.combinedCommands) {
        nextResult = {
            displayText: nextResult.displayText,
            patches: nextResult.patches.map(normalizeCombinedCommandPatch),
        };
    }

    if (!commandId) return nextResult;

    return {
        ...nextResult,
        patches: splitReadyCommandH2SectionPatches(nextResult.patches).map(patch => ({
            ...patch,
            commandId: patch.commandId || commandId,
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

const ORDINAL_PARAGRAPH_TARGETS = [
    {
        index: 0,
        keywords: [
            'الفقرة الافتتاحية',
            'فقرة افتتاحية',
            'الفقرة الاولى',
            'الفقرة الأولى',
            'اول فقرة',
            'أول فقرة',
            'المقدمة',
            'مقدمة المقال',
            'افتتاحية المقال',
            'opening paragraph',
            'first paragraph',
            'introduction',
            'intro',
        ],
    },
    {
        index: 1,
        keywords: [
            'الفقرة الثانية',
            'فقرة ثانية',
            'ثاني فقرة',
            'الفقرة رقم 2',
            'فقرة رقم 2',
            'فقرة 2',
            'ثانية المقال',
            'second paragraph',
            'paragraph 2',
            '2nd paragraph',
        ],
    },
] as const;

const getPatchLocationHint = (patch: AiContentPatch): string => normalizeAnchorText([
    patch.title,
    patch.reason,
    patch.placementLabel,
    patch.anchorText,
    patch.targetText,
].filter(Boolean).join(' '));

const findOrdinalParagraphIndex = (patch: AiContentPatch): number | null => {
    const locationHint = getPatchLocationHint(patch);
    if (!locationHint) return null;

    const target = ORDINAL_PARAGRAPH_TARGETS.find(item => item.keywords.some(keyword => {
        const normalizedKeyword = normalizeAnchorText(keyword);
        return normalizedKeyword && locationHint.includes(normalizedKeyword);
    }));

    return typeof target?.index === 'number' ? target.index : null;
};

const hasOrdinalParagraphReference = (value?: string): boolean => {
    const normalizedValue = normalizeAnchorText(value || '');
    if (!normalizedValue) return false;

    return ORDINAL_PARAGRAPH_TARGETS.some(item => item.keywords.some(keyword => {
        const normalizedKeyword = normalizeAnchorText(keyword);
        return normalizedKeyword && normalizedValue.includes(normalizedKeyword);
    }));
};

const isOrdinalParagraphLocationText = (value?: string): boolean => {
    const normalizedValue = normalizeAnchorText(value || '');
    if (!normalizedValue) return false;
    if (normalizedValue.split(' ').filter(Boolean).length > 8) return false;

    return hasOrdinalParagraphReference(value);
};

const findTopLevelParagraphByIndex = (editor: any, paragraphIndex: number): TextBlockMatch | null => {
    if (!editor?.state?.doc || paragraphIndex < 0) return null;
    let currentIndex = 0;
    let match: TextBlockMatch | null = null;

    editor.state.doc.forEach((node: any, offset: number) => {
        if (match || node.type.name !== 'paragraph' || !node.textContent?.trim()) return;
        if (currentIndex === paragraphIndex) {
            match = {
                from: offset,
                to: offset + node.nodeSize,
                score: 3,
                text: node.textContent,
            };
            return;
        }
        currentIndex += 1;
    });

    return match;
};

const findOrdinalParagraphTarget = (editor: any, patch: AiContentPatch): TextBlockMatch | null => {
    const locationHint = normalizeAnchorText([
        patch.title,
        patch.reason,
        patch.placementLabel,
        patch.anchorText,
        patch.targetText,
    ].filter(Boolean).join(' '));
    if (!locationHint) return null;
    const paragraphIndex = findOrdinalParagraphIndex(patch);
    return typeof paragraphIndex === 'number' ? findTopLevelParagraphByIndex(editor, paragraphIndex) : null;
};

const normalizeBulkFixRangeMatchText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const findExactBulkFixTextUnitMatch = (editor: any, targetText: string, preferredFrom: number): TextBlockMatch | null => {
    if (!editor || !targetText.trim()) return null;
    const normalizedTarget = normalizeBulkFixRangeMatchText(targetText);
    if (!normalizedTarget) return null;
    const candidates: TextBlockMatch[] = [];
    const topLevelBlocks: { from: number; to: number }[] = [];

    editor.state.doc.descendants((node: any, pos: number) => {
        if (!node.isBlock || !['paragraph', 'heading', 'listItem'].includes(node.type.name)) return true;
        const textContent = node.textContent || '';
        if (normalizeBulkFixRangeMatchText(textContent) !== normalizedTarget) return true;
        candidates.push({ from: pos, to: pos + node.nodeSize, score: 4 });
        return true;
    });

    editor.state.doc.forEach((node: any, offset: number) => {
        if (!node.textContent?.trim()) return;
        topLevelBlocks.push({ from: offset, to: offset + node.nodeSize });
    });

    const targetLength = normalizedTarget.length;
    for (let startIndex = 0; startIndex < topLevelBlocks.length; startIndex++) {
        const from = topLevelBlocks[startIndex].from;
        for (let endIndex = startIndex; endIndex < topLevelBlocks.length; endIndex++) {
            const to = topLevelBlocks[endIndex].to;
            const normalizedCandidate = normalizeBulkFixRangeMatchText(editor.state.doc.textBetween(from, to, ' '));
            if (!normalizedCandidate) continue;
            if (normalizedCandidate === normalizedTarget) {
                candidates.push({ from, to, score: 5 });
                break;
            }
            if (normalizedCandidate.length > targetLength * 1.2 && endIndex > startIndex) break;
        }
    }

    return candidates.sort((a, b) => Math.abs(a.from - preferredFrom) - Math.abs(b.from - preferredFrom))[0] || null;
};

const getBulkFixContextScore = (
    source?: BulkFixTargetFingerprint,
    candidate?: BulkFixTargetFingerprint
): { score: number; count: number } => {
    if (!source || !candidate) return { score: 0, count: 0 };
    const scores: number[] = [];

    if (source.previousText && candidate.previousText) {
        scores.push(getBulkFixTextSimilarity(source.previousText, candidate.previousText));
    }
    if (source.nextText && candidate.nextText) {
        scores.push(getBulkFixTextSimilarity(source.nextText, candidate.nextText));
    }
    if (source.sectionHeading && candidate.sectionHeading) {
        scores.push(getBulkFixTextSimilarity(source.sectionHeading, candidate.sectionHeading));
    }

    return {
        score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
        count: scores.length,
    };
};

const getBulkFixIndexScore = (source?: BulkFixTargetFingerprint, candidate?: BulkFixTargetFingerprint): number => {
    if (
        typeof source?.firstBlockIndex !== 'number' ||
        typeof candidate?.firstBlockIndex !== 'number'
    ) {
        return 0;
    }

    return Math.max(0, 1 - Math.min(Math.abs(source.firstBlockIndex - candidate.firstBlockIndex), 8) / 8);
};

const getBulkFixTypeScore = (source?: BulkFixTargetFingerprint, candidate?: BulkFixTargetFingerprint): number => {
    if (!source || !candidate) return 0;
    const firstMatches = source.firstBlockType && candidate.firstBlockType && source.firstBlockType === candidate.firstBlockType;
    const lastMatches = source.lastBlockType && candidate.lastBlockType && source.lastBlockType === candidate.lastBlockType;
    if (firstMatches && lastMatches) return 1;
    if (firstMatches || lastMatches) return 0.65;
    return 0;
};

const findFuzzyBulkFixTextUnitMatch = (
    editor: any,
    targetText: string,
    preferredFrom: number,
    fingerprint?: BulkFixTargetFingerprint
): TextBlockMatch | null => {
    if (!editor?.state?.doc || !targetText.trim() || !fingerprint) return null;

    const candidates: (TextBlockMatch & { confidence: number })[] = [];
    const addCandidate = (from: number, to: number, unitType?: BulkFixTargetFingerprint['unitType']) => {
        const docSize = editor.state.doc.content.size;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > docSize || from >= to) return;
        const text = editor.state.doc.textBetween(from, to, ' ');
        if (!text.trim()) return;
        const candidateFingerprint = getBulkFixRangeFingerprint(editor, from, to, unitType, text);
        const textScore = Math.max(
            getBulkFixTextSimilarity(targetText, text),
            fingerprint.originalStart ? getBulkFixTextSimilarity(fingerprint.originalStart, text) * 0.92 : 0,
            fingerprint.originalEnd ? getBulkFixTextSimilarity(fingerprint.originalEnd, text) * 0.92 : 0
        );
        const context = getBulkFixContextScore(fingerprint, candidateFingerprint);
        const typeScore = getBulkFixTypeScore(fingerprint, candidateFingerprint);
        const indexScore = getBulkFixIndexScore(fingerprint, candidateFingerprint);
        const distanceScore = Math.max(0, 1 - Math.min(Math.abs(from - preferredFrom), 2400) / 2400);
        const confidence = (
            textScore * 0.48 +
            context.score * 0.28 +
            typeScore * 0.08 +
            indexScore * 0.10 +
            distanceScore * 0.06
        );
        const hasStrongTextMatch = textScore >= 0.55 && confidence >= 0.56;
        const hasBalancedMatch = textScore >= 0.24 && context.score >= 0.45 && confidence >= 0.60;
        const hasStrongContextMatch = context.count >= 2 && context.score >= 0.78 && typeScore >= 0.65 && indexScore >= 0.45 && confidence >= 0.52;

        if (!hasStrongTextMatch && !hasBalancedMatch && !hasStrongContextMatch) return;
        candidates.push({ from, to, score: confidence, confidence, text });
    };

    if (fingerprint.unitType === 'section' && (fingerprint.blockCount || 0) > 1) {
        const blocks = getBulkFixTopLevelBlocks(editor).filter(block => block.text.trim().length > 0);
        const baseCount = Math.max(1, fingerprint.blockCount || 1);
        const minCount = Math.max(1, baseCount - 2);
        const maxCount = Math.min(Math.max(baseCount + 2, minCount), 12);
        for (let startIndex = 0; startIndex < blocks.length; startIndex += 1) {
            for (let count = minCount; count <= maxCount; count += 1) {
                const endIndex = startIndex + count - 1;
                if (!blocks[endIndex]) continue;
                addCandidate(blocks[startIndex].from, blocks[endIndex].to, 'section');
            }
        }
    } else {
        editor.state.doc.descendants((node: any, pos: number) => {
            if (!node.isBlock || !['paragraph', 'heading', 'listItem'].includes(node.type.name)) return true;
            if (!node.textContent?.trim()) return true;
            addCandidate(
                pos,
                pos + node.nodeSize,
                node.type.name === 'heading' ? 'heading' : node.type.name === 'paragraph' ? 'paragraph' : 'block'
            );
            return true;
        });
    }

    const sorted = candidates.sort((a, b) => b.confidence - a.confidence || Math.abs(a.from - preferredFrom) - Math.abs(b.from - preferredFrom));
    const best = sorted[0];
    const second = sorted[1];
    if (!best) return null;
    if (second && best.confidence < 0.78 && best.confidence - second.confidence < 0.08) return null;

    return best;
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

const findNearestPrecedingHeading = (editor: any, targetPos: number, levelFilter?: number): HeadingMatch | null => {
    let heading: HeadingMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (pos >= targetPos) return false;
        if (node.type.name === 'heading') {
            const level = node.attrs.level || 2;
            if (levelFilter && level !== levelFilter) return true;
            heading = {
                pos,
                to: pos + node.nodeSize,
                level,
                text: node.textContent,
                score: 1,
            };
        }
        return true;
    });

    return heading;
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

const findConclusionAttachmentHeading = (editor: any): HeadingMatch | null => {
    if (!editor) return null;
    let lastH2Match: HeadingMatch | null = null;
    let lastAnyMatch: HeadingMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name !== 'heading') return true;

        const heading = normalizeAnchorText(node.textContent);
        const found = CONCLUSION_HEADING_KEYWORDS.some(keyword => {
            const normalizedKeyword = normalizeAnchorText(keyword);
            return normalizedKeyword && heading.includes(normalizedKeyword);
        });
        if (!found) return true;

        const match = {
            pos,
            to: pos + node.nodeSize,
            level: node.attrs.level || 2,
            text: node.textContent,
            score: 2,
        };
        lastAnyMatch = match;
        if (match.level === 2) lastH2Match = match;
        return true;
    });

    return lastH2Match || lastAnyMatch;
};

const getCurrentConclusionAttachmentText = (editor: any): string => {
    const conclusionHeading = findConclusionAttachmentHeading(editor);
    if (!editor || !conclusionHeading) return '';

    const sectionEnd = findSectionEnd(editor, conclusionHeading);
    return editor.state.doc.textBetween(conclusionHeading.pos, sectionEnd, '\n', '\n').trim();
};

const getLeadingMarkdownHeadingText = (value: string): string => {
    const firstLine = value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || '';
    const markdownHeading = firstLine.match(/^#{1,6}\s+(.+)$/);
    if (markdownHeading?.[1]) return markdownHeading[1].trim();
    const htmlHeading = firstLine.match(/^<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
    if (htmlHeading?.[1]) return htmlHeading[1].replace(/<[^>]+>/g, '').trim();
    return '';
};

const hasLeadingConclusionHeading = (value: string): boolean => {
    const headingText = normalizeAnchorText(getLeadingMarkdownHeadingText(value));
    if (!headingText) return false;

    return CONCLUSION_HEADING_KEYWORDS.some(keyword => {
        const normalizedKeyword = normalizeAnchorText(keyword);
        return normalizedKeyword && headingText.includes(normalizedKeyword);
    });
};

const isImproveConclusionPatch = (patch: AiContentPatch): boolean => (
    patch.commandId === ENGINEERING_PROMPT_IDS.smartAnalysis.improveConclusion
);

const resolveImproveConclusionPatchTarget = (editor: any, patch: AiContentPatch): PatchTarget | null => {
    if (!isImproveConclusionPatch(patch) || patch.operation === 'delete_block') return null;
    const conclusionHeading = findConclusionAttachmentHeading(editor);
    if (!conclusionHeading) return null;

    const sectionEnd = findSectionEnd(editor, conclusionHeading);
    const replaceWholeSection = isIndependentH2SectionContent(patch.contentMarkdown) || hasLeadingConclusionHeading(patch.contentMarkdown);
    const from = replaceWholeSection ? conclusionHeading.pos : conclusionHeading.to;
    const to = Math.max(from, sectionEnd);

    return {
        from,
        to,
        selectFrom: conclusionHeading.pos,
        selectTo: Math.max(conclusionHeading.to, sectionEnd),
        mode: 'replace',
    };
};

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

const resolveIndependentH2SectionPatchTarget = (
    editor: any,
    patch: AiContentPatch,
    docEnd: number,
): PatchTarget | null => {
    if (!isIndependentH2SectionContent(patch.contentMarkdown)) return null;

    const conclusionHeading = findHeadingByKeywords(editor, CONCLUSION_HEADING_KEYWORDS);

    if (patch.operation === 'insert_before_conclusion') {
        const insertionPos = conclusionHeading?.pos ?? docEnd;
        return {
            from: insertionPos,
            to: insertionPos,
            selectFrom: conclusionHeading?.pos ?? docEnd,
            selectTo: conclusionHeading?.to ?? docEnd,
            mode: 'insert',
        };
    }

    const anchorHeading = patch.anchorText?.trim() ? findHeadingMatch(editor, patch.anchorText) : null;

    if (patch.operation === 'insert_before_heading' && anchorHeading) {
        const insertionHeading = anchorHeading.level <= 2
            ? anchorHeading
            : findNearestPrecedingHeading(editor, anchorHeading.pos, 2) || anchorHeading;
        return {
            from: insertionHeading.pos,
            to: insertionHeading.pos,
            selectFrom: insertionHeading.pos,
            selectTo: insertionHeading.to,
            mode: 'insert',
        };
    }

    if (anchorHeading) {
        const sectionHeading = anchorHeading.level === 2
            ? anchorHeading
            : findNearestPrecedingHeading(editor, anchorHeading.pos, 2) || anchorHeading;
        const sectionEnd = findSectionEnd(editor, sectionHeading);
        return {
            from: sectionEnd,
            to: sectionEnd,
            selectFrom: sectionHeading.pos,
            selectTo: sectionHeading.to,
            mode: 'insert',
        };
    }

    const anchorBlock = findPatchLocationBlockMatch(editor, patch);
    const containingHeading = anchorBlock ? findNearestPrecedingHeading(editor, anchorBlock.from, 2) : null;

    if (containingHeading) {
        const sectionEnd = findSectionEnd(editor, containingHeading);
        return {
            from: sectionEnd,
            to: sectionEnd,
            selectFrom: containingHeading.pos,
            selectTo: containingHeading.to,
            mode: 'insert',
        };
    }

    const fallbackPos = conclusionHeading?.pos ?? docEnd;
    return {
        from: fallbackPos,
        to: fallbackPos,
        selectFrom: conclusionHeading?.pos ?? docEnd,
        selectTo: conclusionHeading?.to ?? docEnd,
        mode: 'insert',
    };
};

type PatchTarget = AiPatchResolvedTarget;

const resolveAiPatchTarget = (editor: any, patch: AiContentPatch): PatchTarget | { error: string } => {
    if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
    const docEnd = editor.state.doc.content.size;
    const improveConclusionTarget = resolveImproveConclusionPatchTarget(editor, patch);

    if (improveConclusionTarget) return improveConclusionTarget;

    const independentH2Target = resolveIndependentH2SectionPatchTarget(editor, patch, docEnd);

    if (independentH2Target) return independentH2Target;

    if (patch.operation === 'replace_block' || patch.operation === 'replace_text' || patch.operation === 'delete_block') {
        const targetText = patch.targetText?.trim() ? patch.targetText : patch.anchorText || '';
        const replaceCandidates = [targetText];
        const ordinalParagraphTarget = findOrdinalParagraphTarget(editor, patch);
        if (ordinalParagraphTarget && (!patch.targetText?.trim() || isOrdinalParagraphLocationText(patch.targetText))) {
            return {
                from: ordinalParagraphTarget.from,
                to: ordinalParagraphTarget.to,
                selectFrom: ordinalParagraphTarget.from,
                selectTo: ordinalParagraphTarget.to,
                mode: 'replace',
            };
        }
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

        if (ordinalParagraphTarget) {
            return {
                from: ordinalParagraphTarget.from,
                to: ordinalParagraphTarget.to,
                selectFrom: ordinalParagraphTarget.from,
                selectTo: ordinalParagraphTarget.to,
                mode: 'replace',
            };
        }

        return { error: `لم يتم العثور على النص المراد ${patch.operation === 'delete_block' ? 'حذفه' : 'استبداله'}: ${patch.targetText || patch.anchorText || patch.title}` };
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

    const ordinalParagraphTarget = findOrdinalParagraphTarget(editor, patch);
    const heading = ordinalParagraphTarget ? null : findHeadingMatch(editor, patch.anchorText || '');
    const anchorBlock = heading
        ? null
        : findPatchLocationBlockMatch(editor, patch) || ordinalParagraphTarget;

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

const isStoredAiPatchTargetUsable = (editor: any, target?: AiPatchResolvedTarget): target is AiPatchResolvedTarget => {
    if (!editor || !target) return false;
    const docEnd = editor.state.doc.content.size;
    const values = [target.from, target.to, target.selectFrom, target.selectTo];
    if (!values.every(value => Number.isFinite(value))) return false;
    if (target.mode !== 'insert' && target.mode !== 'replace') return false;
    if (target.from < 0 || target.to < target.from || target.to > docEnd) return false;
    if (target.selectFrom < 0 || target.selectTo < target.selectFrom || target.selectTo > docEnd) return false;
    return true;
};

const resolveAiPatchTargetForApply = (editor: any, patch: AiContentPatch): PatchTarget | { error: string } => (
    isStoredAiPatchTargetUsable(editor, patch.resolvedTarget)
        ? patch.resolvedTarget
        : resolveAiPatchTarget(editor, patch)
);

const hasAiPatchMergeDeleteTarget = (patch: AiContentPatch): boolean => Boolean(
    patch.mergeDeleteTargetText?.trim() ||
    patch.mergeDeletePlacementLabel?.trim() ||
    patch.mergeDeleteAnchorText?.trim()
);

const buildAiPatchMergeDeleteLocationPatch = (patch: AiContentPatch): AiContentPatch => ({
    ...patch,
    operation: 'replace_block',
    targetText: patch.mergeDeleteTargetText || '',
    anchorText: patch.mergeDeleteAnchorText || patch.mergeDeletePlacementLabel || patch.anchorText || '',
    placementLabel: patch.mergeDeletePlacementLabel || patch.placementLabel || '',
    contentMarkdown: '',
});

const resolveAiPatchMergeDeleteTarget = (editor: any, patch: AiContentPatch): PatchTarget | { error: string } => {
    if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
    if (!hasAiPatchMergeDeleteTarget(patch)) {
        return { error: 'لا توجد فقرة مدمجة محددة للحذف في هذه البطاقة.' };
    }

    const deletePatch = buildAiPatchMergeDeleteLocationPatch(patch);
    const targetText = deletePatch.targetText?.trim() || '';
    const anchorHeading = deletePatch.anchorText?.trim() ? findHeadingMatch(editor, deletePatch.anchorText) : null;

    if (targetText && anchorHeading) {
        const sectionEnd = findSectionEnd(editor, anchorHeading);
        const sectionMatch = findBestTextBlockMatch(editor, [targetText], {
            from: anchorHeading.pos,
            to: sectionEnd,
        });
        if (isConfidentReplacementMatch(sectionMatch, targetText)) {
            return {
                from: sectionMatch.from,
                to: sectionMatch.to,
                selectFrom: sectionMatch.from,
                selectTo: sectionMatch.to,
                mode: 'replace',
            };
        }
    }

    if (targetText) {
        const match = findBestTextBlockMatch(editor, [targetText]);
        if (isConfidentReplacementMatch(match, targetText)) {
            return {
                from: match.from,
                to: match.to,
                selectFrom: match.from,
                selectTo: match.to,
                mode: 'replace',
            };
        }
    }

    const locationMatch = findPatchLocationBlockMatch(editor, deletePatch);
    if (locationMatch) {
        return {
            from: locationMatch.from,
            to: locationMatch.to,
            selectFrom: locationMatch.from,
            selectTo: locationMatch.to,
            mode: 'replace',
        };
    }

    return { error: `لم يتم العثور على الفقرة المدمجة المطلوب حذفها: ${patch.mergeDeleteTargetText || patch.mergeDeletePlacementLabel || patch.mergeDeleteAnchorText || patch.title}` };
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
    stage?: string;
    detail?: string;
    geminiProgress?: GeminiProgressSnapshot | null;
};

interface AIContextType {
    aiResults: Record<AiPatchProvider, string>;
    aiInsertionPatches: Record<AiPatchProvider, AiContentPatch[]>;
    isAiLoading: Record<AiPatchProvider, boolean>;
    quickAiProvider: AiPatchProvider;
    setQuickAiProvider: React.Dispatch<React.SetStateAction<AiPatchProvider>>;
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
    aiRequestProgress: AiRequestProgress | null;
    cancelAiRequest: (progressId: string) => Promise<void>;
    handleAiRequest: (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => Promise<void>;
    handleAnalyzeHeadings: () => Promise<void>;
    handleAiAnalyze: (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta, provider?: GeminiPatchProvider, geminiModel?: string) => Promise<void>;
    handleChatGptAnalyze: (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => Promise<void>;
    handleGeminiReadyCommandsAnalyze: (items: ReadyCommandAnalysisBatchItem[], provider?: GeminiPatchProvider, geminiModel?: string) => Promise<boolean>;
    buildSmartAnalysisPrompt: (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => string;
    importManualChatGptResponse: (rawResponse: string, historyMeta?: ReadyCommandAnalysisHistoryMeta) => void;
    parseAiPatchResponse: (
        rawResponse: string,
        provider: AiPatchProvider,
        options?: { namespace?: string; titlePrefix?: string; commandId?: string }
    ) => SmartAnalysisParsedResult;
    generateSemanticKeywords: () => Promise<{ secondaries: string[]; lsi: string[]; error?: string; cancelled?: boolean }>;
    generateGoalContext: () => Promise<{ context?: GoalContext; error?: string; cancelled?: boolean }>;
    handleAiFix: (rule: CheckResult, item: NonNullable<CheckResult['violatingItems']>[0]) => Promise<void>;
    handleFixAllViolations: (rulesToFix: string[], options?: { includeRelatedRules?: boolean; geminiModel?: string; maxViolationsPerRule?: number }) => Promise<void>;
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
    selectAiContentPatchTarget: (patch: AiContentPatch) => { error?: string; target?: AiPatchResolvedTarget };
    deleteAiPatchMergeDeleteTarget: (patch: AiContentPatch) => { status: 'applied' | 'failed'; error?: string };
    selectAiPatchMergeDeleteTarget: (patch: AiContentPatch) => { error?: string };
    deleteAiInsertionPatchMergeDeleteTarget: (provider: AiPatchProvider, patchId: string) => void;
    selectAiInsertionPatchMergeDeleteTarget: (provider: AiPatchProvider, patchId: string) => void;
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
    const { t, uiLanguage, engineeringPrompts, currentUser, currentView } = useUser();
    const editor = useEditorSelector(context => context.editor);
    const title = useEditorSelector(context => context.title);
    const setTitle = useEditorSelector(context => context.setTitle);
    const text = useEditorSelector(context => context.text);
    const keywords = useEditorSelector(context => context.keywords);
    const setKeywords = useEditorSelector(context => context.setKeywords);
    const analysisResults = useEditorSelector(context => context.analysisResults);
    const goalContext = useEditorSelector(context => context.goalContext);
    const articleLanguage = useEditorSelector(context => context.articleLanguage);
    const articleKey = useEditorSelector(context => context.articleKey);
    const activeArticleId = useEditorSelector(context => context.activeArticleId);
    const { openModal } = useModal();
    
    const [aiResults, setAiResults] = useState<Record<AiPatchProvider, string>>(EMPTY_AI_RESULTS);
    const [aiInsertionPatches, setAiInsertionPatches] = useState<Record<AiPatchProvider, AiContentPatch[]>>(EMPTY_AI_INSERTION_PATCHES);
    const [isAiLoading, setIsAiLoading] = useState<Record<AiPatchProvider, boolean>>({ gemini: false, geminiPaid: false, chatgpt: false });
    const [quickAiProvider, setQuickAiProvider] = useState<AiPatchProvider>('gemini');
    const [isAiCommandLoading, setIsAiCommandLoading] = useState(false);
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [headingsAnalysis, setHeadingsAnalysis] = useState<HeadingAnalysisResult[] | null>(null);
    const [isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized] = useState(false);
    const [aiFixingInfo, setAiFixingInfo] = useState<{ title: string; from: number } | null>(null);
    const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);
    const [aiContextNotice, setAiContextNotice] = useState<{ id: number; flowLabel: string; missingFields: string[] } | null>(null);
    const [aiRequestProgress, setAiRequestProgress] = useState<AiRequestProgress | null>(null);
    const aiResultsRef = useRef<Record<AiPatchProvider, string>>(EMPTY_AI_RESULTS);
    const aiInsertionPatchesRef = useRef<Record<AiPatchProvider, AiContentPatch[]>>(EMPTY_AI_INSERTION_PATCHES);
    const aiHistoryRef = useRef<AIHistoryItem[]>([]);
    const [bulkFixReviewItems, setBulkFixReviewItems] = useState<BulkFixReviewItem[]>([]);
    const bulkFixReviewItemsRef = useRef<BulkFixReviewItem[]>([]);
    const [fixAllProgress, setFixAllProgress] = useState<FixAllProgress>({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    
    const isInitialMount = useRef(true);
    const previousArticleScopeRef = useRef<string>('');
    const previousArticleUserRef = useRef<string | null>(currentUser);

    const getCurrentArticleAiScope = useCallback(() => (
        activeArticleId || getArticleChatStorageScope(articleKey, title)
    ), [activeArticleId, articleKey, title]);

    const getCurrentArticleAiIdentity = useCallback(() => ({
        articleScope: getCurrentArticleAiScope(),
        articleId: activeArticleId || null,
        articleKey: articleKey?.trim() || undefined,
    }), [activeArticleId, articleKey, getCurrentArticleAiScope]);

    const buildApiUsageContext = useCallback((source: string, extra: AiApiUsageContext = {}): AiApiUsageContext => ({
        source,
        articleId: activeArticleId || undefined,
        articleTitle: title.trim() || undefined,
        articleKey: articleKey?.trim() || undefined,
        ...extra,
    }), [activeArticleId, articleKey, title]);

    const trackGeminiProgress = useCallback((
        usageContext: AiApiUsageContext,
        extraCallback?: GeminiProgressCallback,
    ): GeminiProgressCallback => (
        progress: GeminiProgressSnapshot
    ) => {
        setAiRequestProgress({
            ...progress,
            source: usageContext.source,
            active: !progress.completed,
        });
        extraCallback?.(progress);
    }, []);

    const cancelAiRequest = useCallback(async (progressId: string) => {
        await cancelGeminiAnalysisEngine(progressId);
        setAiRequestProgress(previous => {
            const previousProgressId = previous?.progressId || previous?.id;
            if (!previous || previousProgressId !== progressId) return previous;
            return {
                ...previous,
                stage: 'cancelled',
                status: 499,
                message: 'تم إيقاف التحليل يدويًا.',
                completed: true,
                active: false,
            };
        });
        setFixAllProgress(previous => {
            const previousProgressId = previous.geminiProgress?.progressId || previous.geminiProgress?.id;
            if (previousProgressId !== progressId) return previous;
            return {
                ...previous,
                stage: 'cancelled',
                detail: 'تم إيقاف التحليل يدويًا.',
                geminiProgress: {
                    ...previous.geminiProgress,
                    stage: 'cancelled',
                    status: 499,
                    message: 'تم إيقاف التحليل يدويًا.',
                    completed: true,
                },
            };
        });
    }, []);

    const stopAiRequestIfArticleContextMissing = useCallback((flowLabel: string): boolean => {
        const missingFields = getMissingRequiredArticleAiFields(title, keywords, goalContext);
        if (missingFields.length === 0) return false;

        setAiContextNotice({
            id: Date.now(),
            flowLabel,
            missingFields,
        });
        return true;
    }, [goalContext, keywords, title]);

    useEffect(() => {
        if (!aiContextNotice) return undefined;
        const timeoutId = window.setTimeout(() => {
            setAiContextNotice(current => current?.id === aiContextNotice.id ? null : current);
        }, AI_CONTEXT_NOTICE_TIMEOUT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [aiContextNotice]);

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
        aiResultsRef.current = aiResults;
    }, [aiResults]);

    useEffect(() => {
        aiInsertionPatchesRef.current = aiInsertionPatches;
    }, [aiInsertionPatches]);

    useEffect(() => {
        aiHistoryRef.current = aiHistory;
    }, [aiHistory]);

    const clearArticleAiRuntimeState = useCallback(() => {
        setAiResults({ ...EMPTY_AI_RESULTS });
        setAiHistory([]);
        replaceBulkFixReviewItems([]);
        setAiInsertionPatches({ ...EMPTY_AI_INSERTION_PATCHES });
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
        setSuggestion(null);
        setHeadingsAnalysis(null);
        setIsHeadingsAnalysisMinimized(false);
    }, [replaceBulkFixReviewItems]);

    const restoreArticleAiRuntimeState = useCallback((runtime: StoredArticleAiRuntime | null) => {
        setAiResults(runtime?.aiResults || { ...EMPTY_AI_RESULTS });
        setAiHistory(runtime?.aiHistory || []);
        replaceBulkFixReviewItems(runtime?.bulkFixReviewItems || []);
        setAiInsertionPatches(runtime?.aiInsertionPatches || { ...EMPTY_AI_INSERTION_PATCHES });
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
        setSuggestion(null);
        setHeadingsAnalysis(null);
        setIsHeadingsAnalysisMinimized(false);
    }, [replaceBulkFixReviewItems]);

    useEffect(() => {
        const currentScope = currentView === 'editor'
            ? getCurrentArticleAiScope()
            : '';
        const previousScope = previousArticleScopeRef.current;
        const previousUser = previousArticleUserRef.current;
        const scopeChanged = previousScope && previousScope !== currentScope;
        const editorClosed = currentView !== 'editor' && previousScope;

        if (scopeChanged || editorClosed) {
            saveStoredArticleAiRuntime(previousUser, previousScope, {
                aiResults: aiResultsRef.current,
                aiHistory: aiHistoryRef.current,
                bulkFixReviewItems: bulkFixReviewItemsRef.current,
                aiInsertionPatches: aiInsertionPatchesRef.current,
            });
        }

        if (currentScope && (scopeChanged || isInitialMount.current)) {
            restoreArticleAiRuntimeState(readStoredArticleAiRuntime(currentUser, currentScope));
        }

        if (isInitialMount.current) {
            isInitialMount.current = false;
        }

        previousArticleScopeRef.current = currentScope;
        previousArticleUserRef.current = currentUser;
    }, [currentView, currentUser, getCurrentArticleAiScope, restoreArticleAiRuntimeState]);

    useEffect(() => {
        if (currentView !== 'editor') return;
        const currentScope = getCurrentArticleAiScope();
        if (!currentScope.trim()) return;

        const timeoutId = window.setTimeout(() => {
            saveStoredArticleAiRuntime(currentUser, currentScope, {
                aiResults: aiResultsRef.current,
                aiHistory: aiHistoryRef.current,
                bulkFixReviewItems: bulkFixReviewItemsRef.current,
                aiInsertionPatches: aiInsertionPatchesRef.current,
            });
        }, 400);

        return () => window.clearTimeout(timeoutId);
    }, [aiHistory, aiInsertionPatches, aiResults, bulkFixReviewItems, currentUser, currentView, getCurrentArticleAiScope]);

    useEffect(() => {
        const clearCurrentArticleAi = (event: Event) => {
            const requestedArticleId = (event as CustomEvent<{ articleId?: string }>).detail?.articleId;
            if (requestedArticleId && activeArticleId && requestedArticleId !== activeArticleId) return;

            const currentScope = currentView === 'editor'
                ? getArticleChatStorageScope(articleKey, title)
                : previousArticleScopeRef.current;
            clearStoredArticleAiConversations(currentUser, currentScope || '');
            removeStoredArticleAiRuntime(currentUser, activeArticleId || currentScope || '');
            clearArticleAiRuntimeState();
        };

        window.addEventListener(ARTICLE_AI_CLEAR_REQUEST_EVENT, clearCurrentArticleAi);
        return () => window.removeEventListener(ARTICLE_AI_CLEAR_REQUEST_EVENT, clearCurrentArticleAi);
    }, [activeArticleId, articleKey, title, currentView, currentUser, clearArticleAiRuntimeState]);

    useEffect(() => {
        const restoreSavedAiResults = (event: Event) => {
            const detail = (event as CustomEvent<{
                articleId?: string | null;
                aiResults?: Partial<Record<AiPatchProvider, string>>;
            }>).detail;
            if (!detail?.aiResults) return;

            setAiResults(prev => ({
                ...prev,
                gemini: prev.gemini || detail.aiResults?.gemini || '',
                geminiPaid: prev.geminiPaid || detail.aiResults?.geminiPaid || '',
                chatgpt: prev.chatgpt || detail.aiResults?.chatgpt || '',
            }));
        };

        window.addEventListener(ARTICLE_AI_RESULTS_RESTORE_EVENT, restoreSavedAiResults);
        return () => window.removeEventListener(ARTICLE_AI_RESULTS_RESTORE_EVENT, restoreSavedAiResults);
    }, []);

    useEffect(() => {
        bulkFixReviewItemsRef.current = bulkFixReviewItems;
    }, [bulkFixReviewItems]);

    const logToAiHistory = useCallback((item: Omit<AIHistoryItem, 'id'>) => {
        const newItem: AIHistoryItem = { ...getCurrentArticleAiIdentity(), ...item, id: `${Date.now()}-${Math.random()}` };
        setAiHistory(prev => [newItem, ...prev]);
        return newItem.id;
    }, [getCurrentArticleAiIdentity]);

    const normalizeRangeText = useCallback((value: string) => value.replace(/\s+/g, ' ').trim(), []);

    const getSafeRangeText = useCallback((from: number, to: number): string | null => {
        if (!editor) return null;
        const docSize = editor.state.doc.content.size;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > docSize || from >= to) {
            return null;
        }
        return editor.state.doc.textBetween(from, to, ' ');
    }, [editor]);

    const resolveBulkFixReviewRange = useCallback((item: Pick<BulkFixReviewItem, 'from' | 'to' | 'originalText' | 'targetFingerprint'>): { from: number; to: number; currentText: string } | null => {
        const currentText = getSafeRangeText(item.from, item.to);
        if (currentText !== null && normalizeRangeText(currentText) === normalizeRangeText(item.originalText)) {
            return { from: item.from, to: item.to, currentText };
        }

        const exactMatch = findExactBulkFixTextUnitMatch(editor, item.originalText, item.from);
        if (exactMatch) {
            const matchedText = getSafeRangeText(exactMatch.from, exactMatch.to);
            if (matchedText !== null && normalizeRangeText(matchedText) === normalizeRangeText(item.originalText)) {
                return { from: exactMatch.from, to: exactMatch.to, currentText: matchedText };
            }
        }

        const fuzzyMatch = findFuzzyBulkFixTextUnitMatch(editor, item.originalText, item.from, item.targetFingerprint);
        if (!fuzzyMatch) return null;

        const fuzzyText = getSafeRangeText(fuzzyMatch.from, fuzzyMatch.to);
        if (fuzzyText === null) return null;
        return { from: fuzzyMatch.from, to: fuzzyMatch.to, currentText: fuzzyText };
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
        contextParts.push(`**لغة المقال:** ${getArticleLanguageLabel(articleLanguage)}`);
        contextParts.push(buildAiOutputLanguageInstruction(articleLanguage));
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
        return `${professionalRoleAndGoal}\n\n${contextParts.join('\n\n')}\n\n${SITE_OWNER_PUBLISHING_VOICE_GUARD}\n\n**المطلوب:**\n${basePrompt}`;
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
        parts.push(`**لغة المقال:** ${getArticleLanguageLabel(articleLanguage)}`);
        parts.push(buildAiOutputLanguageInstruction(articleLanguage));
        if (articleToc) {
            const tocString = generateToc(editor);
            parts.push(`**جدول محتويات المقالة:**\n${tocString || '- لا يوجد جدول محتويات متاح لأن المقال لا يحتوي على عناوين بعد.'}`);
        }
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
        if (currentConclusion) {
            const conclusionText = getCurrentConclusionAttachmentText(editor);
            parts.push(`**الخاتمة الحالية:**\n${conclusionText ? `---\n${conclusionText}\n---` : '- لا توجد خاتمة حالية واضحة في المحرر.'}`);
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

    const generateSemanticKeywords = useCallback(async (): Promise<{ secondaries: string[]; lsi: string[]; error?: string; cancelled?: boolean }> => {
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
            '- اجعل كل عناصر secondaries وlsi بلغة المقال فقط؛ إذا كانت لغة المقال الإنجليزية فاكتب القوائم بالإنجليزية.',
            '- لا تعتبر اسم الشركة صيغة بديلة أو كلمة LSI، ولا تضع اسم الشركة أو جزءًا منه في أي قائمة.',
            '- لا تكرر الكلمة المفتاحية الأساسية نفسها ضمن الصيغ البديلة.',
            '- لا تعتبر الكلمة المفتاحية الأساسية أو أي صيغة بديلة أو جزءًا منهما كلمة LSI.',
            '- ممنوع أن تتضمن كلمات LSI اسم الشركة أو جزءًا من الكلمة المفتاحية الأساسية أو جزءًا من الصيغ البديلة.',
            '- يجب أن تكون كلمات LSI مفاهيم وكيانات وسياقات دلالية مفيدة، وليست كلمات عامة أو جملًا عامة بلا معنى.',
            '- أخرج 4 إلى 6 صيغ بديلة قصيرة.',
            '- أخرج 10 إلى 16 كلمة أو عبارة LSI.',
            '',
            'أرجع JSON فقط بهذا الشكل دون Markdown ودون شرح:',
            '{ "secondaries": ["صيغة بديلة 1", "صيغة بديلة 2"], "lsi": ["كلمة LSI 1", "كلمة LSI 2"] }',
        ].filter(Boolean).join('\n');

        const usageContext = buildApiUsageContext('semantic_keywords_lsi');
        let result: string;
        try {
            result = await callGeminiAnalysis(
                prompt,
                undefined,
                undefined,
                usageContext,
                trackGeminiProgress(usageContext),
            );
        } catch (error) {
            if (isGeminiAnalysisCancelledError(error)) {
                return { secondaries: [], lsi: [], cancelled: true };
            }
            throw error;
        }
        if (/^حدث خطأ أثناء الاتصال بـ Gemini/.test(result)) {
            return { secondaries: [], lsi: [], error: result };
        }

        const parsed = extractJson(result);
        const normalizeSemanticTerm = (value: string): string => value
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const semanticStopWords = new Set([
            'في', 'من', 'عن', 'على', 'الى', 'إلى', 'مع', 'و', 'أو', 'او', 'ال', 'ل', 'ب', 'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
        ].map(normalizeSemanticTerm));
        const getSemanticTokens = (value: string): string[] => normalizeSemanticTerm(value)
            .split(' ')
            .filter(token => token.length > 2 && !semanticStopWords.has(token));
        const hasProtectedSemanticOverlap = (term: string, protectedTerms: string[]): boolean => {
            const normalizedTerm = normalizeSemanticTerm(term);
            if (!normalizedTerm) return true;

            return protectedTerms.some(protectedTerm => {
                const normalizedProtected = normalizeSemanticTerm(protectedTerm);
                if (!normalizedProtected) return false;
                if (normalizedTerm === normalizedProtected) return true;
                if (normalizedTerm.includes(normalizedProtected) || normalizedProtected.includes(normalizedTerm)) return true;

                const protectedTokens = getSemanticTokens(protectedTerm);
                if (protectedTokens.length === 0) return false;
                return protectedTokens.some(token => normalizedTerm.split(' ').includes(token));
            });
        };
        const isGenericSemanticTerm = (term: string): boolean => {
            const normalizedTerm = normalizeSemanticTerm(term);
            const words = normalizedTerm.split(' ').filter(Boolean);
            const genericTerms = new Set([
                'معلومات', 'نصائح', 'فوائد', 'مميزات', 'خدمات', 'حلول', 'خيارات', 'دليل شامل', 'أفضل خيار', 'تجربة مميزة',
                'information', 'tips', 'benefits', 'features', 'services', 'solutions', 'options', 'complete guide', 'best option',
            ].map(normalizeSemanticTerm));

            return genericTerms.has(normalizedTerm) || (words.length > 4 && !words.some(word => word.length > 5));
        };
        const normalizeTerms = (value: unknown): string[] => {
            if (!Array.isArray(value)) return [];
            const seen = new Set<string>();
            return value
                .map(item => typeof item === 'string' ? item.replace(/[.،,;؛]+$/g, '').trim() : '')
                .filter(Boolean)
                .filter(item => normalizeSemanticTerm(item) !== normalizeSemanticTerm(primary))
                .filter(item => !hasProtectedSemanticOverlap(item, [keywords.company]))
                .filter(item => {
                    const key = normalizeSemanticTerm(item);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        };

        const secondaries = normalizeTerms(parsed?.secondaries).slice(0, 6);
        const lsiProtectedTerms = [primary, keywords.company, ...secondaries].filter(Boolean);
        const lsi = normalizeTerms(parsed?.lsi)
            .filter(item => !hasProtectedSemanticOverlap(item, lsiProtectedTerms))
            .filter(item => !isGenericSemanticTerm(item))
            .slice(0, 16);
        if (secondaries.length === 0 && lsi.length === 0) {
            return { secondaries, lsi, error: 'لم يرجع الذكاء الاصطناعي صيغا قابلة للتوزيع. حاول مرة أخرى.' };
        }

        return { secondaries, lsi };
    }, [articleLanguage, buildApiUsageContext, goalContext, keywords.company, keywords.primary, title, trackGeminiProgress]);

    const generateGoalContext = useCallback(async (): Promise<{ context?: GoalContext; error?: string; cancelled?: boolean }> => {
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
            '- targetCountry: نص حر لاسم المدينة أو الدولة أو الإقليم إذا كان واضحًا من العنوان أو الكلمات، وإلا اتركه فارغًا',
            `- searchIntent: ${GOAL_CONTEXT_ALLOWED_VALUES.searchIntent.join(', ')}`,
            '',
            'قواعد الاستنتاج:',
            '- اختر pageType من نية العنوان والكلمات: category لصفحة تصنيف تضم منتجات أو خدمات ويكتب فيها محتوى داعم، service للخدمات، product للمنتجات، comparison للمقارنات، guide للأدلة، article للمقالات العامة.',
            '- اختر objective بحسب نية المستخدم: category-support عندما يكون المحتوى داعماً لصفحة تصنيف منتجات/خدمات، educate للشرح والتعلّم، compare للمقارنة، convert للحجز/الشراء/التواصل، trust لبناء الثقة، support للدعم والاستخدام.',
            '- اختر searchIntent بحسب ما يوحي به العنوان والكلمات.',
            '- إذا كانت الصفحة تصنيف منتجات أو خدمات والمحتوى هدفه شرح الخيارات أو توجيه المستخدم داخل التصنيف، فغالباً اختر pageType بقيمة category وobjective بقيمة category-support وsearchIntent بقيمة commercial-support.',
            '- اختر audienceScope بحسب وضوح نطاق الاستهداف من العنوان والكلمات، وإذا لم يظهر نطاق واضح فاختر global.',
            '- إذا اخترت local أو country أو regional وكان اسم المدينة أو الدولة أو الإقليم واضحًا، ضعه في targetCountry.',
            '',
            'أرجع JSON فقط دون Markdown ودون شرح بهذا الشكل:',
            '{ "pageType": "service", "objective": "convert", "audienceScope": "global", "targetCountry": "", "searchIntent": "transactional" }',
        ].join('\n');

        const usageContext = buildApiUsageContext('goal_context_generation');
        let result: string;
        try {
            result = await callGeminiAnalysis(
                prompt,
                undefined,
                undefined,
                usageContext,
                trackGeminiProgress(usageContext),
            );
        } catch (error) {
            if (isGeminiAnalysisCancelledError(error)) {
                return { cancelled: true };
            }
            throw error;
        }
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
    }, [articleLanguage, buildApiUsageContext, goalContext, keywords.primary, keywords.secondaries, title, trackGeminiProgress]);

    const generateDraftTitle = useCallback(async (): Promise<string> => {
        const primary = keywords.primary.trim();
        if (!primary) return '';

        const prompt = [
            'أنت خبير SEO ومحرر عناوين.',
            'اكتب عنوانا واحدا فقط مناسبا للمقالة بناء على الكلمة المفتاحية الأساسية وسياق الصفحة وهدفها.',
            '',
            `الكلمة المفتاحية الأساسية: ${primary}`,
            `لغة المقال: ${articleLanguage === 'ar' ? 'العربية' : 'English'}`,
            '',
            'سياق وهدف الصفحة:',
            formatGoalContext(goalContext) || '-',
            '',
            keywords.secondaries.filter(Boolean).length ? `الصيغ البديلة الحالية: ${keywords.secondaries.filter(Boolean).join(', ')}` : '',
            keywords.lsi.filter(Boolean).length ? `كلمات LSI الحالية: ${keywords.lsi.filter(Boolean).join(', ')}` : '',
            '',
            'الشروط:',
            '- اجعل العنوان طبيعيا وغير محشو.',
            '- راع نية البحث ونوع الصفحة وهدفها.',
            '- لا تكتب أكثر من عنوان.',
            '- أرجع JSON فقط دون Markdown.',
            '{ "title": "..." }',
        ].filter(Boolean).join('\n');

        const usageContext = buildApiUsageContext('draft_title_generation');
        let result: string;
        try {
            result = await callGeminiAnalysis(
                prompt,
                undefined,
                undefined,
                usageContext,
                trackGeminiProgress(usageContext),
            );
        } catch (error) {
            if (isGeminiAnalysisCancelledError(error)) return '';
            throw error;
        }
        const parsed = extractJson(result);
        return typeof parsed?.title === 'string' ? parsed.title.trim() : '';
    }, [articleLanguage, buildApiUsageContext, goalContext, keywords.lsi, keywords.primary, keywords.secondaries, trackGeminiProgress]);

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

    const persistGeminiPaidArticleResult = useCallback((result: GeminiAnalysisResult) => {
        if (!activeArticleId || !result.ok || !result.text.trim()) return;
        void saveRemoteArticleAiResult(activeArticleId, {
            provider: 'geminiPaid',
            result: result.text,
            keyFingerprint: result.keyFingerprint,
            keySuffix: result.keySuffix,
            model: result.model || GEMINI_PAID_MODEL,
        }).then(() => {
            window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
        }).catch(error => {
            console.error('Failed to save Gemini Pro result to article metadata:', error);
        });
    }, [activeArticleId]);

    const buildSmartAnalysisPrompt = useCallback((
        userPrompt: string,
        options: any,
        historyMeta?: ReadyCommandAnalysisHistoryMeta
    ): string => (
        buildSmartAnalysisFinalPrompt(
            generateContextAwarePrompt(userPrompt, options),
            { skipPatchInstructions: historyMeta?.skipPatchInstructions },
        )
    ), [generateContextAwarePrompt]);

    const handleGeminiReadyCommandsAnalyze = useCallback(async (
        items: ReadyCommandAnalysisBatchItem[],
        provider: GeminiPatchProvider = 'gemini',
        geminiModel?: string,
    ) => {
        if (!editor || items.length === 0) return false;
        if (stopAiRequestIfArticleContextMissing('الأوامر السريعة')) return false;
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
        setAiResults(prev => ({ ...prev, [provider]: '' }));
        setAiInsertionPatches(prev => ({ ...prev, [provider]: [] }));

        try {
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const results: {
                item: ReadyCommandAnalysisBatchItem;
                parsedResult: SmartAnalysisParsedResult;
            }[] = [];
            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                const finalPrompt = buildSmartAnalysisFinalPrompt(
                    generateContextAwarePrompt(item.userPrompt, item.options),
                    { skipPatchInstructions: item.skipPatchInstructions },
                );
                const usageContext = buildApiUsageContext('ready_commands_batch', {
                    commandId: item.commandId,
                    commandLabel: item.commandLabel,
                    batchIndex: index + 1,
                    batchTotal: items.length,
                });
                const result = await callGeminiArticleChatAnalysis(
                    finalPrompt,
                    currentUser,
                    articleScope,
                    provider,
                    provider === 'geminiPaid' ? persistGeminiPaidArticleResult : undefined,
                    usageContext,
                    provider === 'gemini' ? geminiModel : undefined,
                    trackGeminiProgress(usageContext),
                );
                const parsedResult = item.skipPatchInstructions
                    ? { displayText: result, patches: [] }
                    : namespaceSmartAnalysisPatches(
                        applyReadyCommandPatchRules(parseSmartAnalysisResponse(result, provider), item.commandId),
                        `cmd_${index + 1}`,
                        item.commandLabel
                    );
                logReadyCommandAnalysis(provider, parsedResult, item);
                results.push({
                    item,
                    parsedResult,
                });
            }

            const displayText = results.map((result, index) => (
                `## ${index + 1}. ${result.item.commandLabel}\n\n${result.parsedResult.displayText}`
            )).join('\n\n---\n\n');

            setAiResults(prev => ({ ...prev, [provider]: displayText }));
            setAiInsertionPatches(prev => ({
                ...prev,
                [provider]: results.flatMap(result => result.parsedResult.patches),
            }));
            return true;
        } catch (e) {
            if (isGeminiAnalysisCancelledError(e)) return false;
            setAiResults(prev => ({ ...prev, [provider]: "فشل التحليل المتعدد." }));
            return false;
        } finally {
            setIsAiLoading(prev => ({ ...prev, [provider]: false }));
        }
    }, [editor, generateContextAwarePrompt, logReadyCommandAnalysis, currentUser, articleKey, title, persistGeminiPaidArticleResult, buildApiUsageContext, stopAiRequestIfArticleContextMissing, trackGeminiProgress]);

    const handleAiAnalyze = useCallback(async (
        userPrompt: string,
        options: any,
        historyMeta?: ReadyCommandAnalysisHistoryMeta,
        provider: GeminiPatchProvider = 'gemini',
        geminiModel?: string,
    ) => {
        if (!editor) return;
        if (stopAiRequestIfArticleContextMissing('التحليل الذكي')) return;
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
        setAiResults(prev => ({ ...prev, [provider]: '' }));
        setAiInsertionPatches(prev => ({ ...prev, [provider]: [] }));
        try {
            const finalPrompt = buildSmartAnalysisFinalPrompt(
                generateContextAwarePrompt(userPrompt, options),
                { skipPatchInstructions: historyMeta?.skipPatchInstructions },
            );
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const usageContext = buildApiUsageContext('smart_analysis', {
                commandId: historyMeta?.commandId,
                commandLabel: historyMeta?.commandLabel,
            });
            const result = await callGeminiArticleChatAnalysis(
                finalPrompt,
                currentUser,
                articleScope,
                provider,
                provider === 'geminiPaid' ? persistGeminiPaidArticleResult : undefined,
                usageContext,
                provider === 'gemini' ? geminiModel : undefined,
                trackGeminiProgress(usageContext),
            );
            const parsedResult = historyMeta?.skipPatchInstructions
                ? { displayText: result, patches: [] }
                : applyReadyCommandPatchRules(parseSmartAnalysisResponse(result, provider), historyMeta?.commandId);
            setAiResults(prev => ({ ...prev, [provider]: parsedResult.displayText }));
            setAiInsertionPatches(prev => ({ ...prev, [provider]: parsedResult.patches }));
            logReadyCommandAnalysis(provider, parsedResult, historyMeta);
        } catch (e) {
            if (isGeminiAnalysisCancelledError(e)) return;
            setAiResults(prev => ({ ...prev, [provider]: "فشل التحليل." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, [provider]: false }));
        }
    }, [generateContextAwarePrompt, editor, logReadyCommandAnalysis, currentUser, articleKey, title, persistGeminiPaidArticleResult, buildApiUsageContext, stopAiRequestIfArticleContextMissing, trackGeminiProgress]);

    const handleChatGptAnalyze = useCallback(async (userPrompt: string, options: any, historyMeta?: ReadyCommandAnalysisHistoryMeta) => {
        if (!editor) return;
        if (stopAiRequestIfArticleContextMissing('التحليل الذكي')) return;
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
            const result = await callChatGptAnalysis(finalPrompt, storedConversationId, buildApiUsageContext('smart_analysis', {
                commandId: historyMeta?.commandId,
                commandLabel: historyMeta?.commandLabel,
            }));
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
    }, [generateContextAwarePrompt, editor, logReadyCommandAnalysis, currentUser, articleKey, title, buildApiUsageContext, stopAiRequestIfArticleContextMissing]);

    const importManualChatGptResponse = useCallback((rawResponse: string, historyMeta?: ReadyCommandAnalysisHistoryMeta) => {
        const responseText = rawResponse.trim();
        if (!responseText) return;

        const parsedResult = historyMeta?.skipPatchInstructions
            ? { displayText: responseText, patches: [] }
            : applyReadyCommandPatchRules(parseSmartAnalysisResponse(responseText, 'chatgpt'), historyMeta?.commandId);

        setAiResults(prev => ({ ...prev, chatgpt: parsedResult.displayText }));
        setAiInsertionPatches(prev => ({ ...prev, chatgpt: parsedResult.patches }));
        logReadyCommandAnalysis('chatgpt', parsedResult, historyMeta);
    }, [logReadyCommandAnalysis]);

    const callQuickProviderAnalysis = useCallback(async (
        prompt: string,
        provider: AiPatchProvider = quickAiProvider,
        usageContext: AiApiUsageContext = buildApiUsageContext('quick_provider'),
        geminiModel?: string,
        progressCallback?: GeminiProgressCallback,
    ): Promise<string> => {
        if (provider === 'chatgpt') {
            const articleScope = getArticleChatStorageScope(articleKey, title);
            const storedConversationId = readStoredChatGptConversationId(currentUser, articleScope);
            const result = await callChatGptAnalysis(prompt, storedConversationId, usageContext);
            saveStoredChatGptConversationId(currentUser, articleScope, result.conversationId);
            return result.text;
        }

        const geminiProvider: GeminiPatchProvider = provider === 'geminiPaid' ? 'geminiPaid' : 'gemini';
        const mergedProgressCallback = trackGeminiProgress(usageContext, progressCallback);
        return callGeminiAnalysis(
            prompt,
            geminiProvider === 'geminiPaid'
                ? getGeminiModelForProvider(geminiProvider)
                : geminiModel?.trim() || getGeminiModelForProvider(geminiProvider),
            geminiProvider === 'geminiPaid' ? persistGeminiPaidArticleResult : undefined,
            usageContext,
            mergedProgressCallback,
            geminiProvider,
        );
    }, [articleKey, currentUser, quickAiProvider, title, persistGeminiPaidArticleResult, buildApiUsageContext, trackGeminiProgress]);
    
    const handleAiRequest = useCallback(async (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => {
        const provider = quickAiProvider;
        if (isAiCommandLoading || isAiLoading.gemini || isAiLoading.geminiPaid || isAiLoading.chatgpt || !editor) return;
        if (stopAiRequestIfArticleContextMissing('القائمة العائمة')) return;
        setIsAiCommandLoading(true);
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
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
            const finalPrompt = `${buildComprehensivePrompt(boundedPrompt, localContext?.sectionHeading, { includeArticleTitle: !usesSelectedTextContext, includeArticleToc: !usesSelectedTextContext })}\n\nأرجع النتيجة بتنسيق JSON حصراً وباقتراحين مختلفين بالضبط، حتى إذا طلب نص الأمر اقتراحًا واحدًا. كل عنصر داخل suggestions يجب أن يكون النص المقترح النهائي فقط بلغة المقال دون شرح أو تسمية. الشكل: { "suggestions": ["...", "..."] }`;
            const resultJson = await callQuickProviderAnalysis(finalPrompt, provider, buildApiUsageContext('floating_toolbar', {
                action,
            }));
            if (isAiErrorResponseText(resultJson)) return;
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions
                    .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && !isAiErrorResponseText(s))
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
            if (!isGeminiAnalysisCancelledError(e)) console.error(e);
        } finally {
            setIsAiLoading(prev => ({ ...prev, [provider]: false }));
            setIsAiCommandLoading(false);
        }
    }, [editor, title, text, analysisResults, buildComprehensivePrompt, logToAiHistory, isAiCommandLoading, isAiLoading, quickAiProvider, callQuickProviderAnalysis, buildApiUsageContext, stopAiRequestIfArticleContextMissing]);

    const handleAnalyzeHeadings = useCallback(async () => {
        const provider = quickAiProvider;
        if (isAiLoading.gemini || isAiLoading.geminiPaid || isAiLoading.chatgpt || !editor) return;
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
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
            const prompt = `${buildComprehensivePrompt(promptTemplate)}\n\n${headingsText}\n\nأرجع مصفوفة JSON حصراً. اجعل flaws ملاحظات عربية، واجعل suggestions عناوين مقترحة بلغة المقال فقط: [ { "original": "...", "level": 2, "flaws": [], "suggestions": [] } ]`;
            const resultJson = await callQuickProviderAnalysis(prompt, provider, buildApiUsageContext('heading_analysis'));
            if (isAiErrorResponseText(resultJson)) return;
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
            if (!isGeminiAnalysisCancelledError(e)) console.error(e);
        } finally {
            setIsAiLoading(prev => ({ ...prev, [provider]: false }));
        }
    }, [editor, buildComprehensivePrompt, engineeringPrompts, isAiLoading, quickAiProvider, callQuickProviderAnalysis, buildApiUsageContext]);

    const createBulkFixReviewItemForGroup = useCallback(async (
        group: BulkFixTargetGroup,
        selectedRuleTitles: Set<string>,
        index: number,
        provider: AiPatchProvider = quickAiProvider,
        geminiModel?: string,
        progressCallback?: GeminiProgressCallback,
    ): Promise<BulkFixReviewItem> => {
        if (!editor || !analysisResults.structureAnalysis) {
            throw new Error('Editor or analysis data is not ready.');
        }

        const targetText = getSafeRangeText(group.from, group.to);
        if (targetText === null) {
            throw new Error('Target range is no longer valid.');
        }

        const targetFingerprint = getBulkFixRangeFingerprint(editor, group.from, group.to, group.unitType, targetText);
        const targetContext = getBulkFixTargetContext(editor, group, title);
        const protectionRules = getBulkFixProtectionRules(analysisResults.structureAnalysis, group, selectedRuleTitles, targetContext);
        const articleLevelRules = getBulkFixArticleLevelRules(analysisResults.structureAnalysis, selectedRuleTitles);
        const prompt = buildComprehensivePrompt(
            formatBulkFixGroupPrompt(group, targetText, selectedRuleTitles, protectionRules, targetContext, articleLevelRules),
            targetContext.sectionHeading,
            { includeArticleTitle: false, includeArticleToc: false }
        );
        const res = await callQuickProviderAnalysis(prompt, provider, buildApiUsageContext('bulk_fix_review', {
            rules: Array.from(selectedRuleTitles),
        }), provider === 'gemini' ? geminiModel : undefined, progressCallback);
        if (isAiErrorResponseText(res)) {
            throw new Error(res);
        }
        const parsed = extractJson(res);
        const uniqueRules = getUniqueBulkFixRules(group.violations);
        const targetRules = uniqueRules.filter(itemRule => selectedRuleTitles.has(itemRule.title));
        const fallbackTargetRules = targetRules.length > 0 ? targetRules : uniqueRules.slice(0, 1);
        const criteriaRuleEntries = [
            ...fallbackTargetRules.map(itemRule => ({ rule: itemRule, source: 'target' as const })),
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
        if (!primaryVariant) {
            throw new Error('AI did not return usable suggestions.');
        }
        const finalRange = resolveBulkFixReviewRange({ from: group.from, to: group.to, originalText: targetText, targetFingerprint });
        if (!finalRange) {
            throw new Error('النص الأصلي تغير أثناء إنشاء الاقتراح. أعد إنشاء قائمة الإصلاحات بعد انتهاء التعديل.');
        }
        const finalFingerprint = getBulkFixRangeFingerprint(editor, finalRange.from, finalRange.to, group.unitType, finalRange.currentText);

        const ruleTitles = fallbackTargetRules.map(rule => rule.title);
        return {
            id: `bulk-fix-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
            ...getCurrentArticleAiIdentity(),
            ruleTitle: ruleTitles.length > 1 ? `${ruleTitles.length} معايير: ${ruleTitles.join('، ')}` : ruleTitles[0],
            ruleTitles,
            criteria,
            originalText: finalRange.currentText,
            targetFingerprint: finalFingerprint || targetFingerprint,
            fixedText: primaryVariant.fixedText,
            variants,
            from: finalRange.from,
            to: finalRange.to,
            message: group.violations
                .map(violation => `${violation.rule.title}: ${violation.item.message}`)
                .filter(Boolean)
                .join(' | '),
            status: 'pending',
        };
    }, [editor, analysisResults.structureAnalysis, getSafeRangeText, title, buildComprehensivePrompt, resolveBulkFixReviewRange, quickAiProvider, callQuickProviderAnalysis, buildApiUsageContext, getCurrentArticleAiIdentity]);

    const handleAiFix = useCallback(async (rule: CheckResult, item: any) => {
        if (!editor || !analysisResults.structureAnalysis) return;
        if (stopAiRequestIfArticleContextMissing('الإصلاح المتعدد')) return;
        const provider = quickAiProvider;
        setAiFixingInfo({ title: rule.title, from: item.from });
        replaceBulkFixReviewItems([]);
        setFixAllProgress({
            current: 0,
            total: 1,
            running: true,
            failed: 0,
            errors: [],
            stage: 'preparing',
            detail: 'تحضير طلب الإصلاح...',
            geminiProgress: null,
        });
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
        try {
            const groups = groupBulkFixViolationsByTextUnit(editor, [{ rule, item }]);
            const group = groups[0];
            if (!group) {
                throw new Error('Could not identify the violating text unit.');
            }

            setFixAllProgress(p => ({ ...p, current: 1, stage: 'requesting', detail: 'إرسال النص إلى Gemini لإنشاء اقتراح الإصلاح...' }));
            const proposedItem = await createBulkFixReviewItemForGroup(
                group,
                new Set([rule.title]),
                0,
                provider,
                undefined,
                progress => setFixAllProgress(p => ({
                    ...p,
                    stage: progress.stage || p.stage,
                    detail: progress.message || p.detail,
                    geminiProgress: progress,
                })),
            );
            replaceBulkFixReviewItems([proposedItem]);
            const suggestions = (proposedItem.variants && proposedItem.variants.length > 0
                ? proposedItem.variants.map(variant => variant.fixedText)
                : [proposedItem.fixedText]
            ).filter(Boolean);
            const historyItemId = logToAiHistory({
                type: 'fix-violation',
                ruleTitle: proposedItem.ruleTitle,
                originalText: proposedItem.originalText,
                suggestions,
                from: proposedItem.from,
                to: proposedItem.to,
                bulkFixReviewItem: proposedItem,
            });
            if (suggestions.length > 0) {
                setSuggestion({
                    original: proposedItem.originalText,
                    suggestions,
                    action: 'replace-text',
                    from: proposedItem.from,
                    to: proposedItem.to,
                    historyItemId,
                });
            }
            setFixAllProgress(p => ({ ...p, running: false, stage: 'done', detail: 'تم إنشاء اقتراح الإصلاح.' }));
        } catch (error) {
            if (isGeminiAnalysisCancelledError(error)) {
                setFixAllProgress(previous => ({
                    ...previous,
                    running: false,
                    stage: 'cancelled',
                    detail: 'تم إيقاف التحليل يدويًا.',
                }));
                return;
            }
            const message = error instanceof Error ? error.message : 'Unknown fix error';
            console.error('Single fix proposal failed:', rule.title, error);
            setFixAllProgress({ current: 1, total: 1, running: false, failed: 1, errors: [`${rule.title}: ${message}`], stage: 'failed', detail: message });
        } finally {
            setIsAiLoading(prev => ({ ...prev, [provider]: false }));
            setAiFixingInfo(null);
        }
    }, [editor, analysisResults.structureAnalysis, createBulkFixReviewItemForGroup, logToAiHistory, replaceBulkFixReviewItems, quickAiProvider, stopAiRequestIfArticleContextMissing]);

    const getRelatedBulkFixRules = useCallback((rulesToFix: string[]): BulkFixRelatedRule[] => {
        if (!editor || !analysisResults.structureAnalysis || rulesToFix.length === 0) return [];
        const selectedRuleTitles = new Set(rulesToFix);
        const allViolations = collectBulkFixViolations(analysisResults.structureAnalysis);
        return summarizeRelatedBulkFixRules(editor, allViolations, selectedRuleTitles);
    }, [editor, analysisResults.structureAnalysis]);

    const handleFixAllViolations = useCallback(async (rulesToFix: string[], options: { includeRelatedRules?: boolean; geminiModel?: string; maxViolationsPerRule?: number } = {}) => {
        if (!editor || !analysisResults.structureAnalysis) return;
        if (stopAiRequestIfArticleContextMissing('الإصلاح المتعدد')) return;
        const provider = quickAiProvider;
        const maxViolationsPerRule = Number.isFinite(options.maxViolationsPerRule)
            ? Math.max(1, Math.min(50, Math.floor(options.maxViolationsPerRule || 1)))
            : BULK_FIX_MAX_VIOLATIONS_PER_RULE;
        replaceBulkFixReviewItems([]);
        setFixAllProgress({
            current: 0,
            total: 0,
            running: true,
            failed: 0,
            errors: [],
            stage: 'preparing',
            detail: 'تحضير مجموعات الإصلاح المتعدد...',
            geminiProgress: null,
        });
        setIsAiLoading(prev => ({ ...prev, [provider]: true }));
        const selectedRuleTitles = new Set(rulesToFix);
        const allViolations = collectBulkFixViolations(analysisResults.structureAnalysis);
        const selectedViolations = allViolations.filter(violation => selectedRuleTitles.has(violation.rule.title));
        const relatedViolations = options.includeRelatedRules
            ? getRelatedBulkFixViolations(editor, allViolations, selectedRuleTitles)
            : [];
        const requestViolations = limitBulkFixViolationsPerRule([...selectedViolations, ...relatedViolations], maxViolationsPerRule);
        const groupedViolations = groupBulkFixViolationsByTextUnit(editor, requestViolations);
        const groupedTargets = groupedViolations
            .map(group => {
                const originalText = getSafeRangeText(group.from, group.to);
                return originalText
                    ? {
                        group,
                        originalText,
                        from: group.from,
                        to: group.to,
                        targetFingerprint: getBulkFixRangeFingerprint(editor, group.from, group.to, group.unitType, originalText),
                    }
                    : null;
            })
            .filter((target): target is { group: BulkFixTargetGroup; originalText: string; from: number; to: number; targetFingerprint: BulkFixTargetFingerprint } => Boolean(target));
        setFixAllProgress(p => ({
            ...p,
            total: groupedTargets.length,
            detail: groupedTargets.length > 0
                ? `تم تجهيز ${groupedTargets.length} دفعة إصلاح.`
                : 'لا توجد دفعات قابلة للإرسال.',
        }));

        const proposedItems: BulkFixReviewItem[] = [];
        let wasCancelled = false;
        for (let i = 0; i < groupedTargets.length; i++) {
            const targetSnapshot = groupedTargets[i];
            const originalGroup = targetSnapshot.group;
            setFixAllProgress(p => ({
                ...p,
                current: i + 1,
                stage: 'requesting',
                detail: `إرسال الدفعة ${i + 1} من ${groupedTargets.length} إلى Gemini...`,
                geminiProgress: null,
            }));
            try {
                const resolvedStartRange = resolveBulkFixReviewRange(targetSnapshot);
                if (!resolvedStartRange) {
                    throw new Error('النص الأصلي تغير داخل المحرر أثناء إنشاء الاقتراحات. أعد تشغيل الإصلاح المجمع بعد انتهاء التعديل.');
                }
                const group = { ...originalGroup, from: resolvedStartRange.from, to: resolvedStartRange.to };
                const targetText = resolvedStartRange.currentText;
                const targetFingerprint = getBulkFixRangeFingerprint(editor, group.from, group.to, group.unitType, targetText) || targetSnapshot.targetFingerprint;
                const targetContext = getBulkFixTargetContext(editor, group, title);
                const protectionRules = getBulkFixProtectionRules(analysisResults.structureAnalysis, group, selectedRuleTitles, targetContext);
                const articleLevelRules = getBulkFixArticleLevelRules(analysisResults.structureAnalysis, selectedRuleTitles);
                const prompt = buildComprehensivePrompt(
                    formatBulkFixGroupPrompt(group, targetText, selectedRuleTitles, protectionRules, targetContext, articleLevelRules),
                    targetContext.sectionHeading,
                    { includeArticleTitle: false, includeArticleToc: false }
                );
                const res = await callQuickProviderAnalysis(prompt, provider, buildApiUsageContext('bulk_fix_all', {
                    batchIndex: i + 1,
                    batchTotal: groupedTargets.length,
                    rules: Array.from(selectedRuleTitles),
                }), provider === 'gemini' ? options.geminiModel : undefined, progress => setFixAllProgress(p => ({
                    ...p,
                    stage: progress.stage || p.stage,
                    detail: progress.message || p.detail,
                    geminiProgress: progress,
                })));
                if (isAiErrorResponseText(res)) {
                    throw new Error(res);
                }
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
                    const finalRange = resolveBulkFixReviewRange({ from: resolvedStartRange.from, to: resolvedStartRange.to, originalText: targetText, targetFingerprint });
                    if (!finalRange) {
                        throw new Error('النص الأصلي تغير أثناء إنشاء الاقتراح. أعد تشغيل الإصلاح المجمع بعد انتهاء التعديل.');
                    }
                    const finalFingerprint = getBulkFixRangeFingerprint(editor, finalRange.from, finalRange.to, group.unitType, finalRange.currentText);
                    proposedItems.push({
                        id: `bulk-fix-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
                        ruleTitle: ruleTitles.length > 1 ? `${ruleTitles.length} معايير: ${ruleTitles.join('، ')}` : ruleTitles[0],
                        ruleTitles,
                        criteria,
                        originalText: finalRange.currentText,
                        targetFingerprint: finalFingerprint || targetFingerprint,
                        fixedText: primaryVariant.fixedText,
                        variants,
                        from: finalRange.from,
                        to: finalRange.to,
                        message: group.violations
                            .map(violation => `${violation.rule.title}: ${violation.item.message}`)
                            .filter(Boolean)
                            .join(' | '),
                        status: 'pending',
                    });
                    setFixAllProgress(p => ({
                        ...p,
                        stage: 'received',
                        detail: `تم إنشاء اقتراح الدفعة ${i + 1} من ${groupedTargets.length}.`,
                    }));
                } else {
                    throw new Error('AI did not return usable suggestions.');
                }
            } catch (e) {
                if (isGeminiAnalysisCancelledError(e)) {
                    wasCancelled = true;
                    break;
                }
                const message = e instanceof Error ? e.message : 'Unknown fix error';
                console.error('Fix all proposal failed:', originalGroup.id, e);
                setFixAllProgress(p => ({
                    ...p,
                    failed: p.failed + 1,
                    stage: 'failed',
                    detail: `تعذر إنشاء اقتراح الدفعة ${i + 1}. سيتم الانتقال للدفعة التالية إن وجدت.`,
                    errors: [...p.errors, `${originalGroup.violations.map(violation => violation.rule.title).join(', ')}: ${message}`].slice(-3),
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
        setFixAllProgress(p => ({
            ...p,
            running: false,
            stage: wasCancelled ? 'cancelled' : p.failed > 0 ? 'done-with-errors' : 'done',
            detail: wasCancelled
                ? 'تم إيقاف التحليل يدويًا.'
                : p.failed > 0
                  ? `انتهى الإصلاح المتعدد مع ${p.failed} دفعة متعثرة.`
                  : 'انتهى الإصلاح المتعدد وتم إنشاء الاقتراحات.',
        }));
        setIsAiLoading(prev => ({ ...prev, [provider]: false }));
    }, [editor, analysisResults, buildComprehensivePrompt, getSafeRangeText, logToAiHistory, replaceBulkFixReviewItems, resolveBulkFixReviewRange, quickAiProvider, callQuickProviderAnalysis, buildApiUsageContext, stopAiRequestIfArticleContextMissing]);

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
                : selectLeastViolatingBulkFixVariant(item);
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
                const replacement = getArticleReplacementContent(editor, resolvedRange, fixedText, articleLanguage);
                const applied = editor
                    .chain()
                    .focus()
                    .insertContentAt(replacement.range, replacement.content, { updateSelection: true })
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
    }, [articleLanguage, editor, markBulkFixAppliedAndShiftRanges, resolveBulkFixReviewRange, updateBulkFixReviewItem]);

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

    const updateAiHistoryPatch = useCallback((patchId: string, updates: Partial<AiContentPatch>) => {
        setAiHistory(history => history.map(historyItem => (
            historyItem.analysisPatches?.some(patch => patch.id === patchId)
                ? {
                    ...historyItem,
                    analysisPatches: historyItem.analysisPatches.map(patch => (
                        patch.id === patchId ? { ...patch, ...updates } : patch
                    )),
                }
                : historyItem
        )));
    }, []);

    const selectAiContentPatchTarget = useCallback((patch: AiContentPatch): { error?: string; target?: AiPatchResolvedTarget } => {
        if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
        const target = resolveAiPatchTarget(editor, patch);
        if ('error' in target) {
            return { error: target.error };
        }

        const selection = target.mode === 'insert'
            ? target.from
            : target.selectFrom === target.selectTo
                ? target.from
                : { from: target.selectFrom, to: target.selectTo };

        editor
            .chain()
            .focus()
            .setTextSelection(selection)
            .scrollIntoView()
            .run();

        const resolvedTarget = { ...target };
        const targetUpdates: Partial<AiContentPatch> = {
            resolvedTarget,
            applyError: undefined,
            status: patch.status === 'failed' ? 'pending' : patch.status,
        };
        updateAiInsertionPatch(patch.provider, patch.id, targetUpdates);
        updateAiHistoryPatch(patch.id, targetUpdates);

        return { target: resolvedTarget };
    }, [editor, updateAiHistoryPatch, updateAiInsertionPatch]);

    const selectAiInsertionPatchTarget = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch) return;
        const result = selectAiContentPatchTarget(patch);
        if (result.error) {
            updateAiInsertionPatch(provider, patchId, { status: 'failed', applyError: result.error });
        }
    }, [aiInsertionPatches, selectAiContentPatchTarget, updateAiInsertionPatch]);

    const selectAiPatchMergeDeleteTarget = useCallback((patch: AiContentPatch): { error?: string } => {
        if (!editor) return { error: 'المحرر غير جاهز حالياً.' };
        const target = resolveAiPatchMergeDeleteTarget(editor, patch);
        if ('error' in target) {
            return { error: target.error };
        }

        editor
            .chain()
            .focus()
            .setTextSelection({ from: target.selectFrom, to: target.selectTo })
            .scrollIntoView()
            .run();

        return {};
    }, [editor]);

    const selectAiInsertionPatchMergeDeleteTarget = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch) return;
        const result = selectAiPatchMergeDeleteTarget(patch);
        if (result.error) {
            updateAiInsertionPatch(provider, patchId, { mergeDeleteStatus: 'failed', mergeDeleteApplyError: result.error });
        }
    }, [aiInsertionPatches, selectAiPatchMergeDeleteTarget, updateAiInsertionPatch]);

    const applyAiContentPatch = useCallback((patch: AiContentPatch): { status: 'applied' | 'failed'; error?: string } => {
        if (!editor) return { status: 'failed', error: 'المحرر غير جاهز حالياً.' };
        if (patch.status !== 'pending') return { status: 'failed', error: patch.applyError };
        const target = resolveAiPatchTargetForApply(editor, patch);
        if ('error' in target) {
            return { status: 'failed', error: target.error };
        }

        try {
            if (patch.operation === 'delete_block') {
                const applied = editor
                    .chain()
                    .focus()
                    .deleteRange({ from: target.from, to: target.to })
                    .scrollIntoView()
                    .run();
                if (!applied) throw new Error('تعذر حذف النص من المحرر.');
                return { status: 'applied' };
            }

            const replacement = target.mode === 'replace'
                ? getArticleReplacementContent(editor, { from: target.from, to: target.to }, patch.contentMarkdown, articleLanguage)
                : null;
            const applied = editor
                .chain()
                .focus()
                .insertContentAt(
                    replacement ? replacement.range : target.from,
                    replacement ? replacement.content : parseMarkdownToArticleHtml(patch.contentMarkdown, articleLanguage),
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

    const deleteAiPatchMergeDeleteTarget = useCallback((patch: AiContentPatch): { status: 'applied' | 'failed'; error?: string } => {
        if (!editor) return { status: 'failed', error: 'المحرر غير جاهز حالياً.' };
        if (patch.mergeDeleteStatus === 'applied') return { status: 'failed', error: patch.mergeDeleteApplyError };
        const target = resolveAiPatchMergeDeleteTarget(editor, patch);
        if ('error' in target) {
            return { status: 'failed', error: target.error };
        }

        try {
            const applied = editor
                .chain()
                .focus()
                .deleteRange({ from: target.from, to: target.to })
                .scrollIntoView()
                .run();
            if (!applied) throw new Error('تعذر حذف الفقرة المدمجة من المحرر.');
            return { status: 'applied' };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'تعذر حذف الفقرة المدمجة من المحرر.';
            return { status: 'failed', error: message };
        }
    }, [editor]);

    const applyAiInsertionPatch = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch || patch.status !== 'pending') return;
        const result = applyAiContentPatch(patch);
        updateAiInsertionPatch(provider, patchId, {
            status: result.status,
            applyError: result.status === 'failed' ? result.error : undefined,
        });
    }, [aiInsertionPatches, applyAiContentPatch, updateAiInsertionPatch]);

    const deleteAiInsertionPatchMergeDeleteTarget = useCallback((provider: AiPatchProvider, patchId: string) => {
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch || patch.mergeDeleteStatus === 'applied') return;
        const result = deleteAiPatchMergeDeleteTarget(patch);
        updateAiInsertionPatch(provider, patchId, {
            mergeDeleteStatus: result.status,
            mergeDeleteApplyError: result.status === 'failed' ? result.error : undefined,
        });
    }, [aiInsertionPatches, deleteAiPatchMergeDeleteTarget, updateAiInsertionPatch]);

    const applyAllAiInsertionPatches = useCallback((provider: AiPatchProvider) => {
        aiInsertionPatches[provider]
            .filter(patch => patch.status === 'pending')
            .forEach(patch => applyAiInsertionPatch(provider, patch.id));
    }, [aiInsertionPatches, applyAiInsertionPatch]);

    const markHistorySuggestionApplied = useCallback((id: string, text: string) => {
        setAiHistory(history => history.map(historyItem => (
            historyItem.id === id ? { ...historyItem, appliedSuggestion: text, applyError: undefined } : historyItem
        )));
    }, []);

    const applySuggestionFromHistory = useCallback((id: string, text: string) => {
        if (!editor) return;
        const item = aiHistory.find(historyItem => historyItem.id === id);
        if (!item || item.appliedSuggestion) return;
        const resolvedRange = resolveBulkFixReviewRange(item.bulkFixReviewItem || item);
        if (!resolvedRange) {
            setAiHistory(history => history.map(historyItem => (
                historyItem.id === id
                    ? { ...historyItem, applyError: 'Original text changed. Recreate this suggestion before applying it.' }
                    : historyItem
            )));
            return;
        }
        const replacement = getArticleReplacementContent(editor, resolvedRange, text, articleLanguage);
        editor.chain().focus().insertContentAt(replacement.range, replacement.content).run();
        markHistorySuggestionApplied(id, text);
    }, [aiHistory, articleLanguage, editor, markHistorySuggestionApplied]);

    const openGoogleSearch = useCallback((query: string) => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
    }, []);

    const removeFromAiHistory = useCallback((id: string) => {
        setAiHistory(history => history.filter(item => item.id !== id));
    }, []);

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

    const value = useMemo<AIContextType>(() => ({
        aiResults, aiInsertionPatches, isAiLoading, quickAiProvider, setQuickAiProvider, isAiCommandLoading, aiFixingInfo, suggestion, setSuggestion,
        headingsAnalysis, setHeadingsAnalysis, isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized,
        aiHistory, bulkFixReviewItems, fixAllProgress, aiRequestProgress, cancelAiRequest, handleAiRequest, handleAnalyzeHeadings, handleAiAnalyze,
        buildSmartAnalysisPrompt, importManualChatGptResponse, parseAiPatchResponse, generateSemanticKeywords, generateGoalContext,
        handleChatGptAnalyze, handleGeminiReadyCommandsAnalyze, handleAiFix, handleFixAllViolations, getRelatedBulkFixRules, applyBulkFixReviewItem,
        applySelectedBulkFixReviewItems, selectBulkFixReviewItemTarget, skipBulkFixReviewItem,
        clearBulkFixReviewItems, applySuggestionFromHistory,
        applyAiInsertionPatch, applyAllAiInsertionPatches, selectAiInsertionPatchTarget,
        applyAiContentPatch, selectAiContentPatchTarget,
        deleteAiPatchMergeDeleteTarget, selectAiPatchMergeDeleteTarget,
        deleteAiInsertionPatchMergeDeleteTarget, selectAiInsertionPatchMergeDeleteTarget,
        markHistorySuggestionApplied,
        removeFromAiHistory,
        generateContextAwarePrompt, openGoogleSearch
    }), [
        aiResults,
        aiInsertionPatches,
        isAiLoading,
        quickAiProvider,
        isAiCommandLoading,
        aiFixingInfo,
        suggestion,
        headingsAnalysis,
        isHeadingsAnalysisMinimized,
        aiHistory,
        bulkFixReviewItems,
        fixAllProgress,
        aiRequestProgress,
        cancelAiRequest,
        handleAiRequest,
        handleAnalyzeHeadings,
        handleAiAnalyze,
        buildSmartAnalysisPrompt,
        importManualChatGptResponse,
        parseAiPatchResponse,
        generateSemanticKeywords,
        generateGoalContext,
        handleChatGptAnalyze,
        handleGeminiReadyCommandsAnalyze,
        handleAiFix,
        handleFixAllViolations,
        getRelatedBulkFixRules,
        applyBulkFixReviewItem,
        applySelectedBulkFixReviewItems,
        selectBulkFixReviewItemTarget,
        skipBulkFixReviewItem,
        clearBulkFixReviewItems,
        applySuggestionFromHistory,
        applyAiInsertionPatch,
        applyAllAiInsertionPatches,
        selectAiInsertionPatchTarget,
        applyAiContentPatch,
        selectAiContentPatchTarget,
        deleteAiPatchMergeDeleteTarget,
        selectAiPatchMergeDeleteTarget,
        deleteAiInsertionPatchMergeDeleteTarget,
        selectAiInsertionPatchMergeDeleteTarget,
        markHistorySuggestionApplied,
        removeFromAiHistory,
        generateContextAwarePrompt,
        openGoogleSearch,
    ]);

    return (
        <AIContext.Provider value={value}>
            {children}
            {aiContextNotice && (
                <div
                    role="alert"
                    className="fixed right-4 top-4 z-[10000] w-[min(420px,calc(100vw-2rem))] rounded-lg border border-amber-300 bg-amber-50 p-4 text-right text-sm shadow-xl dark:border-amber-500/40 dark:bg-[#2A2417]"
                    dir="rtl"
                >
                    <div className="font-black text-amber-900 dark:text-amber-100">
                        لا يمكن تشغيل {aiContextNotice.flowLabel} قبل إكمال بيانات المقال الأساسية.
                    </div>
                    <div className="mt-2 leading-6 text-amber-800 dark:text-amber-200">
                        الحقول الناقصة: {aiContextNotice.missingFields.join('، ')}
                    </div>
                    <button
                        type="button"
                        onClick={() => setAiContextNotice(null)}
                        className="mt-3 rounded-md border border-amber-300 px-3 py-1 text-xs font-black text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/10"
                    >
                        إغلاق
                    </button>
                </div>
            )}
        </AIContext.Provider>
    );
};

export const useAISelector = <Selected,>(
  selector: (context: AIContextType) => Selected,
): Selected => useContextSelector(AIContext, context => {
  if (!context) throw new Error("useAISelector must be used within an AIProvider");
  return selector(context);
});
