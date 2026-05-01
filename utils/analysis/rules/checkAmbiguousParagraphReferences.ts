import type { CheckResult } from '../../../types';
import { createCheckResult } from '../analysisUtils';
import type { AnalysisContext } from '../analysisUtils';

const AR_AMBIGUOUS_STARTS = [
    'كما ذكرنا سابقاً', 'كما ذكرنا سابقا', 'كما سبق ذكره', 'كما سبق', 'كما أشرنا',
    'المذكور أعلاه', 'المذكور سابقاً', 'المذكور سابقا', 'السابق ذكره', 'ما سبق',
    'بالإضافة إلى ذلك', 'علاوة على ذلك', 'بناءً على ذلك', 'بناء على ذلك',
    'وبناءً على ذلك', 'وبناء على ذلك', 'نتيجة لذلك', 'نتيجة لهذا', 'بسبب ذلك',
    'بفضل ذلك', 'رغم ذلك', 'مع ذلك', 'على الرغم من ذلك', 'في المقابل',
    'من ناحية أخرى', 'من جهة أخرى', 'في هذا السياق', 'في هذا الصدد',
    'في هذا الإطار', 'ضمن هذا الإطار', 'من هذا المنطلق', 'لهذا السبب',
    'ولهذا السبب', 'لهذه الأسباب', 'لهذا', 'لذلك', 'لذا', 'من هنا', 'ومن هنا',
    'ومن ثم', 'وبهذا', 'وبذلك', 'وبالتالي', 'ومن أجل ذلك',
    'هذا الأمر', 'هذه المشكلة', 'هذه الطريقة', 'هذا الخيار', 'هذه النتيجة',
    'هذه الفكرة', 'هذه النقطة', 'هذه العوامل', 'هذه الأسباب', 'هذه الخطوة',
    'هذه الخدمة', 'هذه العملية', 'هذا الحل', 'هذا النوع', 'هذا المجال',
    'هذا المنتج', 'ذلك يعني', 'هذا يعني', 'وهذا يعني', 'مما يعني',
    'بهذا الشكل', 'بهذه الطريقة', 'بهذا المعنى', 'في هذه الحالة',
    'في تلك الحالة', 'الأمر نفسه', 'نفس الأمر',
    'وهذا', 'فهذا', 'وهذه', 'فهذه', 'وذلك', 'فذلك', 'وتلك', 'فتلك',
    'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء', 'أولئك', 'هنا', 'هناك',
    'الأمر', 'المشكلة', 'الطريقة', 'الخيار', 'النتيجة',
    'هو', 'هي', 'هم', 'هما', 'هن', 'له', 'لها', 'فيه', 'فيها', 'به', 'بها',
    'عليه', 'عليها', 'منه', 'منها', 'إليه', 'إليها', 'إليك',
    'أيضاً', 'أيضا', 'كذلك', 'كما أن', 'ناهيك عن ذلك',
];

const EN_AMBIGUOUS_STARTS = [
    'as mentioned earlier', 'as mentioned above', 'as noted earlier', 'as noted above',
    'as discussed', 'as explained earlier', 'as stated above', 'the above',
    'the aforementioned', 'previously mentioned', 'the previous point',
    'in this context', 'in this regard', 'for this reason', 'for that reason',
    'because of this', 'based on this', 'as a result', 'therefore', 'thus',
    'because of that', 'despite that', 'even so', 'on the other hand',
    'in contrast', 'in addition to that', 'additionally', 'moreover',
    'furthermore', 'also', 'this means', 'that means', 'this approach',
    'this method', 'this option', 'this problem', 'this issue', 'this result',
    'this service', 'this product', 'this process', 'this solution',
    'this', 'that', 'these', 'those', 'it', 'they', 'he', 'she', 'here',
    'there', 'the issue', 'the problem', 'the method', 'the option',
    'the result', 'the same thing',
];

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findAmbiguousStart = (text: string, phrases: string[]) => {
    const prefixMatch = text.match(/^\s*["'“”«»()[\]{}]?\s*/u);
    const prefixLength = prefixMatch?.[0].length ?? 0;
    const textAfterPrefix = text.slice(prefixLength);

    const sortedPhrases = [...phrases].sort((a, b) => b.length - a.length);
    for (const phrase of sortedPhrases) {
        const regex = new RegExp(`^${escapeRegex(phrase)}(?=$|[\\s،,؛;:.!؟?])`, 'iu');
        const match = textAfterPrefix.match(regex);
        if (match) {
            return {
                fromIndex: prefixLength,
                toIndex: prefixLength + match[0].length,
                phrase: match[0],
            };
        }
    }

    return null;
};

export const checkAmbiguousParagraphReferences = (context: AnalysisContext): CheckResult => {
    const { nonEmptyParagraphs, t, articleLanguage, uiLanguage } = context;
    const tRule = t.structureAnalysis['إحالات غامضة'];
    const title = tRule.title;
    const description = tRule.description;
    const requiredText = tRule.required;
    const phrases = articleLanguage === 'ar' ? AR_AMBIGUOUS_STARTS : EN_AMBIGUOUS_STARTS;
    const details = uiLanguage === 'ar'
        ? '• يحذر من الفقرات التي تبدأ بضمير أو إحالة تحتاج إلى سياق سابق.\n• الأفضل أن تبدأ الفقرة باسم الموضوع أو الكيان المقصود بوضوح.\n• هذا معيار تحذيري لأن بعض الإحالات قد تكون صحيحة حسب السياق.'
        : '• Warns about paragraphs that begin with a pronoun or reference that needs prior context.\n• Prefer starting the paragraph with the topic or entity name clearly.\n• This is a warning rule because some references may be valid in context.';
    const warnings: { from: number; to: number; message: string }[] = [];

    nonEmptyParagraphs.forEach(paragraph => {
        const match = findAmbiguousStart(paragraph.text, phrases);
        if (!match) return;

        warnings.push({
            from: paragraph.pos + 1 + match.fromIndex,
            to: paragraph.pos + 1 + match.toIndex,
            message: t.violationMessages.ambiguousParagraphReference(match.phrase),
        });
    });

    if (warnings.length === 0) {
        return createCheckResult(title, 'pass', t.common.good, requiredText, 1, description, details);
    }

    const progress = nonEmptyParagraphs.length > 0
        ? (nonEmptyParagraphs.length - warnings.length) / nonEmptyParagraphs.length
        : 1;
    const result = createCheckResult(title, 'warn', `${warnings.length} ${t.common.warnings}`, requiredText, progress, description, details);
    result.violatingItems = warnings;
    return result;
};
