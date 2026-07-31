import React from 'react';
import {
  CheckCircle2,
  GitCompareArrows,
  Layers3,
  ShieldAlert,
} from 'lucide-react';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import { getContentWritingCandidateStrategy } from '../utils/contentWritingCandidates';
import type { ContentWritingStep } from '../utils/contentWritingSessions';
import ContentWritingKnowledgeResult from './ContentWritingKnowledgeResult';

type ContentWritingCandidateComparisonProps = {
  step: ContentWritingStep;
  workflowSteps: ContentWritingStep[];
  competitorChunks: unknown;
  isArabic: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter(isRecord)
  : [];

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const number = (value: unknown): number => Number.isFinite(Number(value))
  ? Number(value)
  : 0;

const FAILURE_LABELS: Record<string, [string, string]> = {
  candidate_empty: ['لم ينتج نصًا صالحًا', 'No usable text was produced'],
  candidate_missing_required_ideas: ['فقد أفكارًا إلزامية', 'Required ideas were missing'],
  candidate_uses_blocked_claim: ['استخدم ادعاءً محظورًا', 'A blocked claim was used'],
  candidate_has_no_independent_faq: ['لم ينتج سؤالًا مستقلًا موثقًا', 'No independent evidence-backed FAQ was produced'],
  candidate_revision_rejected: ['رفضته حواجز الإصلاح الآمن', 'Rejected by revision safety guards'],
  candidate_missing_requested_claims: ['لم يستخدم كل الادعاءات المطلوبة', 'Not all requested claims were used'],
  candidate_repeats_prior_content: ['تشابه كثيرًا مع محتوى سابق', 'Too similar to prior content'],
  candidate_word_range_mismatch: ['خرج عن ميزانية الكلمات', 'Outside the word budget'],
};

const CandidateMetrics: React.FC<{
  evaluation: Record<string, unknown>;
  isArabic: boolean;
}> = ({ evaluation, isArabic }) => {
  const metrics = isRecord(evaluation.metrics) ? evaluation.metrics : {};
  const range = isRecord(metrics.targetWordRange) ? metrics.targetWordRange : {};
  const hardFailures = Array.isArray(evaluation.hardFailures)
    ? evaluation.hardFailures.map(text).filter(Boolean)
    : [];
  const warnings = Array.isArray(evaluation.warnings)
    ? evaluation.warnings.map(text).filter(Boolean)
    : [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded bg-gray-100 px-2 py-1 text-[10px] font-black text-gray-700 dark:bg-[#333] dark:text-gray-200">
          {isArabic ? 'الدرجة' : 'Score'} {number(evaluation.score).toLocaleString(isArabic ? 'ar' : 'en')}/100
        </span>
        <span className="rounded bg-gray-100 px-2 py-1 text-[10px] font-black text-gray-700 dark:bg-[#333] dark:text-gray-200">
          {isArabic ? 'الكلمات' : 'Words'} {number(metrics.wordCount).toLocaleString(isArabic ? 'ar' : 'en')}
          {number(range.min) > 0 && ` · ${number(range.min).toLocaleString(isArabic ? 'ar' : 'en')}–${number(range.max).toLocaleString(isArabic ? 'ar' : 'en')}`}
        </span>
        {number(metrics.requiredIdeaCount) > 0 && (
          <span className="rounded bg-blue-50 px-2 py-1 text-[10px] font-black text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
            {isArabic ? 'تغطية الأفكار' : 'Idea coverage'} {number(metrics.ideaCoveragePercent).toLocaleString(isArabic ? 'ar' : 'en')}%
          </span>
        )}
        {metrics.acceptedFaqCount !== null && metrics.acceptedFaqCount !== undefined && (
          <span className="rounded bg-violet-50 px-2 py-1 text-[10px] font-black text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
            {isArabic ? 'أسئلة مقبولة' : 'Accepted FAQs'} {number(metrics.acceptedFaqCount).toLocaleString(isArabic ? 'ar' : 'en')}
          </span>
        )}
        {metrics.qualityScore !== null && metrics.qualityScore !== undefined && (
          <span className="rounded bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
            {isArabic ? 'جودة النسخة' : 'Candidate quality'} {number(metrics.qualityScore).toLocaleString(isArabic ? 'ar' : 'en')}
          </span>
        )}
      </div>
      {(hardFailures.length > 0 || warnings.length > 0) && (
        <div className="space-y-1 text-[10px] font-bold leading-5">
          {hardFailures.map(code => (
            <div key={code} className="flex items-start gap-1.5 text-red-700 dark:text-red-300">
              <ShieldAlert size={12} className="mt-1 shrink-0" />
              <span>{FAILURE_LABELS[code]?.[isArabic ? 0 : 1] || code}</span>
            </div>
          ))}
          {warnings.map(code => (
            <div key={code} className="text-amber-700 dark:text-amber-300">
              • {FAILURE_LABELS[code]?.[isArabic ? 0 : 1] || code}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const RevisionCandidateSummary: React.FC<{
  step: ContentWritingStep;
  isArabic: boolean;
}> = ({ step, isArabic }) => {
  const decision = isRecord(step.metadata.revisionDecision)
    ? step.metadata.revisionDecision
    : {};
  const edits = records(step.metadata.revisionEdits);
  const reasons = Array.isArray(decision.reasons)
    ? decision.reasons.map(text).filter(Boolean)
    : [];
  return (
    <div className={`rounded-md p-2.5 text-[10px] font-bold leading-5 ${decision.accepted === true
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
      <div className="font-black">
        {decision.accepted === true
          ? (isArabic ? 'اجتاز هذا التطبيق حواجز الجودة والتغطية والادعاءات.' : 'This application passed quality, coverage, and claim guards.')
          : (isArabic ? 'رُفض هذا التطبيق وبقيت النسخة السابقة آمنة.' : 'This application was rejected and the previous version stayed safe.')}
      </div>
      <div className="mt-1">
        {isArabic ? 'الأجزاء المعدلة' : 'Edited targets'}: {edits.length.toLocaleString(isArabic ? 'ar' : 'en')}
      </div>
      {edits.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {edits.map((edit, index) => (
            <span key={`${text(edit.targetId)}-${index}`} className="rounded bg-white/70 px-1.5 py-0.5 dark:bg-black/20">
              {text(edit.targetId) || (isArabic ? `الجزء ${index + 1}` : `Target ${index + 1}`)}
            </span>
          ))}
        </div>
      )}
      {reasons.length > 0 && (
        <div className="mt-1">
          {isArabic ? 'أسباب الرفض' : 'Rejection reasons'}: {reasons.length.toLocaleString(isArabic ? 'ar' : 'en')}
        </div>
      )}
    </div>
  );
};

const KnowledgeEnsemble: React.FC<{
  step: ContentWritingStep;
  candidateSteps: ContentWritingStep[];
  competitorChunks: unknown;
  isArabic: boolean;
}> = ({ step, candidateSteps, competitorChunks, isArabic }) => {
  const ensemble = isRecord(step.metadata.knowledgeEnsemble)
    ? step.metadata.knowledgeEnsemble
    : null;
  if (!ensemble) return null;
  const finalKnowledge = isRecord(step.metadata.knowledge) ? step.metadata.knowledge : {};
  const finalItems = records(finalKnowledge.items);
  const origins = records(ensemble.itemOrigins);
  const originLabels: Record<string, [string, string]> = {
    both: ['أكدتها القراءتان', 'Confirmed by both readings'],
    first_only: ['اكتشفتها القراءة الشاملة المباشرة', 'Found by the comprehensive direct reading'],
    second_only: ['اكتشفتها قراءة صيد الثغرات', 'Found by the gap-hunting reading'],
    reconciled_or_fallback: ['حُسمت أثناء المصالحة أو التحقق', 'Resolved during reconciliation or validation'],
  };
  return (
    <section className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 dark:border-blue-900/50 dark:bg-blue-900/10">
      <div className="flex items-start gap-2">
        <Layers3 size={15} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-300" />
        <div>
          <div className="font-black text-blue-800 dark:text-blue-200">
            {isArabic ? 'قراءتان مستقلتان ثم مصالحة موثّقة' : 'Two independent readings, then evidence reconciliation'}
          </div>
          <div className="mt-1 text-[10px] font-semibold leading-5 text-blue-700/80 dark:text-blue-300/80">
            {isArabic
              ? `القراءة الشاملة المباشرة: ${number(ensemble.firstPassItemCount).toLocaleString('ar')} فكرة، وقراءة صيد الثغرات: ${number(ensemble.secondPassItemCount).toLocaleString('ar')}، والنتيجة الموحدة: ${number(ensemble.finalItemCount).toLocaleString('ar')}. أضافت قراءة صيد الثغرات وحدها ${number(ensemble.secondPassOnlyItemCount).toLocaleString('ar')} فكرة مدعومة.`
              : `The comprehensive direct reading found ${number(ensemble.firstPassItemCount).toLocaleString('en')} items, gap hunting found ${number(ensemble.secondPassItemCount).toLocaleString('en')}, and reconciliation retained ${number(ensemble.finalItemCount).toLocaleString('en')}. Gap hunting alone contributed ${number(ensemble.secondPassOnlyItemCount).toLocaleString('en')} supported items.`}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[10px] font-black">
        <span className="rounded bg-white px-2 py-1 text-blue-700 dark:bg-black/20 dark:text-blue-200">
          {isArabic ? 'مشتركة' : 'Shared'} {number(ensemble.sharedItemCount).toLocaleString(isArabic ? 'ar' : 'en')}
        </span>
        <span className="rounded bg-white px-2 py-1 text-blue-700 dark:bg-black/20 dark:text-blue-200">
          {isArabic ? 'من القراءة الشاملة فقط' : 'Comprehensive reading only'} {number(ensemble.firstPassOnlyItemCount).toLocaleString(isArabic ? 'ar' : 'en')}
        </span>
        <span className="rounded bg-white px-2 py-1 text-blue-700 dark:bg-black/20 dark:text-blue-200">
          {isArabic ? 'من صيد الثغرات فقط' : 'Gap hunting only'} {number(ensemble.secondPassOnlyItemCount).toLocaleString(isArabic ? 'ar' : 'en')}
        </span>
        <span className={`rounded px-2 py-1 ${ensemble.allChunksAccountedFor === true
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200'}`}>
          {ensemble.allChunksAccountedFor === true
            ? (isArabic ? 'جميع المقاطع محسوبة' : 'All chunks accounted for')
            : (isArabic ? 'توجد فجوة في المقاطع' : 'Chunk coverage gap')}
        </span>
      </div>
      <div className="space-y-1.5">
        {candidateSteps.map((candidate, index) => {
          const pass = number(candidate.metadata.candidateIndex) || index + 1;
          const strategyName = isArabic
            ? text(candidate.metadata.knowledgeStrategyNameAr)
            : text(candidate.metadata.knowledgeStrategyNameEn);
          const fallbackName = pass === 1
            ? (isArabic ? 'القراءة الشاملة المباشرة' : 'Comprehensive direct reading')
            : (isArabic ? 'قراءة صيد الثغرات' : 'Gap-hunting reading');
          return (
          <details key={candidate.id} className="rounded-md border border-blue-100 bg-white dark:border-blue-900/40 dark:bg-[#202020]">
            <summary className="cursor-pointer px-2.5 py-2 text-[10px] font-black text-blue-700 dark:text-blue-300">
              {isArabic ? `عرض ${strategyName || fallbackName}` : `Review ${strategyName || fallbackName}`}
            </summary>
            <div className="border-t border-blue-100 p-2 dark:border-blue-900/40">
              <ContentWritingKnowledgeResult
                outputText={candidate.outputText || ''}
                knowledgeValue={candidate.metadata.knowledge}
                competitorChunks={competitorChunks}
                isArabic={isArabic}
              />
            </div>
          </details>
          );
        })}
      </div>
      {origins.length > 0 && (
        <details className="rounded-md border border-blue-100 bg-white dark:border-blue-900/40 dark:bg-[#202020]">
          <summary className="cursor-pointer px-2.5 py-2 text-[10px] font-black text-blue-700 dark:text-blue-300">
            {isArabic ? 'تتبّع أصل كل فكرة في المصفوفة النهائية' : 'Trace every final knowledge item to its reading'}
          </summary>
          <div className="max-h-72 space-y-1.5 overflow-y-auto border-t border-blue-100 p-2 custom-scrollbar dark:border-blue-900/40">
            {origins.map((origin, index) => {
              const itemId = text(origin.finalKnowledgeItemId);
              const item = finalItems.find(candidate => text(candidate.id) === itemId);
              const originKey = text(origin.origin);
              return (
                <div key={`${itemId}-${index}`} className="rounded bg-gray-50 p-2 dark:bg-[#181818]">
                  <div className="font-black leading-5 text-gray-700 dark:text-gray-200">
                    {text(item?.topic) || (isArabic ? 'فكرة موثقة' : 'Supported knowledge item')}
                  </div>
                  <div className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[9px] font-black ${originKey === 'second_only'
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200'
                    : originKey === 'both'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'}`}>
                    {originLabels[originKey]?.[isArabic ? 0 : 1]
                      || originLabels.reconciled_or_fallback[isArabic ? 0 : 1]}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
};

const ContentWritingCandidateComparison: React.FC<ContentWritingCandidateComparisonProps> = ({
  step,
  workflowSteps,
  competitorChunks,
  isArabic,
}) => {
  const candidateSteps = workflowSteps.filter(candidate => (
    text(candidate.metadata.parentStepKey) === step.stepKey
    && Boolean(candidate.metadata.candidatePhase)
  ));
  if (step.stepType === 'competitor_index') {
    return (
      <KnowledgeEnsemble
        step={step}
        candidateSteps={candidateSteps}
        competitorChunks={competitorChunks}
        isArabic={isArabic}
      />
    );
  }
  const selection = isRecord(step.metadata.candidateSelection)
    ? step.metadata.candidateSelection
    : null;
  if (!selection) {
    if (text(step.metadata.candidateMode) !== 'single_balanced') return null;
    const balanced = getContentWritingCandidateStrategy(0);
    return (
      <section className="mb-3 rounded-lg border border-amber-200 bg-amber-50/50 p-2.5 dark:border-amber-900/50 dark:bg-amber-900/10">
        <div className="font-black text-amber-800 dark:text-amber-200">
          {isArabic ? balanced.nameAr : balanced.nameEn}
        </div>
        <div className="mt-1 text-[10px] font-semibold leading-5 text-amber-700/80 dark:text-amber-300/80">
          {isArabic ? balanced.descriptionAr : balanced.descriptionEn}
        </div>
        <div className="mt-1 text-[9px] font-black text-amber-700 dark:text-amber-300">
          {isArabic ? 'وضع مرشح واحد' : 'Single-candidate mode'}
        </div>
      </section>
    );
  }
  const evaluations = records(selection.candidates);
  return (
    <section className="mb-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-900/10">
      <div className="flex items-start gap-2">
        <GitCompareArrows size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
        <div>
          <div className="font-black text-emerald-800 dark:text-emerald-200">
            {selection.mode === 'faq_union'
              ? (isArabic ? 'دُمجت أفضل الأسئلة من المرشحين' : 'Best questions were merged from both candidates')
              : (isArabic ? 'قورنت مرشحات المرحلة قبل الاعتماد' : 'Stage candidates were compared before approval')}
          </div>
          <div className="mt-1 text-[10px] font-semibold leading-5 text-emerald-700/80 dark:text-emerald-300/80">
            {isArabic
              ? 'يمكن مراجعة كل مرشح ودرجته ومخالفاته والنص الذي أعاده النموذج. النتيجة الظاهرة أسفل هذه البطاقة هي المعتمدة في المقالة.'
              : 'Review each candidate, score, violations, and model output. The result below this card is the version used in the article.'}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {evaluations.map((evaluation, index) => {
          const stepKey = text(evaluation.stepKey);
          const candidateStep = candidateSteps.find(candidate => candidate.stepKey === stepKey);
          const selected = evaluation.selected === true;
          const strategy = getContentWritingCandidateStrategy(number(evaluation.candidateIndex));
          return (
            <details
              key={stepKey || index}
              className={`rounded-md border bg-white dark:bg-[#202020] ${selected
                ? 'border-emerald-300 dark:border-emerald-800'
                : 'border-gray-200 dark:border-[#3C3C3C]'}`}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2">
                <span className="font-black text-gray-700 dark:text-gray-200">
                  {isArabic ? strategy.nameAr : strategy.nameEn}
                </span>
                <span className="flex items-center gap-1.5">
                  {selected && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-1 text-[9px] font-black text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">
                      <CheckCircle2 size={11} />
                      {isArabic ? 'المعتمد' : 'Selected'}
                    </span>
                  )}
                  <span className="rounded bg-gray-100 px-1.5 py-1 text-[9px] font-black text-gray-600 dark:bg-[#333] dark:text-gray-300">
                    {number(evaluation.score).toLocaleString(isArabic ? 'ar' : 'en')}/100
                  </span>
                </span>
              </summary>
              <div className="space-y-2 border-t border-gray-100 p-2.5 dark:border-[#333]">
                <div className="text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                  {isArabic ? strategy.descriptionAr : strategy.descriptionEn}
                </div>
                <CandidateMetrics evaluation={evaluation} isArabic={isArabic} />
                {candidateStep?.metadata.revisionPhase === 'apply' ? (
                  <RevisionCandidateSummary step={candidateStep} isArabic={isArabic} />
                ) : candidateStep?.outputText && (
                  <div
                    className="prose prose-sm max-w-none rounded-md bg-gray-50 p-2.5 text-[11px] leading-6 text-gray-700 dark:prose-invert dark:bg-[#181818] dark:text-gray-200"
                    dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(candidateStep.outputText) }}
                  />
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
};

export default ContentWritingCandidateComparison;
