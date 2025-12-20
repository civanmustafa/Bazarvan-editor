import type { CheckResult, AnalysisStatus } from '../../../types';
import { createCheckResult, getWordCount, countOccurrences, getNodeSizeFromJSON } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';
import { FAQ_KEYWORDS, CONCLUSION_KEYWORDS } from '../../../constants';

export const checkH2Structure = (context: AnalysisContext): CheckResult => {
    const { nodes, totalDocSize, t, articleLanguage } = context;
    const tRule = t.structureAnalysis['قسم H2'];
    const title = tRule.title;
    const description = tRule.description;
    const details = tRule.details;
    const L_FAQ_KEYWORDS = articleLanguage === 'ar' ? FAQ_KEYWORDS : ['questions', 'faq', 'frequently asked questions'];
    const L_CONCLUSION_KEYWORDS = articleLanguage === 'ar' ? CONCLUSION_KEYWORDS : ['conclusion', 'summary', 'in conclusion', 'in summary', 'finally', 'to sum up', 'lastly', 'in the end'];
    
    const h2Indices = nodes
        .map((node, index) => (node.type === 'heading' && node.level === 2 ? index : -1))
        .filter(index => index !== -1);
    
    const lastH2NodePos = h2Indices.length > 0 ? nodes[h2Indices[h2Indices.length - 1]].pos : -1;
    
    let relevantH2Count = 0;
    const violations: { from: number; to: number; message: string; sectionFrom?: number, sectionTo?: number }[] = [];
    const warnings: { from: number; to: number; message: string; sectionFrom?: number, sectionTo?: number }[] = [];

    const boundaries = [...h2Indices, nodes.length];

    for (let i = 0; i < boundaries.length - 1; i++) {
        const startNodeIndex = boundaries[i];
        const h2Node = nodes[startNodeIndex];
        
        const isFaqH2 = L_FAQ_KEYWORDS.some(k => countOccurrences(h2Node.text, k, articleLanguage) > 0);
        const isConclusionH2 = h2Node.pos === lastH2NodePos && L_CONCLUSION_KEYWORDS.some(k => countOccurrences(h2Node.text, k, articleLanguage) > 0);

        if (isFaqH2 || isConclusionH2) {
            continue;
        }
        relevantH2Count++;

        const endNodeIndex = boundaries[i + 1];

        const sectionNodes = nodes.slice(startNodeIndex + 1, endNodeIndex);
        const sectionParagraphs = sectionNodes.filter(n => n.type === 'paragraph' && n.text.trim().length > 0);
        const paraCount = sectionParagraphs.length;
        const sectionH3s = sectionNodes.filter(n => n.type === 'heading' && n.level === 3);
        const h3Count = sectionH3s.length;
        const sectionText = sectionNodes.map(n => n.text).join(' ');
        const wordCount = getWordCount(sectionText);
        
        let statusForThisSection: AnalysisStatus = 'pass';
        let violationMessage = '';

        if (wordCount >= 80 && wordCount <= 150) {
            if (!(paraCount >= 1 && paraCount <= 3 && h3Count === 0)) {
                statusForThisSection = 'fail';
                violationMessage = t.violationMessages.h2Structure_rule1(paraCount, h3Count);
            }
        } else if (wordCount > 150 && wordCount <= 180) {
            if (h3Count > 0) {
                if (!(paraCount >= 3 && paraCount <= 4)) {
                    statusForThisSection = 'fail';
                    violationMessage = t.violationMessages.h2Structure_rule2(paraCount);
                }
            } else {
                statusForThisSection = 'warn';
                violationMessage = t.violationMessages.h2Structure_warn1(wordCount);
            }
        } else if (wordCount > 180 && wordCount <= 220) {
            if (!(h3Count >= 2 && h3Count <= 3 && paraCount >= 3 && paraCount <= 5)) {
                statusForThisSection = 'fail';
                violationMessage = t.violationMessages.h2Structure_rule3(h3Count, paraCount);
            }
        } else if (wordCount > 220 && wordCount <= 300) {
            if (!(h3Count >= 3 && h3Count <= 4 && paraCount >= 4 && paraCount <= 7)) {
                statusForThisSection = 'fail';
                violationMessage = t.violationMessages.h2Structure_rule4(h3Count, paraCount);
            }
        } else if (wordCount > 300) {
            statusForThisSection = 'fail';
            violationMessage = t.violationMessages.h2Structure_tooLong(wordCount);
        }

        if (statusForThisSection !== 'pass') {
            const item = {
                from: h2Node.pos,
                to: h2Node.pos + getNodeSizeFromJSON(h2Node.node),
                message: violationMessage,
                sectionFrom: h2Node.pos,
                sectionTo: endNodeIndex < nodes.length ? nodes[endNodeIndex].pos : totalDocSize,
            };
            if (statusForThisSection === 'fail') {
                violations.push(item);
            } else {
                warnings.push(item);
            }
        }
    }
    
    if (relevantH2Count === 0) {
        return createCheckResult(title, 'pass', t.common.noApplicableHeadings, t.common.preferH2, 1, description, details);
    }

    const progress = relevantH2Count > 0 ? (relevantH2Count - violations.length) / relevantH2Count : 1;
    const requiredText = tRule.required;
    
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

    return createCheckResult(title, 'pass', t.common.good, t.common.allSectionsAdhere, 1, description, details);
};
