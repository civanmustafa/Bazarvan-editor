import React, { useMemo } from 'react';
import { BrainCircuit, ExternalLink } from 'lucide-react';
import type { Keywords } from '../types';
import {
  createCompetitorPhraseIntelligence,
  type CompetitorPhraseIntelligenceDecision,
  type CompetitorPhraseSource,
} from '../utils/competitorPhraseAnalysis';

type CompetitorPhraseIntelligencePanelProps = {
  locale: string;
  articleLanguage: 'ar' | 'en';
  sources: CompetitorPhraseSource[];
  keywords: Keywords;
  competitorUrls: string[];
};

const DECISION_LABELS: Record<CompetitorPhraseIntelligenceDecision, { ar: string; en: string }> = {
  must_cover: { ar: 'يجب تغطيتها', en: 'Must cover' },
  supporting: { ar: 'مساندة', en: 'Supporting' },
  review: { ar: 'تحتاج مراجعة', en: 'Needs review' },
  low_priority: { ar: 'أولوية منخفضة', en: 'Low priority' },
  ignore: { ar: 'تُتجاهل', en: 'Ignore' },
};

const DECISION_STYLES: Record<CompetitorPhraseIntelligenceDecision, string> = {
  must_cover: 'border-[#d4af37]/45 bg-[#d4af37]/15 text-[#8a6f1d] dark:border-[#d4af37]/30 dark:bg-[#d4af37]/15 dark:text-[#f2d675]',
  supporting: 'border-[#d4af37]/30 bg-[#d4af37]/10 text-[#8a6f1d] dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10 dark:text-[#f2d675]',
  review: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-300',
  low_priority: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
  ignore: 'border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-400',
};

