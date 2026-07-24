import {
  contentWritingKnowledgeToPromptJson,
  type ContentWritingCoverageAudit,
  type ContentWritingKnowledgeBase,
  type ContentWritingSectionCoverage,
  type ContentWritingSourceChunk,
} from './contentWritingKnowledge';
import {
  getPromptTemplate,
  PROMPT_TEMPLATE_IDS,
  renderPromptTemplate,
} from '../constants/promptRegistry';

export const CONTENT_WRITING_WORKFLOW_VERSION = 3;
export const CONTENT_WRITING_MIN_OUTLINE_SECTIONS = 4;
export const CONTENT_WRITING_MAX_OUTLINE_SECTIONS = 12;
export const CONTENT_WRITING_MAX_TARGETED_SECTION_REPAIRS = 3;

export type ContentWritingWorkflowStepType =
  | 'competitor_index'
  | 'outline'
  | 'section'
  | 'introduction'
  | 'conclusion'
  | 'faq'
  | 'coverage_audit'
  | 'section_repair'
  | 'final_review'
  | 'quality_repair';

export type ContentWritingOutlineSection = {
  title: string;
  brief: string;
  targetWords?: number;
  subheadings?: string[];
  requiredIdeaIds?: string[];
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
    const sourceChunkIds = isRecord(item) && Array.isArray(item.sourceChunkIds)
      ? Array.from(new Set(item.sourceChunkIds.map(value => toText(value, 120)).filter(Boolean))).slice(0, 100)
      : [];
    return [{
      title,
      brief: brief || title,
      ...(targetWords ? { targetWords } : {}),
      ...(subheadings.length > 0 ? { subheadings } : {}),
      ...(requiredIdeaIds.length > 0 ? { requiredIdeaIds } : {}),
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
  title: 'Competitor knowledge index',
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
  const assigned = new Set<string>();
  const sections = outline.sections.map(section => {
    const requiredIdeaIds = (section.requiredIdeaIds || [])
      .filter(id => validIdeaIds.has(id) && !assigned.has(id));
    requiredIdeaIds.forEach(id => assigned.add(id));
    const sourceChunkIds = Array.from(new Set([
      ...(section.sourceChunkIds || []),
      ...knowledge.items
        .filter(item => requiredIdeaIds.includes(item.id))
        .flatMap(item => item.sourceChunkIds),
    ]));
    return { ...section, requiredIdeaIds, sourceChunkIds };
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
  return { sections };
};

export const createContentWritingWorkflowSteps = (
  outline: ContentWritingOutline,
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
    {
      key: 'conclusion',
      type: 'conclusion',
      ordinal: nextOrdinal + 2,
      title: 'Conclusion',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
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
  ];
};

const outlineJson = (outline: ContentWritingOutline): string => JSON.stringify(outline, null, 2);

export const buildContentWritingCompetitorIndexPrompt = (options: {
  chunks: readonly ContentWritingSourceChunk[];
  language: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.competitorIndex),
  {
    source_ids_json: JSON.stringify(options.chunks.map(chunk => chunk.id)),
    output_language: options.language === 'en' ? 'اللغة الإنجليزية' : 'اللغة العربية',
  },
);

export const buildContentWritingOutlinePrompt = (options: {
  articleTitle: string;
  language: string;
  knowledge: ContentWritingKnowledgeBase;
  qualityContract?: string;
  minimumSections?: number;
  maximumSections?: number;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.outline),
  {
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

export const buildContentWritingSectionPrompt = (options: {
  outline: ContentWritingOutline;
  section: ContentWritingOutlineSection;
  sectionIndex: number;
  previousSection?: string;
  knowledgeItems: ContentWritingKnowledgeBase['items'];
  sourceChunks: readonly ContentWritingSourceChunk[];
  coverageLedger: {
    coveredIdeaIds: string[];
    previousSectionSummaries: Array<{ sectionKey: string; title: string; coveredIdeaIds: string[] }>;
  };
  template?: string;
}): string => renderPromptTemplate(
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
    knowledge_items_json: JSON.stringify(options.knowledgeItems, null, 2),
    source_chunks_json: JSON.stringify(options.sourceChunks.map(chunk => ({
      sourceId: chunk.id,
      competitorNumber: chunk.competitorNumber,
      title: chunk.title,
      url: chunk.url,
      text: chunk.text,
    })), null, 2),
    coverage_ledger_json: JSON.stringify(options.coverageLedger, null, 2),
    previous_section_block: options.previousSection
      ? `القسم السابق كاملًا للترابط فقط:\n<previous_section>\n${options.previousSection}\n</previous_section>`
      : '',
  },
);

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
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.coverageAudit),
  {
    outline_json: outlineJson(options.outline),
    knowledge_json: contentWritingKnowledgeToPromptJson(options.knowledge),
    section_coverages_json: JSON.stringify(options.sectionCoverages, null, 2),
    missing_idea_ids_json: JSON.stringify(options.deterministicMissingIdeaIds),
    completed_draft: options.draft,
    max_repairs: CONTENT_WRITING_MAX_TARGETED_SECTION_REPAIRS,
  },
);

export const buildContentWritingSectionRepairPrompt = (options: {
  outline: ContentWritingOutline;
  section: ContentWritingOutlineSection;
  sectionKey: string;
  originalMarkdown: string;
  repair: ContentWritingCoverageAudit['repairs'][number];
  knowledgeItems: ContentWritingKnowledgeBase['items'];
  sourceChunks: readonly ContentWritingSourceChunk[];
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.sectionRepair),
  {
    section_key: options.sectionKey,
    section_json: JSON.stringify(options.section, null, 2),
    repair_instructions: options.repair.instructions,
    knowledge_items_json: JSON.stringify(options.knowledgeItems, null, 2),
    source_chunks_json: JSON.stringify(
      options.sourceChunks.map(chunk => ({ sourceId: chunk.id, text: chunk.text })),
      null,
      2,
    ),
    original_section_markdown: options.originalMarkdown,
  },
);

export const buildContentWritingIntroductionPrompt = (options: {
  outline: ContentWritingOutline;
  bodyDraft: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.introduction),
  {
    outline_json: outlineJson(options.outline),
    body_draft: options.bodyDraft,
  },
);

export const buildContentWritingConclusionPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.conclusion),
  {
    outline_json: outlineJson(options.outline),
    completed_draft: options.draft,
  },
);

export const buildContentWritingFaqPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.faq),
  {
    outline_json: outlineJson(options.outline),
    completed_draft: options.draft,
  },
);

