import type { CheckResult } from '../../../types';
import { createCheckResult, isProductSaleContext, normalizeArabicText } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const createDeviceSaleH2Check = (
    context: AnalysisContext,
    originalTitleKey: string,
    requiredHeadingsForAnalysis: string[],
    minPercentage: number,
): CheckResult => {
    const { headings, t } = context;
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required.replace('{PERCENT}', String(minPercentage * 100));

    if (!isProductSaleContext(context)) {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }
    const h2Texts = headings.filter(h => h.level === 2).map(h => h.text.toLowerCase());
    const foundCount = requiredHeadingsForAnalysis.filter(reqH => h2Texts.some(h2 => h2.includes(reqH.toLowerCase()))).length;
    const percentageFound = requiredHeadingsForAnalysis.length > 0 ? foundCount / requiredHeadingsForAnalysis.length : 1;
    const status = percentageFound >= minPercentage ? 'pass' : 'fail';
    return createCheckResult(title, status, `${foundCount}/${requiredHeadingsForAnalysis.length}`, requiredText, percentageFound, description);
};

const ARABIC_MANDATORY_H2 = ['مميزات', 'استخدام', 'مواصفات', 'سعر', 'ضمان', 'دفع'];
const ARABIC_SUPPORTING_H2 = ['نصائح', 'ملحقات', 'مقارنة', 'عيوب'];
const ENGLISH_MANDATORY_H2 = ['features', 'usage', 'specifications', 'price', 'warranty', 'payment'];
const ENGLISH_SUPPORTING_H2 = ['tips', 'accessories', 'comparison', 'cons'];
const ARABIC_USAGE_HEADING_TERMS = ['استخدام', 'الاستخدام', 'استخدامات', 'طريقة الاستخدام', 'كيفية الاستخدام', 'كيف تستخدم', 'استعمال', 'استعمالات', 'طريقة الاستعمال', 'تشغيل'];
const ENGLISH_USAGE_HEADING_TERMS = ['use', 'usage', 'how to use', 'using', 'operation', 'setup'];
const ARABIC_TECHNICAL_SPECS_HEADING_TERMS = ['مواصفات', 'المواصفات', 'مواصفات تقنية', 'المواصفات التقنية', 'خصائص', 'الخصائص', 'خصائص تقنية', 'الخصائص التقنية', 'تفاصيل تقنية', 'مميزات', 'المميزات', 'مزايا', 'الميزات'];
const ENGLISH_TECHNICAL_SPECS_HEADING_TERMS = ['specifications', 'specs', 'technical specifications', 'features', 'technical features', 'properties'];
const ARABIC_WARRANTY_TERMS = ['ضمان', 'الضمان', 'كفالة', 'الكفالة', 'ضمانة', 'خدمة ما بعد البيع'];
const ENGLISH_WARRANTY_TERMS = ['warranty', 'guarantee', 'coverage', 'after-sales service'];

const normalizeHeadingTerm = (value: string, language: 'ar' | 'en'): string => (
    language === 'ar' ? normalizeArabicText(value.toLowerCase()) : value.toLowerCase()
);

const headingIncludesAnyTerm = (heading: string, terms: string[], language: 'ar' | 'en'): boolean => {
    const normalizedHeading = normalizeHeadingTerm(heading, language);
    return terms.some(term => normalizedHeading.includes(normalizeHeadingTerm(term, language)));
};

const textIncludesAnyTerm = (text: string, terms: string[], language: 'ar' | 'en'): boolean => {
    const normalizedText = normalizeHeadingTerm(text, language);
    return terms.some(term => normalizedText.includes(normalizeHeadingTerm(term, language)));
};

const createProductHeadingPresenceCheck = (
    context: AnalysisContext,
    originalTitleKey: string,
    terms: string[],
): CheckResult => {
    const { headings, articleLanguage, t } = context;
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = 'details' in tRule ? tRule.details : undefined;

    if (!isProductSaleContext(context)) {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description, details);
    }

    const matchingHeading = headings.find(heading => headingIncludesAnyTerm(heading.text, terms, articleLanguage));
    if (matchingHeading) {
        return createCheckResult(title, 'pass', matchingHeading.text, requiredText, 1, description, details);
    }

    return {
        ...createCheckResult(title, 'fail', articleLanguage === 'ar' ? 'لا يوجد عنوان مناسب' : 'No matching heading', requiredText, 0, description, details),
        violationCount: 1,
        displayCountLabel: '1',
    };
};

const createProductContentPresenceCheck = (
    context: AnalysisContext,
    originalTitleKey: string,
    terms: string[],
): CheckResult => {
    const { textContent, articleLanguage, t } = context;
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = 'details' in tRule ? tRule.details : undefined;

    if (!isProductSaleContext(context)) {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description, details);
    }

    if (textIncludesAnyTerm(textContent, terms, articleLanguage)) {
        return createCheckResult(title, 'pass', articleLanguage === 'ar' ? 'موجود' : 'Found', requiredText, 1, description, details);
    }

    return {
        ...createCheckResult(title, 'fail', articleLanguage === 'ar' ? 'غير موجود' : 'Missing', requiredText, 0, description, details),
        violationCount: 1,
        displayCountLabel: '1',
    };
};

export const checkDeviceSaleMandatoryH2 = (context: AnalysisContext): CheckResult => {
    const headings = context.articleLanguage === 'ar' ? ARABIC_MANDATORY_H2 : ENGLISH_MANDATORY_H2;
    return createDeviceSaleH2Check(context, 'أقسام H2 إلزامية', headings, 0.6);
};

export const checkDeviceSaleSupportingH2 = (context: AnalysisContext): CheckResult => {
    const headings = context.articleLanguage === 'ar' ? ARABIC_SUPPORTING_H2 : ENGLISH_SUPPORTING_H2;
    return createDeviceSaleH2Check(context, 'أقسام H2 داعمة', headings, 0.5);
};

export const checkProductUsageHeading = (context: AnalysisContext): CheckResult => {
    const terms = context.articleLanguage === 'ar' ? ARABIC_USAGE_HEADING_TERMS : ENGLISH_USAGE_HEADING_TERMS;
    return createProductHeadingPresenceCheck(context, 'الاستخدام', terms);
};

export const checkProductTechnicalSpecsHeading = (context: AnalysisContext): CheckResult => {
    const terms = context.articleLanguage === 'ar' ? ARABIC_TECHNICAL_SPECS_HEADING_TERMS : ENGLISH_TECHNICAL_SPECS_HEADING_TERMS;
    return createProductHeadingPresenceCheck(context, 'المواصفات التقنية', terms);
};

export const checkProductWarrantyContent = (context: AnalysisContext): CheckResult => {
    const terms = context.articleLanguage === 'ar' ? ARABIC_WARRANTY_TERMS : ENGLISH_WARRANTY_TERMS;
    return createProductContentPresenceCheck(context, 'الضمان', terms);
};
