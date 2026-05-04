
import React, { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
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
    StructureAnalysis,
} from '../types';
import { parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { ENGINEERING_PROMPT_IDS, getEngineeringPrompt, renderEngineeringPrompt } from '../constants/engineeringPrompts';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const OPENAI_MODEL = 'gpt-4.1-mini';
const CHATGPT_TIMEOUT_MS = 180000;

const GOAL_CONTEXT_LABELS: Record<string, string> = {
    pageType: 'نوع الصفحة',
    objective: 'هدف الصفحة',
    audienceScope: 'نطاق الجمهور',
    targetCountry: 'الدولة/السوق المستهدف',
    targetAudience: 'الجمهور المستهدف',
    searchIntent: 'نية البحث',
};

const GOAL_CONTEXT_VALUE_LABELS: Record<string, string> = {
    article: 'مقالة',
    news: 'خبر',
    service: 'صفحة خدمة',
    comparison: 'مقارنة',
    product: 'منتج',
    landing: 'صفحة هبوط',
    guide: 'دليل',
    faq: 'أسئلة وأجوبة',
    educate: 'شرح وتثقيف',
    compare: 'مقارنة ومساعدة على الاختيار',
    convert: 'تحويل مباشر: شراء/حجز/تواصل',
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
    informational: 'فهم وتعلّم',
    commercial: 'مقارنة واختيار',
    transactional: 'تنفيذ إجراء',
    navigational: 'الوصول إلى علامة أو صفحة محددة',
    'support-intent': 'حل مشكلة أو معرفة طريقة الاستخدام',
    'local-intent': 'فهم وتعلّم',
};

const formatGoalContext = (goalContext: GoalContext): string => {
    return Object.entries(goalContext)
        .filter(([, value]) => value.trim().length > 0)
        .map(([key, value]) => `- ${GOAL_CONTEXT_LABELS[key] || key}: ${GOAL_CONTEXT_VALUE_LABELS[value] || value}`)
        .join('\n');
};

type StructureCriteriaAttachment = {
    optionKey: keyof Pick<
        AiAnalysisOptions,
        'basicStructureCriteria' | 'headingsSequenceCriteria' | 'interactionCtaCriteria' | 'conclusionCriteria'
    >;
    labelKey: 'basicStructure' | 'headingsSequence' | 'interactionCta' | 'conclusion';
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

    return `**${sectionTitle} وشروطها وقواعدها:**\n${formattedRules || '- لا توجد معايير متاحة لهذه المجموعة.'}`;
};

const formatBulkFixViolationPrompt = (
    rule: CheckResult,
    item: NonNullable<CheckResult['violatingItems']>[number],
    targetText: string
): string => {
    return [
        'أصلح النص المحدد بناءً على بطاقة المعيار والمخالفة التالية.',
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
        '- لا تضف شرحاً، ولا تسميات مثل "النص المقترح" أو "الإجابة".',
        '- لا تعدّل خارج النص المحدد، ولا تضف معلومات غير موجودة في السياق.',
        '',
        'أرجع JSON حصراً بهذا الشكل:',
        '{ "fixedText": "النص البديل الجاهز فقط" }',
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

const collectBulkFixViolations = (structureAnalysis: StructureAnalysis): BulkFixViolationContext[] => {
    const violations: BulkFixViolationContext[] = [];
    Object.values(structureAnalysis).forEach((rule) => {
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

const formatBulkFixGroupPrompt = (group: BulkFixTargetGroup, targetText: string): string => {
    const uniqueRules = group.violations.reduce<CheckResult[]>((acc, violation) => {
        if (!acc.some(rule => rule.title === violation.rule.title)) acc.push(violation.rule);
        return acc;
    }, []);

    const ruleCards = uniqueRules.map((rule) => {
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
    }).join('\n\n');

    const unitLabel = group.unitType === 'section'
        ? 'قسم كامل'
        : group.unitType === 'heading'
            ? 'عنوان'
            : group.unitType === 'paragraph'
                ? 'فقرة'
                : 'وحدة نصية';

    return [
        `هذه ${unitLabel} واحدة عليها عدة مخالفات مترابطة. المطلوب إنتاج بدائل محسنة تعالج كل المعايير معاً، لا إصلاحاً منفصلاً لكل معيار.`,
        '',
        '**المعايير والمخالفات المرتبطة بهذه الوحدة:**',
        ruleCards,
        '',
        '**النص المراد استبداله كوحدة واحدة:**',
        `"""${targetText}"""`,
        '',
        '**تعليمات مهمة:**',
        '- ارفق في تفكيرك قواعد وشروط كل معيار أعلاه عند صياغة البدائل.',
        '- قدم اقتراحين فقط مختلفين قابلين للتطبيق، وكل اقتراح يجب أن يكون نصاً نهائياً جاهزاً للاستبدال.',
        '- عالج المخالفات المتداخلة معاً: الطول، الجمل، التكرار، الترقيم، الإحالات الغامضة، الكلمات المطلوب حذفها، أو أي معيار مذكور في البطاقة.',
        '- حافظ على المعنى الأصلي وسياق الصفحة ولا تضف معلومات أو ادعاءات جديدة.',
        '- إذا كان النص يحتوي عناوين، فاستخدم Markdown للحفاظ على مستويات العناوين قدر الإمكان.',
        '- لا تكتب تسميات داخل fixedText مثل "النص المقترح" أو "الإجابة".',
        '- يجب أن يكون الرد JSON صالحاً فقط، دون Markdown fences ودون شرح خارج JSON.',
        '- المفتاح suggestions إلزامي، وكل عنصر داخله يجب أن يحتوي fixedText نصياً غير فارغ.',
        '- داخل كل اقتراح أضف criteriaChecks، وفيه تدقيق لكل معيار: الحالة قبل الإصلاح، الحالة بعد التعديل، المطلوب، و status بقيمة pass أو warn أو fail أو unknown.',
        '',
        'أرجع JSON حصراً بهذا الشكل:',
        '{ "suggestions": [ { "label": "اقتراح 1", "fixedText": "...", "criteriaChecks": [ { "criterionTitle": "اسم المعيار", "before": "الحالة قبل الإصلاح", "after": "الحالة بعد التعديل", "required": "المطلوب", "status": "pass" } ] }, { "label": "اقتراح 2", "fixedText": "...", "criteriaChecks": [ { "criterionTitle": "اسم المعيار", "before": "الحالة قبل الإصلاح", "after": "الحالة بعد التعديل", "required": "المطلوب", "status": "pass" } ] } ] }',
    ].filter(Boolean).join('\n');
};

const normalizeCriteriaCheckStatus = (value: unknown): BulkFixCriterionCheck['status'] => {
    const status = asTrimmedString(value).toLowerCase();
    return status === 'pass' || status === 'warn' || status === 'fail' || status === 'unknown' ? status : 'unknown';
};

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
            };
        })
        .filter((check): check is BulkFixCriterionCheck => Boolean(check));

    if (normalized.length > 0) return normalized;

    return criteria.map((criterion) => ({
        criterionTitle: criterion.title,
        before: String(criterion.current),
        after: 'غير متاح',
        required: String(criterion.required),
        status: 'unknown',
    }));
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

const summarizeBulkFixMeasuredState = (textValue: string, criterionText = ''): string => {
    const stats = getBulkFixStats(textValue);
    const paragraphs = splitBulkFixParagraphs(textValue);
    const sentences = splitBulkFixSentences(textValue);
    const paragraphWords = paragraphs.map(countWords);
    const sentenceWords = sentences.map(countWords);
    const suffixParts: string[] = [];
    const haystack = criterionText.toLowerCase();
    if (haystack.includes('طول الجمل') || haystack.includes('sentence length')) {
        const min = sentenceWords.length ? Math.min(...sentenceWords) : 0;
        const max = sentenceWords.length ? Math.max(...sentenceWords) : 0;
        suffixParts.push(`أطوال الجمل ${min}-${max} كلمة`);
    }
    if (haystack.includes('طول الفقرات') || haystack.includes('paragraph length')) {
        const min = paragraphWords.length ? Math.min(...paragraphWords) : 0;
        const max = paragraphWords.length ? Math.max(...paragraphWords) : 0;
        suffixParts.push(`أطوال الفقرات ${min}-${max} كلمة`);
    }
    if (haystack.includes('علامات الترقيم') || haystack.includes('punctuation')) {
        suffixParts.push(/[.!؟?:]\s*$/.test(textValue.trim()) ? 'علامة النهاية موجودة' : 'علامة النهاية غير موجودة');
    }
    return `${stats.words} كلمة، ${stats.sentences} جملة، ${stats.paragraphs} فقرة${suffixParts.length ? `؛ ${suffixParts.join('، ')}` : ''}`;
};

const inferBulkFixCriterionCheck = (
    criterion: BulkFixCriterionSummary,
    originalText: string,
    fixedText: string
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

    if (haystack.includes('طول الجمل') || haystack.includes('sentence length')) {
        const targetRange = wordRange || { min: 6, max: 20 };
        checks.push(isWithinBulkFixRange(sentences.map(countWords), targetRange) === true);
    } else if (haystack.includes('طول الفقرات') || haystack.includes('paragraph length')) {
        checks.push(isWithinBulkFixRange(paragraphs.map(countWords), wordRange || { min: 30, max: 100 }) === true);
        checks.push(isWithinBulkFixRange(paragraphs.map(countSentences), sentenceRange || { min: 1, max: 4 }) === true);
    } else {
        const wordStatus = isWithinBulkFixRange([afterStats.words], wordRange);
        const sentenceStatus = isWithinBulkFixRange([afterStats.sentences], sentenceRange);
        const paragraphStatus = isWithinBulkFixRange([afterStats.paragraphs], paragraphRange);
        [wordStatus, sentenceStatus, paragraphStatus].forEach(status => {
            if (status !== null) checks.push(status);
        });
    }

    if (haystack.includes('علامات الترقيم') || haystack.includes('punctuation')) {
        checks.push(/[.!؟?:]\s*$/.test(fixedText.trim()));
    }

    return {
        criterionTitle: criterion.title,
        before: String(criterion.current),
        after: summarizeBulkFixMeasuredState(fixedText, criterionText),
        required: String(criterion.required),
        status: checks.length === 0 ? 'unknown' : checks.every(Boolean) ? 'pass' : 'fail',
    };
};

const buildBulkFixCriteriaChecks = (
    rawChecks: unknown,
    criteria: BulkFixCriterionSummary[],
    originalText: string,
    fixedText: string
): BulkFixCriterionCheck[] => {
    const aiChecks = normalizeBulkFixCriteriaChecks(rawChecks, criteria);
    if (criteria.length === 0) return aiChecks;
    return criteria.map((criterion) => {
        const inferred = inferBulkFixCriterionCheck(criterion, originalText, fixedText);
        const matchingAiCheck = aiChecks.find(check => (
            check.criterionTitle === criterion.title ||
            check.criterionTitle.includes(criterion.title) ||
            criterion.title.includes(check.criterionTitle)
        ));
        return {
            ...inferred,
            after: inferred.after || matchingAiCheck?.after || 'غير متاح',
            status: inferred.status !== 'unknown' ? inferred.status : matchingAiCheck?.status || 'unknown',
        };
    });
};

const normalizeBulkFixVariants = (raw: unknown, originalText: string, criteria: BulkFixCriterionSummary[]): BulkFixReviewVariant[] => {
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
    return rawSuggestions
        .map((suggestion, index): BulkFixReviewVariant | null => {
            const suggestionRecord = suggestion && typeof suggestion === 'object'
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
                    fixedText
                ),
            };
        })
        .filter((variant): variant is BulkFixReviewVariant => Boolean(variant))
        .slice(0, 2);
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

const callGeminiAnalysis = async (prompt: string, userKeys?: string | string[]): Promise<string> => {
    const trimmedUserKeys = normalizeGeminiKeys(userKeys);

    if (trimmedUserKeys.length > 0) {
        const errors: string[] = [];

        for (const [index, apiKey] of trimmedUserKeys.entries()) {
            try {
                const ai = new GoogleGenAI({ apiKey });
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: prompt,
                });
                return typeof response.text === 'string' ? response.text : '';
            } catch (error) {
                console.error(`Gemini API key #${index + 1} failed:`, error);
                errors.push(getGeminiErrorMessage(error));
            }
        }

        const lastError = errors[errors.length - 1] || 'فشلت كل مفاتيح Gemini.';
        const prefix = trimmedUserKeys.length > 1
            ? `فشلت كل مفاتيح Gemini (${trimmedUserKeys.length}). آخر خطأ: `
            : '';
        return `حدث خطأ أثناء الاتصال بـ Gemini: ${prefix}${lastError}`;
    }

    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const isJson = response.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await response.json().catch(() => ({})) : {};

      if (!response.ok) {
          throw new Error(data.error || `Gemini request failed with status ${response.status}`);
      }

      if (typeof data.text !== 'string') {
          throw new Error('Gemini server route did not return a valid text response.');
      }

      return data.text;
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const errorMessage = getGeminiErrorMessage(error);
      return `حدث خطأ أثناء الاتصال بـ Gemini: ${errorMessage}`;
    }
};

