import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const createDeviceSaleH2Check = (
    context: AnalysisContext,
    originalTitleKey: string,
    requiredHeadingsForAnalysis: string[],
    minPercentage: number,
): CheckResult => {
    const { analysisGoal, headings, t } = context;
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required.replace('{PERCENT}', String(minPercentage * 100));

    if (analysisGoal !== 'بيع جهاز') {
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

export const checkDeviceSaleMandatoryH2 = (context: AnalysisContext): CheckResult => {
    const headings = context.articleLanguage === 'ar' ? ARABIC_MANDATORY_H2 : ENGLISH_MANDATORY_H2;
    return createDeviceSaleH2Check(context, 'أقسام H2 إلزامية', headings, 0.6);
};

export const checkDeviceSaleSupportingH2 = (context: AnalysisContext): CheckResult => {
    const headings = context.articleLanguage === 'ar' ? ARABIC_SUPPORTING_H2 : ENGLISH_SUPPORTING_H2;
    return createDeviceSaleH2Check(context, 'أقسام H2 داعمة', headings, 0.5);
};
