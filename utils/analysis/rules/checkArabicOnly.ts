
import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, isProtectedKeywordTerm } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkArabicOnly = (context: AnalysisContext): CheckResult => {
    const { textContent, totalWordCount, keywords, t, uiLanguage, articleLanguage } = context;
    const tRule = t.structureAnalysis['كلمات لاتينية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const details = uiLanguage === 'ar'
        ? "• يمنع استخدام كلمات لاتينية (إنجليزية مثلاً) داخل النص العربي إلا للضرورة القصوى.\n• يتم استثناء الكلمات المفتاحية المعرفة من هذا الفحص.\n• النسبة المسموح بها: أقل من 0.5% من إجمالي النص.\n• الهدف: الحفاظ على هوية النص العربي ونقاء اللغة."
        : "• Use of Latin characters within Arabic text is discouraged unless necessary.\n• Target keywords are excluded from this check.\n• Allowed threshold: Less than 0.5% of total word count.\n• Goal: Maintain the linguistic purity and flow of the Arabic text.";

    if (articleLanguage !== 'ar') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description, details);
    }
    const latinWords: string[] = textContent.match(/[a-zA-Z]+/g) || [];
    const nonKeywordLatinWords = latinWords.filter(word => !isProtectedKeywordTerm(word, keywords, articleLanguage));
    const percentage = totalWordCount > 0 ? nonKeywordLatinWords.length / totalWordCount : 0;
    const status = getStatus(percentage, 0, 0.005);
    return createCheckResult(title, status, `${(percentage*100).toFixed(2)}%`, requiredText, 1 - Math.min(percentage / 0.005, 1), description, details);
};
