import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, getSentenceCount, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

export const checkSubHeadingStructure = (context: AnalysisContext, level: 3 | 4): CheckResult => {
    const { nodes, headings, totalDocSize, isPosInFaqSection, t, uiLanguage } = context;
    const originalTitleKey = level === 3 ? 'قسم H3' : 'قسم H4';
    const tRule = t.structureAnalysis[originalTitleKey as keyof typeof t.structureAnalysis];
    const title = tRule.title;
    const description = tRule.description;

    let minWords: number, maxWords: number, requiredText: string;
    let minSentences: number | undefined, maxSentences: number | undefined;
    let minParas: number | undefined, maxParas: number | undefined;

    const details = uiLanguage === 'ar'
        ? (level === 3 
            ? "• ينطبق على العناوين من المستوى H3 خارج قسم الأسئلة الشائعة.\n• يجب أن يحتوي القسم على 2 إلى 4 جمل.\n• إجمالي عدد الكلمات المطلوب: 35 إلى 70 كلمة.\n• الهدف: تقديم معلومات مركزة ومفيدة تحت كل عنوان فرعي."
            : "• ينطبق على العناوين من المستوى H4 خارج قسم الأسئلة الشائعة.\n• يجب أن يتكون القسم من فقرة واحدة فقط.\n• إجمالي عدد الكلمات المطلوب: 20 إلى 60 كلمة.\n• الهدف: إضافة تفاصيل دقيقة ومختصرة جداً.")
        : (level === 3
            ? "• Applies to H3 headings outside the FAQ section.\n• Section must contain 2 to 4 sentences.\n• Word count requirement: 35 to 70 words.\n• Goal: Provide focused and useful information under subheadings."
            : "• Applies to H4 headings outside the FAQ section.\n• Section must consist of exactly one paragraph.\n• Word count requirement: 20 to 60 words.\n• Goal: Add precise and very brief details.");

    if (level === 3) {
        minWords = 35; maxWords = 70;
        minSentences = 2; maxSentences = 4;
        requiredText = tRule.required;
    } else { // level === 4
        minWords = 20; maxWords = 60;
        minParas = 1; maxParas = 1;
        requiredText = tRule.required;
    }

    const relevantHeadings = headings.filter(h => h.level === level && !isPosInFaqSection(h.pos));

    if (relevantHeadings.length === 0) {
        return createCheckResult(title, 'pass', `${0} ${t.structureTab.heading}`, t.common.recommendedForLong, 1, description, details);
    }
    
    const violations: { from: number; to: number; message: string; sectionFrom?: number; sectionTo?: number }[] = [];
    const warnings: { from: number; to: number; message: string; sectionFrom?: number; sectionTo?: number }[] = [];

    const headingIndices = nodes
        .map((node, index) => (node.type === 'heading' && node.level === level && !isPosInFaqSection(node.pos)) ? index : -1)
        .filter(index => index !== -1);

    for (const headingIndex of headingIndices) {
        const headingNode = nodes[headingIndex];
        
        const nextHeadingIndex = nodes.findIndex((node, index) => index > headingIndex && node.type === 'heading');
        const endNodeIndex = nextHeadingIndex === -1 ? nodes.length : nextHeadingIndex;
        const sectionNodes = nodes.slice(headingIndex + 1, endNodeIndex);
        
        const sectionParagraphs = sectionNodes.filter(n => n.type === 'paragraph' && n.text.trim().length > 0);
        
        const sectionContentForWords = sectionNodes.filter(n => (n.type === 'paragraph' && n.text.trim().length > 0) || n.type === 'bulletList' || n.type === 'orderedList');
        const sectionText = sectionContentForWords.map(n => n.text).join(' ');
        const sectionWordCount = getWordCount(sectionText);

        let wordsMet, structureMet, wordsWarn, message;
        
        if (level === 3) {
            const sectionSentenceCount = getSentenceCount(sectionText);
            wordsMet = sectionWordCount >= minWords && sectionWordCount <= maxWords;
            structureMet = sectionSentenceCount >= minSentences! && sectionSentenceCount <= maxSentences!;
            wordsWarn = (sectionWordCount >= minWords - 5 && sectionWordCount < minWords) || (sectionWordCount > maxWords && sectionWordCount <= maxWords + 5);
            message = t.violationMessages.currentWordsSentences(sectionWordCount, sectionSentenceCount);
        } else { // level === 4
            const sectionParaCount = sectionParagraphs.length;
            wordsMet = sectionWordCount >= minWords && sectionWordCount <= maxWords;
            structureMet = sectionParaCount >= minParas! && sectionParaCount <= maxParas!;
            wordsWarn = (sectionWordCount >= minWords - 5 && sectionWordCount < minWords) || (sectionWordCount > maxWords && sectionWordCount <= maxWords + 5);
            message = t.violationMessages.currentWordsParas(sectionWordCount, sectionParaCount);
        }

        if (!wordsMet || !structureMet) {
            const baseViolation = {
                from: headingNode.pos, to: headingNode.pos + getNodeSizeFromJSON(headingNode.node), message: message,
                sectionFrom: headingNode.pos, sectionTo: endNodeIndex < nodes.length ? nodes[endNodeIndex].pos : totalDocSize
            };
            if (structureMet && wordsWarn) warnings.push(baseViolation);
            else violations.push(baseViolation);
        }
    }
    
    const progress = relevantHeadings.length > 0 ? (relevantHeadings.length - violations.length) / relevantHeadings.length : 1;
    let worstStatus: AnalysisStatus = violations.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
    
    if (worstStatus !== 'pass') {
        const currentText = `${violations.length} ${t.common.violations}, ${warnings.length} ${t.common.warnings}`;
        const result = createCheckResult(title, worstStatus, currentText, requiredText, progress, description, details);
        result.violatingItems = [...violations, ...warnings];
        return result;
    }

    return createCheckResult(title, 'pass', t.common.good, `${t.common.allSectionsAdhere}: ${requiredText}`, 1, description, details);
};