import { hasMeaningfulArticleContent } from './articleContent.ts';

const ALLOWED_EDITOR_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);

const ALLOWED_EDITOR_MARK_TYPES = new Set([
  'bold',
  'italic',
  'strike',
  'code',
  'highlight',
  'link',
  'underline',
]);

const INLINE_EDITOR_NODE_TYPES = new Set(['text', 'hardBreak']);
const BLOCK_EDITOR_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'codeBlock',
  'horizontalRule',
  'table',
]);
const TEXT_SEPARATOR_EDITOR_NODE_TYPES = new Set([
  'doc',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isValidEditorMark = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (!ALLOWED_EDITOR_MARK_TYPES.has(value.type)) return false;
  return value.attrs === undefined || isRecord(value.attrs);
};

const hasValidEditorChildren = (type: string, children: Record<string, any>[]): boolean => {
  const childTypes = children.map(child => child.type);

  switch (type) {
    case 'doc':
      return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
    case 'paragraph':
    case 'heading':
      return childTypes.every(childType => INLINE_EDITOR_NODE_TYPES.has(childType));
    case 'blockquote':
      return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
    case 'bulletList':
    case 'orderedList':
      return childTypes.every(childType => childType === 'listItem');
    case 'listItem':
      return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
    case 'codeBlock':
      return childTypes.every(childType => childType === 'text');
    case 'table':
      return childTypes.every(childType => childType === 'tableRow');
    case 'tableRow':
      return childTypes.every(childType => childType === 'tableCell' || childType === 'tableHeader');
    case 'tableCell':
    case 'tableHeader':
      return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
    case 'text':
    case 'hardBreak':
    case 'horizontalRule':
      return children.length === 0;
    default:
      return false;
  }
};

const isValidEditorNode = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (!ALLOWED_EDITOR_NODE_TYPES.has(value.type)) return false;
  if (value.attrs !== undefined && !isRecord(value.attrs)) return false;
  if (value.marks !== undefined && (!Array.isArray(value.marks) || !value.marks.every(isValidEditorMark))) return false;

  if (value.type === 'text') {
    return typeof value.text === 'string' && value.content === undefined;
  }

  if (value.type === 'heading') {
    const level = value.attrs?.level;
    const normalizedLevel = typeof level === 'string' ? Number(level) : level;
    if (normalizedLevel !== undefined && ![1, 2, 3, 4].includes(Number(normalizedLevel))) return false;
  }

  if (value.type === 'hardBreak' || value.type === 'horizontalRule') {
    return value.content === undefined;
  }

  if (value.content === undefined) {
    if (value.type === 'doc' || value.type === 'table' || value.type === 'tableRow' || value.type === 'bulletList' || value.type === 'orderedList') {
      return false;
    }
    return true;
  }

  if (!Array.isArray(value.content) || !value.content.every(isValidEditorNode)) return false;
  return hasValidEditorChildren(value.type, value.content);
};

export const normalizeStoredEditorContent = (value: unknown): any | null => {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value.every(isValidEditorNode) ? { type: 'doc', content: value } : null;
  }

  if (!isRecord(value)) return null;

  const content = Array.isArray(value.content) ? value.content : undefined;
  const normalizedValue = typeof value.type === 'string'
    ? value
    : content
      ? { ...value, type: 'doc' }
      : value;

  return isValidEditorNode(normalizedValue) ? normalizedValue : null;
};

const extractTextFromStoredEditorContent = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractTextFromStoredEditorContent).filter(Boolean).join('\n');
  }
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (value.type === 'hardBreak') return '\n';
  if (Array.isArray(value.content)) {
    const separator = TEXT_SEPARATOR_EDITOR_NODE_TYPES.has(value.type) ? '\n' : '';
    return value.content.map(extractTextFromStoredEditorContent).filter(Boolean).join(separator);
  }
  return '';
};

export const createEditorContentFromPlainText = (text: string): any | null => {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  return {
    type: 'doc',
    content: lines.map(line => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
};

export const getSafeEditorContent = (
  value: unknown,
  fallback: any = { type: 'doc', content: [{ type: 'paragraph' }] },
): any => {
  const normalized = normalizeStoredEditorContent(value);
  if (normalized !== null) return normalized;

  const normalizedFallback = normalizeStoredEditorContent(fallback);
  if (normalizedFallback !== null && hasMeaningfulArticleContent(fallback)) {
    return normalizedFallback;
  }

  const recoveredText = extractTextFromStoredEditorContent(value).trim();
  const recoveredContent = createEditorContentFromPlainText(recoveredText);
  return recoveredContent || normalizedFallback || { type: 'doc', content: [{ type: 'paragraph' }] };
};
