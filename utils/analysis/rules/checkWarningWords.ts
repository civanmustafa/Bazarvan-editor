import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, countOccurrences } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { WARNING_ADVICE_WORDS } from '../../../constants';

export const checkWarningWords = (context: AnalysisContext): CheckResult => {
    const { textContent, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات تحذيرية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = t.common.moreThan(1);
    const ENGLISH_WARNING_ADVICE_WORDS = ['warning', 'caution', 'be careful', 'note', 'important', 'recommendation', 'it is recommended', 'it is important', 'avoid', 'make sure', 'be aware', 'beware', 'take note', 'heads up', 'it is crucial', 'you should', 'remember to', 'pro tip', 'keep in mind'];
    const L_WARNING_ADVICE_WORDS = articleLanguage === 'ar' ? WARNING_ADVICE_WORDS : ENGLISH_WARNING_ADVICE_WORDS;

    const details = uiLanguage === 'ar'
        ? `• يجب استخدام كلمة تحذيرية أو نصيحة ذهبية واحدة على الأقل في المقال.\n• أمثلة: ${L_WARNING_ADVICE_WORDS.slice(0, 10).join('، ')}.\n• الهدف: تعزيز ثقة القارر في الكاتب من خلال تقديم نصائح وقائية مفيدة.`
        : `• At least one warning or golden advice word should be used.\n• Examples: ${L_WARNING_ADVICE_WORDS.slice(0, 10).join(', ')}.\n• Goal: Build reader trust by providing useful preventative advice.`;

    const count = L_WARNING_ADVICE_WORDS.reduce((sum, word) => sum + countOccurrences(textContent, word, articleLanguage), 0);
    return createCheckResult(title, getStatus(count, 1, Infinity), count, requiredText, Math.min(count, 1), description, details);
};