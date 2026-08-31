import {
  contentWritingKnowledgeToPromptJson,
  type ContentWritingCoverageAudit,
  type ContentWritingKnowledgeBase,
  type ContentWritingSectionCoverage,
  type ContentWritingSourceChunk,
} from './contentWritingKnowledge';
import type { ContentWritingClaimLedgerItem } from './contentWritingClaims';
import type {
  ContentWritingRevisionDocument,
  ContentWritingRevisionPlan,
} from './contentWritingRevision';
import {
  getPromptTemplate,
  PROMPT_TEMPLATE_IDS,
  renderPromptTemplate,
} from '../constants/promptRegistry';
import {
  getContentWritingBodyWordBudget,
  type ContentWritingWordRange,
} from './contentWritingTargets';
import {
  competitorPhraseIntelligenceToPromptJson,
  type CompetitorPhraseIntelligenceResult,
} from './competitorPhraseAnalysis';
import type { GoalContext, Keywords } from '../types';
import { getContentWritingFinalSectionKind } from './goalContext';
import {
  getContentWritingFaqIntentBlueprints,
  type ContentWritingFaqQuestionSeed,
} from './contentWritingFaq';
import {
  FAQ_KEYWORDS,
} from '../constants';
import { buildMetaDescriptionGenerationPrompt } from './metaDescription';

export const CONTENT_WRITING_WORKFLOW_VERSION = 14;
export const CONTENT_WRITING_MIN_OUTLINE_SECTIONS = 4;
export const CONTENT_WRITING_MAX_OUTLINE_SECTIONS = 12;
export const CONTENT_WRITING_MAX_TARGETED_SECTION_REPAIRS = CONTENT_WRITING_MAX_OUTLINE_SECTIONS;

type ContentWritingKeywordBrief = Pick<Keywords, 'primary' | 'secondaries' | 'lsi' | 'company'>;

const stringifyUntrustedPromptJson = (value: unknown): string => JSON.stringify(value, null, 2)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

const appendProtectedWritingProtocol = (
  prompt: string,
  options: {
    keywords?: ContentWritingKeywordBrief;
    qualityContract?: string;
    phase: 'outline' | 'section' | 'introduction' | 'conclusion';
    sectionIndex?: number;
  },
): string => {
  const keywords = options.keywords;
  const primary = String(keywords?.primary || '').trim();
  const company = String(keywords?.company || '').trim();
  const secondaries = (keywords?.secondaries || []).map(value => String(value || '').trim()).filter(Boolean);
  const lsi = (keywords?.lsi || []).map(value => String(value || '').trim()).filter(Boolean);
  const sectionIndex = Math.max(0, Math.round(options.sectionIndex || 0));
  const assignedSecondary = secondaries.length > 0 ? secondaries[sectionIndex % secondaries.length] : '';
  const assignedLsi = lsi.length > 0
    ? Array.from(new Set([
        lsi[sectionIndex % lsi.length],
        lsi[(sectionIndex + 1) % lsi.length],
      ].filter(Boolean)))
    : [];
  const keywordInstructions = options.phase === 'outline'
    ? [
        'وزّع الكلمات على الأقسام قبل الكتابة: خصص الكلمة الأساسية طبيعيًا لأقسام المتن، ووزّع الصيغ البديلة وLSI بالتناوب، وحدد مواضع اسم الشركة دون حشو.',
        `الكلمة الأساسية: ${primary || 'غير محددة'}`,
        `الصيغ البديلة: ${secondaries.join(' | ') || 'لا يوجد'}`,
        `كلمات LSI: ${lsi.join(' | ') || 'لا يوجد'}`,
        `اسم الشركة: ${company || 'غير محدد'}`,
      ]
    : options.phase === 'section'
      ? [
          primary ? `استخدم الكلمة الأساسية مرة واحدة طبيعيًا في متن هذا القسم: ${primary}` : '',
          assignedSecondary ? `استخدم هذه الصيغة البديلة مرة واحدة إذا بقي السياق طبيعيًا: ${assignedSecondary}` : '',
          assignedLsi.length > 0 ? `ادمج 1-2 من مصطلحات LSI التالية دون حشو: ${assignedLsi.join(' | ')}` : '',
          company && (sectionIndex === 0) ? `اذكر اسم الشركة مرة واحدة في سياق مفيد: ${company}` : '',
        ]
      : options.phase === 'introduction'
        ? [
            primary ? `استخدم الكلمة الأساسية مرة واحدة في المقدمة: ${primary}` : '',
            secondaries[0] ? `يمكن استخدام الصيغة البديلة التالية مرة واحدة إن كانت طبيعية: ${secondaries[0]}` : '',
            lsi[0] ? `يمكن دمج مصطلح LSI التالي دون حشو: ${lsi[0]}` : '',
          ]
        : [
            primary ? `استخدم الكلمة الأساسية مرة واحدة في الخاتمة: ${primary}` : '',
            company ? `اذكر اسم الشركة مرة واحدة في سياق الخاتمة: ${company}` : '',
          ];
  const qualityBlock = options.qualityContract
    ? `\n<protected_quality_contract>\n${options.qualityContract}\n</protected_quality_contract>`
    : '';
  return `${prompt}\n\n<protected_keyword_and_source_protocol>\n${keywordInstructions.filter(Boolean).map(value => `- ${value}`).join('\n')}
- لا تكتب سعرًا أو رقمًا ماليًا أو قيمة زمنية حالية إلا من ادعاء مسموح تدعمه مادة رسمية أو أولية حالية في سجل الادعاءات.
- أي ادعاء usagePolicy=blocked محظور تمامًا، ولا يكفي تخفيف صياغته أو نسبه إلى مصدر منافس.
- حافظ على طبيعية النص؛ لا تكرر كلمة لمجرد استيفاء التوزيع إذا أدى ذلك إلى حشو.
</protected_keyword_and_source_protocol>${qualityBlock}`;
};

export type ContentWritingWorkflowStepType =
  | 'competitor_index'
  | 'outline'
  | 'section'
  | 'introduction'
  | 'conclusion'
  | 'call_to_action'
  | 'faq'
  | 'coverage_audit'
  | 'section_repair'
  | 'final_review'
  | 'quality_repair'
  | 'meta_description';

export type ContentWritingOutlineSection = {
  title: string;
  brief: string;
  targetWords?: number;
  subheadings?: string[];
  requiredIdeaIds?: string[];
  requiredClaimIds?: string[];
  sourceChunkIds?: string[];
};

export type ContentWritingOutline = {
  sections: ContentWritingOutlineSection[];
};

