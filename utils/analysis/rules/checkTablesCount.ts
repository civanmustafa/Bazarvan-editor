import type { CheckResult } from '../../../types';
import { createCheckResult, countNodesByType } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkTablesCount = (context: AnalysisContext): CheckResult => {
    const { analysisGoal, editorState, t } = context;
    const tRule = t.structureAnalysis['جداول'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    if (analysisGoal !== 'بيع جهاز') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description);
    }
    const tableCount = countNodesByType(editorState, 'table');
    const status = tableCount >= 2 ? 'pass' : (tableCount === 1 ? 'warn' : 'fail');
    return createCheckResult(title, status, tableCount, requiredText, tableCount / 2, description);
};
