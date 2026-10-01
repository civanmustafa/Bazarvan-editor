import type { GoogleDescriptionSuggestion, Keywords } from '../types.ts';

export type StructuredArticleExportFormat = 'markdown' | 'text';

export type StructuredArticleExportOptions = {
  includePrimaryKeyword: boolean;
  includeAlternativePhrases: boolean;
  includeLsiKeywords: boolean;
  includeSeoTitles: boolean;
  includeMetaDescriptions: boolean;
  includeSectionMarkers: boolean;
};

export type StructuredArticleExportInput = {
  title: string;
  metaDescription: string;
  language: 'ar' | 'en';
  keywords: Keywords;
  document: unknown;
  options?: Partial<StructuredArticleExportOptions>;
};

export type StructuredArticleExportResult = {
  format: StructuredArticleExportFormat;
  content: string;
  filename: string;
  wordCount: number;
  sectionCount: number;
  warnings: string[];
};

export const DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS: StructuredArticleExportOptions = {
  includePrimaryKeyword: true,
  includeAlternativePhrases: true,
  includeLsiKeywords: true,
  includeSeoTitles: true,
  includeMetaDescriptions: true,
  includeSectionMarkers: true,
};

type JsonRecord = Record<string, unknown>;

type ExportSectionRole =
  | 'introduction'
  | 'body'
  | 'faq'
  | 'conclusion'
  | 'steps'
  | 'comparison';

type ExportSection = {
  id: string;
  role: ExportSectionRole;
  nodes: JsonRecord[];
};

const asRecord = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);

const asNodes = (value: unknown): JsonRecord[] => (
  Array.isArray(value) ? value.map(asRecord).filter(node => typeof node.type === 'string') : []
);

const cleanText = (value: unknown): string => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\t ]+\n/g, '\n')
  .trim();