export const buildContentWritingFinalReviewPrompt = (options: {
  articleTitle: string;
  draft: string;
  knowledge?: ContentWritingKnowledgeBase;
  coverageAudit?: ContentWritingCoverageAudit;
  qualityContract?: string;
  template?: string;
}): string => renderPromptTemplate(
  options.template || getPromptTemplate(undefined, PROMPT_TEMPLATE_IDS.finalReview),
  {
    article_title: options.articleTitle,
    quality_contract_block: options.qualityContract
      ? `عقد الجودة البرمجي:\n${options.qualityContract}`
      : '',
    knowledge_json: options.knowledge ? contentWritingKnowledgeToPromptJson(options.knowledge) : '{}',
    coverage_audit_json: JSON.stringify(options.coverageAudit || {}, null, 2),
    assembled_draft: options.draft,
  },
);

const removeLeadingHeading = (value: string, maximumLevel = 6): string => {
  const normalized = stripCodeFence(value);
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

const joinNonEmpty = (parts: Array<string | undefined | null>): string => (
  parts.map(part => String(part || '').trim()).filter(Boolean).join('\n\n')
);

export const assembleContentWritingDraft = (options: {
  articleTitle: string;
  language: string;
  outline: ContentWritingOutline;
  outputs: Record<string, string>;
  includeFaq?: boolean;
}): string => {
  const articleTitle = options.articleTitle.replace(/[\r\n]+/g, ' ').trim();
  const sectionParts = options.outline.sections.map((section, index) => {
    const output = removeLeadingHeading(options.outputs[`section-${String(index + 1).padStart(2, '0')}`] || '');
    return output ? `## ${section.title}\n\n${output}` : '';
  });
  const introduction = removeLeadingHeading(options.outputs.introduction || '');
  const conclusion = removeLeadingHeading(options.outputs.conclusion || '');
  const faq = removeLeadingHeading(options.outputs.faq || '', 2);
  const faqTitle = options.language === 'en' ? 'Frequently asked questions' : 'الأسئلة الشائعة';
  const conclusionTitle = options.language === 'en' ? 'Conclusion' : 'الخاتمة';
  return joinNonEmpty([
    `# ${articleTitle}`,
    introduction,
    ...sectionParts,
    options.includeFaq !== false && faq ? `## ${faqTitle}\n\n${faq}` : '',
    conclusion ? `## ${conclusionTitle}\n\n${conclusion}` : '',
  ]);
};

export const normalizeFinalContentWritingResult = (value: string): string => stripCodeFence(value);

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
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);
