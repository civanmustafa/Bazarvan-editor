import React, { useMemo } from 'react';
import type { ContentWritingSourceChunk } from '../utils/contentWritingKnowledge';

type ContentWritingChunkDisclosureProps = {
  chunkIds: readonly string[];
  chunks: readonly ContentWritingSourceChunk[];
  isArabic: boolean;
  className?: string;
};

const ContentWritingChunkDisclosure: React.FC<ContentWritingChunkDisclosureProps> = ({
  chunkIds,
  chunks,
  isArabic,
  className = '',
}) => {
  const chunksById = useMemo(() => new Map(chunks.map(chunk => [chunk.id, chunk])), [chunks]);
  const referencedChunks = chunkIds
    .map(chunkId => chunksById.get(chunkId))
    .filter((chunk): chunk is ContentWritingSourceChunk => Boolean(chunk));
  if (referencedChunks.length === 0) return null;

  return (
    <div className={`space-y-1.5 ${className}`} data-content-writing-chunk-disclosure="true">
      {referencedChunks.map(chunk => (
        <details key={chunk.id} className="overflow-hidden rounded border border-violet-100 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-900/10">
          <summary className="cursor-pointer list-none px-2 py-1.5 font-mono text-[9px] font-black text-violet-700 dark:text-violet-300">
            {chunk.id}
            <span className="ms-1.5 font-sans font-bold text-gray-500 dark:text-gray-400">
              {chunk.title || (
                isArabic
                  ? `مقتطف من المنافس ${chunk.competitorNumber}`
                  : `Excerpt from competitor ${chunk.competitorNumber}`
              )}
            </span>
          </summary>
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-violet-100 bg-white p-2.5 text-[11px] font-normal leading-6 text-gray-700 custom-scrollbar dark:border-violet-900/40 dark:bg-[#252525] dark:text-gray-200">
            {chunk.text}
          </div>
        </details>
      ))}
    </div>
  );
};

export default ContentWritingChunkDisclosure;