export type ContentWritingWorkflowStepDefinition = {
  key: string;
  type: ContentWritingWorkflowStepType;
  ordinal: number;
  title: string;
  metadata: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 2_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const stripCodeFence = (value: string): string => value
  .trim()
  .replace(/^```(?:json|markdown|md)?\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  const normalized = stripCodeFence(value);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return null;
};

export const normalizeContentWritingOutline = (value: unknown): ContentWritingOutline | null => {
  const source = typeof value === 'string' ? parseJsonObject(value) : isRecord(value) ? value : null;
  if (!source || !Array.isArray(source.sections)) return null;
  const seen = new Set<string>();
  const sections = source.sections.flatMap((item): ContentWritingOutlineSection[] => {
    const rawTitle = typeof item === 'string'
      ? toText(item, 300)
      : isRecord(item)
        ? toText(item.title, 300)
        : '';
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    const normalizedTitle = title.toLocaleLowerCase();
    if (!title || seen.has(normalizedTitle)) return [];
    seen.add(normalizedTitle);
    const brief = isRecord(item) ? toText(item.brief, 1_200) : '';
    const targetWords = isRecord(item) && Number.isFinite(Number(item.targetWords))
      ? Math.max(80, Math.min(Math.round(Number(item.targetWords)), 300))
      : undefined;
    const subheadings = isRecord(item) && Array.isArray(item.subheadings)
      ? item.subheadings.map(value => toText(value, 300)).filter(Boolean).slice(0, 4)
      : [];
    const requiredIdeaIds = isRecord(item) && Array.isArray(item.requiredIdeaIds)
      ? Array.from(new Set(item.requiredIdeaIds.map(value => toText(value, 120)).filter(Boolean))).slice(0, 100)
      : [];
    const requiredClaimIds = isRecord(item) && Array.isArray(item.requiredClaimIds)
      ? Array.from(new Set(item.requiredClaimIds.map(value => toText(value, 120)).filter(Boolean))).slice(0, 100)
      : [];
    const sourceChunkIds = isRecord(item) && Array.isArray(item.sourceChunkIds)
      ? Array.from(new Set(item.sourceChunkIds.map(value => toText(value, 120)).filter(Boolean))).slice(0, 100)
      : [];
    return [{
      title,
      brief: brief || title,
      ...(targetWords ? { targetWords } : {}),
      ...(subheadings.length > 0 ? { subheadings } : {}),
      ...(requiredIdeaIds.length > 0 ? { requiredIdeaIds } : {}),
      ...(requiredClaimIds.length > 0 ? { requiredClaimIds } : {}),
      ...(sourceChunkIds.length > 0 ? { sourceChunkIds } : {}),
    }];
  }).slice(0, CONTENT_WRITING_MAX_OUTLINE_SECTIONS);
  if (sections.length < CONTENT_WRITING_MIN_OUTLINE_SECTIONS) return null;
  return { sections };
};

export const parseContentWritingOutline = (value: string): ContentWritingOutline => {
  const outline = normalizeContentWritingOutline(value);
  if (!outline) {
    throw new Error(
      `The outline must be valid JSON with ${CONTENT_WRITING_MIN_OUTLINE_SECTIONS}-${CONTENT_WRITING_MAX_OUTLINE_SECTIONS} unique sections.`,
    );
  }
  return outline;
};

export const getContentWritingCompetitorIndexStep = (): ContentWritingWorkflowStepDefinition => ({
  key: 'competitor-index',
  type: 'competitor_index',
  ordinal: 1,
  title: 'Competitor coverage and claim ledger',
  metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
});

export const getContentWritingOutlineStep = (): ContentWritingWorkflowStepDefinition => ({
  key: 'outline',
  type: 'outline',
  ordinal: 2,
  title: 'Article outline',
  metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
});

const comparableWords = (value: string): Set<string> => new Set(
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3),
);

const similarityScore = (left: string, right: string): number => {
  const leftWords = comparableWords(left);
  const rightWords = comparableWords(right);
  let score = 0;
  leftWords.forEach(word => {
    if (rightWords.has(word)) score += 1;
  });
  return score;
};

export const ensureContentWritingOutlineKnowledgeCoverage = (
  outline: ContentWritingOutline,
  knowledge: ContentWritingKnowledgeBase,
): ContentWritingOutline => {
  const validIdeaIds = new Set(knowledge.items.map(item => item.id));
  const usableClaims = knowledge.claimLedger.claims.filter(claim => claim.usagePolicy !== 'blocked');
  const validClaimIds = new Set(usableClaims.map(claim => claim.id));
  const assigned = new Set<string>();
  const assignedClaims = new Set<string>();
  const sections = outline.sections.map(section => {
    const requiredIdeaIds = (section.requiredIdeaIds || [])
      .filter(id => validIdeaIds.has(id) && !assigned.has(id));
    requiredIdeaIds.forEach(id => assigned.add(id));
    const requiredClaimIds = (section.requiredClaimIds || [])
      .filter(id => validClaimIds.has(id) && !assignedClaims.has(id));
    requiredClaimIds.forEach(id => assignedClaims.add(id));
    const sourceChunkIds = Array.from(new Set([
      ...(section.sourceChunkIds || []),
      ...knowledge.items
        .filter(item => requiredIdeaIds.includes(item.id))
        .flatMap(item => item.sourceChunkIds),
      ...usableClaims
        .filter(claim => requiredClaimIds.includes(claim.id))
        .flatMap(claim => claim.supportingSourceChunkIds),
    ]));
    return { ...section, requiredIdeaIds, requiredClaimIds, sourceChunkIds };
  });

  knowledge.items.forEach(item => {
    if (assigned.has(item.id)) return;
    const bestIndex = sections
      .map((section, index) => ({
        index,
        score: similarityScore(
          `${item.topic}\n${item.detail}`,
          `${section.title}\n${section.brief}\n${(section.subheadings || []).join('\n')}`,
        ),
        load: section.requiredIdeaIds?.length || 0,
      }))
      .sort((left, right) => right.score - left.score || left.load - right.load || left.index - right.index)[0]?.index || 0;
    const section = sections[bestIndex];
    section.requiredIdeaIds = [...(section.requiredIdeaIds || []), item.id];
    section.sourceChunkIds = Array.from(new Set([
      ...(section.sourceChunkIds || []),
      ...item.sourceChunkIds,
    ]));
    assigned.add(item.id);
  });
  usableClaims.forEach(claim => {
    if (assignedClaims.has(claim.id)) return;
    const bestIndex = sections
      .map((section, index) => ({
        index,
        linkedIdeaCount: claim.knowledgeItemIds
          .filter(id => (section.requiredIdeaIds || []).includes(id)).length,
        score: similarityScore(
          claim.statement,
          `${section.title}\n${section.brief}\n${(section.subheadings || []).join('\n')}`,
        ),
        load: section.requiredClaimIds?.length || 0,
      }))
      .sort((left, right) => (
        right.linkedIdeaCount - left.linkedIdeaCount
        || right.score - left.score
        || left.load - right.load
        || left.index - right.index
      ))[0]?.index || 0;
    const section = sections[bestIndex];
    section.requiredClaimIds = [...(section.requiredClaimIds || []), claim.id];
    section.sourceChunkIds = Array.from(new Set([
      ...(section.sourceChunkIds || []),
      ...claim.supportingSourceChunkIds,
    ]));
    assignedClaims.add(claim.id);
  });
  return { sections };
};

export const fitContentWritingOutlineSectionRange = (
  outline: ContentWritingOutline,
  knowledge: ContentWritingKnowledgeBase,
  range: ContentWritingWordRange,
): ContentWritingOutline => {
  const minimum = Math.max(CONTENT_WRITING_MIN_OUTLINE_SECTIONS, Math.round(range.min));
  const maximum = Math.max(minimum, Math.min(CONTENT_WRITING_MAX_OUTLINE_SECTIONS, Math.round(range.max)));
  let sections = outline.sections.map(section => ({ ...section }));

  if (sections.length > maximum) {
    const retained = sections.slice(0, maximum);
    const mergeTarget = retained[retained.length - 1];
    sections.slice(maximum).forEach(overflow => {
      mergeTarget.brief = [mergeTarget.brief, overflow.title, overflow.brief]
        .filter(Boolean)
        .join('\n');
      mergeTarget.subheadings = Array.from(new Set([
        ...(mergeTarget.subheadings || []),
        overflow.title,
        ...(overflow.subheadings || []),
      ])).slice(0, 12);
      mergeTarget.requiredIdeaIds = Array.from(new Set([
        ...(mergeTarget.requiredIdeaIds || []),
        ...(overflow.requiredIdeaIds || []),
      ]));
      mergeTarget.requiredClaimIds = Array.from(new Set([
        ...(mergeTarget.requiredClaimIds || []),
        ...(overflow.requiredClaimIds || []),
      ]));
      mergeTarget.sourceChunkIds = Array.from(new Set([
        ...(mergeTarget.sourceChunkIds || []),
        ...(overflow.sourceChunkIds || []),
      ]));
    });
    sections = retained;
  }

  const existingTitles = new Set(sections.map(section => section.title.toLocaleLowerCase()));
  const candidates = knowledge.items
    .filter(item => !existingTitles.has(item.topic.toLocaleLowerCase()))
    .sort((left, right) => (
      (right.priority === 'high' ? 2 : right.priority === 'medium' ? 1 : 0)
      - (left.priority === 'high' ? 2 : left.priority === 'medium' ? 1 : 0)
      || right.coverageCount - left.coverageCount
    ));
  while (sections.length < minimum && candidates.length > 0) {
    const item = candidates.shift();
    if (!item) break;
    existingTitles.add(item.topic.toLocaleLowerCase());
    sections.push({
      title: item.topic,
      brief: item.detail,
      requiredIdeaIds: [item.id],
      sourceChunkIds: [...item.sourceChunkIds],
    });
  }

  // This fallback is only reachable when the model returned at least four valid
  // sections but the knowledge index has no unused topic to fill a stricter policy.
  while (sections.length < minimum && sections.length > 0) {
    const source = sections[sections.length % outline.sections.length];
    const ordinal = sections.length + 1;
    sections.push({
      title: `${source.title} (${ordinal})`,
      brief: source.brief,
      subheadings: source.subheadings ? [...source.subheadings] : undefined,
    });
  }

  return { sections };
};

export const balanceContentWritingOutlineWordTargets = (
  outline: ContentWritingOutline,
  targetWords: ContentWritingWordRange,
): ContentWritingOutline => {
  if (outline.sections.length === 0) return outline;
  const bodyBudget = getContentWritingBodyWordBudget(targetWords);
  const desiredBodyWords = Math.max(
    outline.sections.length * 80,
    Math.min(
      Math.round((bodyBudget.min + bodyBudget.max) / 2),
      outline.sections.length * 300,
    ),
  );
  const weights = outline.sections.map(section => Math.max(
    1,
    1
      + ((section.requiredIdeaIds?.length || 0) * 0.8)
      + ((section.requiredClaimIds?.length || 0) * 0.25)
      + ((section.subheadings?.length || 0) * 0.35),
  ));
  const targets = outline.sections.map(() => 80);
  let remaining = desiredBodyWords - targets.reduce((sum, value) => sum + value, 0);

  while (remaining > 0) {
    const activeIndexes = targets
      .map((value, index) => ({ value, index }))
      .filter(item => item.value < 300)
      .map(item => item.index);
    if (activeIndexes.length === 0) break;
    const activeWeight = activeIndexes.reduce((sum, index) => sum + weights[index], 0);
    let distributed = 0;
    activeIndexes.forEach(index => {
      const proportional = Math.max(
        1,
        Math.floor((remaining * weights[index]) / Math.max(1, activeWeight)),
      );
      const increment = Math.min(300 - targets[index], proportional, remaining - distributed);
      if (increment <= 0) return;
      targets[index] += increment;
      distributed += increment;
    });
    if (distributed <= 0) break;
    remaining -= distributed;
  }

  return {
    sections: outline.sections.map((section, index) => ({
      ...section,
      targetWords: targets[index],
    })),
  };
};

export const createContentWritingWorkflowSteps = (
  outline: ContentWritingOutline,
  goalContext?: Partial<GoalContext> | null,
): ContentWritingWorkflowStepDefinition[] => {
  const sectionSteps = outline.sections.map((section, index) => ({
    key: `section-${String(index + 1).padStart(2, '0')}`,
    type: 'section' as const,
    ordinal: index + 3,
    title: section.title,
    metadata: {
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      sectionIndex: index + 1,
      sectionCount: outline.sections.length,
      section,
    },
  }));
  const nextOrdinal = sectionSteps.length + 3;
  const finalSectionKind = getContentWritingFinalSectionKind(goalContext);
  const finalSectionDefinition: ContentWritingWorkflowStepDefinition = finalSectionKind === 'call_to_action'
    ? {
        key: 'call-to-action',
        type: 'call_to_action',
        ordinal: nextOrdinal + 2,
        title: 'Call to action',
        metadata: {
          workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
          finalSectionKind,
          pageType: String(goalContext?.pageType || ''),
        },
      }
    : {
        key: 'conclusion',
        type: 'conclusion',
        ordinal: nextOrdinal + 2,
        title: 'Conclusion',
        metadata: {
          workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
          finalSectionKind,
          pageType: String(goalContext?.pageType || ''),
        },
      };
  return [
    getContentWritingCompetitorIndexStep(),
    getContentWritingOutlineStep(),
    ...sectionSteps,
    {
      key: 'introduction',
      type: 'introduction',
      ordinal: nextOrdinal,
      title: 'Introduction',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
    {
      key: 'faq',
      type: 'faq',
      ordinal: nextOrdinal + 1,
      title: 'Frequently asked questions',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
    finalSectionDefinition,
    {
      key: 'coverage-audit',
      type: 'coverage_audit',
      ordinal: nextOrdinal + 3,
      title: 'Knowledge coverage audit',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
    {
      key: 'final-review',
      type: 'final_review',
      ordinal: nextOrdinal + 4,
      title: 'Final review',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
    {
      key: 'meta-description-suggestions',
      type: 'meta_description',
      ordinal: nextOrdinal + 5,
      title: 'Meta-description suggestions',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION, suggestionCount: 2 },
    },
  ];
};

const outlineJson = (outline: ContentWritingOutline): string => JSON.stringify(outline, null, 2);

export const buildContentWritingCompetitorIndexPrompt = (options: {
  chunks: readonly ContentWritingSourceChunk[];
  language: string;
  template?: string;
  sourceClaimsTemplate?: string;
  competitorPhraseIntelligence?: CompetitorPhraseIntelligenceResult | null;
  extractionPass?: 1 | 2;
}): string => {
  const variables = {
    source_ids_json: JSON.stringify(options.chunks.map(chunk => chunk.id)),
    competitor_phrase_intelligence_json: competitorPhraseIntelligenceToPromptJson(
      options.competitorPhraseIntelligence || null,
    ),
    output_language: options.language === 'en' ? 'اللغة الإنجليزية' : 'اللغة العربية',
  };
  const extractionPassProtocol = options.extractionPass
    ? `
<protected_knowledge_extraction_pass>
- هذه قراءة مستقلة رقم ${options.extractionPass} من المصادر باسم «${options.extractionPass === 1 ? 'القراءة الشاملة المباشرة' : 'قراءة صيد الثغرات'}». لا تفترض وجود قراءة أخرى ولا تحاول تخمين نتيجتها.
${options.extractionPass === 1
  ? '- استخدم منهج التغطية الشاملة المباشرة، وسجّل كل فكرة ذرية مفيدة مع مصدرها.'
  : '- استخدم منهج صائد الثغرات: ركّز على التفاصيل الفريدة والجداول والخطوات والشروط والاستثناءات والأرقام والأسئلة وطرق الاستخدام والشراء والدفع والتعارضات التي يسهل إغفالها.'}
- افحص كل معرّف مقطع في القائمة، واحتفظ بالمعلومة الفريدة المدعومة حتى إن ظهرت لدى منافس واحد فقط.
- لا تكتب عن عملية القراءتين داخل JSON، والتزم بعقد الإخراج الأصلي.
</protected_knowledge_extraction_pass>`
    : '';
  return [
    renderPromptTemplate(
      options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.competitorIndex),
      variables,
    ),
    renderPromptTemplate(
      options.sourceClaimsTemplate
        || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.sourceClaimsLedger),
      variables,
    ),
    extractionPassProtocol,
  ].filter(Boolean).join('\n\n');
};

export const buildContentWritingKnowledgeReconciliationPrompt = (options: {
  firstPass: ContentWritingKnowledgeBase;
  secondPass: ContentWritingKnowledgeBase;
  chunks: readonly ContentWritingSourceChunk[];
  language: string;
  template?: string;
}): string => {
  const compactExtraction = (knowledge: ContentWritingKnowledgeBase): string => JSON.stringify({
    processedChunkIds: knowledge.modelProcessedChunkIds,
    fallbackChunkIds: knowledge.fallbackChunkIds,
    items: knowledge.items,
    sourceAssessments: knowledge.sourceRegistry.sources.map(source => ({
      competitorNumber: source.competitorNumber,
      category: source.category,
      freshness: source.freshness,
      assessmentNotes: source.assessmentNotes,
    })),
    claims: knowledge.claimLedger.claims,
  }, null, 2);
  return renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.knowledgeReconciliation),
    {
      output_language: options.language === 'en' ? 'اللغة الإنجليزية' : 'اللغة العربية',
      source_ids_json: JSON.stringify(options.chunks.map(chunk => chunk.id)),
      first_knowledge_json: compactExtraction(options.firstPass),
      second_knowledge_json: compactExtraction(options.secondPass),
    },
  );
};

export const buildContentWritingOutlinePrompt = (options: {
  articleTitle: string;
  language: string;
  knowledge: ContentWritingKnowledgeBase;
  qualityContract?: string;
  targetWords?: ContentWritingWordRange;
  minimumSections?: number;
  maximumSections?: number;
  keywords?: ContentWritingKeywordBrief;
  template?: string;
}): string => {
  const rendered = renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.outline),
    {
    ...(() => {
      const targetWords = options.targetWords || { min: 1_100, max: 1_450 };
      const bodyBudget = getContentWritingBodyWordBudget(targetWords);
      return {
        target_word_range: `${targetWords.min}-${targetWords.max}`,
        body_word_budget_range: `${bodyBudget.min}-${bodyBudget.max}`,
      };
    })(),
    article_title: options.articleTitle,
    knowledge_json: contentWritingKnowledgeToPromptJson(options.knowledge),
    quality_contract_block: options.qualityContract
      ? `عقد الجودة الإلزامي:\n${options.qualityContract}`
      : '',
    output_language: options.language === 'en' ? 'اللغة الإنجليزية' : 'اللغة العربية',
    minimum_sections: options.minimumSections || CONTENT_WRITING_MIN_OUTLINE_SECTIONS,
    maximum_sections: options.maximumSections || CONTENT_WRITING_MAX_OUTLINE_SECTIONS,
    },
  );
  return appendProtectedWritingProtocol(
    rendered,
    { keywords: options.keywords, qualityContract: options.qualityContract, phase: 'outline' },
  );
};

export const buildContentWritingSectionPrompt = (options: {
  outline: ContentWritingOutline;
  section: ContentWritingOutlineSection;
  sectionIndex: number;
  previousSection?: string;
  knowledgeItems: ContentWritingKnowledgeBase['items'];
  claims: ContentWritingClaimLedgerItem[];
  sourceChunks: readonly ContentWritingSourceChunk[];
  coverageLedger: {
    coveredIdeaIds: string[];
    usedClaimIds: string[];
    previousSectionSummaries: Array<{
      sectionKey: string;
      title: string;
      coveredIdeaIds: string[];
      usedClaimIds: string[];
    }>;
  };
  keywords?: ContentWritingKeywordBrief;
  qualityContract?: string;
  template?: string;
}): string => {
  const rendered = renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.bodySection),
    {
    section_number: options.sectionIndex + 1,
    section_count: options.outline.sections.length,
    outline_json: outlineJson(options.outline),
    section_title: options.section.title,
    section_brief: options.section.brief,
    target_words: options.section.targetWords || 140,
    subheadings_line: options.section.subheadings?.length
      ? `- عناوين H3 المطلوبة: ${options.section.subheadings.join(' | ')}`
      : '- لا تستخدم H3 إلا إذا احتاجه عقد الجودة.',
    required_idea_ids: (options.section.requiredIdeaIds || []).join(', ') || 'لا يوجد',
    required_claim_ids: (options.section.requiredClaimIds || []).join(', ') || 'لا يوجد',
    knowledge_items_json: JSON.stringify(options.knowledgeItems, null, 2),
    claims_ledger_json: JSON.stringify(options.claims, null, 2),
    source_chunks_json: stringifyUntrustedPromptJson(options.sourceChunks.map(chunk => ({
      sourceId: chunk.id,
      competitorNumber: chunk.competitorNumber,
      title: chunk.title,
      url: chunk.url,
      sourceKind: chunk.sourceKind || 'competitor',
      sourceRole: chunk.sourceRole || null,
      writingSourceId: chunk.sourceId || null,
      text: chunk.text,
    }))),
    coverage_ledger_json: JSON.stringify(options.coverageLedger, null, 2),
    previous_section_block: options.previousSection
      ? `القسم السابق كاملًا للترابط فقط:\n<previous_section>\n${options.previousSection}\n</previous_section>`
      : '',
    },
  );
  return appendProtectedWritingProtocol(rendered, {
    keywords: options.keywords,
    qualityContract: options.qualityContract,
    phase: 'section',
    sectionIndex: options.sectionIndex,
  });
};

export const buildContentWritingCoverageAuditPrompt = (options: {
  outline: ContentWritingOutline;
  knowledge: ContentWritingKnowledgeBase;
  draft: string;
  sectionCoverages: Array<{
    sectionKey: string;
    title: string;
    coverage: ContentWritingSectionCoverage;
  }>;
  deterministicMissingIdeaIds: string[];
  deterministicBlockedClaimIds: string[];
  template?: string;
}): string => {
  const rendered = renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.coverageAudit),
    {
    outline_json: outlineJson(options.outline),
    knowledge_json: contentWritingKnowledgeToPromptJson(options.knowledge),
    section_coverages_json: JSON.stringify(options.sectionCoverages, null, 2),
    missing_idea_ids_json: JSON.stringify(options.deterministicMissingIdeaIds),
    blocked_claim_ids_json: JSON.stringify(options.deterministicBlockedClaimIds),
    completed_draft: options.draft,
    max_repairs: CONTENT_WRITING_MAX_TARGETED_SECTION_REPAIRS,
    },
  );
  return rendered;
};

export const buildContentWritingSectionRepairPrompt = (options: {
  outline: ContentWritingOutline;
  section: ContentWritingOutlineSection;
  sectionKey: string;
  originalMarkdown: string;
  repair: ContentWritingCoverageAudit['repairs'][number];
  knowledgeItems: ContentWritingKnowledgeBase['items'];
  claims: ContentWritingClaimLedgerItem[];
  sourceChunks: readonly ContentWritingSourceChunk[];
  template?: string;
}): string => {
  const rendered = renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.sectionRepair),
    {
    section_key: options.sectionKey,
    section_json: JSON.stringify(options.section, null, 2),
    repair_instructions: options.repair.instructions,
    knowledge_items_json: JSON.stringify(options.knowledgeItems, null, 2),
    claims_ledger_json: JSON.stringify(options.claims, null, 2),
    source_chunks_json: stringifyUntrustedPromptJson(
      options.sourceChunks.map(chunk => ({
        sourceId: chunk.id,
        sourceKind: chunk.sourceKind || 'competitor',
        sourceRole: chunk.sourceRole || null,
        writingSourceId: chunk.sourceId || null,
        text: chunk.text,
      })),
    ),
    original_section_markdown: options.originalMarkdown,
    },
  );
  return rendered;
};

export const buildContentWritingIntroductionPrompt = (options: {
  outline: ContentWritingOutline;
  bodyDraft: string;
  keywords?: ContentWritingKeywordBrief;
  qualityContract?: string;
  template?: string;
}): string => appendProtectedWritingProtocol(renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.introduction),
    {
    outline_json: outlineJson(options.outline),
    body_draft: options.bodyDraft,
    },
  ), { keywords: options.keywords, qualityContract: options.qualityContract, phase: 'introduction' });

export const buildContentWritingConclusionPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
  keywords?: ContentWritingKeywordBrief;
  qualityContract?: string;
  template?: string;
}): string => appendProtectedWritingProtocol(renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.conclusion),
    {
    outline_json: outlineJson(options.outline),
    completed_draft: options.draft,
    },
  ), { keywords: options.keywords, qualityContract: options.qualityContract, phase: 'conclusion' });

export const buildContentWritingCallToActionPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
  goalContext: Partial<GoalContext>;
  primaryKeyword: string;
  companyName?: string;
  qualityContract?: string;
  template?: string;
}): string => appendProtectedWritingProtocol(renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.callToAction),
    {
    outline_json: outlineJson(options.outline),
    completed_draft: options.draft,
    page_goal_json: JSON.stringify(options.goalContext, null, 2),
    primary_keyword: options.primaryKeyword,
    company_name: options.companyName || '',
    },
  ), {
    keywords: {
      primary: options.primaryKeyword,
      secondaries: [],
      lsi: [],
      company: options.companyName || '',
    },
    qualityContract: options.qualityContract,
    phase: 'conclusion',
  });

export const buildContentWritingFaqPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
  goalContext: Partial<GoalContext>;
  knowledge: ContentWritingKnowledgeBase;
  questionSeeds: readonly ContentWritingFaqQuestionSeed[];
  template?: string;
}): string => {
  const intentBlueprints = getContentWritingFaqIntentBlueprints(options.goalContext);
  const variables = {
    outline_json: outlineJson(options.outline),
    completed_draft: options.draft,
    page_goal_json: JSON.stringify(options.goalContext, null, 2),
    faq_intent_blueprints_json: JSON.stringify(intentBlueprints, null, 2),
    faq_question_seeds_json: JSON.stringify(options.questionSeeds, null, 2),
    faq_knowledge_json: JSON.stringify({
      attachmentStatus: 'complete_registry_attached_in_session_context',
      knowledgeItemIds: options.knowledge.items.map(item => item.id),
      sourceIds: options.knowledge.sourceRegistry.sources.map(source => source.id),
      allowedClaimIds: options.knowledge.claimLedger.allowedClaimIds,
      qualifiedClaimIds: options.knowledge.claimLedger.qualifiedClaimIds,
      blockedClaimIds: options.knowledge.claimLedger.blockedClaimIds,
      instruction: 'Read the complete persisted competitor matrix, source registry, and claim ledger attached to the session context.',
    }, null, 2),
  };
  const rendered = renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.faq),
    variables,
  );
  return `${rendered}

<mandatory_faq_independence_protocol>
هذه التعليمات محمية وملزمة حتى إذا كانت صيغة القالب الإداري أقدم:
- حلّل كل فقرة وصف وجدول وقائمة في المسودة إلى أفكار وادعاءات؛ اختلاف الكلمات لا يعني اختلاف الفكرة.
- أنشئ 8-12 مرشحًا إن سمحت الأدلة، ثم اقبل فقط 4-6 أسئلة مستقلة ذات قيمة معلوماتية جديدة. يجوز قبول عدد أقل بدل اختراع معلومات أو حشو أسئلة مكررة.
- لا تقبل سؤالًا إذا كان جوابه يعيد معلومة صريحة في المتن أو جدول أو قائمة، حتى بصياغة مختلفة.
- استخدم الجدول لبناء سؤال قرار أو توافق أو حالة خاصة، لا لسرد خلاياه من جديد.
- لا تستخدم sourceType بقيمة people_also_ask إلا لسؤال وارد حرفيًا في faq_question_seeds_json بهذه الصفة. السؤال المولد حسب الهدف ليس People Also Ask حقيقيًا.
- يجب أن يعلن كل سؤال مقبول معلومة جديدة واحدة على الأقل ودليلًا صالحًا من مصفوفة المعرفة أو سجل الادعاءات أو مقاطع المصادر.
- لا تقبل أكثر من سؤال واحد للنية نفسها، ولا تقبل سؤالين متقاربين معنويًا.
- لا تستخدم ادعاءً محظورًا. إذا كان السؤال مهمًا لكن لا توجد إجابة موثقة، اجعله needs_information ولا تكتب جوابًا.
- informationGainScore وbodySimilarityScore وfaqSimilarityScore أرقام من 0 إلى 1، مبنية على المعنى لا على التطابق اللفظي فقط.
- كل جواب مقبول 35-75 كلمة و2-3 جمل، بصياغة أصلية مباشرة، دون دعوة بيع مكررة.

أرجع JSON صالحًا فقط بهذا الشكل، دون Markdown أو شرح خارجه:
{
  "candidates": [
    {
      "id": "FAQC001",
      "question": "السؤال",
      "answer": "الجواب، أو فارغ عند الرفض/نقص المعلومات",
      "intent": "selection|compatibility|usage|purchase|payment|shipping|returns|warranty|pricing|requirements|process|timing|troubleshooting|safety|comparison|eligibility|support|implications|privacy|cancellation|other",
      "sourceType": "people_also_ask|competitor_question|knowledge_matrix|page_context|goal_based_extension",
      "sourceLabel": "وصف مفهوم للمصدر",
      "decision": "accepted|rejected|needs_information",
      "decisionReason": "سبب واضح للمستخدم",
      "newInformation": ["المعلومة الجديدة الدقيقة"],
      "nearestArticleExcerpt": "أقرب فكرة موجودة في المتن",
      "informationGainScore": 0.75,
      "bodySimilarityScore": 0.25,
      "faqSimilarityScore": 0.10,
      "evidenceIdeaIds": ["K001"],
      "usedClaimIds": ["CL001"],
      "sourceChunkIds": ["C1-S001"]
    }
  ]
}
</mandatory_faq_independence_protocol>`;
};

export const buildContentWritingFinalReviewPrompt = (options: {
  articleTitle: string;
  draft: string;
  knowledge?: ContentWritingKnowledgeBase;
  coverageAudit?: ContentWritingCoverageAudit;
  qualityContract?: string;
  qualityReportJson?: string;
  documentTargetsJson?: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.finalReview),
  {
    article_title: options.articleTitle,
    quality_contract_block: options.qualityContract
      ? `عقد الجودة البرمجي:\n${options.qualityContract}`
      : '',
    quality_report_json: options.qualityReportJson || '{}',
    knowledge_json: options.knowledge ? contentWritingKnowledgeToPromptJson(options.knowledge) : '{}',
    coverage_audit_json: JSON.stringify(options.coverageAudit || {}, null, 2),
    document_targets_json: options.documentTargetsJson || '[]',
    assembled_draft: options.draft,
  },
);

export const buildContentWritingRevisionApplyPrompt = (options: {
  plan: ContentWritingRevisionPlan;
  document: ContentWritingRevisionDocument;
  knowledge: ContentWritingKnowledgeBase;
  qualityContract?: string;
  language: string;
  template?: string;
}): string => {
  const targetIds = new Set(options.plan.operations.map(operation => operation.targetId));
  const targetSegments = options.document.targets
    .filter(target => targetIds.has(target.id))
    .map(target => ({
      id: target.id,
      regionId: target.regionId,
      sectionKey: target.sectionKey || null,
      kind: target.kind,
      heading: target.heading,
      markdown: target.markdown,
    }));
  const requiredIdeaIds = new Set(
    options.plan.operations.flatMap(operation => operation.requiredIdeaIds),
  );
  const knowledgeItems = options.knowledge.items.filter(item => requiredIdeaIds.has(item.id));
  return renderPromptTemplate(
    options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.revisionApply),
    {
      language_instruction: options.language === 'en'
        ? 'اكتب النصوص البديلة باللغة الإنجليزية.'
        : 'اكتب النصوص البديلة باللغة العربية.',
      quality_contract: options.qualityContract || '- حافظ على جودة النسخة السابقة ولا تُدخل مخالفة جديدة.',
      revision_plan_json: JSON.stringify(options.plan, null, 2),
      target_segments_json: JSON.stringify(targetSegments, null, 2),
      knowledge_items_json: JSON.stringify(knowledgeItems, null, 2),
      claim_ledger_json: JSON.stringify(options.knowledge.claimLedger, null, 2),
    },
  );
};

export const buildContentWritingMetaDescriptionSuggestionsPrompt = (options: {
  articleTitle: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  finalArticle: string;
  goalContext: Record<string, unknown>;
  template?: string;
  previousInvalidResponse?: string;
}): string => buildMetaDescriptionGenerationPrompt({
  mode: 'writing_suggestions',
  title: options.articleTitle,
  primaryKeyword: options.primaryKeyword,
  articleLanguage: options.articleLanguage,
  finalArticle: options.finalArticle,
  goalContext: options.goalContext,
  template: options.template,
  previousInvalidResponse: options.previousInvalidResponse,
});

const GENERATED_LIST_DIGIT_MAP: Record<string, string> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
};

const toAsciiListNumber = (value: string): string => Array.from(value)
  .map(character => GENERATED_LIST_DIGIT_MAP[character] || character)
  .join('');

const normalizeGeneratedListMarker = (line: string): string => {
  const bulletMatch = line.match(/^(\s*)[•‣◦⁃–—]\s+(.+)$/u);
  if (bulletMatch) return `${bulletMatch[1]}- ${bulletMatch[2]}`;

  const orderedMatch = line.match(
    /^(\s*)(?:([\d٠-٩۰-۹]{1,2})[.)\-–—:]|\(([\d٠-٩۰-۹]{1,2})\))\s+(.+)$/u,
  );
  if (!orderedMatch) return line;
  return `${orderedMatch[1]}${toAsciiListNumber(orderedMatch[2] || orderedMatch[3])}. ${orderedMatch[4]}`;
};

const removeGeneratedBoldFormatting = (value: string): string => value
  .replace(/<\/?(?:strong|b)\b[^>]*>/gi, '')
  .replace(/\*\*([^*\n]+)\*\*/g, '$1')
  .replace(/__([^_\n]+)__/g, '$1');

const normalizeGeneratedContentWritingMarkdown = (value: string): string => (
  removeGeneratedBoldFormatting(
    stripCodeFence(value)
      .split(/\r?\n/)
      .map(normalizeGeneratedListMarker)
      .join('\n'),
  )
);

const removeLeadingHeading = (value: string, maximumLevel = 6): string => {
  const normalized = normalizeGeneratedContentWritingMarkdown(value);
  const lines = normalized.split(/\r?\n/);
  const firstContentIndex = lines.findIndex(line => Boolean(line.trim()));
  const heading = firstContentIndex >= 0
    ? lines[firstContentIndex].trim().match(/^(#{1,6})\s+\S/)
    : null;
  if (heading && heading[1].length <= maximumLevel) {
    lines.splice(firstContentIndex, 1);
  }
  return lines.join('\n').trim();
};

const ENGLISH_FAQ_HEADINGS = ['faq', 'faqs', 'frequently asked questions', 'questions and answers'];
const ARABIC_EXPLICIT_CONCLUSION_HEADINGS = [
  'الخاتمة',
  'خاتمة',
  'الخلاصة',
  'خلاصة',
  'في الختام',
  'الملخص النهائي',
  'ملخص نهائي',
  'الخلاصة النهائية',
];
const ENGLISH_CONCLUSION_HEADINGS = [
  'conclusion',
  'summary',
  'final summary',
  'in conclusion',
  'wrap up',
  'wrapping up',
];
const ARABIC_CALL_TO_ACTION_HEADINGS = [
  'اشتر',
  'اطلب',
  'احجز',
  'تواصل',
  'اتصل',
  'ابدأ',
  'سجل',
  'انضم',
  'جرب',
  'اكتشف',
  'احصل',
  'تسوق',
  'راسل',
  'استشر',
];
const ENGLISH_CALL_TO_ACTION_HEADINGS = [
  'buy now',
  'order now',
  'book now',
  'reserve now',
  'shop now',
  'request a quote',
  'get a quote',
  'contact us',
  'call us',
  'talk to us',
  'start now',
  'get started',
  'try now',
  'sign up',
  'subscribe',
  'join now',
  'discover more',
  'view plans',
  'choose your plan',
];

const normalizeStructuralHeading = (value: string): string => value
  .normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[*_`~\[\](){}:؛،,.!?؟]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

const headingContainsOneOf = (
  value: string,
  keywords: readonly string[],
): boolean => {
  const normalized = normalizeStructuralHeading(value);
  return keywords.some(keyword => {
    const candidate = normalizeStructuralHeading(keyword);
    return candidate.length > 0 && normalized.includes(candidate);
  });
};

const headingStartsWithOneOf = (
  value: string,
  keywords: readonly string[],
): boolean => {
  const normalized = normalizeStructuralHeading(value);
  return keywords.some(keyword => {
    const candidate = normalizeStructuralHeading(keyword);
    return candidate.length > 0 && (
      normalized === candidate
      || normalized.startsWith(`${candidate} `)
    );
  });
};

const getMarkdownH2Sections = (value: string): Array<{
  heading: string;
  startLine: number;
  endLine: number;
}> => {
  const lines = normalizeGeneratedContentWritingMarkdown(value).split(/\r?\n/);
  const starts = lines
    .map((line, index) => {
      const match = line.trim().match(/^##[ \t]+(.+?)\s*$/);
      return match ? { heading: match[1].trim(), startLine: index } : null;
    })
    .filter((item): item is { heading: string; startLine: number } => Boolean(item));
  return starts.map((item, index) => ({
    ...item,
    endLine: starts[index + 1]?.startLine ?? lines.length,
  }));
};

const isFaqHeading = (value: string): boolean => headingContainsOneOf(
  value,
  [...FAQ_KEYWORDS, ...ENGLISH_FAQ_HEADINGS],
);

const isConclusionHeading = (value: string): boolean => headingContainsOneOf(
  value,
  [...ARABIC_EXPLICIT_CONCLUSION_HEADINGS, ...ENGLISH_CONCLUSION_HEADINGS],
);

const isCallToActionHeading = (value: string): boolean => headingStartsWithOneOf(
  value,
  [...ARABIC_CALL_TO_ACTION_HEADINGS, ...ENGLISH_CALL_TO_ACTION_HEADINGS],
);

const truncateGeneratedBodyBeforeH2 = (
  value: string,
  maximumLeadingHeadingLevel = 6,
): string => {
  const body = removeLeadingHeading(value, maximumLeadingHeadingLevel);
  const lines = body.split(/\r?\n/);
  const nextH2Index = lines.findIndex(line => /^##[ \t]+\S/.test(line.trim()));
  return (nextH2Index >= 0 ? lines.slice(0, nextH2Index) : lines).join('\n').trim();
};

const extractGeneratedFinalSectionBody = (
  value: string,
  kind: 'conclusion' | 'call_to_action',
): string => {
  const normalized = normalizeGeneratedContentWritingMarkdown(value);
  const lines = normalized.split(/\r?\n/);
  const sections = getMarkdownH2Sections(normalized);
  const predicate = kind === 'conclusion' ? isConclusionHeading : isCallToActionHeading;
  const matching = [...sections].reverse().find(section => predicate(section.heading));
  const selected = matching || sections[0];
  if (!selected) return truncateGeneratedBodyBeforeH2(normalized);
  return lines
    .slice(
      kind === 'conclusion' ? selected.startLine + 1 : selected.startLine,
      selected.endLine,
    )
    .join('\n')
    .trim();
};

export type ContentWritingFinalSectionStructureAudit = {
  accepted: boolean;
  finalSectionKind: 'conclusion' | 'call_to_action';
  h2Headings: string[];
  faqHeadingCount: number;
  finalHeading: string;
  reasons: string[];
};

export const auditContentWritingFinalSectionStructure = (options: {
  markdown: string;
  goalContext?: Partial<GoalContext> | null;
}): ContentWritingFinalSectionStructureAudit => {
  const finalSectionKind = getContentWritingFinalSectionKind(options.goalContext);
  const sections = getMarkdownH2Sections(options.markdown);
  const h2Headings = sections.map(section => section.heading);
  const faqIndexes = sections
    .map((section, index) => (isFaqHeading(section.heading) ? index : -1))
    .filter(index => index >= 0);
  const conclusionIndexes = sections
    .map((section, index) => (isConclusionHeading(section.heading) ? index : -1))
    .filter(index => index >= 0);
  const finalIndex = sections.length - 1;
  const finalHeading = sections[finalIndex]?.heading || '';
  const duplicateFinalHeadingCount = finalHeading
    ? h2Headings.filter(heading => (
        normalizeStructuralHeading(heading) === normalizeStructuralHeading(finalHeading)
      )).length
    : 0;
  const reasons: string[] = [];

  if (faqIndexes.length !== 1) reasons.push('final_structure_faq_count');
  if (faqIndexes.length === 1 && faqIndexes[0] !== finalIndex - 1) {
    reasons.push('final_structure_faq_not_penultimate');
  }
  if (!finalHeading) reasons.push('final_structure_final_heading_missing');
  if (duplicateFinalHeadingCount > 1) reasons.push('final_structure_duplicate_final_heading');

  if (finalSectionKind === 'conclusion') {
    if (conclusionIndexes.length !== 1) reasons.push('final_structure_conclusion_count');
    if (!isConclusionHeading(finalHeading)) reasons.push('final_structure_conclusion_not_last');
  } else {
    if (conclusionIndexes.length > 0) reasons.push('final_structure_conclusion_forbidden');
    if (!isCallToActionHeading(finalHeading)) reasons.push('final_structure_cta_not_last');
  }

  return {
    accepted: reasons.length === 0,
    finalSectionKind,
    h2Headings,
    faqHeadingCount: faqIndexes.length,
    finalHeading,
    reasons: Array.from(new Set(reasons)),
  };
};

const joinNonEmpty = (parts: Array<string | undefined | null>): string => (
  parts.map(part => String(part || '').trim()).filter(Boolean).join('\n\n')
);

export const assembleContentWritingDraft = (options: {
  articleTitle: string;
  language: string;
  outline: ContentWritingOutline;
  outputs: Record<string, string>;
  includeFaq?: boolean;
  goalContext?: Partial<GoalContext> | null;
  primaryKeyword?: string;
}): string => {
  const articleTitle = options.articleTitle.replace(/[\r\n]+/g, ' ').trim();
  const sectionParts = options.outline.sections.map((section, index) => {
    const output = truncateGeneratedBodyBeforeH2(
      options.outputs[`section-${String(index + 1).padStart(2, '0')}`] || '',
    );
    return output ? `## ${section.title}\n\n${output}` : '';
  });
  const introduction = truncateGeneratedBodyBeforeH2(options.outputs.introduction || '');
  const conclusion = extractGeneratedFinalSectionBody(
    options.outputs.conclusion || '',
    'conclusion',
  );
  const callToAction = extractGeneratedFinalSectionBody(
    options.outputs['call-to-action'] || '',
    'call_to_action',
  );
  const faq = truncateGeneratedBodyBeforeH2(options.outputs.faq || '', 2);
  const faqTitle = options.language === 'en' ? 'Frequently asked questions' : 'الأسئلة الشائعة';
  const conclusionTitle = options.language === 'en' ? 'Conclusion' : 'الخاتمة';
  const inferredFinalSectionKind = getContentWritingFinalSectionKind(options.goalContext);
  const callToActionLines = callToAction.split(/\r?\n/);
  const callToActionHeadingIndex = callToActionLines.findIndex(line => /^##[ \t]+\S/.test(line.trim()));
  const callToActionSection = callToAction
    ? callToActionHeadingIndex >= 0
      ? callToActionLines.slice(callToActionHeadingIndex).join('\n').trim()
      : [
          `## ${
            options.language === 'en'
              ? `Contact us about ${options.primaryKeyword || 'this service'}`
              : `تواصل معنا بشأن ${options.primaryKeyword || 'هذه الخدمة'}`
          }`,
          '',
          removeLeadingHeading(callToAction),
        ].join('\n').trim()
    : '';
  const finalSection = inferredFinalSectionKind === 'call_to_action'
    ? callToActionSection
    : conclusion
      ? `## ${conclusionTitle}\n\n${conclusion}`
      : '';
  return joinNonEmpty([
    `# ${articleTitle}`,
    introduction,
    ...sectionParts,
    options.includeFaq !== false && faq ? `## ${faqTitle}\n\n${faq}` : '',
    finalSection,
  ]);
};

export type RecoverableContentWritingStep = {
  stepKey: string;
  stepType: ContentWritingWorkflowStepType;
  ordinal: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  outputText?: string | null;
  metadata?: Record<string, unknown>;
};

export type RecoveredContentWritingDraft = {
  markdown: string;
  source: 'session_result' | 'review_step' | 'assembled_steps';
  includedStepCount: number;
};

/**
 * Rebuilds the safest article draft available from persisted workflow steps.
 *
 * Analysis-only outputs (competitor index, outline, and coverage audit) are
 * intentionally excluded. A completed final/quality review is already a full
 * article and takes precedence; otherwise the same deterministic assembler used
 * by the worker combines only completed prose stages. Targeted section repairs
 * replace their original section instead of being appended as duplicate text.
 */
export const recoverContentWritingDraft = (options: {
  articleTitle: string;
  language: string;
  sessionResultText?: string | null;
  steps: readonly RecoverableContentWritingStep[];
  goalContext?: Partial<GoalContext> | null;
  primaryKeyword?: string;
}): RecoveredContentWritingDraft | null => {
  const sessionResult = String(options.sessionResultText || '').trim();
  if (sessionResult) {
    return {
      markdown: normalizeFinalContentWritingResult(sessionResult),
      source: 'session_result',
      includedStepCount: options.steps.filter(step => step.status === 'completed').length,
    };
  }

  const completedWithOutput = options.steps
    .filter(step => step.status === 'completed' && Boolean(String(step.outputText || '').trim()))
    .sort((left, right) => left.ordinal - right.ordinal);
  const acceptedRevision = [...completedWithOutput]
    .reverse()
    .find(step => (
      (step.stepType === 'quality_repair' || step.stepType === 'final_review')
      && step.metadata?.revisionPhase === 'apply'
      && step.metadata?.revisionDecision
      && typeof step.metadata.revisionDecision === 'object'
      && (step.metadata.revisionDecision as Record<string, unknown>).accepted === true
      && Boolean(toText(step.metadata?.acceptedDraft, 200_000))
    ));
  if (acceptedRevision) {
    return {
      markdown: normalizeFinalContentWritingResult(
        toText(acceptedRevision.metadata?.acceptedDraft, 200_000),
      ),
      source: 'review_step',
      includedStepCount: 1,
    };
  }

  // Legacy workflow versions persisted a complete article as the step output.
  // Structured revision plans and edit bundles are JSON and must never be
  // mistaken for recoverable article prose.
  const reviewedDraft = [...completedWithOutput]
    .reverse()
    .find(step => (
      (step.stepType === 'quality_repair' || step.stepType === 'final_review')
      && !step.metadata?.revisionPhase
      && /^#[ \t]+\S/m.test(String(step.outputText || ''))
    ));
  if (reviewedDraft?.outputText) {
    return {
      markdown: normalizeFinalContentWritingResult(reviewedDraft.outputText),
      source: 'review_step',
      includedStepCount: 1,
    };
  }

  const outlineStep = completedWithOutput.find(step => step.stepType === 'outline');
  const outline = normalizeContentWritingOutline(outlineStep?.metadata?.outline)
    || normalizeContentWritingOutline(outlineStep?.outputText);
  if (!outline) return null;

  const outputs: Record<string, string> = {};
  let includedStepCount = 0;
  completedWithOutput.forEach(step => {
    const output = String(step.outputText || '').trim();
    if (!output) return;
    if (
      step.stepType === 'section'
      || step.stepType === 'introduction'
      || step.stepType === 'faq'
      || step.stepType === 'conclusion'
      || step.stepType === 'call_to_action'
    ) {
      outputs[step.stepKey] = output;
      includedStepCount += 1;
      return;
    }
    if (step.stepType === 'section_repair') {
      const repairedSectionKey = toText(
        step.metadata?.repairedSectionKey || step.metadata?.sectionKey,
        120,
      );
      if (repairedSectionKey && /^section-\d{2}$/.test(repairedSectionKey)) {
        outputs[repairedSectionKey] = output;
        includedStepCount += 1;
      }
    }
  });

  if (includedStepCount === 0) return null;
  const markdown = assembleContentWritingDraft({
    articleTitle: options.articleTitle,
    language: options.language,
    outline,
    outputs,
    goalContext: options.goalContext,
    primaryKeyword: options.primaryKeyword,
  }).trim();
  return markdown
    ? { markdown, source: 'assembled_steps', includedStepCount }
    : null;
};

export const normalizeFinalContentWritingResult = (
  value: string,
): string => normalizeGeneratedContentWritingMarkdown(value);

const normalizeComparableHeading = (value: string): string => value
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`~]/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

export type PreparedContentWritingResult = {
  markdown: string;
  leadingTitle: string;
  titleMatchesArticle: boolean;
};

/**
 * The editor owns the article title separately, so a generated leading H1 must
 * never be inserted into the body. Keeping this normalization in one place
 * makes review and insertion use exactly the same document.
 */
export const prepareContentWritingResultForEditor = (
  value: string,
  articleTitle: string,
): PreparedContentWritingResult => {
  const normalized = normalizeFinalContentWritingResult(value);
  const lines = normalized.split(/\r?\n/);
  const firstContentIndex = lines.findIndex(line => Boolean(line.trim()));
  const headingMatch = firstContentIndex >= 0
    ? lines[firstContentIndex].trim().match(/^#\s+(.+?)\s*#*\s*$/)
    : null;
  const leadingTitle = headingMatch?.[1]?.trim() || '';

  if (headingMatch) lines.splice(firstContentIndex, 1);

  return {
    markdown: lines.join('\n').trim(),
    leadingTitle,
    titleMatchesArticle: Boolean(leadingTitle)
      && normalizeComparableHeading(leadingTitle) === normalizeComparableHeading(articleTitle),
  };
};

export const contentWritingMarkdownToPlainText = (value: string): string => (
  normalizeFinalContentWritingResult(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-+*•‣◦⁃–—]|[\p{N}]{1,2}[.)\-–—:]|\([\p{N}]{1,2}\))\s+/gmu, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);
