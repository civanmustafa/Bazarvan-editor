import type { CheckResult } from '../../../types';
import { parseContentWritingTargetWordRange } from '../../contentWritingTargets';
import { createCheckResult, getStatus } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkWordCount = (context: AnalysisContext): CheckResult => {
    const { totalWordCount, analysisGoal, goalContext, lengthTarget, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['عدد الكلمات'];
    const title = tRule.title;
    let description = tRule.description;
    let requiredText = tRule.required;
    let minWords = 800;
    let warnMin = 600;
    const manualTarget = parseContentWritingTargetWordRange(goalContext.targetWordRange);

    if (manualTarget) {
        const isInsideTarget = (
            totalWordCount >= manualTarget.min
            && totalWordCount <= manualTarget.max
        );
        const progress = isInsideTarget
            ? 1
            : totalWordCount < manualTarget.min
                ? Math.min(totalWordCount / manualTarget.min, 1)
                : Math.min(manualTarget.max / Math.max(totalWordCount, 1), 1);
        description = uiLanguage === 'ar'
            ? `النطاق الذي عيّنه المستخدم هو ${manualTarget.min} إلى ${manualTarget.max} كلمة، ويُعد المقال مخالفًا إذا كان أقل أو أكثر منه.`
            : `The user-defined target is ${manualTarget.min} to ${manualTarget.max} words; content outside this range fails the criterion.`;

        return createCheckResult(
            title,
            isInsideTarget ? 'pass' : 'fail',
            totalWordCount,
            t.common.range(manualTarget.min, manualTarget.max),
            progress,
            description,
        );
    }

    const automaticTarget = (
        lengthTarget?.mode === 'automatic'
        && lengthTarget.baselineCompetitor
    )
        ? lengthTarget
        : null;
    if (automaticTarget) {
        const { min, max } = automaticTarget.targetWords;
        const isInsideTarget = totalWordCount >= min && totalWordCount <= max;
        const progress = isInsideTarget
            ? 1
            : totalWordCount < min
                ? Math.min(totalWordCount / min, 1)
                : Math.min(max / Math.max(totalWordCount, 1), 1);
        description = uiLanguage === 'ar'
            ? `لأن خانة عدد الكلمات فارغة، حُسب الهدف من أكبر نص منافس فعلي (${automaticTarget.baselineCompetitor.wordCount} كلمة) × 1.20 = ${automaticTarget.centerWords} كلمة، مع هامش نجاح ±10% ليصبح النطاق ${min}-${max} كلمة.`
            : `Because the word-count field is empty, the target uses the largest actual competitor text (${automaticTarget.baselineCompetitor.wordCount} words) × 1.20 = ${automaticTarget.centerWords} words, with a ±10% passing tolerance (${min}-${max} words).`;

        return createCheckResult(
            title,
            isInsideTarget ? 'pass' : 'fail',
            totalWordCount,
            t.common.range(min, max),
            progress,
            description,
        );
    }

    if (analysisGoal === 'برنامج سياحي') {
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
        requiredText = `≥ ${minWords}`;
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
