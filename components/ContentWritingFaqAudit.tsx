import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  FileQuestion,
  Lightbulb,
  Link2,
  SearchCheck,
  ShieldQuestion,
  XCircle,
} from 'lucide-react';
import type { ContentWritingTransparencySnapshot } from '../utils/contentWritingTransparency';

type ContentWritingFaqAuditProps = {
  auditValue: unknown;
  transparency: ContentWritingTransparencySnapshot | null;
  isArabic: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const records = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value) ? value.filter(isRecord) : []
);

const texts = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : []
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const score = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
};

const INTENT_LABELS: Record<string, [string, string]> = {
  selection: ['اختيار الأنسب', 'Selection'],
  compatibility: ['التوافق', 'Compatibility'],
  usage: ['الاستخدام والعناية', 'Usage and care'],
  purchase: ['الشراء والطلب', 'Purchase'],
  payment: ['الدفع', 'Payment'],
  shipping: ['الشحن والاستلام', 'Shipping'],
  returns: ['الإرجاع والاستبدال', 'Returns'],
  warranty: ['الضمان', 'Warranty'],
  pricing: ['السعر والتكلفة', 'Pricing'],
  requirements: ['المتطلبات', 'Requirements'],
  process: ['آلية التنفيذ', 'Process'],
  timing: ['المدة والتوقيت', 'Timing'],
  troubleshooting: ['حل المشكلات', 'Troubleshooting'],
  safety: ['السلامة والاستثناءات', 'Safety'],
  comparison: ['المقارنة والقرار', 'Comparison'],
  eligibility: ['الأهلية والملاءمة', 'Eligibility'],
  support: ['الدعم والمتابعة', 'Support'],
  implications: ['الآثار العملية', 'Implications'],
  privacy: ['الخصوصية', 'Privacy'],
  cancellation: ['الإلغاء', 'Cancellation'],
  other: ['نية إضافية', 'Additional intent'],
};

const SOURCE_LABELS: Record<string, [string, string]> = {
  people_also_ask: ['People Also Ask حقيقي من المصدر', 'Real People Also Ask source'],
  competitor_question: ['سؤال ظهر لدى منافس', 'Competitor question'],
  knowledge_matrix: ['مصفوفة المعرفة', 'Knowledge matrix'],
  page_context: ['سياق الصفحة', 'Page context'],
  goal_based_extension: ['امتداد مناسب لهدف الصفحة', 'Goal-based extension'],
};

const GUARD_REASON_LABELS: Record<string, [string, string]> = {
  invalid_model_decision: ['قرار المرشح غير صالح', 'Invalid candidate decision'],
  answer_missing: ['لا توجد إجابة موثقة', 'No supported answer'],
  no_new_information_declared: ['لم يضف معلومة جديدة', 'No new information'],
  evidence_missing: ['لا يوجد دليل مرتبط', 'No linked evidence'],
  blocked_claim: ['يرتبط بادعاء محظور', 'Uses a blocked claim'],
  information_gain_too_low: ['القيمة المعلوماتية منخفضة', 'Information gain is too low'],
  duplicates_article_body: ['يعيد فكرة موجودة في المقالة', 'Duplicates the article body'],
  duplicates_another_faq: ['يشبه سؤالًا شائعًا آخر', 'Duplicates another FAQ'],
  duplicate_intent: ['تكررت نية السؤال', 'Question intent is duplicated'],
  accepted_limit_reached: ['اكتمل العدد المتنوع المطلوب', 'The diverse question limit was reached'],
};

const percentage = (value: unknown, locale: string): string => (
  `${Math.round(score(value) * 100).toLocaleString(locale)}%`
);

