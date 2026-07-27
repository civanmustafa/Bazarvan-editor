import React, { useMemo } from 'react';
import {
  BookOpenCheck,
  ExternalLink,
  FileText,
  Grid3X3,
  Lightbulb,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import type { ContentWritingTransparencySnapshot } from '../utils/contentWritingTransparency';
import ContentWritingChunkDisclosure from './ContentWritingChunkDisclosure';

type ContentWritingTransparencyPanelProps = {
  snapshot: ContentWritingTransparencySnapshot;
  isArabic: boolean;
};

const labels = (isArabic: boolean) => ({
  matrix: isArabic ? 'مصفوفة تغطية المنافسين الكاملة' : 'Complete competitor coverage matrix',
  sources: isArabic ? 'سجل المصادر الكامل' : 'Complete source registry',
  claims: isArabic ? 'سجل الادعاءات وسياسة استخدامها' : 'Claims ledger and usage policy',
  excerpts: isArabic ? 'المقاطع الأصلية الكاملة' : 'Complete original excerpts',
});

const priorityLabel = (value: string, isArabic: boolean): string => ({
  high: isArabic ? 'أولوية عالية' : 'High priority',
  medium: isArabic ? 'أولوية متوسطة' : 'Medium priority',
  low: isArabic ? 'أولوية منخفضة' : 'Low priority',
}[value] || value);

const sourceCategoryLabel = (value: string, isArabic: boolean): string => ({
  official: isArabic ? 'رسمي' : 'Official',
  government: isArabic ? 'حكومي' : 'Government',
  academic: isArabic ? 'أكاديمي' : 'Academic',
  industry: isArabic ? 'متخصص في المجال' : 'Industry',
  news: isArabic ? 'إخباري' : 'News',
  commercial: isArabic ? 'تجاري' : 'Commercial',
  community: isArabic ? 'مجتمعي' : 'Community',
  unknown: isArabic ? 'غير محدد' : 'Unknown',
}[value] || value);

const freshnessLabel = (value: string, isArabic: boolean): string => ({
  current: isArabic ? 'حديث' : 'Current',
  dated: isArabic ? 'قديم نسبيًا' : 'Dated',
  unknown: isArabic ? 'حداثته غير معروفة' : 'Freshness unknown',
}[value] || value);

const sourcePolicyLabel = (value: string, isArabic: boolean): string => ({
  primary_support: isArabic ? 'دعم أساسي' : 'Primary support',
  contextual_support: isArabic ? 'دعم سياقي' : 'Contextual support',
  reference_only: isArabic ? 'مرجع للاسترشاد فقط' : 'Reference only',
}[value] || value);

const claimPolicyLabel = (value: string, isArabic: boolean): string => ({
  allowed: isArabic ? 'مسموح' : 'Allowed',
  qualify: isArabic ? 'يُستخدم بتحفّظ' : 'Use with qualification',
  blocked: isArabic ? 'محظور' : 'Blocked',
}[value] || value);

const verificationLabel = (value: string, isArabic: boolean): string => ({
  corroborated_by_competitors: isArabic ? 'متكرر لدى عدة منافسين' : 'Repeated by competitors',
  single_competitor_reference: isArabic ? 'مرجع منافس واحد' : 'Single competitor reference',
  requires_external_verification: isArabic ? 'يحتاج تحققًا خارجيًا' : 'Requires external verification',
  conflicting: isArabic ? 'المصادر متعارضة' : 'Conflicting sources',
}[value] || value);

const coverageLabel = (value: string, isArabic: boolean): string => ({
  all_competitors: isArabic ? 'موجود لدى جميع المنافسين' : 'Covered by all competitors',
  multiple_competitors: isArabic ? 'مشترك بين عدة منافسين' : 'Covered by multiple competitors',
  single_competitor: isArabic ? 'فكرة لدى منافس واحد' : 'Single-competitor idea',
}[value] || value);

const toSafeExternalUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const policyTone = (value: string): string => {
  if (value === 'allowed' || value === 'primary_support') {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300';
  }
  if (value === 'blocked' || value === 'reference_only') {
    return 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300';
  }
  return 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300';
};

const ContentWritingTransparencyPanel: React.FC<ContentWritingTransparencyPanelProps> = ({
  snapshot,
  isArabic,
}) => {
  const copy = labels(isArabic);
  const { knowledge, chunks } = snapshot;
  const chunksById = useMemo(() => new Map(chunks.map(chunk => [chunk.id, chunk])), [chunks]);
  const claimsById = useMemo(
    () => new Map(knowledge.claimLedger.claims.map(claim => [claim.id, claim])),
    [knowledge.claimLedger.claims],
  );

  return (
    <div className="space-y-2.5" dir={isArabic ? 'rtl' : 'ltr'} data-content-writing-transparency="complete">
      <div className="grid grid-cols-2 gap-1.5">
        {[
          [knowledge.items.length, isArabic ? 'فكرة موثقة' : 'Documented ideas'],
          [knowledge.sourceRegistry.sources.length, isArabic ? 'مصدرًا' : 'Sources'],
          [knowledge.claimLedger.claims.length, isArabic ? 'ادعاءً' : 'Claims'],
          [chunks.length, isArabic ? 'مقطعًا أصليًا' : 'Original excerpts'],
        ].map(([value, label]) => (
          <div key={String(label)} className="rounded-md bg-gray-50 px-2 py-2 text-center dark:bg-[#1F1F1F]">
            <div className="text-sm font-black text-[#8a6f1d] dark:text-[#f2d675]">{value}</div>
            <div className="mt-0.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">{label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-emerald-200 bg-emerald-50/70 p-2.5 text-[10px] font-bold leading-5 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/10 dark:text-emerald-200">
        {isArabic
          ? 'هذه هي قاعدة المعرفة النهائية بعد التحقق البرمجي، وليست إجابة النموذج الخام. افتح أي سجل لقراءة الروابط والمقاطع وسياسات الاستخدام.'
          : 'This is the final programmatically validated knowledge base, not the raw model response. Expand any registry to inspect URLs, excerpts, and usage policies.'}
      </div>

      <details open className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <Grid3X3 size={14} className="text-[#d4af37]" />
          <span>{copy.matrix}</span>
        </summary>
        <div className="max-h-[34rem] space-y-2 overflow-y-auto p-2 custom-scrollbar">
          {knowledge.items.map(item => (
            <article key={item.id} className="rounded-md border border-gray-100 bg-gray-50 p-2.5 dark:border-[#333] dark:bg-[#1F1F1F]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-black leading-5 text-gray-800 dark:text-gray-100">{item.topic}</div>
                  <div className="mt-0.5 font-mono text-[9px] text-gray-400">{item.id} · {item.kind}</div>
                </div>
                <span className="shrink-0 rounded bg-white px-1.5 py-1 text-[9px] font-black text-gray-500 dark:bg-[#2A2A2A]">
                  {priorityLabel(item.priority, isArabic)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap leading-6 text-gray-600 dark:text-gray-300">{item.detail}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {item.competitorNumbers.map(number => (
                  <span key={number} className="rounded bg-blue-50 px-1.5 py-1 text-[9px] font-black text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                    {isArabic ? `المنافس ${number}` : `Competitor ${number}`}
                  </span>
                ))}
                <span className="rounded bg-violet-50 px-1.5 py-1 text-[9px] font-black text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
                  {coverageLabel(item.coverageLevel, isArabic)}
                </span>
              </div>
              <div className="mt-1.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">
                {isArabic ? 'المقاطع الداعمة: ' : 'Supporting excerpts: '}
                <span className="font-mono">{item.sourceChunkIds.join('، ')}</span>
              </div>
              <ContentWritingChunkDisclosure
                chunkIds={item.sourceChunkIds}
                chunks={chunks}
                isArabic={isArabic}
                className="mt-2"
              />
              {item.originalityOpportunity && (
                <div className="mt-2 rounded border-s-2 border-[#d4af37] bg-[#d4af37]/5 px-2 py-1.5 leading-5 text-gray-600 dark:text-gray-300">
                  <Lightbulb size={12} className="me-1 inline text-[#d4af37]" />
                  <span className="font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {isArabic ? 'فرصة التفوق: ' : 'Originality opportunity: '}
                  </span>
                  {item.originalityOpportunity}
                </div>
              )}
            </article>
          ))}
        </div>
      </details>

      <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <BookOpenCheck size={14} className="text-blue-600" />
          <span>{copy.sources}</span>
        </summary>
        <div className="space-y-2 p-2">
          {knowledge.sourceRegistry.sources.map(source => {
            const safeUrl = toSafeExternalUrl(source.url);
            const sourceClaims = source.supportedClaimIds
              .map(claimId => claimsById.get(claimId))
              .filter(Boolean);
            return (
              <article key={source.id} className="rounded-md border border-gray-100 bg-gray-50 p-2.5 dark:border-[#333] dark:bg-[#1F1F1F]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-black text-gray-800 dark:text-gray-100">
                      {source.title || (isArabic ? `المنافس ${source.competitorNumber}` : `Competitor ${source.competitorNumber}`)}
                    </div>
                    <div className="mt-0.5 font-mono text-[9px] text-gray-400">{source.id}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[9px] font-black ${policyTone(source.usePolicy)}`}>
                    {sourcePolicyLabel(source.usePolicy, isArabic)}
                  </span>
                </div>
                {safeUrl && (
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1.5 flex items-center gap-1 break-all text-[10px] font-bold text-blue-600 underline underline-offset-2 dark:text-blue-300"
                  >
                    <ExternalLink size={11} className="shrink-0" />
                    <span>{safeUrl}</span>
                  </a>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                    {sourceCategoryLabel(source.category, isArabic)}
                  </span>
                  <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                    {freshnessLabel(source.freshness, isArabic)}
                  </span>
                  <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                    {source.chunkIds.length} {isArabic ? 'مقاطع' : 'excerpts'}
                  </span>
                </div>
                {source.assessmentNotes && (
                  <p className="mt-2 leading-5 text-gray-600 dark:text-gray-300">{source.assessmentNotes}</p>
                )}
                {sourceClaims.length > 0 && (
                  <div className="mt-2 rounded bg-white p-2 dark:bg-[#2A2A2A]">
                    <div className="mb-1 text-[9px] font-black text-gray-500">
                      {isArabic ? 'الادعاءات المرتبطة بهذا المصدر' : 'Claims linked to this source'}
                    </div>
                    {sourceClaims.map(claim => (
                      <div key={claim!.id} className="border-t border-gray-100 py-1.5 first:border-0 dark:border-[#3C3C3C]">
                        <span className="font-mono text-[9px] text-gray-400">{claim!.id}</span>
                        <p className="leading-5 text-gray-700 dark:text-gray-200">{claim!.statement}</p>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </details>

      <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <ShieldCheck size={14} className="text-emerald-600" />
          <span>{copy.claims}</span>
        </summary>
        <div className="max-h-[34rem] space-y-2 overflow-y-auto p-2 custom-scrollbar">
          {knowledge.claimLedger.claims.length === 0 ? (
            <div className="rounded-md bg-gray-50 p-2.5 font-bold text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-400">
              {isArabic ? 'لم يُسجّل النظام ادعاءات قابلة للتحقق.' : 'No verifiable claims were registered.'}
            </div>
          ) : knowledge.claimLedger.claims.map(claim => (
            <article key={claim.id} className="rounded-md border border-gray-100 bg-gray-50 p-2.5 dark:border-[#333] dark:bg-[#1F1F1F]">
              <div className="flex items-start gap-2">
                {claim.usagePolicy === 'blocked'
                  ? <ShieldX size={14} className="mt-1 shrink-0 text-red-600" />
                  : <ShieldCheck size={14} className="mt-1 shrink-0 text-emerald-600" />}
                <div className="min-w-0">
                  <div className="font-mono text-[9px] text-gray-400">{claim.id}</div>
                  <p className="font-bold leading-6 text-gray-800 dark:text-gray-100">{claim.statement}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className={`rounded px-1.5 py-1 text-[9px] font-black ${policyTone(claim.usagePolicy)}`}>
                  {claimPolicyLabel(claim.usagePolicy, isArabic)}
                </span>
                <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                  {verificationLabel(claim.verificationStatus, isArabic)}
                </span>
                <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                  {claim.claimType}
                </span>
                <span className="rounded bg-white px-1.5 py-1 text-[9px] font-bold dark:bg-[#2A2A2A]">
                  {isArabic ? `الحساسية: ${claim.riskLevel}` : `Risk: ${claim.riskLevel}`}
                </span>
              </div>
              {claim.usageGuidance && (
                <div className="mt-2 rounded bg-white p-2 leading-5 text-gray-600 dark:bg-[#2A2A2A] dark:text-gray-300">
                  <span className="font-black">{isArabic ? 'طريقة الاستخدام: ' : 'Usage guidance: '}</span>
                  {claim.usageGuidance}
                </div>
              )}
              <div className="mt-2 space-y-1 font-mono text-[9px] text-gray-500 dark:text-gray-400">
                <div>{isArabic ? 'الأفكار: ' : 'Ideas: '}{claim.knowledgeItemIds.join('، ') || '—'}</div>
                <div>{isArabic ? 'المصادر: ' : 'Sources: '}{claim.supportingSourceIds.join('، ') || '—'}</div>
                <div>{isArabic ? 'المقاطع: ' : 'Excerpts: '}{claim.supportingSourceChunkIds.join('، ') || '—'}</div>
              </div>
            </article>
          ))}
        </div>
      </details>

      <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <FileText size={14} className="text-violet-600" />
          <span>{copy.excerpts}</span>
        </summary>
        <div className="space-y-2 p-2">
          {knowledge.sourceRegistry.sources.map(source => (
            <details key={source.id} className="overflow-hidden rounded-md border border-gray-100 dark:border-[#333]">
              <summary className="cursor-pointer list-none bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#1F1F1F] dark:text-gray-200">
                {source.title || (isArabic ? `المنافس ${source.competitorNumber}` : `Competitor ${source.competitorNumber}`)}
                <span className="ms-1.5 font-mono text-[9px] text-gray-400">{source.chunkIds.length}</span>
              </summary>
              <div className="space-y-2 p-2">
                {source.chunkIds.map(chunkId => {
                  const chunk = chunksById.get(chunkId);
                  if (!chunk) return null;
                  return (
                    <details key={chunkId} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                      <summary className="cursor-pointer list-none font-mono text-[9px] font-black text-blue-600 dark:text-blue-300">
                        {chunkId}
                      </summary>
                      <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2.5 text-[11px] leading-6 text-gray-700 custom-scrollbar dark:bg-[#252525] dark:text-gray-200">
                        {chunk.text}
                      </div>
                    </details>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      </details>
    </div>
  );
};

export default ContentWritingTransparencyPanel;
