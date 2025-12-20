import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkH2Count = (context: AnalysisContext): CheckResult => {
    const { headings, totalWordCount, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['عدد H2'];
    const title = tRule.title;
    const description = tRule.description;
    
    const h2Headings = headings.filter(h => h.level === 2);
    const h2Count = h2Headings.length;

    let min = 0;
    let max = Infinity;
    let requiredText = "N/A";

    const details = uiLanguage === 'ar' 
        ? "• 1000 - 1500 كلمة: يتطلب وجود 6 إلى 7 عناوين H2.\n• 1500 - 2000 كلمة: يتطلب وجود 8 إلى 9 عناوين H2.\n• 2000 - 2500 كلمة: يتطلب وجود 9 إلى 10 عناوين H2.\n\n*ملاحظة: إذا كان المقال خارج هذه النطاقات، يعتبر المعيار ناجحاً تلقائياً ولكن يستمر في عرض الإحصائيات للتنظيم.*"
        : "• 1000 - 1500 words: Requires 6 to 7 H2 headings.\n• 1500 - 2000 words: Requires 8 to 9 H2 headings.\n• 2000 - 2500 words: Requires 9 to 10 H2 headings.\n\n*Note: If the word count is outside these ranges, the criteria passes automatically but continues to show stats for organization.*";

    if (totalWordCount >= 1000 && totalWordCount <= 1500) {
        min = 6; max = 7; requiredText = t.common.range(6, 7);
    } else if (totalWordCount > 1500 && totalWordCount <= 2000) {
        min = 8; max = 9; requiredText = t.common.range(8, 9);
    } else if (totalWordCount > 2000 && totalWordCount <= 2500) {
        min = 9; max = 10; requiredText = t.common.range(9, 10);
    } else {
        requiredText = tRule.required;
        const result = createCheckResult(title, 'pass', h2Count, requiredText, 1, description, details);
        result.violatingItems = h2Headings.map(h => ({
            from: h.pos, to: h.pos + getNodeSizeFromJSON(h.node), message: `${t.common.current}: ${h.text}`
        }));
        return result;
    }

    const status = getStatus(h2Count, min, max);
    const progress = status === 'pass' ? 1 : (max > 0 ? Math.min(h2Count / max, 1) : 0);

    const result = createCheckResult(title, status, h2Count, requiredText, progress, description, details);
    
    if (status !== 'pass') {
        result.violatingItems = h2Headings.map(h => ({
            from: h.pos,
            to: h.pos + getNodeSizeFromJSON(h.node),
            message: t.violationMessages.h2Count(h2Count, requiredText)
        }));
    }

    return result;
};