const CandidateCard: React.FC<{
  candidate: Record<string, unknown>;
  transparency: ContentWritingTransparencySnapshot | null;
  isArabic: boolean;
}> = ({ candidate, transparency, isArabic }) => {
  const locale = isArabic ? 'ar' : 'en';
  const decision = text(candidate.decision);
  const isAccepted = decision === 'accepted';
  const needsInformation = decision === 'needs_information';
  const intent = text(candidate.intent);
  const sourceType = text(candidate.sourceType);
  const newInformation = texts(candidate.newInformation);
  const ideaIds = texts(candidate.evidenceIdeaIds);
  const claimIds = texts(candidate.usedClaimIds);
  const chunkIds = texts(candidate.sourceChunkIds);
  const guardReasons = texts(candidate.guardReasons);
  const knowledgeItems = ideaIds
    .map(id => transparency?.knowledge.items.find(item => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const claims = claimIds
    .map(id => transparency?.knowledge.claimLedger.claims.find(claim => claim.id === id))
    .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
  const chunks = chunkIds
    .map(id => transparency?.chunks.find(chunk => chunk.id === id))
    .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
  return (
    <article className={`rounded-md border p-2.5 ${
      isAccepted
        ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-900/10'
        : needsInformation
          ? 'border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-900/10'
          : 'border-red-100 bg-red-50/40 dark:border-red-900/40 dark:bg-red-900/10'
    }`}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${
          isAccepted
            ? 'text-emerald-600'
            : needsInformation
              ? 'text-amber-600'
              : 'text-red-500'
        }`}>
          {isAccepted
            ? <CheckCircle2 size={15} />
            : needsInformation
              ? <ShieldQuestion size={15} />
              : <XCircle size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-black leading-5 text-gray-800 dark:text-gray-100">
            {text(candidate.question)}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="rounded bg-white px-1.5 py-1 text-[9px] font-black text-violet-700 dark:bg-[#252525] dark:text-violet-300">
              {INTENT_LABELS[intent]?.[isArabic ? 0 : 1] || intent}
            </span>
            <span className="rounded bg-white px-1.5 py-1 text-[9px] font-black text-blue-700 dark:bg-[#252525] dark:text-blue-300">
              {SOURCE_LABELS[sourceType]?.[isArabic ? 0 : 1] || text(candidate.sourceLabel)}
            </span>
          </div>
        </div>
      </div>

      {isAccepted && text(candidate.answer) && (
        <p className="mt-2 rounded bg-white/80 p-2 font-semibold leading-6 text-gray-700 dark:bg-black/15 dark:text-gray-200">
          {text(candidate.answer)}
        </p>
      )}

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="rounded bg-white/80 p-1.5 text-center dark:bg-black/15">
          <div className="font-black text-emerald-700 dark:text-emerald-300">
            {percentage(candidate.informationGainScore, locale)}
          </div>
          <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'قيمة جديدة' : 'New value'}</div>
        </div>
        <div className="rounded bg-white/80 p-1.5 text-center dark:bg-black/15">
          <div className="font-black text-blue-700 dark:text-blue-300">
            {percentage(candidate.bodySimilarityScore, locale)}
          </div>
          <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'تشابه المتن' : 'Body overlap'}</div>
        </div>
        <div className="rounded bg-white/80 p-1.5 text-center dark:bg-black/15">
          <div className="font-black text-violet-700 dark:text-violet-300">
            {percentage(candidate.faqSimilarityScore, locale)}
          </div>
          <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'تشابه FAQ' : 'FAQ overlap'}</div>
        </div>
      </div>

      {newInformation.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1 text-[9px] font-black text-emerald-700 dark:text-emerald-300">
            <Lightbulb size={11} />
            {isArabic ? 'ما الذي يضيفه السؤال؟' : 'What does this question add?'}
          </div>
          <ul className="space-y-1">
            {newInformation.map(item => (
              <li key={item} className="rounded bg-white/80 px-2 py-1 font-semibold leading-5 text-gray-700 dark:bg-black/15 dark:text-gray-200">
                • {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {text(candidate.nearestArticleExcerpt) && (
        <details className="mt-2 rounded border border-gray-200 bg-white/70 p-2 dark:border-[#3C3C3C] dark:bg-black/10">
          <summary className="cursor-pointer list-none text-[9px] font-black text-gray-600 dark:text-gray-300">
            {isArabic ? 'أقرب فكرة موجودة في المقالة' : 'Closest idea already in the article'}
          </summary>
          <p className="mt-1.5 leading-5 text-gray-600 dark:text-gray-300">
            {text(candidate.nearestArticleExcerpt)}
          </p>
        </details>
      )}

      {(knowledgeItems.length > 0 || claims.length > 0 || chunks.length > 0) && (
        <details className="mt-2 rounded border border-gray-200 bg-white/70 p-2 dark:border-[#3C3C3C] dark:bg-black/10">
          <summary className="cursor-pointer list-none text-[9px] font-black text-blue-700 dark:text-blue-300">
            {isArabic ? 'الأدلة التي استُخدمت في الإجابة' : 'Evidence used in the answer'}
          </summary>
          <div className="mt-2 space-y-1.5">
            {knowledgeItems.map(item => (
              <div key={item.id} className="flex items-start gap-1.5 rounded bg-white p-1.5 dark:bg-[#252525]">
                <Lightbulb size={11} className="mt-1 shrink-0 text-amber-600" />
                <div>
                  <div className="font-black text-gray-700 dark:text-gray-200">{item.topic}</div>
                  <div className="mt-0.5 leading-5 text-gray-500 dark:text-gray-400">{item.detail}</div>
                </div>
              </div>
            ))}
            {claims.map(claim => (
              <div key={claim.id} className="flex items-start gap-1.5 rounded bg-white p-1.5 dark:bg-[#252525]">
                <SearchCheck size={11} className="mt-1 shrink-0 text-emerald-600" />
                <div className="font-semibold leading-5 text-gray-700 dark:text-gray-200">{claim.statement}</div>
              </div>
            ))}
            {chunks.map(chunk => (
              <div key={chunk.id} className="flex items-start gap-1.5 rounded bg-white p-1.5 dark:bg-[#252525]">
                <Link2 size={11} className="mt-1 shrink-0 text-blue-600" />
                <div>
                  <div className="font-black text-gray-700 dark:text-gray-200">
                    {chunk.title || (isArabic ? `المنافس ${chunk.competitorNumber}` : `Competitor ${chunk.competitorNumber}`)}
                  </div>
                  <div className="mt-0.5 line-clamp-3 leading-5 text-gray-500 dark:text-gray-400">{chunk.text}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {!isAccepted && (
        <div className={`mt-2 rounded p-2 font-bold leading-5 ${
          needsInformation
            ? 'bg-amber-100/70 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200'
            : 'bg-red-100/60 text-red-700 dark:bg-red-900/20 dark:text-red-300'
        }`}>
          {text(candidate.decisionReason)
            || (needsInformation
              ? (isArabic ? 'السؤال مهم لكن لا توجد معلومات موثقة تكفي للإجابة.' : 'The question matters, but the available evidence is insufficient.')
              : (isArabic ? 'رُفض السؤال لأنه لا يحقق الاستقلالية المطلوبة.' : 'The question was rejected because it is not sufficiently independent.'))}
          {guardReasons.length > 0 && (
            <div className="mt-1 text-[9px]">
              {guardReasons.map(reason => (
                <div key={reason}>• {GUARD_REASON_LABELS[reason]?.[isArabic ? 0 : 1] || reason}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
};

const ContentWritingFaqAudit: React.FC<ContentWritingFaqAuditProps> = ({
  auditValue,
  transparency,
  isArabic,
}) => {
  if (!isRecord(auditValue)) return null;
  const candidates = records(auditValue.candidates);
  const accepted = candidates.filter(candidate => candidate.decision === 'accepted');
  const rejected = candidates.filter(candidate => candidate.decision === 'rejected');
  const needsInformation = candidates.filter(candidate => candidate.decision === 'needs_information');
  const questionSeeds = records(auditValue.questionSeeds);
  const paaCount = questionSeeds.filter(seed => seed.sourceType === 'people_also_ask').length;
  const intentBlueprints = records(auditValue.intentBlueprints);
  const locale = isArabic ? 'ar' : 'en';
  return (
    <section className="mb-3 space-y-2" dir={isArabic ? 'rtl' : 'ltr'}>
      <div className="rounded-md border border-violet-200 bg-violet-50/60 p-2.5 dark:border-violet-900/50 dark:bg-violet-900/10">
        <div className="flex items-start gap-2">
          <FileQuestion size={16} className="mt-0.5 shrink-0 text-violet-700 dark:text-violet-300" />
          <div>
            <div className="font-black text-violet-800 dark:text-violet-200">
              {isArabic ? 'تدقيق استقلالية الأسئلة الشائعة' : 'FAQ independence audit'}
            </div>
            <p className="mt-1 font-semibold leading-5 text-violet-700 dark:text-violet-300">
              {isArabic
                ? 'لا يُدرج النظام السؤال لمجرد اختلاف صياغته؛ يجب أن يقدم قيمة جديدة موثقة وألا يكرر نية سؤال آخر.'
                : 'A question is not included merely because it is worded differently; it must add supported value and use a distinct intent.'}
            </p>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <div className="rounded bg-white/80 p-2 text-center dark:bg-black/15">
            <div className="font-black text-emerald-700">{accepted.length.toLocaleString(locale)}</div>
            <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'مقبول' : 'Accepted'}</div>
          </div>
          <div className="rounded bg-white/80 p-2 text-center dark:bg-black/15">
            <div className="font-black text-red-600">{rejected.length.toLocaleString(locale)}</div>
            <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'مرفوض' : 'Rejected'}</div>
          </div>
          <div className="rounded bg-white/80 p-2 text-center dark:bg-black/15">
            <div className="font-black text-amber-600">{needsInformation.length.toLocaleString(locale)}</div>
            <div className="text-[8px] font-bold text-gray-500">{isArabic ? 'يحتاج معلومات' : 'Needs evidence'}</div>
          </div>
        </div>
      </div>

      <details className="rounded-md border border-gray-200 bg-gray-50 p-2.5 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
        <summary className="cursor-pointer list-none font-black text-gray-700 dark:text-gray-200">
          {isArabic
            ? `خطة الأسئلة حسب هدف الصفحة (${intentBlueprints.length.toLocaleString(locale)} نيات)`
            : `Question plan for this page goal (${intentBlueprints.length.toLocaleString(locale)} intents)`}
        </summary>
        <div className="mt-2 flex flex-wrap gap-1">
          {intentBlueprints.map(item => {
            const intent = text(item.intent);
            return (
              <span key={intent} className="rounded bg-violet-100 px-2 py-1 text-[9px] font-black text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {INTENT_LABELS[intent]?.[isArabic ? 0 : 1] || intent}
              </span>
            );
          })}
        </div>
      </details>

      <details className="rounded-md border border-gray-200 bg-gray-50 p-2.5 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
        <summary className="cursor-pointer list-none font-black text-gray-700 dark:text-gray-200">
          {isArabic
            ? `الأسئلة المكتشفة قبل التصفية: ${questionSeeds.length.toLocaleString(locale)} — People Also Ask موثق: ${paaCount.toLocaleString(locale)}`
            : `Discovered seeds: ${questionSeeds.length.toLocaleString(locale)} — verified People Also Ask: ${paaCount.toLocaleString(locale)}`}
        </summary>
        <div className="mt-2 space-y-1">
          {questionSeeds.length === 0 ? (
            <div className="rounded bg-amber-50 p-2 font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              {isArabic
                ? 'لم تصل أسئلة PAA صريحة من المصادر؛ لذلك لم يسمِّ النظام الأسئلة المولدة على أنها PAA حقيقية.'
                : 'No explicit PAA questions were found in the sources, so generated questions were not labeled as real PAA.'}
            </div>
          ) : questionSeeds.map((seed, index) => (
            <div key={`${text(seed.id)}-${index}`} className="flex items-start gap-1.5 rounded bg-white p-1.5 dark:bg-[#252525]">
              <CircleHelp size={11} className="mt-1 shrink-0 text-blue-600" />
              <div>
                <div className="font-bold leading-5 text-gray-700 dark:text-gray-200">{text(seed.question)}</div>
                <div className="text-[8px] font-black text-gray-400">
                  {SOURCE_LABELS[text(seed.sourceType)]?.[isArabic ? 0 : 1] || text(seed.sourceType)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </details>

      {accepted.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 font-black text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 size={14} />
            {isArabic ? 'الأسئلة المقبولة وما أضافته' : 'Accepted questions and their new value'}
          </div>
          {accepted.map((candidate, index) => (
            <CandidateCard
              key={`${text(candidate.id)}-${index}`}
              candidate={candidate}
              transparency={transparency}
              isArabic={isArabic}
            />
          ))}
        </div>
      )}

      {(rejected.length > 0 || needsInformation.length > 0) && (
        <details className="rounded-md border border-gray-200 bg-gray-50 p-2.5 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <summary className="cursor-pointer list-none">
            <span className="flex items-center gap-1.5 font-black text-gray-700 dark:text-gray-200">
              <AlertTriangle size={13} className="text-amber-600" />
              {isArabic ? 'الأسئلة المستبعدة وأسباب القرار' : 'Excluded questions and decision reasons'}
            </span>
          </summary>
          <div className="mt-2 space-y-1.5">
            {[...needsInformation, ...rejected].map((candidate, index) => (
              <CandidateCard
                key={`${text(candidate.id)}-excluded-${index}`}
                candidate={candidate}
                transparency={transparency}
                isArabic={isArabic}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
};

export default ContentWritingFaqAudit;
