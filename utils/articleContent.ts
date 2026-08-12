const HTML_TAG_PATTERN = /<\s*\/?\s*[a-z][^>]*>/gi;
const MEANINGFUL_MEDIA_TAG_PATTERN = /<\s*(?:img|audio|video|iframe|embed|object)\b/i;
const HTML_SPACE_ENTITIES_PATTERN = /(?:&nbsp;|&#0*160;)/gi;

const hasMeaningfulString = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (MEANINGFUL_MEDIA_TAG_PATTERN.test(trimmed)) return true;

  return trimmed
    .replace(HTML_TAG_PATTERN, ' ')
    .replace(HTML_SPACE_ENTITIES_PATTERN, ' ')
    .trim()
    .length > 0;
};

/**
 * Distinguishes a real editor body from TipTap's empty document, whose HTML is
 * just `<p></p>` and whose JSON still has a valid `doc`/`paragraph` shape.
 */
export const hasMeaningfulArticleContent = (value: unknown): boolean => {
  if (typeof value === 'string') return hasMeaningfulString(value);
  if (Array.isArray(value)) return value.some(hasMeaningfulArticleContent);
  if (!value || typeof value !== 'object') return false;

  const node = value as Record<string, unknown>;
  if (typeof node.text === 'string' && node.text.trim()) return true;

  const type = typeof node.type === 'string' ? node.type : '';
  if (type === 'image' || type === 'audio' || type === 'video' || type === 'iframe') return true;

  return Array.isArray(node.content) && node.content.some(hasMeaningfulArticleContent);
};