const normalizeChatGptKeys = (keys?: string | string[]): string[] => {
    const keyList = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return keyList.map(key => key.trim()).filter(Boolean);
};

const callChatGptAnalysis = async (prompt: string, userKeys?: string | string[]): Promise<string> => {
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
                apiKeys: trimmedUserKeys.length > 0 ? trimmedUserKeys : undefined,
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

        return data.text;
    } catch (error) {
        window.clearTimeout(timeoutId);
        console.error("Error calling ChatGPT API:", error);
        if (error instanceof Error && error.name === 'AbortError') {
            return "انتهت مهلة الاتصال بـ ChatGPT (180 ثانية). إذا لم يظهر طلب في لوحة OpenAI فهذا يعني أن الخادم المحلي لم يصل إلى OpenAI.";
        }
        const message = error instanceof Error ? error.message : 'خطأ غير معروف';
        return `حدث خطأ أثناء الاتصال بـ ChatGPT: ${message}`;
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
        const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```|({[\s\S]*})/i);
        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            const parsed = tryParse(jsonMatch[1] || jsonMatch[2]);
            if (parsed != null) return parsed;
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed = tryParse(trimmed);
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
                return tryParse(trimmed.slice(start, end + 1));
            }
        }
        return null;
    } catch (e) {
        return null;
    }
};

const SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION = `

تعليمات تنفيذية للمحرر:
أرجع الرد بصيغة JSON فقط دون أي نص خارج JSON. يجب أن يكون محتوى التقرير العربي داخل analysisMarkdown، ويجب أن تكون أي إضافات جاهزة للتطبيق داخل patches.
هذه التعليمات لها أولوية على أي طلب سابق يطلب كتابة النصوص الجاهزة داخل التقرير نفسه.
مهم جداً: لا تكرر أي نص جاهز للإضافة داخل analysisMarkdown وداخل patches في الوقت نفسه.
اجعل analysisMarkdown للتشخيص المختصر، الحكم، الفجوة، سببها، ومكانها فقط.
اجعل patches هي المكان الوحيد الذي يحتوي النصوص الجاهزة للنسخ أو الإدراج داخل المقال.
إذا كان بند في التقرير يحتاج "الحل العملي الجاهز" أو "الإجابة المقترحة" أو "الجملة المقترحة"، فاكتب في analysisMarkdown عبارة قصيرة مثل: النص الجاهز متاح في قسم التعديلات القابلة للتطبيق بعنوان: [عنوان التعديل].
استخدم هذا الشكل حصراً:
{
  "analysisMarkdown": "اكتب هنا التحليل العربي بنفس ترتيب الأمر المطلوب.",
  "patches": [
    {
      "operation": "insert_after_heading",
      "title": "عنوان قصير للتعديل",
      "anchorText": "العنوان أو الفقرة المرجعية داخل المقال",
      "placementLabel": "بعد قسم كذا",
      "contentMarkdown": "النص المقترح الجاهز للإضافة فقط",
      "reason": "سبب مختصر",
      "confidence": 0.85
    }
  ]
}

القيم المسموحة لـ operation:
- insert_after_heading
- insert_before_heading
- append_to_section
- insert_before_faq
- insert_before_conclusion
- append_to_article

اجعل patches تشمل فقط النصوص المقترحة الجاهزة للإضافة أو الاستبدال الجزئي المذكورة في التحليل. لا تضف patches إذا لم يكن هناك نص جاهز قابل للتطبيق داخل المقال. لا تخترع معلومات جديدة.`;

const SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION = `

تعليمات أحدث لبطاقات التنفيذ داخل التقرير:
يجب أن يظهر خيار التنفيذ داخل analysisMarkdown نفسه، وليس في قسم منفصل في آخر التقرير.
لكل نص جاهز قابل للتطبيق، أنشئ patch واحداً فقط، ثم ضع داخل analysisMarkdown علامة مكانها بالضبط بهذا الشكل:
[[PATCH:patch_1]]
[[PATCH:patch_2]]

لكل patch استخدم marker مطابقاً للعلامة، مثل "patch_1". لا تكتب النص الجاهز داخل analysisMarkdown.

إذا كان المطلوب تعديل فقرة موجودة، استخدم operation بقيمة "replace_block"، ويجب أن يكون targetText نسخة حرفية من الفقرة الحالية داخل المقال لا تلخيصاً لها. ضع النص الجديد فقط في contentMarkdown.
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

لا تستخدم عبارة "قسم التعديلات القابلة للتطبيق". استخدم فقط علامة [[PATCH:...]] في موضع التنفيذ داخل التقرير.`;

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
        const found = keywords.some(keyword => heading.includes(normalizeAnchorText(keyword)));
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

const REPLACEABLE_BLOCK_TYPES = new Set(['paragraph', 'listItem']);

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
};

const findTextBlockMatch = (editor: any, targetText: string): TextBlockMatch | null => {
    if (!editor || !targetText.trim()) return null;
    let bestMatch: TextBlockMatch | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
        if (!REPLACEABLE_BLOCK_TYPES.has(node.type.name)) return true;
        const textContent = node.textContent || '';
        if (!textContent.trim()) return true;
        const score = scoreTextBlockMatch(textContent, targetText);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = {
                from: pos,
                to: pos + node.nodeSize,
                score,
            };
        }
        return true;
    });

    return bestMatch;
};

const findBestTextBlockMatch = (editor: any, candidates: string[]): TextBlockMatch | null => {
    let bestMatch: TextBlockMatch | null = null;

    candidates
        .map(candidate => candidate.trim())
        .filter(candidate => candidate.length > 0)
        .forEach(candidate => {
            const match = findTextBlockMatch(editor, candidate);
            if (match && (!bestMatch || match.score > bestMatch.score)) {
                bestMatch = match;
            }
        });

    return bestMatch;
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
        const match = findBestTextBlockMatch(editor, [
            patch.targetText || '',
            patch.anchorText || '',
            patch.contentMarkdown || '',
        ]);
        if (!match) {
            return { error: `لم يتم العثور على النص المراد استبداله: ${patch.targetText || patch.anchorText || patch.title}` };
        }
        return { from: match.from, to: match.to, selectFrom: match.from, selectTo: match.to, mode: 'replace' };
    }

    if (patch.operation === 'append_to_article') {
        return { from: docEnd, to: docEnd, selectFrom: docEnd, selectTo: docEnd, mode: 'insert' };
    }

    if (patch.operation === 'insert_before_faq') {
        const faqHeading = findHeadingByKeywords(editor, ['الأسئلة الشائعة', 'اسئلة شائعة', 'faq']);
        return faqHeading
            ? { from: faqHeading.pos, to: faqHeading.pos, selectFrom: faqHeading.pos, selectTo: faqHeading.to, mode: 'insert' }
            : { from: docEnd, to: docEnd, selectFrom: docEnd, selectTo: docEnd, mode: 'insert' };
    }

    if (patch.operation === 'insert_before_conclusion') {
        const conclusionHeading = findHeadingByKeywords(editor, ['الخاتمة', 'الخلاصة', 'في الختام', 'ختام']);
        return conclusionHeading
            ? { from: conclusionHeading.pos, to: conclusionHeading.pos, selectFrom: conclusionHeading.pos, selectTo: conclusionHeading.to, mode: 'insert' }
            : { from: docEnd, to: docEnd, selectFrom: docEnd, selectTo: docEnd, mode: 'insert' };
    }

    const heading = findHeadingMatch(editor, patch.anchorText || '');
    if (!heading) {
        return { error: `لم يتم العثور على الموضع المرجعي: ${patch.anchorText || patch.placementLabel || patch.title}` };
    }

    if (patch.operation === 'insert_before_heading') {
        return { from: heading.pos, to: heading.pos, selectFrom: heading.pos, selectTo: heading.to, mode: 'insert' };
    }

    if (patch.operation === 'append_to_section') {
        const sectionEnd = findSectionEnd(editor, heading);
        return { from: sectionEnd, to: sectionEnd, selectFrom: heading.pos, selectTo: heading.to, mode: 'insert' };
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
    handleAiAnalyze: (userPrompt: string, options: any) => Promise<void>;
    handleChatGptAnalyze: (userPrompt: string, options: any) => Promise<void>;
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
    const { t, uiLanguage, apiKeys, engineeringPrompts } = useUser();
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
    const [fixAllProgress, setFixAllProgress] = useState<FixAllProgress>({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    
    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setAiHistory([]);
        setBulkFixReviewItems([]);
        setAiInsertionPatches({ gemini: [], chatgpt: [] });
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    }, [articleKey]);

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

    useEffect(() => {
        if (suggestion) openModal('suggestion');
    }, [suggestion, openModal]);
    
    useEffect(() => {
        if (headingsAnalysis && !isHeadingsAnalysisMinimized) openModal('headingsAnalysis');
    }, [headingsAnalysis, isHeadingsAnalysisMinimized, openModal]);

    const buildComprehensivePrompt = (basePrompt: string, sectionHeading?: string) => {
        const professionalRoleAndGoal = `أنت كاتب محتوى خبير في موضوع "${keywords.primary || 'المحتوى العام'}". هدفك إنتاج محتوى متوافق مع SEO و AEO و GEO.`;
        let contextParts: string[] = [];
        if (title.trim()) contextParts.push(`**عنوان المقال الحالي:** ${title.trim()}`);
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
        if (sectionHeading) contextParts.push(`**سياق العنوان:** "${sectionHeading}"`);
        const tocString = generateToc(editor);
        if (tocString) contextParts.push(`**هيكل المقال:**\n${tocString}`);
        return `${professionalRoleAndGoal}\n\n${contextParts.join('\n\n')}\n\n**المطلوب:**\n${basePrompt}`;
    };

    const generateContextAwarePrompt = useCallback((userPrompt: string, options: any) => {
        const {
            manualCommand,
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
        if (title.trim()) {
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
    }, [title, keywords, text, goalContext, articleLanguage, analysisResults, t]);
    
    const handleAiAnalyze = useCallback(async (userPrompt: string, options: any) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        setAiInsertionPatches(prev => ({ ...prev, gemini: [] }));
        try {
            const finalPrompt = `${generateContextAwarePrompt(userPrompt, options)}\n\n${SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION}\n\n${SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION}`;
            const result = await callGeminiAnalysis(finalPrompt, apiKeys.gemini);
            const parsedResult = parseSmartAnalysisResponse(result, 'gemini');
            setAiResults(prev => ({ ...prev, gemini: parsedResult.displayText }));
            setAiInsertionPatches(prev => ({ ...prev, gemini: parsedResult.patches }));
        } catch (e) {
            setAiResults(prev => ({ ...prev, gemini: "فشل التحليل." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.gemini, editor]);

    const handleChatGptAnalyze = useCallback(async (userPrompt: string, options: any) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, chatgpt: true }));
        setAiResults(prev => ({ ...prev, chatgpt: '' }));
        setAiInsertionPatches(prev => ({ ...prev, chatgpt: [] }));
        try {
            const finalPrompt = `${generateContextAwarePrompt(userPrompt, options)}\n\n${SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION}\n\n${SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION}`;
            const result = await callChatGptAnalysis(finalPrompt, apiKeys.chatgpt);
            const parsedResult = parseSmartAnalysisResponse(result, 'chatgpt');
            setAiResults(prev => ({ ...prev, chatgpt: parsedResult.displayText }));
            setAiInsertionPatches(prev => ({ ...prev, chatgpt: parsedResult.patches }));
        } catch (e) {
            setAiResults(prev => ({ ...prev, chatgpt: "فشل تحليل ChatGPT." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, chatgpt: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.chatgpt, editor]);
    
    const handleAiRequest = useCallback(async (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => {
        if (isAiCommandLoading || isAiLoading.gemini || !editor) return;
        setIsAiCommandLoading(true);
        try {
            let textToProcess = "";
            let originalText = "";
            let from, to;
            if (action === 'replace-text') {
                const { from: f, to: t } = editor.state.selection;
                from = f; to = t;
                textToProcess = editor.state.doc.textBetween(f, t, ' ');
                originalText = textToProcess;
            } else {
                textToProcess = text;
                originalText = action === 'replace-title' ? title : 'Meta Description';
            }
            const prompt = renderEngineeringPrompt(promptTemplate, {
                selectedText: textToProcess,
                fullArticleText: textToProcess,
            });
            const finalPrompt = `${buildComprehensivePrompt(prompt)}\n\nأرجع النتيجة بتنسيق JSON حصراً: { "suggestions": ["..."] }`;
            const resultJson = await callGeminiAnalysis(finalPrompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
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
    }, [editor, title, text, buildComprehensivePrompt, apiKeys.gemini, logToAiHistory]);

    const handleAnalyzeHeadings = useCallback(async () => {
        if (isAiLoading.gemini || !editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        try {
            const headings: any[] = [];
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'heading') headings.push({ level: node.attrs.level, text: node.textContent, from: pos, to: pos + node.nodeSize });
            });
            const headingsText = headings.map(h => `[H${h.level}] ${h.text}`).join('\n');
            const promptTemplate = getEngineeringPrompt(engineeringPrompts, ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings);
            const prompt = `${buildComprehensivePrompt(promptTemplate)}\n\n${headingsText}\n\nأرجع مصفوفة JSON حصراً: [ { "original": "...", "level": 2, "flaws": [], "suggestions": [] } ]`;
            const resultJson = await callGeminiAnalysis(prompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (Array.isArray(parsed)) {
                setHeadingsAnalysis(parsed.map((item, idx) => ({ ...item, from: headings[idx]?.from, to: headings[idx]?.to })));
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
            const prompt = `${buildComprehensivePrompt(`أصلح النص التالي لحل مشكلة: ${rule.title}`)}\nالنص: "${originalText}"\nأرجع JSON: { "suggestions": ["..."] }`;
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
        setBulkFixReviewItems([]);
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
                const prompt = buildComprehensivePrompt(formatBulkFixGroupPrompt(group, targetText));
                const res = await callGeminiAnalysis(prompt, apiKeys.gemini);
                const parsed = extractJson(res);
                const uniqueRules = group.violations.reduce<CheckResult[]>((acc, violation) => {
                    if (!acc.some(rule => rule.title === violation.rule.title)) acc.push(violation.rule);
                    return acc;
                }, []);
                const criteria: BulkFixCriterionSummary[] = uniqueRules.map((rule) => ({
                    title: rule.title,
                    current: rule.current,
                    required: rule.required,
                    status: rule.status,
                    message: group.violations
                        .filter(violation => violation.rule.title === rule.title)
                        .map(violation => violation.item.message)
                        .filter(Boolean)
                        .join(' | '),
                }));
                let variants = normalizeBulkFixVariants(parsed, targetText, criteria);
                if (variants.length === 0) {
                    variants = normalizeBulkFixVariants(res, targetText, criteria);
                }
                const primaryVariant = variants[0];
                const ruleTitles = uniqueRules.map(rule => rule.title);
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
        setBulkFixReviewItems(proposedItems);
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
            });
        });
        setFixAllProgress(p => ({ ...p, running: false }));
    }, [editor, analysisResults, buildComprehensivePrompt, apiKeys.gemini, getSafeRangeText, logToAiHistory]);

    const updateBulkFixReviewItem = useCallback((itemId: string, updates: Partial<BulkFixReviewItem>) => {
        setBulkFixReviewItems(items => items.map(item => (
            item.id === itemId ? { ...item, ...updates } : item
        )));
    }, []);

    const markBulkFixAppliedAndShiftRanges = useCallback((appliedItem: BulkFixReviewItem, delta: number, appliedText: string, appliedVariantId?: string) => {
        setBulkFixReviewItems(items => items.map(item => {
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
    }, []);

    const selectBulkFixReviewItemTarget = useCallback((itemId: string) => {
        if (!editor) return;
        const item = bulkFixReviewItems.find(reviewItem => reviewItem.id === itemId);
        if (!item) return;
        const currentText = getSafeRangeText(item.from, item.to);
        if (currentText === null) {
            updateBulkFixReviewItem(itemId, { status: 'failed', applyError: 'تعذر تحديد الموضع لأن نطاق النص لم يعد صالحاً.' });
            return;
        }
        editor.chain().focus().setTextSelection({ from: item.from, to: item.to }).scrollIntoView().run();
    }, [bulkFixReviewItems, editor, getSafeRangeText, updateBulkFixReviewItem]);

    const applySelectedBulkFixReviewItems = useCallback((itemIds: string[], variantSelections: Record<string, string> = {}) => {
        if (!editor) return;
        const selectedIds = new Set(itemIds);
        const itemsToApply = bulkFixReviewItems
            .filter(item => selectedIds.has(item.id) && item.status === 'pending')
            .sort((a, b) => b.from - a.from);

        itemsToApply.forEach(item => {
            const selectedVariantId = variantSelections[item.id];
            const selectedVariant = selectedVariantId
                ? item.variants?.find(variant => variant.id === selectedVariantId)
                : item.variants?.[0];
            const fixedText = selectedVariant?.fixedText || item.fixedText;
            const currentText = getSafeRangeText(item.from, item.to);
            if (currentText === null || normalizeRangeText(currentText) !== normalizeRangeText(item.originalText)) {
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
                    .insertContentAt({ from: item.from, to: item.to }, parseMarkdownToHtml(fixedText), { updateSelection: true })
                    .scrollIntoView()
                    .run();
                if (!applied) {
                    throw new Error('تعذر تطبيق التعديل داخل المحرر.');
                }
                const delta = editor.state.doc.content.size - beforeDocSize;
                markBulkFixAppliedAndShiftRanges(item, delta, fixedText, selectedVariant?.id);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'تعذر تطبيق التعديل داخل المحرر.';
                updateBulkFixReviewItem(item.id, { status: 'failed', applyError: message });
            }
        });
    }, [bulkFixReviewItems, editor, getSafeRangeText, markBulkFixAppliedAndShiftRanges, normalizeRangeText, updateBulkFixReviewItem]);

    const applyBulkFixReviewItem = useCallback((itemId: string, variantId?: string) => {
        applySelectedBulkFixReviewItems([itemId], variantId ? { [itemId]: variantId } : {});
    }, [applySelectedBulkFixReviewItems]);

    const skipBulkFixReviewItem = useCallback((itemId: string) => {
        updateBulkFixReviewItem(itemId, { status: 'skipped', applyError: undefined });
    }, [updateBulkFixReviewItem]);

    const clearBulkFixReviewItems = useCallback(() => {
        setBulkFixReviewItems([]);
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    }, []);

    const updateAiInsertionPatch = useCallback((provider: AiPatchProvider, patchId: string, updates: Partial<AiContentPatch>) => {
        setAiInsertionPatches(prev => ({
            ...prev,
            [provider]: prev[provider].map(patch => (
                patch.id === patchId ? { ...patch, ...updates } : patch
            )),
        }));
    }, []);

    const selectAiInsertionPatchTarget = useCallback((provider: AiPatchProvider, patchId: string) => {
        if (!editor) return;
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch) return;

        const target = resolveAiPatchTarget(editor, patch);
        if ('error' in target) {
            updateAiInsertionPatch(provider, patchId, { status: 'failed', applyError: target.error });
            return;
        }

        editor
            .chain()
            .focus()
            .setTextSelection(target.selectFrom === target.selectTo ? target.from : { from: target.selectFrom, to: target.selectTo })
            .scrollIntoView()
            .run();
    }, [aiInsertionPatches, editor, updateAiInsertionPatch]);

    const applyAiInsertionPatch = useCallback((provider: AiPatchProvider, patchId: string) => {
        if (!editor) return;
        const patch = aiInsertionPatches[provider].find(item => item.id === patchId);
        if (!patch || patch.status !== 'pending') return;

        const target = resolveAiPatchTarget(editor, patch);
        if ('error' in target) {
            updateAiInsertionPatch(provider, patchId, { status: 'failed', applyError: target.error });
            return;
        }

        try {
            editor
                .chain()
                .focus()
                .insertContentAt(
                    target.mode === 'replace' ? { from: target.from, to: target.to } : target.from,
                    parseMarkdownToHtml(patch.contentMarkdown),
                    { updateSelection: true }
                )
                .scrollIntoView()
                .run();
            updateAiInsertionPatch(provider, patchId, { status: 'applied', applyError: undefined });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'تعذر تطبيق التعديل داخل المحرر.';
            updateAiInsertionPatch(provider, patchId, { status: 'failed', applyError: message });
        }
    }, [aiInsertionPatches, editor, updateAiInsertionPatch]);

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
        const currentText = getSafeRangeText(item.from, item.to);
        if (currentText === null || normalizeRangeText(currentText) !== normalizeRangeText(item.originalText)) {
            setAiHistory(history => history.map(historyItem => (
                historyItem.id === id
                    ? { ...historyItem, applyError: 'Original text changed. Recreate this suggestion before applying it.' }
                    : historyItem
            )));
            return;
        }
        editor.chain().focus().insertContentAt({ from: item.from, to: item.to }, parseMarkdownToHtml(text)).run();
        markHistorySuggestionApplied(id, text);
    };

    const openGoogleSearch = (query: string) => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
    };

    const value = {
        aiResults, aiInsertionPatches, isAiLoading, isAiCommandLoading, aiFixingInfo, suggestion, setSuggestion,
        headingsAnalysis, setHeadingsAnalysis, isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized,
        aiHistory, bulkFixReviewItems, fixAllProgress, handleAiRequest, handleAnalyzeHeadings, handleAiAnalyze,
        handleChatGptAnalyze, handleAiFix, handleFixAllViolations, getRelatedBulkFixRules, applyBulkFixReviewItem,
        applySelectedBulkFixReviewItems, selectBulkFixReviewItemTarget, skipBulkFixReviewItem,
        clearBulkFixReviewItems, applySuggestionFromHistory,
        applyAiInsertionPatch, applyAllAiInsertionPatches, selectAiInsertionPatchTarget,
        markHistorySuggestionApplied,
        removeFromAiHistory: (id: string) => setAiHistory(h => h.filter(x => x.id !== id)),
        generateContextAwarePrompt, openGoogleSearch
    };

    return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};
