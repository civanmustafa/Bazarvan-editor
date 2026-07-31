import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import {
  extractProgrammaticCompetitorContentFromHtml,
  fetchProgrammaticHtml,
  normalizeProgrammaticCompetitorUrl,
} from './programmaticCompetitorExtractor.ts';

export type ArticleImportCounts = {
  headings: number;
  paragraphs: number;
  lists: number;
  links: number;
  tables: number;
};

export type ArticleImportPreview = {
  sourceUrl: string;
  canonicalUrl: string;
  fetchedUrl: string;
  title: string;
  description: string;
  author: string;
  publishedAt: string;
  language: 'ar' | 'en';
  contentHtml: string;
  plainText: string;
  wordCount: number;
  skippedImageCount: number;
  counts: ArticleImportCounts;
  contentHash: string;
  extractionProvider: 'rich_html' | 'programmatic_text_fallback';
  fetchedAt: string;
  warnings: string[];
};

export class ArticleImportExtractionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'article_import_content_not_found', status = 422) {
    super(message);
    this.name = 'ArticleImportExtractionError';
    this.code = code;
    this.status = status;
  }
}

type SerializationState = {
  baseUrl: string;
  counts: ArticleImportCounts;
  skippedImageCount: number;
};

const MAX_IMPORT_HTML_LENGTH = 750_000;
const MAX_IMPORT_TEXT_LENGTH = 180_000;
const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'dialog',
  'nav',
  'header',
  'footer',
  'aside',
  'video',
  'audio',
  'source',
]);
const UNWRAP_TAGS = new Set([
  'html',
  'body',
  'article',
  'main',
  'section',
  'div',
  'span',
  'picture',
  'figure',
  'details',
  'summary',
]);
const NOISE_MARKER_PATTERN = /(^|[\s_-])(nav|navbar|menu|header|footer|sidebar|aside|widget|comment|comments|reply|share|social|breadcrumb|breadcrumbs|cookie|cookies|banner|advertisement|advert|ads|popup|modal|newsletter|subscribe|search|recent|popular|related|recommend|tagcloud|pagination|preloader|offcanvas|login|toolbar|promo)([\s_-]|$)/i;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const normalizeText = (value: string, maximum = MAX_IMPORT_TEXT_LENGTH): string => value
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t\f\v]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, maximum);

const comparableText = (value: string): string => normalizeText(value)
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const countWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const metaContent = (document: Document, names: string[]): string => {
  const targets = new Set(names.map(name => name.toLocaleLowerCase()));
  for (const meta of Array.from(document.querySelectorAll('meta'))) {
    const key = (meta.getAttribute('property') || meta.getAttribute('name') || '').trim().toLocaleLowerCase();
    if (!targets.has(key)) continue;
    const content = normalizeText(meta.getAttribute('content') || '', 2_000);
    if (content) return content;
  }
  return '';
};

const resolveCanonicalUrl = (document: Document, fetchedUrl: string): string => {
  for (const link of Array.from(document.querySelectorAll('link[rel][href]'))) {
    const relations = (link.getAttribute('rel') || '').toLocaleLowerCase().split(/\s+/);
    if (!relations.includes('canonical')) continue;
    try {
      return normalizeProgrammaticCompetitorUrl(
        new URL(link.getAttribute('href') || '', fetchedUrl).toString(),
      );
    } catch {
      return fetchedUrl;
    }
  }
  return fetchedUrl;
};

const elementMarker = (element: Element): string => [
  element.getAttribute('id') || '',
  element.getAttribute('class') || '',
  element.getAttribute('role') || '',
  element.getAttribute('aria-label') || '',
].join(' ');

const isNoiseElement = (element: Element): boolean => (
  NOISE_MARKER_PATTERN.test(elementMarker(element))
);

