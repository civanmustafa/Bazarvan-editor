import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { INTERROGATIVE_H2_KEYWORDS } from '../../../constants';

export const checkInterrogativeH2 = (context: AnalysisContext): CheckResult => {
    const { headings, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['عناوين H2 استفهامية'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const L_INTERROGATIVE_H2_KEYWORDS = articleLanguage === 'ar' ? INTERROGATIVE_H2_KEYWORDS : ['what', 'who', 'when', 'where', 'how', 'why', 'is', 'are', 'do', 'does', 'can', 'will', 'should'];

    const details = uiLanguage === 'ar'
        ? `• يجب أن يحتوي المقال على 3 عناوين من المستوى H2 بصيغة سؤال على الأقل.\n• كلمات الاستفهام المكتشفة تشمل: ${L_INTERROGATIVE_H2_KEYWORDS.slice(0, 10).join('، ')}...\n• الهدف: تلبية نية البحث المباشرة للمستخدم (Search Intent) وتحسين الظهور في ميزات AI Overviews.`
        : `• Article must contain at least 3 interrogative H2 headings.\n• Detected question words include: ${L_INTERROGATIVE_H2_KEYWORDS.slice(0, 10).join(', ')}...\n• Goal: Address direct user search intent and improve visibility in AI Overviews.`;

    const interrogativeH2s = headings.filter(h => h.level === 2 && L_INTERROGATIVE_H2_KEYWORDS.some(k => h.text.trim().toLowerCase().startsWith(k)));
    const count = interrogativeH2s.length;
    const status = getStatus(count, 3, Infinity);
    
    const result = createCheckResult(title, status, count, requiredText, Math.min(count / 3, 1), description, details);
    if (status === 'fail') {
        result.violatingItems = headings.filter(h => h.level === 2).map(h => ({
            from: h.pos, to: h.pos + getNodeSizeFromJSON(h.node), message: t.violationMessages.interrogativeCount(count)
        }));
    }
    return result;
};
