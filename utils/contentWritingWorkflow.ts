export const CONTENT_WRITING_WORKFLOW_VERSION = 2;
export const CONTENT_WRITING_MIN_OUTLINE_SECTIONS = 4;
export const CONTENT_WRITING_MAX_OUTLINE_SECTIONS = 12;

export type ContentWritingWorkflowStepType =
  | 'outline'
  | 'section'
  | 'introduction'
  | 'conclusion'
  | 'faq'
  | 'final_review'
  | 'quality_repair';

export type ContentWritingOutlineSection = {
  title: string;
  brief: string;
  targetWords?: number;
  subheadings?: string[];
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
    return [{
      title,
      brief: brief || title,
      ...(targetWords ? { targetWords } : {}),
      ...(subheadings.length > 0 ? { subheadings } : {}),
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

export const getContentWritingOutlineStep = (): ContentWritingWorkflowStepDefinition => ({
  key: 'outline',
  type: 'outline',
  ordinal: 1,
  title: 'Article outline',
  metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
});

export const createContentWritingWorkflowSteps = (
  outline: ContentWritingOutline,
): ContentWritingWorkflowStepDefinition[] => {
  const sectionSteps = outline.sections.map((section, index) => ({
    key: `section-${String(index + 1).padStart(2, '0')}`,
    type: 'section' as const,
    ordinal: index + 2,
    title: section.title,
    metadata: {
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      sectionIndex: index + 1,
      sectionCount: outline.sections.length,
      section,
    },
  }));
  const nextOrdinal = sectionSteps.length + 2;
  return [
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
      key: 'final-review',
      type: 'final_review',
      ordinal: nextOrdinal + 3,
      title: 'Final review',
      metadata: { workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION },
    },
  ];
};

const outlineJson = (outline: ContentWritingOutline): string => JSON.stringify(outline, null, 2);

export const buildContentWritingOutlinePrompt = (options: {
  articleTitle: string;
  language: string;
  qualityContract?: string;
  minimumSections?: number;
  maximumSections?: number;
}): string => `Execute only the outline stage for the article "${options.articleTitle}".

The permanent instructions, article data, keyword data, and the full text of all three competitors are already present in the conversation context. Do not write the article yet.

${options.qualityContract ? `Mandatory quality contract:\n${options.qualityContract}\n` : ''}

Return only valid JSON with this exact shape:
{"sections":[{"title":"Section title","brief":"What this section must cover","targetWords":140,"subheadings":["Optional H3 title"]}]}

Requirements:
- Use ${options.language === 'en' ? 'English' : 'Arabic'} for every title and brief.
- Return between ${options.minimumSections || CONTENT_WRITING_MIN_OUTLINE_SECTIONS} and ${options.maximumSections || CONTENT_WRITING_MAX_OUTLINE_SECTIONS} unique body sections in a logical order.
- Do not include the introduction, conclusion, or FAQ as body sections.
- Cover the search intent and important competitor topics without copying competitor wording.
- Make at least three H2 titles direct questions when the language and topic permit it.
- Prefer either 120-150 target words without H3, or 180-220 words with 2-3 H3 subheadings.
- Do not wrap the JSON in a code fence and do not add commentary.`;

export const buildContentWritingSectionPrompt = (options: {
  outline: ContentWritingOutline;
  section: ContentWritingOutlineSection;
  sectionIndex: number;
  previousSection?: string;
}): string => `Execute only body section ${options.sectionIndex + 1} of ${options.outline.sections.length}.

Full approved outline:
${outlineJson(options.outline)}

Current section:
- Title: ${options.section.title}
- Coverage brief: ${options.section.brief}
- Target words: ${options.section.targetWords || 140}
${options.section.subheadings?.length ? `- Required H3 subheadings: ${options.section.subheadings.join(' | ')}` : '- H3 subheadings: none unless needed by the quality contract'}

${options.previousSection ? `The complete preceding section is included for continuity only:
<previous_section>
${options.previousSection}
</previous_section>

` : ''}Write the complete Markdown body for this section only. Use the requested H3 headings when listed, but do not repeat the H2 section heading, article title, introduction, conclusion, or FAQ. Follow all permanent instructions and use the full competitor context as reference data, without copying it.`;

export const buildContentWritingIntroductionPrompt = (options: {
  outline: ContentWritingOutline;
  bodyDraft: string;
}): string => `Execute only the introduction stage.

Approved outline:
${outlineJson(options.outline)}

Completed body sections:
<completed_body>
${options.bodyDraft}
</completed_body>

Write exactly two useful introduction paragraphs that match the search intent and naturally prepare the reader for the completed body. The first paragraph must contain 30-60 words and 2-4 sentences. The second must contain 40-80 words and 2-4 sentences. Return the introduction body only in Markdown. Do not add a heading, list, or repeat the article title.`;

export const buildContentWritingConclusionPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
}): string => `Execute only the conclusion stage.

Approved outline:
${outlineJson(options.outline)}

Completed article draft so far:
<completed_draft>
${options.draft}
</completed_draft>

Write a focused 70-120 word conclusion that closes the article without unsupported facts. Start the first paragraph with a natural concluding indicator. Include at least one useful number already supported by the article and one short list; introduce that list with a 15-40 word sentence ending in a colon or question mark. Return the conclusion body only in Markdown. Do not add a heading or repeat the article title.`;

export const buildContentWritingFaqPrompt = (options: {
  outline: ContentWritingOutline;
  draft: string;
}): string => `Execute only the FAQ stage.

Approved outline:
${outlineJson(options.outline)}

Completed article draft:
<completed_draft>
${options.draft}
</completed_draft>

Write a useful FAQ based on the search intent, article, keywords, and full competitor context. Return only the questions and answers in Markdown, using level-three headings for questions. Every answer must be one paragraph of 35-75 words and 2-3 sentences. Do not add an FAQ section heading or repeat unsupported claims.`;

export const buildContentWritingFinalReviewPrompt = (options: {
  articleTitle: string;
  draft: string;
  qualityContract?: string;
}): string => `Execute the final editorial review for the article "${options.articleTitle}".

Act as an independent semantic editor, not as the original section writer. Review the complete assembled draft against every permanent instruction, the article context, target keywords, search intent, and the full competitor sources. Correct coherence, repetition, unsupported claims, Markdown structure, language quality, and natural keyword use.

Verify semantic usefulness explicitly: search-intent coverage, completeness of the answer, entity/topic coverage, factual grounding, originality versus competitors, quotable direct answers for AEO/GEO, logical progression, and an appropriate conversion or next-step cue. Remove any statement that is not supported by the supplied context rather than inventing evidence.

${options.qualityContract ? `Deterministic quality contract:\n${options.qualityContract}\n` : ''}

<assembled_draft>
${options.draft}
</assembled_draft>

Return the complete corrected article only as Markdown. Keep exactly one level-one title, preserve all necessary sections, and do not include code fences, commentary, review notes, or hidden reasoning.`;

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
