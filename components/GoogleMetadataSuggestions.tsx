import React from 'react';
import { Copy } from 'lucide-react';

import { useEditorSelector } from '../contexts/EditorContext';
import { useUser } from '../contexts/UserContext';

const GoogleMetadataSuggestions: React.FC = () => {
  const { t } = useUser();
  const keywords = useEditorSelector(context => context.keywords);
  const setTitle = useEditorSelector(context => context.setTitle);
  const setMetaDescription = useEditorSelector(context => context.setMetaDescription);
  const labels = t.leftSidebar;
  const googleTitles = keywords.googleTitles || [];
  const googleDescriptions = keywords.googleDescriptions || [];
  const hasSuggestions = googleTitles.length > 0 || googleDescriptions.length > 0;

  return (
    <section
      className="mx-auto mb-8 mt-4 w-full max-w-[52rem] space-y-3 px-4"
      aria-label={labels.googleMetadataSuggestions}
    >
      {!hasSuggestions && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/10">
          <h3 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{labels.googleMetadataSuggestions}</h3>
          <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{labels.googleMetadataSuggestionsPending}</p>
        </div>
      )}

      {googleTitles.length > 0 && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-white p-3 dark:border-[#d4af37]/30 dark:bg-[#2A2A2A]">
          <h3 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{labels.googleTitleSuggestions}</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {googleTitles.map((suggestion, index) => (
              <article key={`${suggestion}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <p className="text-xs font-bold leading-5 text-gray-800 dark:text-gray-200">{suggestion}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setTitle(suggestion)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                    {labels.useGoogleTitle}
                  </button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(suggestion)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                    <Copy size={12} /> {labels.copy}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {googleDescriptions.length > 0 && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-white p-3 dark:border-[#d4af37]/30 dark:bg-[#2A2A2A]">
          <h3 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{labels.googleDescriptionSuggestions}</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {googleDescriptions.map((suggestion, index) => (
              <article key={`${suggestion.text}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <p className="text-xs font-medium leading-5 text-gray-700 dark:text-gray-300">{suggestion.text}</p>
                {suggestion.callToAction && (
                  <p className="mt-1 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">{labels.callToAction}: {suggestion.callToAction}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setMetaDescription(suggestion.text)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                    {labels.useGoogleDescription}
                  </button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(suggestion.text)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                    <Copy size={12} /> {labels.copy}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export default GoogleMetadataSuggestions;
