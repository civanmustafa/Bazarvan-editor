import {
  normalizeContentWritingKnowledgeBase,
  normalizeContentWritingSourceChunks,
  type ContentWritingKnowledgeBase,
  type ContentWritingSourceChunk,
} from './contentWritingKnowledge';
import { parseContentWritingPresentationObject } from './contentWritingKnowledgePresentation';

export type ContentWritingTransparencySnapshot = {
  knowledge: ContentWritingKnowledgeBase;
  chunks: ContentWritingSourceChunk[];
};

export const buildContentWritingTransparencySnapshot = (options: {
  knowledgeValue?: unknown;
  competitorChunks?: unknown;
  fallbackOutputText?: string;
}): ContentWritingTransparencySnapshot | null => {
  const chunks = normalizeContentWritingSourceChunks(options.competitorChunks);
  if (chunks.length === 0) return null;
  const fallbackValue = options.fallbackOutputText
    ? parseContentWritingPresentationObject(options.fallbackOutputText)
    : null;
  const knowledge = normalizeContentWritingKnowledgeBase(
    options.knowledgeValue || fallbackValue || {},
    chunks,
  );
  if (knowledge.items.length === 0) return null;
  return { knowledge, chunks };
};
