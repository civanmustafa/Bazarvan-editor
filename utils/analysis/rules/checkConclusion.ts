import type { CheckResult } from '../../../types';
import { createCheckResult, getStatus } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { CONCLUSION_KEYWORDS, CONCLUSION_INDICATOR_WORDS } from '../../../constants';

export const checkConclusion = (context: AnalysisContext): {
    lastH2IsConclusion: CheckResult;
    conclusionParagraph: CheckResult;
    conclusionWordCount: CheckResult;
    conclusionHasNumber: CheckResult;
    conclusionHasList: CheckResult;
} => {
    const { conclusionSection, t, articleLanguage } = context;
    const tRuleTitle = t.structureAnalysis['عنوان الخاتمة'];
    const tRulePara = t.structureAnalysis['فقرة الخاتمة'];
    const tRuleLength = t.structureAnalysis['طول الخاتمة'];
    const tRuleNum = t.structureAnalysis['أرقام بالخاتمة'];
    const tRuleList = t.structureAnalysis['قائمة الخاتمة'];
    
    const ENGLISH_CONCLUSION_KEYWORDS = ['conclusion', 'summary', 'in conclusion', 'in summary', 'finally', 'to sum up', 'lastly', 'in the end'];
    const L_CONCLUSION_KEYWORDS = articleLanguage === 'ar' ? CONCLUSION_KEYWORDS : ENGLISH_CONCLUSION_KEYWORDS;
    const L_CONCLUSION_INDICATOR_WORDS = articleLanguage === 'ar' ? CONCLUSION_INDICATOR_WORDS : ENGLISH_CONCLUSION_KEYWORDS;

    const baseResult = (title: string, required: string, description: string) => createCheckResult(title, 'fail', t.common.noConclusion, required, 0, description);

    if (!conclusionSection) {
        const lastH2Result = baseResult(tRuleTitle.title, tRuleTitle.required, tRuleTitle.description);
        lastH2Result.details = L_CONCLUSION_KEYWORDS.join(', ');
        const paraResult = baseResult(tRulePara.title, tRulePara.required, tRulePara.description);
        paraResult.details = L_CONCLUSION_INDICATOR_WORDS.join(', ');

        return {
            lastH2IsConclusion: lastH2Result,
            conclusionParagraph: paraResult,
            conclusionWordCount: baseResult(tRuleLength.title, tRuleLength.required, tRuleLength.description),
            conclusionHasNumber: baseResult(tRuleNum.title, tRuleNum.required, tRuleNum.description),
            conclusionHasList: baseResult(tRuleList.title, tRuleList.required, tRuleList.description),
        };
    }
    
    const wcStatus = getStatus(conclusionSection.wordCount, 50, 100);
    const firstPara = conclusionSection.paragraphs[0];
    const firstParaStartsWithIndicator = firstPara && L_CONCLUSION_INDICATOR_WORDS.some(w => firstPara.text.trim().toLowerCase().startsWith(w.toLowerCase()));

    const lastH2Result = createCheckResult(tRuleTitle.title, 'pass', t.common.found, tRuleTitle.required, 1, tRuleTitle.description);
    lastH2Result.details = L_CONCLUSION_KEYWORDS.join(', ');
    
    const paraResult = createCheckResult(tRulePara.title, firstParaStartsWithIndicator ? 'pass' : 'fail', firstParaStartsWithIndicator ? t.common.yes : t.common.no, tRulePara.required, firstParaStartsWithIndicator ? 1 : 0, tRulePara.description);
    paraResult.details = L_CONCLUSION_INDICATOR_WORDS.join(', ');

    return {
        lastH2IsConclusion: lastH2Result,
        conclusionParagraph: paraResult,
        conclusionWordCount: createCheckResult(tRuleLength.title, wcStatus, conclusionSection.wordCount, tRuleLength.required, wcStatus === 'pass' ? 1 : 0, tRuleLength.description),
        conclusionHasNumber: createCheckResult(tRuleNum.title, conclusionSection.hasNumber ? 'pass' : 'fail', conclusionSection.hasNumber ? t.common.yes : t.common.no, tRuleNum.required, conclusionSection.hasNumber ? 1 : 0, tRuleNum.description),
        conclusionHasList: createCheckResult(tRuleList.title, conclusionSection.hasList ? 'pass' : 'fail', conclusionSection.hasList ? t.common.yes : t.common.no, tRuleList.required, conclusionSection.hasList ? 1 : 0, tRuleList.description),
    };
};