const candidateScore = (element: Element): number => {
  if (isNoiseElement(element)) return Number.NEGATIVE_INFINITY;
  const text = normalizeText(element.textContent || '');
  if (!text) return Number.NEGATIVE_INFINITY;
  const paragraphCount = element.querySelectorAll('p').length;
  const headingCount = element.querySelectorAll('h1,h2,h3,h4').length;
  const listItemCount = element.querySelectorAll('li').length;
  const linkTextLength = Array.from(element.querySelectorAll('a'))
    .reduce((total, link) => total + normalizeText(link.textContent || '').length, 0);
  const linkPenalty = text.length ? Math.round((linkTextLength / text.length) * 1_200) : 0;
  const tag = element.tagName.toLocaleLowerCase();
  const semanticBonus = tag === 'article'
    ? 4_000
    : tag === 'main' || element.getAttribute('role') === 'main'
      ? 2_500
      : tag === 'body'
        ? -2_000
        : 1_000;
  return semanticBonus + text.length + (paragraphCount * 180) + (headingCount * 100) + (listItemCount * 30) - linkPenalty;
};

const selectArticleRoot = (document: Document): Element => {
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const addCandidates = (selector: string) => {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!seen.has(element)) {
        seen.add(element);
        candidates.push(element);
      }
    }
  };

  [
    'article',
    'main',
    '[role="main"]',
    '.article-content',
    '.article-body',
    '.entry-content',
    '.post-content',
    '.story-body',
    '.news-content',
    '#article-content',
    '#content',
  ].forEach(addCandidates);
  if (document.body && !seen.has(document.body)) candidates.push(document.body);

  return candidates
    .map(element => ({ element, score: candidateScore(element) }))
    .sort((left, right) => right.score - left.score)[0]?.element
    || document.body
    || document.documentElement;
};

const safeHref = (value: string, baseUrl: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return trimmed.startsWith('#') ? trimmed.slice(0, 300) : '';
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(resolved.protocol)) return '';
    if (['http:', 'https:'].includes(resolved.protocol) && (resolved.username || resolved.password)) return '';
    return resolved.toString().slice(0, 2_048);
  } catch {
    return '';
  }
};

const safeSpanAttribute = (element: Element, name: 'colspan' | 'rowspan'): string => {
  const parsed = Number.parseInt(element.getAttribute(name) || '', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 20 ? ` ${name}="${parsed}"` : '';
};

const safeDirectionAttribute = (element: Element): string => {
  const direction = (element.getAttribute('dir') || '').toLocaleLowerCase();
  return direction === 'rtl' || direction === 'ltr' ? ` dir="${direction}"` : '';
};

const serializeNode = (
  node: Node,
  state: SerializationState,
  preserveWhitespace = false,
): string => {
  if (node.nodeType === 3) {
    const value = node.nodeValue || '';
    const normalized = preserveWhitespace
      ? value.replace(/\r\n?/g, '\n').slice(0, 40_000)
      : value.replace(/\s+/g, ' ');
    return escapeHtml(normalized);
  }
  if (node.nodeType !== 1) return '';

  const element = node as Element;
  const tag = element.tagName.toLocaleLowerCase();
  if (tag === 'img') {
    state.skippedImageCount += 1;
    return '';
  }
  if (DROP_TAGS.has(tag) || isNoiseElement(element)) return '';

  const children = Array.from(element.childNodes)
    .map(child => serializeNode(child, state, preserveWhitespace || tag === 'pre'))
    .join('');
  const hasVisibleContent = normalizeText(element.textContent || '').length > 0;

  if (UNWRAP_TAGS.has(tag)) return children;
  if (tag === 'figcaption') {
    return hasVisibleContent ? `<p>${children}</p>` : '';
  }
  if (/^h[1-6]$/.test(tag)) {
    if (!hasVisibleContent) return '';
    const level = Math.min(4, Math.max(1, Number.parseInt(tag.slice(1), 10)));
    state.counts.headings += 1;
    return `<h${level}${safeDirectionAttribute(element)}>${children}</h${level}>`;
  }
  if (tag === 'p') {
    if (!hasVisibleContent && !element.querySelector('br')) return '';
    state.counts.paragraphs += 1;
    return `<p${safeDirectionAttribute(element)}>${children}</p>`;
  }
  if (tag === 'ul' || tag === 'ol') {
    if (!hasVisibleContent) return '';
    state.counts.lists += 1;
    return `<${tag}${safeDirectionAttribute(element)}>${children}</${tag}>`;
  }
  if (tag === 'li' || tag === 'blockquote') {
    return hasVisibleContent ? `<${tag}${safeDirectionAttribute(element)}>${children}</${tag}>` : '';
  }
  if (tag === 'strong' || tag === 'b') return hasVisibleContent ? `<strong>${children}</strong>` : '';
  if (tag === 'em' || tag === 'i') return hasVisibleContent ? `<em>${children}</em>` : '';
  if (tag === 's' || tag === 'strike' || tag === 'del') return hasVisibleContent ? `<s>${children}</s>` : '';
  if (tag === 'br') return '<br>';
  if (tag === 'pre') return hasVisibleContent ? `<pre>${children}</pre>` : '';
  if (tag === 'code') return hasVisibleContent ? `<code>${children}</code>` : '';
  if (tag === 'a') {
    const href = safeHref(element.getAttribute('href') || '', state.baseUrl);
    if (!href) return children;
    state.counts.links += 1;
    return `<a href="${escapeHtml(href)}">${children}</a>`;
  }
  if (tag === 'table') {
    if (!hasVisibleContent) return '';
    state.counts.tables += 1;
    return `<table>${children}</table>`;
  }
  if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr') {
    return `<${tag}>${children}</${tag}>`;
  }
  if (tag === 'th' || tag === 'td') {
    return `<${tag}${safeSpanAttribute(element, 'colspan')}${safeSpanAttribute(element, 'rowspan')}>${children}</${tag}>`;
  }

  return children;
};

