import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkParagraphLength = (context: AnalysisContext): CheckResult => {
    const { nodes, nonEmptyParagraphs, conclusionSection, isPosInFaqSection, t, uiLanguage } = context;
    const tRule = t.structureAnalysis['طول الفقرات'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    
    const details = uiLanguage === 'ar'
        ? "• ينطبق على فقرات المحتوى الأساسية (خارج المقدمة، الخاتمة، والأسئلة الشائعة).\n• طول الفقرة المثالي: 1-4 جمل.\n• عدد الكلمات المسموح: 30-100 كلمة.\n• الهدف: تجنب الكتل النصية الطويلة لتحسين قابلية القراءة."
        : "• Applies to core content paragraphs (excluding intro, conclusion, and FAQs).\n• Ideal length: 1-4 sentences.\n• Allowed words: 30-100 words.\n• Goal: Avoid large text blocks to improve readability.";

    const firstHeadingIndex = nodes.findIndex(n => n.type === 'heading');
    const introNodes = firstHeadingIndex === -1 ? nodes : nodes.slice(0, firstHeadingIndex);
    const introParagraphPositions = new Set(introNodes.filter(n => n.type === 'paragraph').map(p => p.pos));

    const conclusionParas = conclusionSection ? conclusionSection.paragraphs : [];
    const conclusionParaPositions = new Set(conclusionParas.map(p => p.pos));

    const contentParagraphs = nonEmptyParagraphs.filter(p => {
        if (introParagraphPositions.has(p.pos)) return false;
        if (conclusionParaPositions.has(p.pos)) return false;
        if (isPosInFaqSection(p.pos)) return false;
        return true;
    });
    
    const violations: { from: number; to: number; message: string }[] = [];
    const warnings: { from: number; to: number; message: string }[] = [];
    
    contentParagraphs.forEach(p => {
        if (!p || !p.node) return;
        const wc = getWordCount(p.text);
        const sc = getSentenceCount(p.text);
        const scMet = sc >= 1 && sc <= 4;
        const wcMet = wc >= 30 && wc <= 100;
        const wcWarn = (wc >= 25 && wc < 30) || (wc > 100 && wc <= 110);

        if (!scMet || !wcMet) {
            const item = {
                from: p.pos,
                to: p.pos + getNodeSizeFromJSON(p.node),
                message: t.violationMessages.currentWordsSentences(wc, sc)
            };
            if (scMet && wcWarn) {
                warnings.push(item);
            } else {
                violations.push(item);
            }
        }
    });

    const totalContentParagraphs = contentParagraphs.length;
    if (totalContentParagraphs === 0 && nonEmptyParagraphs.length > 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }
    const progress = totalContentParagraphs > 0 ? (totalContentParagraphs - violations.length) / totalContentParagraphs : 1;
    
    let worstStatus: AnalysisStatus = 'pass';
    if (violations.length > 0) {
        worstStatus = 'fail';
    } else if (warnings.length > 0) {
        worstStatus = 'warn';
    }

    if (worstStatus !== 'pass') {
        const currentText = `${violations.length} ${t.common.violations}, ${warnings.length} ${t.common.warnings}`;
        const result = createCheckResult(title, worstStatus, currentText, requiredText, progress, description, details);
        result.violatingItems = [...violations, ...warnings];
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, `${t.common.allParagraphsAdhere}: ${requiredText}`, 1, description, details);
};