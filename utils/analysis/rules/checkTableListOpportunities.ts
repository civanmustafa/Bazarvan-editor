import type { CheckResult } from '../../../types';
import { createCheckResult, getNodeSizeFromJSON, getWordCount } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const AR_TABLE_INDICATORS = [
    'مقارنة', 'قارن', 'الفرق بين', 'مقابل', 'مقارنة بين', 'السعر', 'الأسعار', 'تكلفة',
    'التكلفة', 'مواصفات', 'المواصفات', 'خصائص', 'الخصائص', 'مميزات', 'عيوب',
    'إيجابيات', 'سلبيات', 'أنواع', 'باقات', 'خطة', 'خطط', 'الأرخص', 'الأغلى', 'الأفضل',
    'الفروقات', 'الاختلافات', 'يختلف', 'تختلف', 'أفضل من', 'أقل من', 'أكثر من',
    'أعلى من', 'أدنى من', 'أسرع من', 'أبطأ من', 'أقوى من', 'أضعف من', 'أرخص من',
    'أغلى من', 'مزايا', 'نقاط القوة', 'نقاط الضعف', 'بدائل', 'البدائل', 'خيارات',
    'الخيارات', 'فئات', 'الفئات', 'تصنيف', 'ترتيب', 'معايير', 'المعايير', 'رسوم',
    'اشتراك', 'اشتراكات', 'مدة', 'المدة', 'حجم', 'الحجم', 'وزن', 'الوزن', 'سعة',
    'السعة', 'قدرة', 'القدرة', 'نسبة', 'النسبة', 'معدل', 'المعدل', 'عدد', 'العدد',
    'قيمة', 'القيمة',
];

const EN_TABLE_INDICATORS = [
    'comparison', 'compare', 'difference between', 'versus', 'vs', 'price', 'prices', 'cost',
    'specs', 'specifications', 'features', 'pros', 'cons', 'types', 'plans', 'cheapest',
    'most expensive', 'best', 'differences', 'different', 'better than', 'less than',
    'more than', 'higher than', 'lower than', 'faster than', 'slower than', 'stronger than',
    'weaker than', 'alternatives', 'options', 'categories', 'ranking', 'criteria', 'fees',
    'subscription', 'duration', 'size', 'weight', 'capacity', 'power', 'percentage', 'rate',
    'amount', 'value',
];

const AR_LIST_INDICATORS = [
    'خطوات', 'الخطوات', 'أولاً', 'أولا', 'ثانياً', 'ثانيا', 'ثالثاً', 'ثالثا',
    'بعد ذلك', 'ثم', 'نصائح', 'أسباب', 'عوامل', 'شروط', 'متطلبات', 'عناصر',
    'فوائد', 'طرق', 'طريقة', 'تشمل', 'تتضمن', 'تتمثل', 'منها', 'أبرز', 'أهم',
    'مراحل', 'المرحلة', 'إجراءات', 'الإجراءات', 'إرشادات', 'توصيات', 'قواعد',
    'بنود', 'نقاط', 'أمور', 'مهام', 'مسؤوليات', 'استخدامات', 'حالات', 'أمثلة',
    'علامات', 'مؤشرات', 'أخطاء', 'مشاكل', 'حلول', 'مكونات', 'المكونات', 'أنواع',
    'الأنواع', 'احرص', 'تأكد', 'اتبع', 'يجب', 'ينبغي', 'يفضل', 'ابدأ', 'اختر',
    'استخدم', 'تجنب',
];

const EN_LIST_INDICATORS = [
    'steps', 'first', 'second', 'third', 'then', 'next', 'tips', 'reasons', 'factors',
    'requirements', 'items', 'benefits', 'ways', 'methods', 'include', 'includes',
    'including', 'consist of', 'top', 'main', 'stages', 'phase', 'procedures',
    'guidelines', 'recommendations', 'rules', 'points', 'tasks', 'responsibilities',
    'uses', 'cases', 'examples', 'signs', 'indicators', 'mistakes', 'problems',
    'solutions', 'components', 'make sure', 'follow', 'must', 'should', 'prefer',
    'start', 'choose', 'use', 'avoid',
];

const isStructuredNode = (type: string | undefined, kind: 'table' | 'list'): boolean => {
    if (kind === 'table') return type === 'table';
    return type === 'bulletList' || type === 'orderedList';
};

const countIndicators = (text: string, indicators: string[]): number => {
    const lowerText = text.toLowerCase();
    return indicators.reduce((count, indicator) => (
        lowerText.includes(indicator.toLowerCase()) ? count + 1 : count
    ), 0);
};

const countDelimiters = (text: string): number => (text.match(/[،,؛;]/g) || []).length;
const countMatches = (text: string, regex: RegExp): number => (text.match(regex) || []).length;

const hasCurrencyOrUnit = (text: string): boolean => (
    /(?:%|٪|\$|€|£|ريال|ر\.س|ليرة|درهم|دينار|دولار|يورو|جنيه|sar|usd|aed|try|kg|كجم|كيلو|متر|سم|ملم|لتر|مل|واط|watt|ساعة|يوم|شهر|سنة|gb|mb|mah|hz)/iu.test(text)
);