const uniqueText = (values: unknown[]): string[] => {
  const seen = new Set<string>();
  return values
    .map(cleanText)
    .filter(value => {
      if (!value) return false;
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const yamlString = (value: unknown): string => JSON.stringify(cleanText(value));

const escapeInlineMarkdown = (value: string): string => value
  .replace(/\\/g, '\\\\')
  .replace(/([`*_{}\[\]<>])/g, '\\$1');

const escapeLinkDestination = (value: string): string => value
  .replace(/\\/g, '\\\\')
  .replace(/\)/g, '\\)');

const applyMarks = (text: string, marksValue: unknown): string => {
  let output = escapeInlineMarkdown(text);
  const marks = asNodes(marksValue);
  for (const mark of marks) {
    const type = String(mark.type || '');
    if (type === 'code') output = `\`${output.replace(/`/g, '\\`')}\``;
    if (type === 'bold' || type === 'strong') output = `**${output}**`;
    if (type === 'italic' || type === 'em') output = `*${output}*`;
    if (type === 'strike') output = `~~${output}~~`;
    if (type === 'link') {
      const href = cleanText(asRecord(mark.attrs).href);
      if (href) output = `[${output}](${escapeLinkDestination(href)})`;
    }
  }
  return output;
};

const serializeInlineNodes = (nodesValue: unknown): string => asNodes(nodesValue)
  .map(node => {
    const type = String(node.type || '');
    if (type === 'text') return applyMarks(String(node.text || ''), node.marks);
    if (type === 'hardBreak') return '  \n';
    return serializeInlineNodes(node.content);
  })
  .join('')
  .trim();

const indentLines = (value: string, prefix: string): string => value
  .split('\n')
  .map(line => `${prefix}${line}`)
  .join('\n');

const tableCellText = (node: JsonRecord): string => {
  const value = asNodes(node.content)
    .map(child => serializeInlineNodes(child.content) || serializeInlineNodes([child]))
    .filter(Boolean)
    .join(' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
  return value || ' ';
};

const serializeTable = (node: JsonRecord): string => {
  const rows = asNodes(node.content).map(row => asNodes(row.content).map(tableCellText));
  if (rows.length === 0) return '';
  const columnCount = Math.max(...rows.map(row => row.length), 1);
  const normalizedRows = rows.map(row => Array.from({ length: columnCount }, (_, index) => row[index] || ' '));
  const header = normalizedRows[0];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalizedRows.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
};

const serializeListItem = (node: JsonRecord, marker: string, depth: number): string => {
  const children = asNodes(node.content);
  const firstTextNode = children.find(child => child.type === 'paragraph');
  const firstLine = firstTextNode ? serializeInlineNodes(firstTextNode.content) : '';
  const nested = children
    .filter(child => child.type === 'bulletList' || child.type === 'orderedList')
    .map(child => serializeList(child, depth + 1))
    .filter(Boolean)
    .join('\n');
  const prefix = '  '.repeat(depth);
  return [`${prefix}${marker} ${firstLine || ' '}`, nested].filter(Boolean).join('\n');
};

const serializeList = (node: JsonRecord, depth = 0): string => {
  const ordered = node.type === 'orderedList';
  const start = Number(asRecord(node.attrs).start || 1);
  return asNodes(node.content)
    .map((item, index) => serializeListItem(item, ordered ? `${start + index}.` : '-', depth))
    .join('\n');
};

const serializeBlockNode = (node: JsonRecord): string => {
  const type = String(node.type || '');
  if (type === 'paragraph') return serializeInlineNodes(node.content);
  if (type === 'heading') {
    const requestedLevel = Number(asRecord(node.attrs).level || 2);
    const level = Math.min(6, Math.max(2, requestedLevel));
    return `${'#'.repeat(level)} ${serializeInlineNodes(node.content)}`.trim();
  }
  if (type === 'bulletList' || type === 'orderedList') return serializeList(node);
  if (type === 'blockquote') {
    const inner = asNodes(node.content).map(serializeBlockNode).filter(Boolean).join('\n\n');
    return inner ? indentLines(inner, '> ') : '';
  }
  if (type === 'codeBlock') {
    const language = cleanText(asRecord(node.attrs).language);
    const code = asNodes(node.content).map(child => String(child.text || '')).join('');
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  if (type === 'horizontalRule') return '---';
  if (type === 'table') return serializeTable(node);
  if (type === 'image') {
    const attrs = asRecord(node.attrs);
    const src = cleanText(attrs.src);
    const alt = cleanText(attrs.alt) || 'image';
    return src ? `![${escapeInlineMarkdown(alt)}](${escapeLinkDestination(src)})` : '';
  }
  return asNodes(node.content).map(serializeBlockNode).filter(Boolean).join('\n\n');
};

const sectionRoleFromHeading = (value: string): ExportSectionRole => {
  const heading = value.toLocaleLowerCase().replace(/[؟?!:،,.\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:المقدمة|مقدمة|تمهيد|نظرة عامة|introduction|overview)(?:$|\s)/.test(heading)) return 'introduction';
  if (/(?:الأسئلة الشائعة|اسئلة شائعة|أسئلة وأجوبة|سؤال وجواب|faq|frequently asked)/.test(heading)) return 'faq';
  if (/(?:الخاتمة|خاتمة|الخلاصة|ملخص نهائي|كلمة أخيرة|conclusion|final thoughts|summary)/.test(heading)) return 'conclusion';
  if (/(?:الخطوات|خطوات|طريقة|كيفية|دليل عملي|steps|how to)/.test(heading)) return 'steps';
  if (/(?:مقارنة|الفرق بين|مقابل|comparison|versus|\bvs\b)/.test(heading)) return 'comparison';
  return 'body';
};

const getNodeHeadingText = (node: JsonRecord): string => serializeInlineNodes(node.content)
  .replace(/[*_~`\\]/g, '')
  .trim();

const createSections = (nodes: JsonRecord[]): ExportSection[] => {
  const sections: ExportSection[] = [];
  let current: ExportSection = { id: 'introduction', role: 'introduction', nodes: [] };

  const commit = () => {
    if (current.nodes.some(node => cleanText(serializeBlockNode(node)))) sections.push(current);
  };

  nodes.forEach(node => {
    const isH2 = node.type === 'heading' && Number(asRecord(node.attrs).level || 2) <= 2;
    if (!isH2) {
      current.nodes.push(node);
      return;
    }
    commit();
    const role = sectionRoleFromHeading(getNodeHeadingText(node));
    current = {
      id: `section-${sections.length + 1}`,
      role,
      nodes: [node],
    };
  });
  commit();
  return sections;
};

const normalizeDocumentNodes = (documentValue: unknown, articleTitle: string): JsonRecord[] => {
  const root = asRecord(documentValue);
  const nodes = asNodes(root.content);
  const normalizedTitle = cleanText(articleTitle).toLocaleLowerCase();
  let removedMatchingH1 = false;
  return nodes.filter(node => {
    if (node.type !== 'heading' || Number(asRecord(node.attrs).level || 2) !== 1) return true;
    if (!removedMatchingH1 && getNodeHeadingText(node).toLocaleLowerCase() === normalizedTitle) {
      removedMatchingH1 = true;
      return false;
    }
    return true;
  });
};

const countWords = (value: string): number => value
  .replace(/<!--[^]*?-->/g, ' ')
  .replace(/\[[A-Z_]+[^\]]*\]/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .length;

const filenameStem = (title: string): string => cleanText(title)
  .normalize('NFKC')
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 80) || 'article';

const buildWarnings = (
  input: StructuredArticleExportInput,
  nodes: JsonRecord[],
  sections: ExportSection[],
): string[] => {
  const warnings: string[] = [];
  if (!cleanText(input.title)) warnings.push('لا يوجد عنوان رئيسي للمقالة.');
  if (!cleanText(input.keywords.primary)) warnings.push('لا توجد كلمة مفتاحية أساسية.');
  if (nodes.length === 0 || !nodes.some(node => cleanText(serializeBlockNode(node)))) warnings.push('جسم المقالة فارغ.');
  if (!cleanText(input.metaDescription) && descriptionTexts(input.keywords.googleDescriptions).length === 0) {
    warnings.push('لا يوجد وصف حالي أو أوصاف مقترحة.');
  }
  if (!sections.some(section => section.role === 'conclusion')) warnings.push('لم يُتعرف تلقائيًا على قسم خاتمة.');

  let previousLevel = 1;
  nodes.forEach(node => {
    if (node.type !== 'heading') return;
    const level = Math.min(6, Math.max(1, Number(asRecord(node.attrs).level || 2)));
    if (level > previousLevel + 1) {
      warnings.push(`يوجد انتقال غير متسلسل من H${previousLevel} إلى H${level}.`);
    }
    previousLevel = level;
  });
  return uniqueText(warnings);
};

const descriptionTexts = (values: GoogleDescriptionSuggestion[] | undefined): string[] => uniqueText(
  (values || []).map(value => value?.text),
);

const buildMarkdownFrontMatter = (
  input: StructuredArticleExportInput,
  options: StructuredArticleExportOptions,
): string => {
  const currentTitle = cleanText(input.title);
  const currentDescription = cleanText(input.metaDescription);
  const titles = uniqueText(input.keywords.googleTitles || []);
  const descriptions = descriptionTexts(input.keywords.googleDescriptions);
  const lines = [
    '---',
    'schema: "bazarvan-article/1"',
    `language: ${yamlString(input.language)}`,
    `current_title: ${yamlString(currentTitle)}`,
  ];

  if (options.includePrimaryKeyword) lines.push(`primary_keyword: ${yamlString(input.keywords.primary)}`);
  if (options.includeAlternativePhrases) {
    const alternatives = uniqueText(input.keywords.secondaries || []);
    lines.push(alternatives.length ? 'alternative_phrases:' : 'alternative_phrases: []');
    if (alternatives.length) lines.push(...alternatives.map(value => `  - ${yamlString(value)}`));
  }
  if (options.includeLsiKeywords) {
    const lsi = uniqueText(input.keywords.lsi || []);
    lines.push(lsi.length ? 'lsi_keywords:' : 'lsi_keywords: []');
    if (lsi.length) lines.push(...lsi.map(value => `  - ${yamlString(value)}`));
  }
  if (options.includeSeoTitles) {
    lines.push(titles.length ? 'seo_titles:' : 'seo_titles: []');
    if (titles.length) lines.push(...titles.flatMap(value => [
        `  - text: ${yamlString(value)}`,
        `    selected: ${Boolean(currentTitle && value === currentTitle)}`,
      ]));
  }
  if (options.includeMetaDescriptions) {
    lines.push(`current_meta_description: ${yamlString(currentDescription)}`);
    lines.push(descriptions.length ? 'meta_descriptions:' : 'meta_descriptions: []');
    if (descriptions.length) lines.push(...descriptions.flatMap(value => [
        `  - text: ${yamlString(value)}`,
        `    selected: ${Boolean(currentDescription && value === currentDescription)}`,
      ]));
  }
  lines.push('---');
  return lines.join('\n');
};

const buildMarkdownBody = (
  title: string,
  sections: ExportSection[],
  includeMarkers: boolean,
): string => {
  const blocks = ['<!-- ARTICLE_BODY_START -->', '', `# ${escapeInlineMarkdown(cleanText(title) || 'Untitled article')}`];
  sections.forEach(section => {
    const content = section.nodes.map(serializeBlockNode).filter(Boolean).join('\n\n').trim();
    if (!content) return;
    blocks.push('');
    if (includeMarkers) blocks.push(`<!-- SECTION_START role="${section.role}" id="${section.id}" -->`, '');
    blocks.push(content);
    if (includeMarkers) blocks.push('', '<!-- SECTION_END -->');
  });
  blocks.push('', '<!-- ARTICLE_BODY_END -->');
  return blocks.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
};

const buildTextContext = (
  input: StructuredArticleExportInput,
  options: StructuredArticleExportOptions,
): string[] => {
  const lines = ['[ARTICLE_CONTEXT]', `[LANGUAGE] ${input.language}`, `[CURRENT_TITLE] ${cleanText(input.title)}`];
  if (options.includePrimaryKeyword) lines.push(`[PRIMARY_KEYWORD] ${cleanText(input.keywords.primary) || '—'}`);
  if (options.includeAlternativePhrases) {
    lines.push('', '[ALTERNATIVE_PHRASES]', ...uniqueText(input.keywords.secondaries || []).map(value => `- ${value}`));
  }
  if (options.includeLsiKeywords) {
    lines.push('', '[LSI_KEYWORDS]', ...uniqueText(input.keywords.lsi || []).map(value => `- ${value}`));
  }
  if (options.includeSeoTitles) {
    lines.push('', '[SEO_TITLES]', ...uniqueText(input.keywords.googleTitles || []).map(value => (
      `- ${value}${value === cleanText(input.title) ? ' [SELECTED]' : ''}`
    )));
  }
  if (options.includeMetaDescriptions) {
    lines.push('', `[CURRENT_META_DESCRIPTION] ${cleanText(input.metaDescription) || '—'}`, '[META_DESCRIPTIONS]');
    lines.push(...descriptionTexts(input.keywords.googleDescriptions).map(value => (
      `- ${value}${value === cleanText(input.metaDescription) ? ' [SELECTED]' : ''}`
    )));
  }
  lines.push('[/ARTICLE_CONTEXT]');
  return lines;
};

const markdownBlockToStructuredText = (markdown: string): string => markdown
  .split('\n')
  .map(line => {
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) return `[HEADING level="${heading[1].length}"]\n${heading[2]}`;
    return line;
  })
  .join('\n');

const buildTextBody = (title: string, sections: ExportSection[]): string => {
  const blocks = ['[ARTICLE_BODY_START]', '', '[ARTICLE_TITLE]', cleanText(title) || 'Untitled article'];
  sections.forEach(section => {
    const content = section.nodes.map(serializeBlockNode).filter(Boolean).join('\n\n').trim();
    if (!content) return;
    blocks.push('', `[SECTION type="${section.role}" id="${section.id}"]`, markdownBlockToStructuredText(content), '[/SECTION]');
  });
  blocks.push('', '[ARTICLE_BODY_END]');
  return blocks.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
};

export const buildStructuredArticleExport = (
  input: StructuredArticleExportInput,
  format: StructuredArticleExportFormat = 'markdown',
): StructuredArticleExportResult => {
  const options = { ...DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS, ...(input.options || {}) };
  const nodes = normalizeDocumentNodes(input.document, input.title);
  const sections = createSections(nodes);
  const warnings = buildWarnings(input, nodes, sections);
  const content = format === 'markdown'
    ? `${buildMarkdownFrontMatter(input, options)}\n\n${buildMarkdownBody(input.title, sections, options.includeSectionMarkers)}\n`
    : `${buildTextContext(input, options).join('\n')}\n\n${buildTextBody(input.title, sections)}\n`;

  return {
    format,
    content,
    filename: `${filenameStem(input.title)}.${format === 'markdown' ? 'md' : 'txt'}`,
    wordCount: countWords(sections.flatMap(section => section.nodes.map(serializeBlockNode)).join('\n')),
    sectionCount: sections.length,
    warnings,
  };
};

export const copyUtf8Text = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.inset = '-9999px auto auto -9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard API is not available.');
};

export const downloadStructuredArticleExport = (result: StructuredArticleExportResult): void => {
  const mime = result.format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  const blob = new Blob([result.content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