const normalizeImportedHtml = (
  html: string,
  title: string,
): { contentHtml: string; plainText: string } => {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const firstHeading = document.body.querySelector('h1');
  if (firstHeading && comparableText(firstHeading.textContent || '') === comparableText(title)) {
    firstHeading.remove();
  }
  const contentHtml = document.body.innerHTML
    .replace(/>\s+</g, '><')
    .trim();
  if (contentHtml.length > MAX_IMPORT_HTML_LENGTH) {
    throw new ArticleImportExtractionError(
      'The extracted article is too large to import safely.',
      'article_import_content_too_large',
      413,
    );
  }
  const plainText = normalizeText(document.body.textContent || '');
  return { contentHtml, plainText };
};

const detectLanguage = (document: Document, plainText: string): 'ar' | 'en' => {
  const declared = (document.documentElement.getAttribute('lang') || '').trim().toLocaleLowerCase();
  if (declared.startsWith('ar')) return 'ar';
  if (declared.startsWith('en')) return 'en';
  const letters = plainText.match(/\p{L}/gu) || [];
  const arabicLetters = plainText.match(/[\u0600-\u06ff]/g) || [];
  return letters.length > 0 && arabicLetters.length / letters.length >= 0.25 ? 'ar' : 'en';
};

const buildFallbackHtml = (
  extracted: ReturnType<typeof extractProgrammaticCompetitorContentFromHtml>,
): string => {
  const headings = [
    ...extracted.headings.h2.map(value => `<h2>${escapeHtml(value)}</h2>`),
    ...extracted.headings.h3.map(value => `<h3>${escapeHtml(value)}</h3>`),
  ];
  const paragraphs = extracted.paragraphs.map(value => `<p>${escapeHtml(value)}</p>`);
  const list = extracted.listItems.length
    ? `<ul>${extracted.listItems.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`
    : '';
  return [...headings, ...paragraphs, list].join('');
};

