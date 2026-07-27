import React, { useMemo } from 'react';
import {
  BookOpenCheck,
  CheckCircle2,
  Database,
  FileText,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';
import type { ContentWritingTransparencySnapshot } from '../utils/contentWritingTransparency';
import type { ContentWritingStageKnowledgeUsage } from '../utils/contentWritingStageKnowledge';
import ContentWritingTransparencyPanel from './ContentWritingTransparencyPanel';
import ContentWritingChunkDisclosure from './ContentWritingChunkDisclosure';

type ContentWritingStageKnowledgeUsageProps = {
  snapshot: ContentWritingTransparencySnapshot;
  usage: ContentWritingStageKnowledgeUsage;
  isArabic: boolean;
};

const ContentWritingStageKnowledgeUsagePanel: React.FC<ContentWritingStageKnowledgeUsageProps> = ({
  snapshot,
  usage,
  isArabic,
}) => {
  const referencedIdeaIds = useMemo(
    () => new Set(usage.referencedKnowledgeItemIds),
    [usage.referencedKnowledgeItemIds],
  );
  const referencedSourceIds = useMemo(
    () => new Set(usage.referencedSourceIds),
    [usage.referencedSourceIds],
  );
  const referencedClaimIds = useMemo(
    () => new Set(usage.referencedClaimIds),
    [usage.referencedClaimIds],
  );
  const referencedChunkIds = useMemo(
    () => new Set(usage.referencedSourceChunkIds),
    [usage.referencedSourceChunkIds],
  );
  const referencedIdeas = snapshot.knowledge.items.filter(item => referencedIdeaIds.has(item.id));
  const referencedSources = snapshot.knowledge.sourceRegistry.sources.filter(source => referencedSourceIds.has(source.id));
  const referencedClaims = snapshot.knowledge.claimLedger.claims.filter(claim => referencedClaimIds.has(claim.id));
  const referencedChunks = snapshot.chunks.filter(chunk => referencedChunkIds.has(chunk.id));
  const referenceCount = referencedIdeas.length
    + referencedSources.length
    + referencedClaims.length
    + referencedChunks.length;

  const scopeCopy = usage.scope === 'targeted'
    ? (
        isArabic
          ? 'استلمت هذه المرحلة السجلات الكاملة ضمن سياق الجلسة، وأُرفقت معها نصوص المقتطفات الأصلية المرتبطة بنطاقها فقط.'
          : 'This stage received the complete registries in session context plus only the original excerpts related to its target.'
      )
    : usage.scope === 'creation'
      ? (
          isArabic
            ? 'هذه هي المرحلة المسؤولة عن إنشاء مصفوفة المعرفة وسجل المصادر والادعاءات من جميع المنافسين المتاحين.'
            : 'This stage creates the knowledge matrix, source registry, and claims ledger from every available competitor.'
        )
      : (
          isArabic
            ? 'استلمت هذه المرحلة مصفوفة المعرفة وسجل المصادر والادعاءات كاملين ضمن سياق الجلسة، دون إعادة إرسال نصوص المنافسين الخام.'
            : 'This stage received the complete normalized knowledge, source, and claim registries without resending raw competitor text.'
        );

  const referenceTitle = {
    created: isArabic ? 'ما أنشأته المرحلة' : 'Created by this stage',
    planned: isArabic ? 'ما اختاره المخطط للاستخدام' : 'Selected by the outline',
    declared_used: isArabic ? 'ما صرّحت المرحلة باستخدامه فعليًا' : 'Declared as actually used',
    flagged: isArabic ? 'ما أشارت إليه نتيجة التدقيق' : 'Flagged by the audit',
    not_declared: isArabic ? 'الاستخدام التفصيلي غير مصرّح به' : 'Item-level use was not declared',
  }[usage.referenceKind];

  return (
    <details className="mt-3 overflow-hidden rounded-md border border-violet-200 bg-violet-50/30 dark:border-violet-900/50 dark:bg-violet-900/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 bg-violet-50 px-3 py-2.5 font-black text-violet-800 dark:bg-violet-900/20 dark:text-violet-200">
        <Database size={15} className="shrink-0" />
        <span>{isArabic ? 'المعرفة والمصادر والادعاءات في هذه المرحلة' : 'Knowledge, sources, and claims in this stage'}</span>
      </summary>

      <div className="space-y-3 p-3" dir={isArabic ? 'rtl' : 'ltr'}>
        <p className="rounded-md bg-white p-2.5 text-[11px] font-bold leading-6 text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          {scopeCopy}
        </p>

        <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
          {[
            [Database, usage.sentKnowledgeItemIds.length, snapshot.knowledge.items.length, isArabic ? 'أفكار أُرسلت' : 'Ideas sent'],
            [BookOpenCheck, usage.sentSourceIds.length, snapshot.knowledge.sourceRegistry.sources.length, isArabic ? 'سجلات مصادر أُرسلت' : 'Source records sent'],
            [ShieldCheck, usage.sentClaimIds.length, snapshot.knowledge.claimLedger.claims.length, isArabic ? 'ادعاءات أُرسلت' : 'Claims sent'],
            [FileText, usage.sentSourceChunkIds.length, snapshot.chunks.length, isArabic ? 'مقتطفات أصلية أُرسلت' : 'Original excerpts sent'],
          ].map(([Icon, current, total, label]) => {
            const MetricIcon = Icon as typeof Database;
            return (
              <div key={String(label)} className="rounded-md bg-white p-2 text-center dark:bg-[#252525]">
                <MetricIcon size={13} className="mx-auto mb-1 text-violet-600 dark:text-violet-300" />
                <div className="font-black text-gray-800 dark:text-gray-100">
                  {Number(current).toLocaleString(isArabic ? 'ar' : 'en')}
                  <span className="mx-1 text-gray-400">/</span>
                  {Number(total).toLocaleString(isArabic ? 'ar' : 'en')}
                </div>
                <div className="mt-0.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">{String(label)}</div>
              </div>
            );
          })}
        </div>

        <div className={`rounded-md p-2.5 text-[10px] font-bold leading-5 ${
          usage.referenceKind === 'not_declared'
            ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200'
            : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200'
        }`}>
          <div className="flex items-center gap-1.5 font-black">
            {usage.referenceKind === 'not_declared' ? <ListChecks size={13} /> : <CheckCircle2 size={13} />}
            <span>{referenceTitle}</span>
          </div>
          {usage.referenceKind === 'not_declared' && (
            <p className="mt-1">
              {isArabic
                ? 'يمكن إثبات أن السجلات الكاملة أُرسلت، لكن مخرجات هذه المرحلة نص حر ولا تعيد معرّفات الأفكار والمصادر التي اعتمدت عليها؛ لذلك لا ينسب النظام استخدامًا دقيقًا دون دليل.'
                : 'The complete registries were sent, but this free-form prose step does not return the IDs it relied on, so exact use is not inferred without evidence.'}
            </p>
          )}
          {usage.referenceKind !== 'not_declared' && referenceCount === 0 && (
            <p className="mt-1">
              {isArabic ? 'لم تُرجع المرحلة عناصر محددة ضمن هذه الفئة.' : 'The stage returned no specific referenced items in this category.'}
            </p>
          )}
        </div>

        {referenceCount > 0 && (
          <details className="overflow-hidden rounded-md border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#252525]">
            <summary className="cursor-pointer list-none px-2.5 py-2 font-black text-gray-700 dark:text-gray-200">
              {referenceTitle} · {referenceCount.toLocaleString(isArabic ? 'ar' : 'en')}
            </summary>
            <div className="space-y-2 border-t border-gray-100 p-2 dark:border-[#3C3C3C]">
              {referencedIdeas.map(item => (
                <div key={item.id} className="rounded bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                  <span className="font-mono text-[9px] text-gray-400">{item.id}</span>
                  <div className="font-black text-gray-700 dark:text-gray-200">{item.topic}</div>
                </div>
              ))}
              {referencedSources.map(source => (
                <div key={source.id} className="rounded bg-blue-50 p-2 dark:bg-blue-900/10">
                  <span className="font-mono text-[9px] text-blue-400">{source.id}</span>
                  <div className="font-black text-blue-800 dark:text-blue-200">
                    {source.title || (isArabic ? `المنافس ${source.competitorNumber}` : `Competitor ${source.competitorNumber}`)}
                  </div>
                </div>
              ))}
              {referencedClaims.map(claim => (
                <div key={claim.id} className="rounded bg-amber-50 p-2 dark:bg-amber-900/10">
                  <span className="font-mono text-[9px] text-amber-500">{claim.id}</span>
                  <div className="font-bold leading-5 text-amber-900 dark:text-amber-100">{claim.statement}</div>
                </div>
              ))}
              {referencedChunks.map(chunk => (
                <div key={chunk.id} className="rounded bg-violet-50 p-2 dark:bg-violet-900/10">
                  <span className="font-mono text-[9px] text-violet-500">{chunk.id}</span>
                  <div className="font-bold text-violet-800 dark:text-violet-200">
                    {chunk.title || (isArabic ? `مقتطف من المنافس ${chunk.competitorNumber}` : `Excerpt from competitor ${chunk.competitorNumber}`)}
                  </div>
                  <ContentWritingChunkDisclosure
                    chunkIds={[chunk.id]}
                    chunks={snapshot.chunks}
                    isArabic={isArabic}
                    className="mt-1.5"
                  />
                </div>
              ))}
            </div>
          </details>
        )}

        <details className="overflow-hidden rounded-md border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#252525]">
          <summary className="cursor-pointer list-none px-2.5 py-2 font-black text-gray-700 dark:text-gray-200">
            {isArabic
              ? 'فتح قاعدة المعرفة المحفوظة للجلسة (قد تتضمن مقتطفات لم تُرسل لهذه المرحلة)'
              : 'Open the persisted session knowledge (may include excerpts not sent to this stage)'}
          </summary>
          <div className="border-t border-gray-100 p-2 dark:border-[#3C3C3C]">
            <ContentWritingTransparencyPanel snapshot={snapshot} isArabic={isArabic} />
          </div>
        </details>
      </div>
    </details>
  );
};

export default ContentWritingStageKnowledgeUsagePanel;
