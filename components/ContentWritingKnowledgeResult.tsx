import React, { useMemo } from 'react';
import {
  AlertTriangle,
  BookOpenText,
  CheckCircle2,
  Lightbulb,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { presentContentWritingKnowledge } from '../utils/contentWritingKnowledgePresentation';
import { buildContentWritingTransparencySnapshot } from '../utils/contentWritingTransparency';
import ContentWritingTransparencyPanel from './ContentWritingTransparencyPanel';

type ContentWritingKnowledgeResultProps = {
  outputText: string;
  knowledgeValue?: unknown;
  competitorChunks?: unknown;
  isArabic: boolean;
};

const priorityLabel = (priority: 'high' | 'medium' | 'low', isArabic: boolean): string => {
  const labels = {
    high: isArabic ? 'أولوية عالية' : 'High priority',
    medium: isArabic ? 'أولوية متوسطة' : 'Medium priority',
    low: isArabic ? 'أولوية منخفضة' : 'Low priority',
  };
  return labels[priority];
};

const riskLabel = (risk: 'high' | 'medium' | 'low', isArabic: boolean): string => {
  const labels = {
    high: isArabic ? 'حساسية عالية' : 'High risk',
    medium: isArabic ? 'يحتاج دقة' : 'Needs care',
    low: isArabic ? 'حساسية منخفضة' : 'Low risk',
  };
  return labels[risk];
};

const sourceCategoryLabel = (category: string, isArabic: boolean): string => {
  const labels: Record<string, [string, string]> = {
    official: ['رسمي', 'Official'],
    government: ['حكومي', 'Government'],
    academic: ['أكاديمي', 'Academic'],
    industry: ['متخصص في المجال', 'Industry'],
    news: ['إخباري', 'News'],
    commercial: ['تجاري', 'Commercial'],
    community: ['مجتمعي', 'Community'],
    unknown: ['غير محدد', 'Unspecified'],
  };
  const label = labels[category] || labels.unknown;
  return label[isArabic ? 0 : 1];
};

const freshnessLabel = (freshness: string, isArabic: boolean): string => {
  const labels: Record<string, [string, string]> = {
    current: ['حديث', 'Current'],
    dated: ['قديم نسبيًا', 'Dated'],
    unknown: ['حداثته غير معروفة', 'Freshness unknown'],
  };
  const label = labels[freshness] || labels.unknown;
  return label[isArabic ? 0 : 1];
};

const competitorCoverageLabel = (numbers: number[], isArabic: boolean): string => {
  if (numbers.length === 0) return isArabic ? 'المصدر غير محدد' : 'Source unspecified';
  if (numbers.length === 1) {
    return isArabic ? `ظهر لدى المنافس ${numbers[0]}` : `Found in competitor ${numbers[0]}`;
  }
  return isArabic
    ? `مشترك بين المنافسين ${numbers.join('، ')}`
    : `Shared by competitors ${numbers.join(', ')}`;
};

const ContentWritingKnowledgeResult: React.FC<ContentWritingKnowledgeResultProps> = ({
  outputText,
  knowledgeValue,
  competitorChunks,
  isArabic,
}) => {
  const transparency = useMemo(() => buildContentWritingTransparencySnapshot({
    knowledgeValue,
    competitorChunks,
    fallbackOutputText: outputText,
  }), [competitorChunks, knowledgeValue, outputText]);
  const knowledge = useMemo(() => presentContentWritingKnowledge(outputText), [outputText]);
  if (transparency) {
    return <ContentWritingTransparencyPanel snapshot={transparency} isArabic={isArabic} />;
  }
  if (!knowledge) {
    return (
      <div className="rounded-md bg-amber-50 p-2.5 font-bold leading-5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        {isArabic
          ? 'اكتملت المرحلة وحُفظت نتيجتها، لكن تعذر تحويل تفاصيلها إلى العرض المبسّط. لن تُعرض البيانات البرمجية الخام.'
          : 'The step completed and its result was saved, but the details could not be converted to the simplified view. Raw technical data is hidden.'}
      </div>
    );
  }

  const highPriorityCount = knowledge.items.filter(item => item.priority === 'high').length;
  const sensitiveClaimCount = knowledge.claims.filter(claim => claim.riskLevel === 'high' || claim.conflicting).length;

  return (
    <div className="space-y-2.5" dir={isArabic ? 'rtl' : 'ltr'}>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          [knowledge.competitorCount, isArabic ? 'منافسون' : 'Competitors'],
          [knowledge.items.length, isArabic ? 'أفكار مستخلصة' : 'Extracted ideas'],
          [highPriorityCount, isArabic ? 'أفكار مهمة' : 'Important ideas'],
          [knowledge.claims.length, isArabic ? 'ادعاءات قابلة للتحقق' : 'Verifiable claims'],
        ].map(([value, label]) => (
          <div key={String(label)} className="rounded-md bg-gray-50 px-2 py-2 text-center dark:bg-[#1F1F1F]">
            <div className="text-sm font-black text-[#8a6f1d] dark:text-[#f2d675]">{value}</div>
            <div className="mt-0.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 rounded-md bg-emerald-50 p-2 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
        <CheckCircle2 size={13} className="shrink-0" />
        <span>
          {isArabic
            ? `تمت قراءة ${knowledge.processedChunkCount.toLocaleString('ar')} مقطعًا مرجعيًا وبناء ملخص موحد دون عرض الرموز التقنية.`
            : `${knowledge.processedChunkCount.toLocaleString('en')} source sections were read and combined into this plain-language summary.`}
        </span>
      </div>

      <details open className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
        <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
          <Lightbulb size={14} className="text-[#d4af37]" />
          <span>{isArabic ? 'الموضوعات والأفكار المستخلصة' : 'Extracted topics and ideas'}</span>
        </summary>
        <div className="max-h-96 space-y-2 overflow-y-auto p-2 custom-scrollbar">
          {knowledge.items.map((item, index) => (
            <article key={`${item.topic}-${index}`} className="rounded-md bg-gray-50 p-2.5 dark:bg-[#1F1F1F]">
              <div className="font-black leading-5 text-gray-800 dark:text-gray-100">{item.topic}</div>
              {item.detail && <p className="mt-1 leading-6 text-gray-600 dark:text-gray-300">{item.detail}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                <span className={`rounded px-1.5 py-1 text-[9px] font-black ${
                  item.priority === 'high'
                    ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                    : item.priority === 'medium'
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
                      : 'bg-gray-100 text-gray-600 dark:bg-[#333] dark:text-gray-300'
                }`}>
                  {priorityLabel(item.priority, isArabic)}
                </span>
                <span className="rounded bg-blue-50 px-1.5 py-1 text-[9px] font-black text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                  {competitorCoverageLabel(item.competitorNumbers, isArabic)}
                </span>
              </div>
              {item.originalityOpportunity && (
                <div className="mt-2 rounded border-s-2 border-[#d4af37] bg-[#d4af37]/5 px-2 py-1.5 leading-5 text-gray-600 dark:text-gray-300">
                  <span className="font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {isArabic ? 'فرصة للتفوق: ' : 'Opportunity: '}
                  </span>
                  {item.originalityOpportunity}
                </div>
              )}
            </article>
          ))}
        </div>
      </details>

      {knowledge.sources.length > 0 && (
        <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
          <summary className="flex cursor-pointer list-none items-center gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
            <BookOpenText size={14} className="text-blue-600" />
            <span>{isArabic ? 'تقييم مصادر المنافسين' : 'Competitor source assessment'}</span>
          </summary>
          <div className="space-y-1.5 p-2">
            {knowledge.sources.map(source => (
              <div key={source.competitorNumber} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                <div className="flex flex-wrap items-center gap-1 font-black text-gray-700 dark:text-gray-200">
                  <Users size={13} />
                  <span>{isArabic ? `المنافس ${source.competitorNumber}` : `Competitor ${source.competitorNumber}`}</span>
                  <span className="rounded bg-white px-1.5 py-0.5 text-[9px] dark:bg-[#2A2A2A]">{sourceCategoryLabel(source.category, isArabic)}</span>
                  <span className="rounded bg-white px-1.5 py-0.5 text-[9px] dark:bg-[#2A2A2A]">{freshnessLabel(source.freshness, isArabic)}</span>
                </div>
                {source.notes && <p className="mt-1 leading-5 text-gray-600 dark:text-gray-300">{source.notes}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      {knowledge.claims.length > 0 && (
        <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
            <span className="flex items-center gap-2">
              <ShieldAlert size={14} className="text-amber-600" />
              <span>{isArabic ? 'الحقائق والادعاءات التي تحتاج انتباهًا' : 'Claims requiring attention'}</span>
            </span>
            {sensitiveClaimCount > 0 && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] text-red-700 dark:bg-red-900/20 dark:text-red-300">
                {sensitiveClaimCount}
              </span>
            )}
          </summary>
          <div className="max-h-80 space-y-1.5 overflow-y-auto p-2 custom-scrollbar">
            {knowledge.claims.map((claim, index) => (
              <article key={`${claim.statement}-${index}`} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                <div className="flex items-start gap-1.5">
                  {claim.conflicting && <AlertTriangle size={13} className="mt-1 shrink-0 text-red-600" />}
                  <p className="font-bold leading-5 text-gray-700 dark:text-gray-200">{claim.statement}</p>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${
                    claim.riskLevel === 'high'
                      ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
                  }`}>
                    {riskLabel(claim.riskLevel, isArabic)}
                  </span>
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-black text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                    {competitorCoverageLabel(claim.competitorNumbers, isArabic)}
                  </span>
                  {claim.conflicting && (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-black text-red-700 dark:bg-red-900/20 dark:text-red-300">
                      {isArabic ? 'المصادر متعارضة' : 'Conflicting sources'}
                    </span>
                  )}
                </div>
                {claim.guidance && (
                  <p className="mt-1.5 leading-5 text-gray-500 dark:text-gray-400">
                    <span className="font-black">{isArabic ? 'طريقة الاستخدام: ' : 'Usage: '}</span>
                    {claim.guidance}
                  </p>
                )}
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export default ContentWritingKnowledgeResult;