const hasComparisonPattern = (text: string): boolean => (
    /(?:أفضل|أقل|أكثر|أعلى|أدنى|أسرع|أبطأ|أقوى|أضعف|أرخص|أغلى)\s+من|(?:بين|مقارنة\s+(?:ب|مع))\s+\S+|(?:better|less|more|higher|lower|faster|slower|stronger|weaker|cheaper|more expensive)\s+than|(?:between|compared\s+(?:with|to))\s+\S+/iu.test(text)
);

const countSequenceMarkers = (text: string): number => countMatches(
    text,
    /(?:أولاً|أولا|ثانياً|ثانيا|ثالثاً|ثالثا|رابعاً|رابعا|خامساً|خامسا|سادساً|سادسا|سابعاً|سابعا|ثامناً|ثامنا|أخيراً|أخيرا|first|second|third|fourth|fifth|sixth|seventh|eighth|finally|\b\d+[.)-])/giu,
);

const sectionNodesFor = (nodes: AnalysisContext['nodes'], nodeIndex: number) => {
    let startIndex = 0;
    for (let index = nodeIndex; index >= 0; index--) {
        if (nodes[index].type === 'heading' && nodes[index].level === 2) {
            startIndex = index;
            break;
        }
    }

    let endIndex = nodes.length;
    for (let index = nodeIndex + 1; index < nodes.length; index++) {
        if (nodes[index].type === 'heading' && nodes[index].level === 2) {
            endIndex = index;
            break;
        }
    }

    return nodes.slice(startIndex, endIndex);
};

const hasStructuredNodeInSection = (
    nodes: AnalysisContext['nodes'],
    nodeIndex: number,
    kind: 'table' | 'list',
): boolean => sectionNodesFor(nodes, nodeIndex).some(node => isStructuredNode(node.type, kind));

export const checkTableListOpportunities = (context: AnalysisContext): CheckResult => {
    const { nodes, nonEmptyParagraphs, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['جداول وقوائم'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const tableIndicators = articleLanguage === 'ar' ? AR_TABLE_INDICATORS : EN_TABLE_INDICATORS;
    const listIndicators = articleLanguage === 'ar' ? AR_LIST_INDICATORS : EN_LIST_INDICATORS;
    const details = uiLanguage === 'ar'
        ? '• يحذر من الفقرات التي تبدو مناسبة لجدول أو قائمة.\n• يعتمد على مؤشرات مثل المقارنة، الأسعار، المواصفات، الخطوات، الأسباب، الشروط، والتعدادات الطويلة.\n• إذا كان القسم يحتوي بالفعل على جدول أو قائمة مناسبة فلن يظهر التحذير.'
        : '• Warns about paragraphs that appear better as a table or list.\n• Uses signals like comparisons, prices, specifications, steps, reasons, requirements, and long enumerations.\n• If the section already contains a suitable table or list, the warning is skipped.';
    const warnings: { from: number; to: number; message: string }[] = [];

    nonEmptyParagraphs.forEach(paragraph => {
        const nodeIndex = nodes.findIndex(node => node.pos === paragraph.pos);
        if (nodeIndex === -1) return;

        const text = paragraph.text.trim();
        const wordCount = getWordCount(text);
        if (wordCount < 20) return;

        const delimiterCount = countDelimiters(text);
        const tableScore = countIndicators(text, tableIndicators);
        const listScore = countIndicators(text, listIndicators);
        const numberCount = countMatches(text, /\p{N}+/gu);
        const hasNumbers = numberCount > 0;
        const sequenceMarkerCount = countSequenceMarkers(text);
        const hasDenseEnumeration = delimiterCount >= 3 || /[:：]\s*\S+(?:.*[،,؛;]){2,}/u.test(text);
        const hasValueSignals = numberCount >= 2 || hasCurrencyOrUnit(text);
        const hasComparisonSignals = hasComparisonPattern(text);
        const shouldBeTable = (
            (tableScore >= 2) ||
            (tableScore >= 1 && (hasValueSignals || hasDenseEnumeration || hasComparisonSignals || wordCount >= 45)) ||
            (hasComparisonSignals && (hasValueSignals || delimiterCount >= 2 || wordCount >= 45)) ||
            (numberCount >= 3 && (hasCurrencyOrUnit(text) || delimiterCount >= 2))
        );
        const shouldBeList = (
            (listScore >= 2) ||
            (listScore >= 1 && (hasDenseEnumeration || sequenceMarkerCount >= 1 || delimiterCount >= 2 || wordCount >= 45)) ||
            (sequenceMarkerCount >= 2) ||
            (hasDenseEnumeration && delimiterCount >= 2 && wordCount >= 35)
        );

        if (shouldBeTable && !hasStructuredNodeInSection(nodes, nodeIndex, 'table')) {
            warnings.push({
                from: paragraph.pos,
                to: paragraph.pos + getNodeSizeFromJSON(paragraph.node),
                message: t.violationMessages.tableOpportunity,
            });
            return;
        }

        if (shouldBeList && !hasStructuredNodeInSection(nodes, nodeIndex, 'list')) {
            warnings.push({
                from: paragraph.pos,
                to: paragraph.pos + getNodeSizeFromJSON(paragraph.node),
                message: t.violationMessages.listOpportunity,
            });
        }
    });

    if (warnings.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const progress = nonEmptyParagraphs.length > 0
        ? (nonEmptyParagraphs.length - warnings.length) / nonEmptyParagraphs.length
        : 1;
    const result = createCheckResult(title, 'warn', `${warnings.length} ${t.common.warnings}`, requiredText, progress, description, details);
    result.violatingItems = warnings;
    return result;
};
