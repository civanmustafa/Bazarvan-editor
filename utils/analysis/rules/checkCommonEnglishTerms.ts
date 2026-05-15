import type { CheckResult } from '../../../types';
import { COMMON_ENGLISH_TERMS } from '../../../constants';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

type EnglishTermMatch = {
    from: number;
    to: number;
    message: string;
    length: number;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildEnglishTermRegex = (term: string): RegExp => {
    const escapedParts = term.trim().split(/\s+/).map(escapeRegex);
    const pattern = escapedParts.join('[\\s_-]+');
    return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'giu');
};

const isOverlapping = (match: EnglishTermMatch, selected: EnglishTermMatch[]): boolean => (
    selected.some(item => match.from < item.to && match.to > item.from)
);

export const checkCommonEnglishTerms = (context: AnalysisContext): CheckResult => {
    const { nodes, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['مصطلحات إنجليزية شائعة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const details = COMMON_ENGLISH_TERMS
        .map(item => `${item.terms.join(' / ')} -> ${item.preferred}`)
        .join(uiLanguage === 'ar' ? '\n' : '\n');

    if (articleLanguage !== 'ar') {
        return createCheckResult(title, 'pass', t.common.notApplicable, requiredText, 1, description, details);
    }

    const searchableNodes = nodes.filter(node => (
        (node.type === 'paragraph' || node.type === 'heading') &&
        node.text.trim().length > 0
    ));
    const violations: { from: number; to: number; message: string }[] = [];

    searchableNodes.forEach((node) => {
        const candidates: EnglishTermMatch[] = [];

        COMMON_ENGLISH_TERMS.forEach(({ terms, preferred }) => {
            terms.forEach((term) => {
                const regex = buildEnglishTermRegex(term);
                let match: RegExpExecArray | null;

                while ((match = regex.exec(node.text)) !== null) {
                    const matchedText = match[0];
                    candidates.push({
                        from: node.pos + 1 + match.index,
                        to: node.pos + 1 + match.index + matchedText.length,
                        message: t.violationMessages.commonEnglishTerm(matchedText, preferred),
                        length: matchedText.length,
                    });
                }
            });
        });

        const selectedMatches = candidates
            .sort((a, b) => a.from - b.from || b.length - a.length)
            .reduce<EnglishTermMatch[]>((selected, candidate) => (
                isOverlapping(candidate, selected) ? selected : [...selected, candidate]
            ), []);

        violations.push(...selectedMatches.map(({ from, to, message }) => ({ from, to, message })));
    });

    if (violations.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const result = createCheckResult(
        title,
        'fail',
        `${violations.length} ${t.common.violations}`,
        requiredText,
        Math.max(0, 1 - (violations.length / Math.max(searchableNodes.length, 1))),
        description,
        details,
    );
    result.violatingItems = violations;
    return result;
};
