import type { CheckResult } from '../../../types';
import { createCheckResult, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkAnswerParagraph = (context: AnalysisContext): CheckResult => {
    const { faqSections, nodes, t } = context;
    const tRule = t.structureAnalysis['فقرة الأجوبة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;

    const faqParagraphs: any[] = [];
    let totalFaqH3s = 0;

    faqSections.forEach(section => {
        const sectionNodes = nodes.filter(n => n.pos >= section.startPos && n.pos < section.endPos);
        const faqH3Indices = sectionNodes
            .map((node, index) => (node.type === 'heading' && node.level === 3 ? index : -1))
            .filter(index => index !== -1);
        
        totalFaqH3s += faqH3Indices.length;

        faqH3Indices.forEach((h3Index, i) => {
            const nextH3Index = i + 1 < faqH3Indices.length ? faqH3Indices[i+1] : sectionNodes.length;
            const answerNodes = sectionNodes.slice(h3Index + 1, nextH3Index);
            const answerParagraphs = answerNodes.filter(n => n.type === 'paragraph');
            faqParagraphs.push(...answerParagraphs);
        });
    });

    if (totalFaqH3s === 0) {
        return createCheckResult(title, 'pass', t.common.noH3, 'Applies when H3s exist', 1, description);
    }

    if (faqParagraphs.length === 0) {
        return createCheckResult(title, 'fail', '0 paragraphs found', requiredText, 0, description);
    }

    const violations = faqParagraphs.filter(p => {
        const wc = getWordCount(p.text);
        const sc = getSentenceCount(p.text);
        return !(wc >= 35 && wc <= 75 && sc >= 2 && sc <= 3);
    });

    const progress = (faqParagraphs.length - violations.length) / faqParagraphs.length;
    if (violations.length > 0) {
        const result = createCheckResult(title, 'fail', `${violations.length} ${t.common.violations}`, requiredText, progress, description);
        result.violatingItems = violations.map(p => ({
            from: p.pos,
            to: p.pos + getNodeSizeFromJSON(p.node),
            message: t.violationMessages.currentWordsSentences(getWordCount(p.text), getSentenceCount(p.text))
        }));
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description);
};
