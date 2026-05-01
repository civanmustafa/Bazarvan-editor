import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { WORDS_TO_DELETE } from '../../../constants';

export const checkWordsToDelete = (context: AnalysisContext): CheckResult => {
    const { nodes, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['كلمات للحذف'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const ENGLISH_WORDS_TO_DELETE = ['synergy', 'leverage', 'paradigm shift', 'game-changer', 'out of the box', 'low-hanging fruit', 'circle back', 'deep dive', 'win-win', 'thought leader', 'value-added', 'next-gen', 'cutting-edge', 'robust', 'scalable', 'disrupt', 'pivot', 'actionable insights', 'growth hacking', 'core competency', 'ideation', 'seamless integration'];
    const L_WORDS_TO_DELETE = articleLanguage === 'ar' ? WORDS_TO_DELETE : ENGLISH_WORDS_TO_DELETE;

    const details = uiLanguage === 'ar'
        ? `• قائمة بكلمات تسويقية مفرطة أو "كليشيهات" يفضل حذفها.\n• أمثلة: ${L_WORDS_TO_DELETE.slice(0, 10).join('، ')}.\n• الهدف: تقليل الحشو اللغوي الذي يفتقر للقيمة الحقيقية ويفقده القارئ الثقة.`
        : `• A list of overused marketing terms or clichés to be removed.\n• Examples: ${L_WORDS_TO_DELETE.slice(0, 10).join(', ')}.\n• Goal: Reduce linguistic filler that lacks real value and diminishes reader trust.`;
    
    const searchableNodes = nodes.filter(node => (node.type === 'paragraph' || node.type === 'heading') && node.text.trim().length > 0);
    const violations: {from: number, to: number, message: string}[] = [];
    searchableNodes.forEach(node => {
        L_WORDS_TO_DELETE.forEach(word => {
            const regex = new RegExp(word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
            let match;
            while((match = regex.exec(node.text)) !== null) {
                violations.push({
                    from: node.pos + 1 + match.index,
                    to: node.pos + 1 + match.index + match[0].length,
                    message: t.violationMessages.avoidWord(word)
                });
            }
        });
    });
    
    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }
    const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, 0, description, details);
    result.violatingItems = violations;
    return result;
};
