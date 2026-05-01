
import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus } from '../analysisUtils';
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
    
    // Fix: Explicitly type latinWords as string[] to prevent 'never[]' inference
    // which was causing the 'word' variable in the filter on line 26 to be typed as 'never'.
    const latinWords: string[] = textContent.match(/[a-zA-Z]+/g) || [];
    
    // Fix: Use spread operator for cleaner and more robust type inference when combining strings and arrays.
    const allKeywordValues: string[] = [
        keywords.primary,
        ...keywords.secondaries,
        keywords.company,
        ...keywords.lsi
    ];
    
    // Fix: Added a type guard to the filter to ensure TypeScript correctly narrows the type to string[] 
    // before mapping, ensuring 'k' is correctly typed as string instead of never.
    const keywordsLower = allKeywordValues
        .filter((k): k is string => Boolean(k) && typeof k === 'string')
        .map(k => k.toLowerCase());

    // Fix: 'word' is now correctly typed as string thanks to the explicit typing of latinWords above.
    const nonKeywordLatinWords = latinWords.filter(word => !keywordsLower.includes(word.toLowerCase()));
    const percentage = totalWordCount > 0 ? nonKeywordLatinWords.length / totalWordCount : 0;
    const status = getStatus(percentage, 0, 0.005);
    return createCheckResult(title, status, `${(percentage*100).toFixed(2)}%`, requiredText, 1 - Math.min(percentage / 0.005, 1), description, details);
};
