import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkWordCount = (context: AnalysisContext): CheckResult => {
    const { totalWordCount, aiGoal, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['عدد الكلمات'];
    const title = tRule.title;
    let description = tRule.description;
    let requiredText = tRule.required;
    let minWords = 800;
    let warnMin = 600;

    if (aiGoal === 'برنامج سياحي') {
        let numberOfDays = 0;
        const dayKeywords = context.articleLanguage === 'ar' ? ['يوم', 'أيام'] : ['day', 'days'];
        const durationRegex = new RegExp(`(\\d+)\\s+(${dayKeywords.join('|')})`);
        const durationMatch = context.textContent.match(durationRegex);

        if (durationMatch && durationMatch[1]) {
            numberOfDays = parseInt(durationMatch[1], 10);
        } else {
            const dayStr = context.articleLanguage === 'ar' ? 'اليوم' : 'Day';
            const dayHeadingRegex = new RegExp(`${dayStr}\\s+(?:\\d+|الأول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|الحادي عشر|الثاني عشر|الثالث عشر|الرابع عشر|الخامس عشر|السادس عشر|السابع عشر|الثامن عشر|التاسع عشر|العشرون|one|two|three|four|five|six|seven|eight|nine|ten)`, 'i');
            const mentionedDays = new Set<string>();
            context.headings.forEach(h => {
                const match = h.text.match(dayHeadingRegex);
                if (match && match[0]) {
                    mentionedDays.add(match[0].trim());
                }
            });
            numberOfDays = mentionedDays.size;
        }

        const calculatedMin = numberOfDays > 0 ? (numberOfDays * 200 + 900) : 1100;
        minWords = Math.max(1100, calculatedMin);
        warnMin = minWords * 0.8;
        
        description = uiLanguage === 'ar' 
          ? `لبرنامج سياحي، عدد الكلمات الأدنى هو ${minWords} بناءً على ${numberOfDays > 0 ? `${numberOfDays} يوم/أيام تم اكتشافها` : 'قاعدة عامة'}. المعادلة: عدد الأيام * 200 + 900.`
          : `For a tourism program, the minimum word count is ${minWords} based on ${numberOfDays > 0 ? `${numberOfDays} day(s) detected` : 'a general rule'}. Formula: # of days * 200 + 900.`;
        requiredText = t.common.moreThan(minWords);
    }

    return createCheckResult(
        title,
        getStatus(totalWordCount, minWords, Infinity, warnMin, minWords - 1),
        totalWordCount,
        requiredText,
        Math.min(totalWordCount / minWords, 1),
        description
    );
};