export const extractArticleImportPreviewFromHtml = (options: {
  html: string;
  sourceUrl: string;
  finalUrl?: string;
  responseContentType?: string;
  redirectCount?: number;
}): ArticleImportPreview => {
  const sourceUrl = normalizeProgrammaticCompetitorUrl(options.sourceUrl);
  const fetchedUrl = normalizeProgrammaticCompetitorUrl(options.finalUrl || sourceUrl);
  const { document } = parseHTML(options.html);
  const root = selectArticleRoot(document);
  const rootHeading = normalizeText(root.querySelector('h1')?.textContent || '', 500);
  const title = rootHeading
    || metaContent(document, ['og:title', 'twitter:title'])
    || normalizeText(document.querySelector('title')?.textContent || '', 500);
  const state: SerializationState = {
    baseUrl: fetchedUrl,
    counts: { headings: 0, paragraphs: 0, lists: 0, links: 0, tables: 0 },
    skippedImageCount: 0,
  };
  let serialized = serializeNode(root, state);
  let normalized = normalizeImportedHtml(serialized, title);
  let extractionProvider: ArticleImportPreview['extractionProvider'] = 'rich_html';

  if (normalized.plainText.length < 80 || countWords(normalized.plainText) < 12) {
    const fallback = extractProgrammaticCompetitorContentFromHtml({
      html: options.html,
      sourceUrl,
      finalUrl: fetchedUrl,
      responseContentType: options.responseContentType,
      redirectCount: options.redirectCount,
    });
    serialized = buildFallbackHtml(fallback);
    normalized = normalizeImportedHtml(serialized, title || fallback.title);
    extractionProvider = 'programmatic_text_fallback';
    state.counts = {
      headings: fallback.headings.h2.length + fallback.headings.h3.length,
      paragraphs: fallback.paragraphs.length,
      lists: fallback.listItems.length ? 1 : 0,
      links: 0,
      tables: 0,
    };
  }

  if (!normalized.contentHtml || normalized.plainText.length < 80 || countWords(normalized.plainText) < 12) {
    throw new ArticleImportExtractionError(
      'No sufficiently clear article or news content was found at this URL.',
    );
  }

  const canonicalUrl = resolveCanonicalUrl(document, fetchedUrl);
  const warnings: string[] = [];
  if (state.skippedImageCount > 0) {
    warnings.push(`${state.skippedImageCount} image(s) were skipped.`);
  }
  if (extractionProvider === 'programmatic_text_fallback') {
    warnings.push('The page required the simplified text extraction fallback.');
  }

  return {
    sourceUrl,
    canonicalUrl,
    fetchedUrl,
    title: title || new URL(canonicalUrl).hostname,
    description: metaContent(document, ['description', 'og:description', 'twitter:description']),
    author: metaContent(document, ['author', 'article:author', 'twitter:creator']),
    publishedAt: metaContent(document, [
      'article:published_time',
      'date',
      'datepublished',
      'publishdate',
      'pubdate',
    ]),
    language: detectLanguage(document, normalized.plainText),
    contentHtml: normalized.contentHtml,
    plainText: normalized.plainText,
    wordCount: countWords(normalized.plainText),
    skippedImageCount: state.skippedImageCount,
    counts: state.counts,
    contentHash: createHash('sha256').update(normalized.plainText).digest('hex'),
    extractionProvider,
    fetchedAt: new Date().toISOString(),
    warnings,
  };
};

const getBoundedEnvInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

export const getArticleImportPreview = async (options: {
  url: string;
  signal?: AbortSignal;
}): Promise<ArticleImportPreview> => {
  const sourceUrl = normalizeProgrammaticCompetitorUrl(options.url);
  const fetched = await fetchProgrammaticHtml({
    url: sourceUrl,
    signal: options.signal,
    timeoutMs: getBoundedEnvInteger('ARTICLE_IMPORT_TIMEOUT_MS', 30_000, 5_000, 90_000),
    maximumBytes: getBoundedEnvInteger('ARTICLE_IMPORT_MAX_BYTES', 4 * 1024 * 1024, 128 * 1024, 10 * 1024 * 1024),
  });
  return extractArticleImportPreviewFromHtml({
    html: fetched.html,
    sourceUrl,
    finalUrl: fetched.finalUrl,
    responseContentType: fetched.contentType,
    redirectCount: fetched.redirects,
  });
};
