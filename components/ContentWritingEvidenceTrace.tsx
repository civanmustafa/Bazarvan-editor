import React, { useMemo } from 'react';
import {
  BookOpenText,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  Lightbulb,
  ShieldAlert,
} from 'lucide-react';
import type { ContentWritingTransparencySnapshot } from '../utils/contentWritingTransparency';
import {
  normalizeContentWritingEvidenceTrace,
  normalizeContentWritingSectionCoverage,
} from '../utils/contentWritingEvidence';

type ContentWritingEvidenceTraceProps = {
  evidenceTrace: unknown;
  sectionCoverage: unknown;
  promptText?: string;
  transparency: ContentWritingTransparencySnapshot | null;
  isArabic: boolean;
};

const policyLabel = (value: string, isArabic: boolean): string => ({
  allowed: isArabic ? 'مسموح' : 'Allowed',
  qualify: isArabic ? 'يُستخدم بتحفّظ' : 'Qualified',
  blocked: isArabic ? 'محظور' : 'Blocked',
}[value] || value);

const verificationLabel = (value: string, isArabic: boolean): string => ({
  corroborated_by_competitors: isArabic ? 'متكرر لدى عدة منافسين' : 'Repeated by competitors',
  single_competitor_reference: isArabic ? 'مرجع منافس واحد' : 'Single competitor reference',
  requires_external_verification: isArabic ? 'يحتاج تحققًا خارجيًا' : 'External verification required',
  conflicting: isArabic ? 'متعارض' : 'Conflicting',
}[value] || value);

const policyTone = (value: string): string => {
  if (value === 'allowed') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300';
  if (value === 'blocked') return 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300';
  return 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300';
};

const toSafeExternalUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const ContentWritingEvidenceTrace: React.FC<ContentWritingEvidenceTraceProps> = ({
  evidenceTrace,
  sectionCoverage,
  promptText = '',
  transparency,
  isArabic,
}) => {
  const trace = useMemo(
    () => normalizeContentWritingEvidenceTrace(evidenceTrace, promptText),
    [evidenceTrace, promptText],
  );
  const coverage = useMemo(
    () => normalizeContentWritingSectionCoverage(sectionCoverage),
    [sectionCoverage],
  );
  const sourceByCompetitor = useMemo(
    () => new Map(
      (transparency?.knowledge.sourceRegistry.sources || [])
        .map(source => [source.competitorNumber, source]),
    ),
    [transparency],
  );
  if (!trace) return null;

  const coveredIdeas = new Set(coverage.coveredIdeaIds);
  const usedClaims = new Set(coverage.usedClaimIds);
  const usedChunks = new Set(coverage.usedSourceChunkIds);

  return (
    <div className="mt-3 space-y-2.5" dir={isArabic ? 'rtl' : 'ltr'} data-content-writing-evidence-trace="true">
      <div className="rounded-md border border-violet-200 bg-violet-50/60 p-2.5 dark:border-violet-900/50 dark:bg-violet-900/10">
        <div className="flex items-center gap-2 font-black text-violet-800 dark:text-violet-200">
          <FileSearch size={14} />
          <span>{isArabic ? 'خريطة اعتماد هذا القسم' : 'This section’s evidence map'}</span>
        </div>
        <p className="mt-1 text-[10px] font-semibold leading-5 text-violet-700 dark:text-violet-300">
          {isArabic
            ? '«متاح» يعني أنه أُرسل للمرحلة، بينما «استُخدم» يعني أن نتيجة المرحلة صرّحت باستخدامه فعلًا.'
            : '“Available” means it was sent to the step; “used” means the step result explicitly declared using it.'}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {[
            [trace.knowledgeItems.length, isArabic ? 'أفكار متاحة' : 'Ideas available'],
            [trace.claims.length, isArabic ? 'ادعاءات متاحة' : 'Claims available'],
            [trace.sourceChunks.length, isArabic ? 'مقتطفات متاحة' : 'Excerpts available'],
          ].map(([value, label]) => (
            <div key={String(label)} className="rounded bg-white p-1.5 text-center dark:bg-[#252525]">
              <div className="font-black text-violet-800 dark:text-violet-200">{value}</div>
              <div className="text-[8px] font-bold text-gray-500 dark:text-gray-400">{label}</div>
            </div>
          ))}
        </div>
      </div>

      <details open className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <Lightbulb size={14} className="text-[#d4af37]" />
          <span>{isArabic ? 'الأفكار المخصصة للقسم' : 'Ideas assigned to the section'}</span>
        </summary>
        <div className="space-y-1.5 p-2">
          {trace.knowledgeItems.map(item => {
            const used = coveredIdeas.has(item.id);
            return (
              <article key={item.id} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-[9px] text-gray-400">{item.id}</span>
                    <div className="font-black leading-5 text-gray-800 dark:text-gray-100">{item.topic}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[9px] font-black ${
                    used
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-gray-100 text-gray-500 dark:bg-[#333] dark:text-gray-300'
                  }`}>
                    {used ? (isArabic ? 'استُخدمت' : 'Used') : (isArabic ? 'متاحة' : 'Available')}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap leading-5 text-gray-600 dark:text-gray-300">{item.detail}</p>
                {item.originalityOpportunity && (
                  <p className="mt-1.5 rounded bg-[#d4af37]/5 p-1.5 leading-5 text-gray-600 dark:text-gray-300">
                    <span className="font-black text-[#8a6f1d] dark:text-[#f2d675]">
                      {isArabic ? 'فرصة التفوق: ' : 'Opportunity: '}
                    </span>
                    {item.originalityOpportunity}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </details>

      {trace.claims.length > 0 && (
        <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
          <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
            <ShieldAlert size={14} className="text-amber-600" />
            <span>{isArabic ? 'الادعاءات المتاحة وسياسة استخدامها' : 'Available claims and usage policy'}</span>
          </summary>
          <div className="space-y-1.5 p-2">
            {trace.claims.map(claim => {
              const used = usedClaims.has(claim.id);
              return (
                <article key={claim.id} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-[9px] text-gray-400">{claim.id}</span>
                      <p className="font-bold leading-5 text-gray-800 dark:text-gray-100">{claim.statement}</p>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-1 text-[9px] font-black ${
                      used
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-500 dark:bg-[#333] dark:text-gray-300'
                    }`}>
                      {used ? (isArabic ? 'استُخدم' : 'Used') : (isArabic ? 'متاح' : 'Available')}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <span className={`rounded px-1.5 py-1 text-[9px] font-black ${policyTone(claim.usagePolicy)}`}>
                      {policyLabel(claim.usagePolicy, isArabic)}
                    </span>
                    <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#252525]">
                      {verificationLabel(claim.verificationStatus, isArabic)}
                    </span>
                  </div>
                  {claim.usageGuidance && (
                    <p className="mt-1.5 leading-5 text-gray-500 dark:text-gray-400">
                      <span className="font-black">{isArabic ? 'طريقة الاستخدام: ' : 'Guidance: '}</span>
                      {claim.usageGuidance}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </details>
      )}

      <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <BookOpenText size={14} className="text-blue-600" />
          <span>{isArabic ? 'المقتطفات الأصلية المرسلة لهذه المرحلة' : 'Original excerpts sent to this step'}</span>
        </summary>
        <div className="space-y-2 p-2">
          {trace.sourceChunks.map(chunk => {
            const source = sourceByCompetitor.get(chunk.competitorNumber);
            const safeUrl = toSafeExternalUrl(source?.url || chunk.url);
            const used = usedChunks.has(chunk.id);
            return (
              <article key={chunk.id} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-black text-gray-800 dark:text-gray-100">
                      {source?.title || chunk.title || (isArabic ? `المنافس ${chunk.competitorNumber}` : `Competitor ${chunk.competitorNumber}`)}
                    </div>
                    <div className="font-mono text-[9px] text-gray-400">{chunk.id}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[9px] font-black ${
                    used
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-gray-100 text-gray-500 dark:bg-[#333] dark:text-gray-300'
                  }`}>
                    {used ? (isArabic ? 'استُخدم' : 'Used') : (isArabic ? 'متاح' : 'Available')}
                  </span>
                </div>
                {safeUrl && (
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 flex items-center gap-1 break-all text-[9px] font-bold text-blue-600 underline dark:text-blue-300"
                  >
                    <ExternalLink size={10} className="shrink-0" />
                    <span>{safeUrl}</span>
                  </a>
                )}
                <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2.5 text-[11px] leading-6 text-gray-700 custom-scrollbar dark:bg-[#252525] dark:text-gray-200">
                  {chunk.text}
                </div>
                {used && (
                  <div className="mt-1.5 flex items-center gap-1 text-[9px] font-black text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 size={11} />
                    <span>{isArabic ? 'صرّحت المرحلة باستخدام هذا المقتطف.' : 'The step declared this excerpt as used.'}</span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </details>
    </div>
  );
};

export default ContentWritingEvidenceTrace;
