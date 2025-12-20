import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, countOccurrences } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { CTA_WORDS } from '../../../constants';

export const checkCtaWords = (context: AnalysisContext): CheckResult => {
    const { textContent, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات الحث'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = t.common.moreThan(1);
    const ENGLISH_CTA_WORDS = ['start now', 'try now', 'sign up', 'book your spot', 'get', 'order now', 'contact us', 'join us', 'discover more', 'learn more', 'benefit now', 'subscribe', 'download', 'buy', 'shop', 'explore', 'request a quote', 'click here', 'submit', 'register', 'claim your', 'get started', 'find out more'];
    const L_CTA_WORDS = articleLanguage === 'ar' ? CTA_WORDS : ENGLISH_CTA_WORDS;

    const details = uiLanguage === 'ar'
        ? `• يجب وجود عبارة حث على اتخاذ إجراء (CTA) واحدة على الأقل.\n• أمثلة: ${L_CTA_WORDS.slice(0, 10).join('، ')}.\n• الهدف: تحويل القارئ من مستهلك سلبي للمعلومات إلى متفاعل أو عميل محتمل.`
        : `• At least one Call-to-Action (CTA) word must be present.\n• Examples: ${L_CTA_WORDS.slice(0, 10).join(', ')}.\n• Goal: Convert the reader from a passive consumer to an active participant or lead.`;

    const count = L_CTA_WORDS.reduce((sum, word) => sum + countOccurrences(textContent, word, articleLanguage), 0);
    const status = getStatus(count, 1, Infinity);
    return createCheckResult(title, status, count, requiredText, Math.min(count, 1), description, details);
};