const toSafeUrl = (value?: string): string => {
  const trimmed = value?.trim() || '';
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const getSourceHost = (value?: string): string => {
  const safeUrl = toSafeUrl(value);
  return safeUrl ? new URL(safeUrl).hostname.replace(/^www\./i, '') : '';
};

const CompetitorPhraseIntelligencePanel: React.FC<CompetitorPhraseIntelligencePanelProps> = ({
  locale,
  articleLanguage,
  sources,
  keywords,
  competitorUrls,
}) => {
  const isArabic = locale === 'ar';
  const intelligence = useMemo(
    () => createCompetitorPhraseIntelligence({
      sources,
      keywords,
      articleLanguage,
    }),
    [articleLanguage, keywords, sources],
  );
  const priorityItems = useMemo(
    () => [
      ...intelligence.mustCover,
      ...intelligence.supporting,
      ...intelligence.review,
    ].slice(0, 24),
    [intelligence],
  );
  const lowPriorityItems = useMemo(
    () => intelligence.lowPriority.slice(0, 10),
    [intelligence],
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-bold text-gray-800 dark:text-gray-100">
          <BrainCircuit size={14} className="shrink-0 text-[#d4af37]" />
          <span>{isArabic ? 'تحليل أهمية العبارات' : 'Phrase importance analysis'}</span>
        </div>
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-400">
          {isArabic
            ? `${intelligence.items.length.toLocaleString('ar')} عبارات رئيسية`
            : `${intelligence.items.length.toLocaleString('en')} canonical`}
        </span>
      </div>
      <p className="mb-3 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
        {isArabic
          ? 'تصنيف برمجي يربط العبارات المتكررة والمشتركة بالكلمة الأساسية والصيغ البديلة والكلمات الدلالية. الغرض هو تحويلها إلى أفكار تغطية، لا نسخها حرفيًا أو حشوها.'
          : 'A deterministic classification that connects repeated and shared phrases to the primary, alternative, and LSI keywords. It guides topic coverage rather than copying or stuffing phrases.'}
      </p>

      <div className="mb-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
        {([
          ['must_cover', intelligence.mustCover.length],
          ['supporting', intelligence.supporting.length],
          ['review', intelligence.review.length],
          ['low_priority', intelligence.lowPriority.length],
        ] as const).map(([decision, count]) => (
          <div
            key={decision}
            className={`rounded-md border px-2 py-1.5 font-bold ${DECISION_STYLES[decision]}`}
          >
            <div>{DECISION_LABELS[decision][isArabic ? 'ar' : 'en']}</div>
            <div className="mt-0.5 text-sm font-black tabular-nums">{count}</div>
          </div>
        ))}
      </div>

      {priorityItems.length === 0 ? (
        <div className="rounded-md bg-white/80 p-3 text-xs text-gray-400 dark:bg-[#1F1F1F]">
          {sources.length === 0
            ? (isArabic
              ? 'أضف نص منافس واحد على الأقل لبدء التحليل.'
              : 'Add at least one competitor text to start the analysis.')
            : (isArabic
              ? 'لم تُكتشف بعد عبارات ذات أولوية كافية.'
              : 'No phrases with sufficient priority were found yet.')}
        </div>
      ) : (
        <div className="max-h-[32rem] space-y-2 overflow-y-auto custom-scrollbar">
          {priorityItems.map(item => (
            <div
              key={`${item.decision}-${item.size}-${item.normalizedText}`}
              className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 whitespace-normal break-words text-xs font-semibold leading-5 text-gray-700 dark:text-gray-200">
                  {item.text}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] font-black ${DECISION_STYLES[item.decision]}`}>
                    {DECISION_LABELS[item.decision][isArabic ? 'ar' : 'en']}
                  </span>
                  <span
                    className="rounded bg-[#d4af37]/15 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]"
                    title={isArabic ? 'درجة الأهمية من 100' : 'Importance score out of 100'}
                  >
                    {item.score}/100
                  </span>
                </div>
              </div>

              <div className="mt-1 text-[10px] font-bold text-gray-400">
                {item.size} {isArabic ? 'كلمات' : 'words'}
                <span className="px-1">•</span>
                {isArabic ? `${item.competitorCount} منافسين` : `${item.competitorCount} competitors`}
                <span className="px-1">•</span>
                {isArabic ? `${item.totalCount} مرات إجمالًا` : `${item.totalCount} total occurrences`}
              </div>

              {item.matchedKeywordTerms.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[9px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {isArabic ? 'التقاطع مع الكلمات المستهدفة' : 'Keyword overlap'}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {item.matchedKeywordTerms.map(term => (
                      <span
                        key={term}
                        className="rounded-full bg-[#d4af37]/15 px-2 py-0.5 text-[9px] font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]"
                      >
                        {term}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-2 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                {item.rationale}
              </p>

              <div className="mt-2 flex flex-wrap gap-1">
                {item.competitors.map(occurrence => {
                  const sourceUrl = toSafeUrl(competitorUrls[occurrence.competitorNumber - 1]);
                  const sourceHost = getSourceHost(sourceUrl);
                  const label = isArabic
                    ? `المنافس ${occurrence.competitorNumber}`
                    : `Competitor ${occurrence.competitorNumber}`;
                  const chip = (
                    <>
                      <span>{label}{sourceHost ? ` · ${sourceHost}` : ''}</span>
                      <span className="tabular-nums opacity-70">×{occurrence.count}</span>
                    </>
                  );
                  return sourceUrl ? (
                    <a
                      key={occurrence.competitorNumber}
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-1 text-[9px] font-bold text-gray-600 hover:border-[#d4af37]/50 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-300 dark:hover:text-[#f2d675]"
                      title={sourceUrl}
                    >
                      {chip}
                      <ExternalLink size={9} className="shrink-0" />
                    </a>
                  ) : (
                    <span
                      key={occurrence.competitorNumber}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-[9px] font-bold text-gray-600 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300"
                    >
                      {chip}
                    </span>
                  );
                })}
              </div>

              {Boolean(item.containedPhrases?.length) && (
                <details className="mt-2 border-t border-gray-200 pt-2 dark:border-[#3C3C3C]">
                  <summary className="cursor-pointer text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {isArabic
                      ? `تتضمن ${item.containedPhrases!.length.toLocaleString('ar')} عبارات أقصر مدمجة`
                      : `Includes ${item.containedPhrases!.length.toLocaleString('en')} collapsed shorter phrases`}
                  </summary>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.containedPhrases!.map(phrase => (
                      <span
                        key={`${phrase.size}-${phrase.normalizedText}`}
                        className="rounded-full border border-gray-200 bg-white px-2 py-1 text-[9px] font-bold text-gray-500 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-400"
                      >
                        {phrase.text}
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {lowPriorityItems.length > 0 && (
        <details className="mt-3 rounded-md border border-gray-200 bg-white/80 p-2 dark:border-gray-700 dark:bg-[#1F1F1F]">
          <summary className="cursor-pointer text-[10px] font-black text-gray-600 dark:text-gray-300">
            {isArabic
              ? `عبارات لا ينبغي مطاردتها (${lowPriorityItems.length})`
              : `Phrases not to chase (${lowPriorityItems.length})`}
          </summary>
          <div className="mt-2 space-y-1.5">
            {lowPriorityItems.map(item => (
              <div
                key={`low-${item.size}-${item.normalizedText}`}
                className="rounded bg-gray-50 px-2 py-1.5 text-[10px] dark:bg-gray-900/40"
              >
                <div className="font-bold text-gray-600 dark:text-gray-300">{item.text}</div>
                <div className="mt-0.5 text-gray-400">{item.rationale}</div>
                {Boolean(item.containedPhrases?.length) && (
                  <div className="mt-1 text-[9px] font-bold text-[#8a6f1d] dark:text-[#f2d675]">
                    {isArabic
                      ? `${item.containedPhrases!.length.toLocaleString('ar')} عبارات أقصر مدمجة`
                      : `${item.containedPhrases!.length.toLocaleString('en')} collapsed shorter phrases`}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export default CompetitorPhraseIntelligencePanel;
