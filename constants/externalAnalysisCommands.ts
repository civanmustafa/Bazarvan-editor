import {
  ENGINEERING_PROMPT_DEFINITIONS,
  ENGINEERING_PROMPT_IDS,
} from './engineeringPrompts';

export const EXTERNAL_AUTOMATIC_COMMAND_IDS = [
  ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison,
  ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis,
  ENGINEERING_PROMPT_IDS.smartAnalysis.combinedCommands,
  ENGINEERING_PROMPT_IDS.smartAnalysis.repetitionAndFillerAudit,
  ENGINEERING_PROMPT_IDS.smartAnalysis.fullArticleAudit,
] as const;

const EXTERNAL_COMMAND_LABELS: Record<string, { ar: string; en: string }> = {
  entityMap: { ar: 'خريطة الكيانات', en: 'Entity map' },
  analyzeFull: { ar: 'تحليل المقالة كاملة', en: 'Full article audit' },
  contentSummaryForCompetitors: { ar: 'تلخيص المحتوى للمنافسين', en: 'Content summary for competitors' },
  competitorGapAnalysis: { ar: 'مقارنة محتوى المنافسين', en: 'Compare content with competitors' },
  competitorContentComparison: { ar: 'أفكار جديدة أو متضاربة مع المنافسين', en: 'New or conflicting competitor ideas' },
  combinedCommands: { ar: 'تجميعة الأوامر', en: 'Commands bundle' },
  improveConclusion: { ar: 'تحسين الخاتمة', en: 'Improve conclusion' },
  improveWeakest: { ar: 'تحسين أضعف قسم', en: 'Improve weakest section' },
  suggestNew: { ar: 'اقتراح فكرة جديدة', en: 'Suggest a new idea' },
  peopleQuestions: { ar: 'أسئلة الناس', en: 'People also ask' },
  structuredContent: { ar: 'فرص المحتوى المنظم', en: 'Structured content opportunities' },
  unsuitableSections: { ar: 'الأقسام غير المناسبة', en: 'Unsuitable sections' },
  repetitionAndFillerAudit: { ar: 'اكتشاف التكرار والحشو', en: 'Repetition and filler audit' },
  articleSectionOrder: { ar: 'ترتيب الأقسام', en: 'Section order analysis' },
};

const automaticOrder = new Map<string, number>(
  EXTERNAL_AUTOMATIC_COMMAND_IDS.map((id, index) => [id, index]),
);

export const EXTERNAL_READY_COMMAND_DEFINITIONS = ENGINEERING_PROMPT_DEFINITIONS
  .filter(definition => definition.source === 'smartAnalysis')
  .map((definition, definitionIndex) => ({ definition, definitionIndex }))
  .sort((left, right) => {
    const leftOrder = automaticOrder.get(left.definition.id);
    const rightOrder = automaticOrder.get(right.definition.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? EXTERNAL_AUTOMATIC_COMMAND_IDS.length)
        - (rightOrder ?? EXTERNAL_AUTOMATIC_COMMAND_IDS.length);
    }
    return left.definitionIndex - right.definitionIndex;
  })
  .map(item => item.definition);

export const getExternalReadyCommandDefinition = (commandId: string) => (
  EXTERNAL_READY_COMMAND_DEFINITIONS.find(definition => definition.id === commandId) ?? null
);

export const getExternalReadyCommandLabel = (
  commandId: string,
  locale: 'ar' | 'en' = 'ar',
): string => {
  const definition = getExternalReadyCommandDefinition(commandId);
  if (!definition) return commandId;
  return EXTERNAL_COMMAND_LABELS[definition.labelKey]?.[locale] || definition.labelKey;
};
