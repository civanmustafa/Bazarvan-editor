import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { FAQ_KEYWORDS } from '../../../constants';

export const checkBetweenH2H3 = (context: AnalysisContext): CheckResult => {
    const { nodes, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['بين H2-H3'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const details = uiLanguage === 'ar'
        ? "• ينطبق على المساحة الفاصلة بين عنوان H2 وعنوان H3 الذي يليه مباشرة.\n• يجب أن يحتوي هذا الفراغ على فقرة واحدة إلى فقرتين.\n• عدد الكلمات المطلوب في هذه المنطقة: 40 إلى 120 كلمة.\n• الهدف: التمهيد الجيد للعنوان الفرعي قبل الدخول في تفاصيله."
        : "• Applies to the space between an H2 heading and the H3 that immediately follows it.\n• Must contain 1 to 2 paragraphs.\n• Word count requirement: 40 to 120 words.\n• Goal: Provide a proper introduction to the subheading content.";

    const L_FAQ_KEYWORDS = articleLanguage === 'ar' ? FAQ_KEYWORDS : ['questions', 'faq', 'frequently asked questions'];
    const minWords = 40, maxWords = 120, minParas = 1, maxParas = 2, warnMargin = 5;

    const violations: { from: number; to: number; message: string; sectionFrom?: number; sectionTo?: number }[] = [];
    const warnings: { from: number; to: number; message: string; sectionFrom?: number; sectionTo?: number }[] = [];
    let totalSections = 0;

    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].type === 'heading' && nodes[i].level === 2) {
            const h2Node = nodes[i];
            if (L_FAQ_KEYWORDS.some(k => countOccurrences(h2Node.text, k, articleLanguage) > 0)) continue;
            
            let sectionNodesBetween: any[] = [];
            for (let j = i + 1; j < nodes.length; j++) {
                const aheadNode = nodes[j];
                if (aheadNode.type === 'heading') {
                    if (aheadNode.level === 3) {
                        totalSections++;
                        const sectionParagraphs = sectionNodesBetween.filter(n => n.type === 'paragraph' && n.text.trim().length > 0);
                        const paraCount = sectionParagraphs.length;
                        const sectionText = sectionNodesBetween.map(n => n.text).join(' ');
                        const sectionWordCount = getWordCount(sectionText);
                        
                        const paragraphsMet = paraCount >= minParas && paraCount <= maxParas;
                        const wordsMet = sectionWordCount >= minWords && sectionWordCount <= maxWords;
                        const wordsWarn = (sectionWordCount >= minWords - warnMargin && sectionWordCount < minWords) || (sectionWordCount > maxWords && sectionWordCount <= maxWords + warnMargin);
                        
                        if (!paragraphsMet || !wordsMet) {
                            const item = {
                                from: h2Node.pos, to: h2Node.pos + getNodeSizeFromJSON(h2Node.node),
                                message: t.violationMessages.currentParasWords(paraCount, sectionWordCount),
                                sectionFrom: h2Node.pos, sectionTo: aheadNode.pos
                            };
                            if (paragraphsMet && wordsWarn) warnings.push(item);
                            else violations.push(item);
                        }
                    }
                    break; 
                } else {
                    sectionNodesBetween.push(aheadNode);
                }
            }
        }
    }
    
    const progress = totalSections > 0 ? (totalSections - violations.length) / totalSections : 1;
    let worstStatus: AnalysisStatus = violations.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
    
    if (worstStatus !== 'pass') {
        const currentText = `${violations.length} ${t.common.violations}, ${warnings.length} ${t.common.warnings}`;
        const result = createCheckResult(title, worstStatus, currentText, requiredText, progress, description, details);
        result.violatingItems = [...violations, ...warnings];
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, `${t.common.allSectionsAdhere}: ${requiredText}`, 1, description, details);
};