import React, { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Eye,
  FileInput,
  Fingerprint,
  Route,
  SearchCheck,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  CompetitorPhraseIntelligenceDecision,
  CompetitorPhraseIntelligenceResult,
} from '../utils/competitorPhraseAnalysis';
import {
  buildContentWritingPhraseAudit,
  getContentWritingPhraseAuditOutput,
  type ContentWritingPhraseAuditItem,
} from '../utils/contentWritingPhraseAudit';
import {
  collectAiModelKeyReports,
  formatAiKeySuffix,
} from '../utils/aiKeyUsageFeedback';
import type { ContentWritingStep } from '../utils/contentWritingSessions';

type ContentWritingStageAuditPanelProps = {
  step: ContentWritingStep;
  contextSnapshot: Record<string, unknown>;
  isArabic: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatDateTime = (value: string | null, isArabic: boolean): string => {
  if (!value) return isArabic ? 'غير متاح' : 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(isArabic ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
};

const formatDuration = (
  startedAt: string | null,
  completedAt: string | null,
  isArabic: boolean,
): string => {
  if (!startedAt || !completedAt) return isArabic ? 'غير متاح' : 'Not available';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return isArabic ? 'غير متاح' : 'Not available';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds.toLocaleString(isArabic ? 'ar' : 'en')} ${isArabic ? 'ثانية' : 'sec'}`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes.toLocaleString(isArabic ? 'ar' : 'en')} ${isArabic ? 'د' : 'min'}`
    + (remainingSeconds ? ` ${remainingSeconds.toLocaleString(isArabic ? 'ar' : 'en')} ${isArabic ? 'ث' : 'sec'}` : '');
};

const decisionLabels: Record<CompetitorPhraseIntelligenceDecision, [string, string]> = {
  must_cover: ['ضرورية التغطية', 'Must cover'],
  supporting: ['داعمة للمحتوى', 'Supporting'],
  review: ['تحتاج مراجعة بشرية', 'Manual review'],
  low_priority: ['منخفضة الأولوية', 'Low priority'],
  ignore: ['مستبعدة من الإرسال', 'Excluded'],
};

const decisionStyles: Record<CompetitorPhraseIntelligenceDecision, string> = {
  must_cover: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-900/10',
  supporting: 'border-blue-200 bg-blue-50/60 dark:border-blue-900/50 dark:bg-blue-900/10',
  review: 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-900/10',
  low_priority: 'border-gray-200 bg-gray-50 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]',
  ignore: 'border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-900/10',
};

const stageInputExplanation = (
  step: ContentWritingStep,
  isArabic: boolean,
): string[] => {
  if (step.stepType === 'competitor_index') {
    return isArabic
      ? [
          step.metadata.knowledgeEnsemble
            ? 'جميع مقتطفات المنافسين المتاحة أُرسلت إلى «القراءة الشاملة المباشرة» و«قراءة صيد الثغرات»، ثم صولح بين النتيجتين في طلب ثالث باتحاد الأفكار المدعومة.'
            : 'جميع مقتطفات المنافسين المتاحة تُرسل لبناء مصفوفة المعرفة وسجل المصادر والادعاءات.',
          'سجل ذكاء العبارات يُرفق داخل طلب التوليد، ويُكرر في تعليمات هذه المرحلة بوصفه مدخلًا مباشرًا للتصنيف.',
          'العبارات المهمة إشارات لتغطية الموضوع وليست نصوصًا مطلوب نسخها حرفيًا.',
        ]
      : [
          step.metadata.knowledgeEnsemble
            ? 'Every available competitor excerpt was sent through two independent readings, then reconciled in a third request as an evidence-backed union.'
            : 'All available competitor excerpts are sent to build the knowledge matrix, source registry, and claims ledger.',
          'Phrase intelligence is attached to the generation request and repeated in this stage instructions as a direct classification input.',
          'Important phrases are topical coverage signals, not text to copy verbatim.',
        ];
  }
  if (step.stepType === 'section' || step.stepType === 'section_repair') {
    return isArabic
      ? [
          ...(step.metadata.candidateSelection
            ? ['وُلّدت «الكتابة المركّزة الشاملة» و«الكتابة العميقة الاستقصائية» لهذا القسم، وقِيس فقد الأفكار والادعاءات المحظورة والتكرار وميزانية الكلمات قبل اعتماد الأعلى درجة.']
            : step.metadata.candidateMode === 'single_balanced'
              ? ['استُخدمت «الكتابة المتوازنة» بمرشح واحد يجمع عمق التغطية مع الوضوح وتقليل الحشو.']
              : []),
          'تستقبل المرحلة السياق المختصر للجلسة، وفيه مصفوفة المعرفة وسجل المصادر والادعاءات وسجل ذكاء العبارات.',
          'تُرفق معها النصوص الأصلية للمقتطفات المرتبطة بهذا القسم فقط، إضافة إلى الأفكار والادعاءات المستهدفة.',
          'تطابق العبارة في الناتج يحدد موضع ظهورها، أما مجرد إرسالها فلا يعني أنها استُخدمت.',
        ]
      : [
          ...(step.metadata.candidateSelection
            ? ['Two independent candidates were generated, then checked for idea loss, blocked claims, repetition, and word budget before selection.']
            : step.metadata.candidateMode === 'single_balanced'
              ? ['Balanced writing used one candidate combining deep coverage with clarity and minimal padding.']
              : []),
          'The stage receives compact session context containing the knowledge, source, claim, and phrase-intelligence registries.',
          'Only original excerpts related to this section are attached, together with its targeted ideas and claims.',
          'An output match shows where a phrase appeared; attachment alone does not prove use.',
        ];
  }
  if (step.metadata.revisionPhase === 'apply') {
    return isArabic
      ? [
          ...(step.metadata.candidateSelection
            ? ['أُنشئ تطبيقان مستقلان لخطة التعديل باستراتيجيتي الكتابة المركّزة والكتابة العميقة، ولم يُعتمد أي منهما إلا بعد مقارنته بالنسخة السابقة.']
            : step.metadata.candidateMode === 'single_balanced'
              ? ['طُبّقت خطة التعديل باستراتيجية «الكتابة المتوازنة» مع إبقاء حواجز المقارنة بالنسخة السابقة.']
              : []),
          'تستقبل مرحلة التطبيق سجل المعرفة وذكاء العبارات، لكن نص المقالة الكامل يُحجب عن الاستبدال.',
          'تُرسل فقط الأجزاء المحددة في خطة التعديل، ثم تُقارن النسخة المرشحة بالنسخة السابقة قبل اعتمادها.',
        ]
      : [
          ...(step.metadata.candidateSelection
            ? ['Two independent applications of the edit plan were produced, and neither could be accepted without beating the previous safe version.']
            : step.metadata.candidateMode === 'single_balanced'
              ? ['The edit plan used balanced writing while retaining comparison guards against the previous version.']
              : []),
          'The apply stage receives knowledge and phrase intelligence, while the full article is withheld from replacement.',
          'Only planned targets are sent, then the candidate is compared with the previous article before acceptance.',
        ];
  }
  if (step.stepType === 'coverage_audit') {
    return isArabic
      ? [
          'تقرأ المرحلة المسودة المكتملة وتقارنها بالمخطط وبجميع سجلات المعرفة والعبارات.',
          'لا تعيد كتابة المقالة؛ بل تُخرج قائمة بالنواقص والإصلاحات المحددة.',
        ]
      : [
          'The stage reads the completed draft and compares it with the outline and all knowledge and phrase registries.',
          'It does not rewrite the article; it returns specific gaps and repairs.',
        ];
  }
  if (step.stepType === 'final_review' || step.stepType === 'quality_repair') {
    return isArabic
      ? [
          'تُقرأ المقالة والسجلات الكاملة لاكتشاف مواضع التعديل، ويظل ذكاء العبارات جزءًا من سياق القرار.',
          'ناتج مرحلة التخطيط هو تعديلات مستهدفة، ولا تُستبدل الأجزاء السليمة من المقالة.',
        ]
      : [
          'The article and complete registries are read to locate edits; phrase intelligence remains part of the decision context.',
          'The planning result contains targeted edits and does not replace healthy article sections.',
        ];
  }
  return isArabic
    ? [
        ...(step.metadata.candidateSelection
          ? ['وُلّدت «الكتابة المركّزة الشاملة» و«الكتابة العميقة الاستقصائية»، ثم اختير الناتج الذي اجتاز البوابات القاطعة وحقق الدرجة الأعلى.']
          : step.metadata.candidateMode === 'single_balanced'
            ? ['استُخدمت «الكتابة المتوازنة» بمرشح واحد يجمع العمق والتركيز.']
            : []),
        'تستقبل المرحلة السياق المختصر للجلسة، وفيه مصفوفة المعرفة وسجل المصادر والادعاءات وسجل ذكاء العبارات.',
        'تستقبل كذلك ما يلزم من المخطط أو المسودة الحالية وفق وظيفة المرحلة.',
        'العبارات المهمة تُستخدم كإشارات للتغطية الطبيعية، لا كتعليمات للحشو أو النسخ.',
      ]
    : [
        ...(step.metadata.candidateSelection
          ? ['Two independent candidates were generated, then the hard-gate pass with the highest score was selected.']
          : step.metadata.candidateMode === 'single_balanced'
            ? ['Balanced writing used one candidate combining depth and focus.']
            : []),
        'The stage receives compact session context containing the knowledge, source, claim, and phrase-intelligence registries.',
        'It also receives the outline or current draft required for this stage.',
        'Important phrases are natural coverage signals, not keyword-stuffing or copying instructions.',
      ];
};

const PhraseItem: React.FC<{
  item: ContentWritingPhraseAuditItem;
  isArabic: boolean;
}> = ({ item, isArabic }) => (
  <article className="rounded-md border border-gray-200 bg-white p-2.5 dark:border-[#3C3C3C] dark:bg-[#252525]">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[9px] font-black text-gray-500 dark:bg-[#333] dark:text-gray-300">
            {item.id}
          </span>
          <span className="font-black leading-5 text-gray-800 dark:text-gray-100">{item.text}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-bold">
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
            {isArabic ? 'الأهمية' : 'Score'} {item.score.toLocaleString(isArabic ? 'ar' : 'en')}/100
          </span>
          <span className="rounded bg-gray-50 px-1.5 py-0.5 text-gray-600 dark:bg-[#1F1F1F] dark:text-gray-300">
            {isArabic ? 'المنافسون' : 'Competitors'}: {item.competitorNumbers.length > 0
              ? item.competitorNumbers.map(value => value.toLocaleString(isArabic ? 'ar' : 'en')).join('، ')
              : '—'}
          </span>
          <span className="rounded bg-gray-50 px-1.5 py-0.5 text-gray-600 dark:bg-[#1F1F1F] dark:text-gray-300">
            {isArabic ? 'التكرار' : 'Occurrences'}: {item.totalCount.toLocaleString(isArabic ? 'ar' : 'en')}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        <span className={`rounded px-1.5 py-1 text-[9px] font-black ${
          item.sentToStage
            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200'
            : 'bg-gray-100 text-gray-500 dark:bg-[#333] dark:text-gray-300'
        }`}>
          {item.sentToStage
            ? (isArabic ? 'أُرسلت للمرحلة' : 'Sent to stage')
            : (isArabic ? 'لم تُرسل' : 'Not sent')}
        </span>
        <span className={`rounded px-1.5 py-1 text-[9px] font-black ${
          item.observedInOutput
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
        }`}>
          {item.observedInOutput
            ? (isArabic
                ? `ظهرت ${item.outputOccurrenceCount.toLocaleString('ar')} مرة`
                : `Appeared ${item.outputOccurrenceCount.toLocaleString('en')} times`)
            : (isArabic ? 'لا تطابق نصيًا' : 'No textual match')}
        </span>
      </div>
    </div>

    {item.matchedKeywordTerms.length > 0 && (
      <div className="mt-2">
        <div className="mb-1 text-[9px] font-black text-gray-500">
          {isArabic ? 'ارتباطها بالكلمات المستهدفة' : 'Target keyword overlap'}
        </div>
        <div className="flex flex-wrap gap-1">
          {item.matchedKeywordTerms.map(term => (
            <span key={term} className="rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
              {term}
            </span>
          ))}
        </div>
      </div>
    )}

    {item.locations.length > 0 && (
      <div className="mt-2 space-y-1">
        <div className="text-[9px] font-black text-emerald-700 dark:text-emerald-300">
          {isArabic ? 'موضع الظهور في ناتج المرحلة' : 'Where it appears in the stage output'}
        </div>
        {item.locations.map(location => (
          <div
            key={`${location.lineNumber}-${location.excerpt}`}
            className="rounded bg-emerald-50 p-2 text-[10px] font-bold leading-5 text-emerald-900 dark:bg-emerald-900/15 dark:text-emerald-100"
          >
            <span className="me-1.5 text-emerald-600 dark:text-emerald-300">
              {isArabic ? 'السطر' : 'Line'} {location.lineNumber.toLocaleString(isArabic ? 'ar' : 'en')}
            </span>
            {location.excerpt}
          </div>
        ))}
      </div>
    )}
  </article>
);

const ContentWritingStageAuditPanel: React.FC<ContentWritingStageAuditPanelProps> = ({
  step,
  contextSnapshot,
  isArabic,
}) => {
  const [copied, setCopied] = useState(false);
  const intelligence = isRecord(contextSnapshot.competitorPhraseIntelligence)
    ? contextSnapshot.competitorPhraseIntelligence as unknown as CompetitorPhraseIntelligenceResult
    : null;
  const configuredEnabled = contextSnapshot.competitorPhraseIntelligenceEnabled === true
    || intelligence?.enabled === true;
  const output = useMemo(() => getContentWritingPhraseAuditOutput({
    outputText: step.outputText,
    metadata: step.metadata,
  }), [step.metadata, step.outputText]);
  const audit = useMemo(() => buildContentWritingPhraseAudit({
    stepType: step.stepType,
    intelligence,
    outputText: output.text,
    outputSubject: output.subject,
  }), [intelligence, output.subject, output.text, step.stepType]);
  const explanations = stageInputExplanation(step, isArabic);
  const execution = isRecord(step.metadata.execution) ? step.metadata.execution : {};
  const providerMetadata = isRecord(execution.providerMetadata) ? execution.providerMetadata : {};
  const modelKeyReports = useMemo(
    () => collectAiModelKeyReports({ execution, providerMetadata }),
    [execution, providerMetadata],
  );
  const usage = isRecord(providerMetadata.usage) ? providerMetadata.usage : {};
  const totalTokens = numberValue(usage.totalTokens || usage.total_tokens);
  const inputTokens = numberValue(
    usage.inputTokens || usage.promptTokens || usage.input_tokens || usage.prompt_tokens,
  );
  const outputTokens = numberValue(
    usage.outputTokens || usage.completionTokens || usage.output_tokens || usage.completion_tokens,
  );
  const model = String(execution.model || '').trim();
  const hasPersistedAudit = isRecord(step.metadata.competitorPhraseAudit);
  const decisions: CompetitorPhraseIntelligenceDecision[] = [
    'must_cover',
    'supporting',
    'review',
    'low_priority',
    'ignore',
  ];
  const locale = isArabic ? 'ar' : 'en';

  const copyAudit = async () => {
    const lines = [
      `${isArabic ? 'المرحلة' : 'Stage'}: ${step.title} (#${step.ordinal})`,
      `${isArabic ? 'حالة ذكاء العبارات' : 'Phrase intelligence'}: ${
        audit.attachedToStage ? (isArabic ? 'مفعّل ومرفق' : 'enabled and attached') : (isArabic ? 'غير مرفق' : 'not attached')
      }`,
      `${isArabic ? 'المنافسون المحللون' : 'Analyzed competitors'}: ${audit.analyzedCompetitorCount}`,
      `${isArabic ? 'العبارات المرسلة' : 'Phrases sent'}: ${audit.sentPhraseCount}/${audit.analyzedPhraseCount}`,
      `${isArabic ? 'التطابقات المرصودة' : 'Observed matches'}: ${audit.observedPhraseCount}`,
      '',
      ...audit.items.flatMap(item => [
        `${item.id} | ${decisionLabels[item.decision][isArabic ? 0 : 1]} | ${item.text}`,
        `${isArabic ? 'أرسلت' : 'Sent'}: ${item.sentToStage ? '✓' : '×'} | ${isArabic ? 'ظهرت' : 'Observed'}: ${item.outputOccurrenceCount}`,
        `${isArabic ? 'المنافسون' : 'Competitors'}: ${item.competitorNumbers.join(', ') || '—'} | ${isArabic ? 'الكلمات المرتبطة' : 'Keyword terms'}: ${item.matchedKeywordTerms.join(', ') || '—'}`,
        ...item.locations.map(location => (
          `${isArabic ? 'السطر' : 'Line'} ${location.lineNumber}: ${location.excerpt}`
        )),
        '',
      ]),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section
      className="mb-3 overflow-hidden rounded-md border border-fuchsia-200 bg-fuchsia-50/30 dark:border-fuchsia-900/50 dark:bg-fuchsia-900/5"
      dir={isArabic ? 'rtl' : 'ltr'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-fuchsia-50 px-3 py-2.5 dark:bg-fuchsia-900/20">
        <div className="flex min-w-0 items-center gap-2">
          <SearchCheck size={16} className="shrink-0 text-fuchsia-700 dark:text-fuchsia-300" />
          <div>
            <div className="font-black text-fuchsia-900 dark:text-fuchsia-100">
              {isArabic ? 'سجل تدقيق المرحلة وذكاء عبارات المنافسين' : 'Stage audit and competitor phrase intelligence'}
            </div>
            <div className="mt-0.5 text-[9px] font-bold text-fuchsia-700 dark:text-fuchsia-300">
              {hasPersistedAudit
                ? (isArabic ? 'حُفظ سجل التدقيق عند اكتمال المرحلة' : 'Audit saved when the stage completed')
                : (isArabic ? 'سجل حي قابل للمراجعة لهذه المرحلة' : 'Live reviewable audit for this stage')}
            </div>
          </div>
        </div>
        <span className={`rounded px-2 py-1 text-[10px] font-black ${
          audit.attachedToStage
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
            : configuredEnabled
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
              : 'bg-gray-100 text-gray-600 dark:bg-[#333] dark:text-gray-300'
        }`}>
          {audit.attachedToStage
            ? (isArabic ? 'مفعّل ومرفق لهذه المرحلة' : 'Enabled and attached')
            : configuredEnabled
              ? (isArabic ? 'مفعّل، ولا توجد عبارات قابلة للإرسال' : 'Enabled; no phrases to send')
              : (isArabic ? 'غير مفعّل' : 'Disabled')}
        </span>
      </div>

      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
          {[
            [Fingerprint, step.ordinal, isArabic ? 'ترتيب المرحلة' : 'Stage order'],
            [FileInput, step.attemptCount, isArabic ? 'عدد المحاولات' : 'Attempts'],
            [Sparkles, audit.sentPhraseCount, isArabic ? 'عبارات أُرسلت' : 'Phrases sent'],
            [Eye, audit.observedPhraseCount, isArabic ? 'عبارات ظهرت في الناتج' : 'Phrases observed'],
          ].map(([Icon, value, label]) => {
            const MetricIcon = Icon as typeof Fingerprint;
            return (
              <div key={String(label)} className="rounded-md bg-white p-2 text-center dark:bg-[#252525]">
                <MetricIcon size={13} className="mx-auto mb-1 text-fuchsia-600 dark:text-fuchsia-300" />
                <div className="font-black text-gray-800 dark:text-gray-100">
                  {Number(value).toLocaleString(locale)}
                </div>
                <div className="mt-0.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">{String(label)}</div>
              </div>
            );
          })}
        </div>

        <details className="overflow-hidden rounded-md border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#252525]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-black text-gray-700 dark:text-gray-200">
            <Route size={14} className="text-blue-600 dark:text-blue-300" />
            <span>{isArabic ? 'ماذا وصل إلى هذه المرحلة وكيف استُخدم؟' : 'What reached this stage and how was it used?'}</span>
          </summary>
          <div className="space-y-1.5 border-t border-gray-100 p-2.5 dark:border-[#3C3C3C]">
            {explanations.map(explanation => (
              <div key={explanation} className="flex items-start gap-2 rounded bg-gray-50 p-2 font-bold leading-5 text-gray-700 dark:bg-[#1F1F1F] dark:text-gray-200">
                <CheckCircle2 size={13} className="mt-1 shrink-0 text-emerald-600 dark:text-emerald-300" />
                <span>{explanation}</span>
              </div>
            ))}
            {audit.attachmentModes.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {audit.attachmentModes.map(mode => (
                  <span key={mode} className="rounded bg-blue-50 px-1.5 py-1 text-[9px] font-black text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                    {{
                      direct_stage_instructions: isArabic ? 'داخل تعليمات المرحلة مباشرة' : 'Direct stage instructions',
                      generation_request: isArabic ? 'داخل طلب التوليد الثابت' : 'Generation request',
                      compact_article_context: isArabic ? 'داخل سياق المقالة المختصر' : 'Compact article context',
                    }[mode]}
                  </span>
                ))}
              </div>
            )}
          </div>
        </details>

        <details className="overflow-hidden rounded-md border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#252525]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-black text-gray-700 dark:text-gray-200">
            <Clock3 size={14} className="text-violet-600 dark:text-violet-300" />
            <span>{isArabic ? 'بيانات تنفيذ المرحلة' : 'Stage execution details'}</span>
          </summary>
          <div className="grid grid-cols-1 gap-1.5 border-t border-gray-100 p-2.5 sm:grid-cols-2 dark:border-[#3C3C3C]">
            {[
              [isArabic ? 'بدأت' : 'Started', formatDateTime(step.startedAt, isArabic)],
              [isArabic ? 'اكتملت' : 'Completed', formatDateTime(step.completedAt, isArabic)],
              [isArabic ? 'المدة' : 'Duration', formatDuration(step.startedAt, step.completedAt, isArabic)],
              [isArabic ? 'النموذج' : 'Model', model || (isArabic ? 'لم يبدأ التنفيذ بعد' : 'Not executed yet')],
              [isArabic ? 'رموز الإدخال' : 'Input tokens', inputTokens ? inputTokens.toLocaleString(locale) : '—'],
              [isArabic ? 'رموز الإخراج' : 'Output tokens', outputTokens ? outputTokens.toLocaleString(locale) : '—'],
              [isArabic ? 'إجمالي الرموز' : 'Total tokens', totalTokens ? totalTokens.toLocaleString(locale) : '—'],
              [isArabic ? 'حالة المرحلة' : 'Stage status', step.status],
            ].map(([label, value]) => (
              <div key={label} className="rounded bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                <div className="text-[9px] font-black text-gray-500">{label}</div>
                <div className="mt-0.5 break-words font-bold text-gray-800 dark:text-gray-100">{value}</div>
              </div>
            ))}
          </div>
        </details>

        {modelKeyReports.length > 0 && (
          <details className="overflow-hidden rounded-md border border-blue-200 bg-white dark:border-blue-900/50 dark:bg-[#252525]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-black text-blue-800 dark:text-blue-200">
              <Fingerprint size={14} />
              <span>{isArabic ? 'تقرير الموديلات والمفاتيح' : 'Model and key report'}</span>
            </summary>
            <div className="space-y-2 border-t border-blue-100 p-2.5 dark:border-blue-900/40">
              <p className="rounded bg-blue-50 p-2 text-[10px] font-bold leading-5 text-blue-900 dark:bg-blue-900/15 dark:text-blue-100">
                {isArabic
                  ? 'يعرض التقرير كل موديل فحصه المحرك، والمفاتيح التي أُرسل بها طلب فعلي، والمفاتيح غير المتاحة مؤقتًا أو المعطلة. لا تُعرض قيمة أي مفتاح؛ يظهر آخر جزء آمن منه فقط.'
                  : 'This report lists every evaluated model, actual key attempts, and temporarily unavailable or disabled keys. Secret key values are never shown; only a safe suffix is displayed.'}
              </p>
              {modelKeyReports.map((report, reportIndex) => {
                const availability = report.lastAvailability;
                const statusLabel = {
                  succeeded: isArabic ? 'نجح' : 'Succeeded',
                  exhausted: isArabic ? 'اكتملت المفاتيح المؤهلة' : 'Eligible keys completed',
                  temporarily_unavailable: isArabic ? 'غير متاح مؤقتًا' : 'Temporarily unavailable',
                  attempting: isArabic ? 'قيد المحاولة' : 'Attempting',
                  pending: isArabic ? 'قيد الانتظار' : 'Pending',
                }[report.status] || report.status;
                const availabilityItems: Array<readonly [string, number, string]> = availability ? [
                  [isArabic ? 'متاح' : 'Eligible', availability.eligibleCount, 'text-emerald-700 dark:text-emerald-300'],
                  [isArabic ? 'محجوز' : 'Leased', availability.leasedCount, 'text-blue-700 dark:text-blue-300'],
                  [isArabic ? 'تبريد' : 'Cooldown', availability.cooldownCount, 'text-amber-700 dark:text-amber-300'],
                  [isArabic ? 'معطل' : 'Disabled', availability.disabledCount, 'text-red-700 dark:text-red-300'],
                  [isArabic ? 'غير نشط' : 'Inactive', availability.inactiveCount, 'text-gray-600 dark:text-gray-300'],
                  [isArabic ? 'جُرّب' : 'Tried', availability.excludedCount, 'text-violet-700 dark:text-violet-300'],
                ] : [];
                return (
                  <article key={`${report.model}-${reportIndex}`} className="rounded-md border border-gray-200 p-2.5 dark:border-[#3C3C3C]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="break-all font-black text-gray-900 dark:text-gray-100">{report.model}</div>
                      <span className={`rounded px-2 py-1 text-[9px] font-black ${
                        report.status === 'succeeded'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
                          : report.status === 'temporarily_unavailable'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                            : 'bg-gray-100 text-gray-700 dark:bg-[#333] dark:text-gray-200'
                      }`}>{statusLabel}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-black">
                      {report.provider && (
                        <span className="rounded bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-900/20 dark:text-blue-200">
                          {isArabic ? 'المزود' : 'Provider'}: {report.provider}
                        </span>
                      )}
                      {report.credentialSource && (
                        <span className="rounded bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-900/20 dark:text-violet-200">
                          {isArabic ? 'مصدر المفاتيح' : 'Key source'}: {report.credentialSource}
                        </span>
                      )}
                      <span className="rounded bg-gray-100 px-2 py-1 text-gray-700 dark:bg-[#333] dark:text-gray-200">
                        {isArabic ? 'مفاتيح جُرّبت' : 'Keys tried'}: {report.attemptedKeyCount.toLocaleString(locale)}/{report.configuredKeyCount.toLocaleString(locale)}
                      </span>
                      <span className="rounded bg-gray-100 px-2 py-1 text-gray-700 dark:bg-[#333] dark:text-gray-200">
                        {isArabic ? 'طلبات فعلية' : 'API attempts'}: {report.attemptCount.toLocaleString(locale)}
                      </span>
                      {report.waitedMs > 0 && (
                        <span className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                          {isArabic ? 'انتظار' : 'Waited'}: {(report.waitedMs / 1_000).toLocaleString(locale, { maximumFractionDigits: 1 })} {isArabic ? 'ث' : 'sec'}
                        </span>
                      )}
                    </div>
                    {availabilityItems.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {availabilityItems.map(([label, value, style]) => (
                          <span key={label} className={`rounded border border-gray-100 px-2 py-1 text-[9px] font-black dark:border-[#3C3C3C] ${style}`}>
                            {label}: {value.toLocaleString(locale)}
                          </span>
                        ))}
                      </div>
                    )}
                    {report.entries.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {report.entries.map((entry, entryIndex) => (
                          <div key={`${entry.keySuffix}-${entry.outcome}-${entryIndex}`} className="flex flex-wrap items-center gap-1.5 rounded bg-gray-50 px-2 py-1.5 text-[9px] font-bold dark:bg-[#1F1F1F]">
                            <span className="font-black text-gray-800 dark:text-gray-100">{formatAiKeySuffix(entry.keySuffix)}</span>
                            <span className={entry.outcome === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}>
                              {entry.outcome === 'success' ? (isArabic ? 'نجح' : 'Success') : (isArabic ? 'فشل' : 'Failed')}
                            </span>
                            {entry.status ? <span className="text-gray-500">HTTP {entry.status}</span> : null}
                            {entry.reason ? <span className="text-gray-500">{entry.reason}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded bg-gray-50 p-2 text-[9px] font-bold text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-300">
                        {isArabic
                          ? 'لم يُرسل طلب فعلي بمفتاح على هذا الموديل؛ يوضح توزيع الحالة أعلاه سبب عدم الأهلية.'
                          : 'No key made an API attempt on this model; the availability breakdown above explains why.'}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </details>
        )}

        {audit.attachedToStage ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-[10px] font-bold leading-5 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-900/15 dark:text-emerald-100">
            <div className="flex items-center gap-1.5 font-black">
              <CheckCircle2 size={14} />
              <span>
                {isArabic
                  ? `أُرسلت ${audit.sentPhraseCount.toLocaleString('ar')} عبارة من أصل ${audit.analyzedPhraseCount.toLocaleString('ar')} عبارة مصنفة بعد تحليل ${audit.analyzedCompetitorCount.toLocaleString('ar')} منافسًا.`
                  : `${audit.sentPhraseCount.toLocaleString('en')} of ${audit.analyzedPhraseCount.toLocaleString('en')} classified phrases were sent after analyzing ${audit.analyzedCompetitorCount.toLocaleString('en')} competitors.`}
              </span>
            </div>
            <p className="mt-1">
              {isArabic
                ? 'الظهور النصي أدناه دليل قابل للفحص على وجود العبارة في الناتج، لكنه لا يدّعي وحده أن النموذج اعتمد عليها سببيًا. والعبارات المستبعدة تظهر في السجل للتدقيق لكنها لا تُرسل للنموذج.'
                : 'A textual match below is reviewable evidence that the phrase appears in the output; it does not by itself claim causal model reliance. Excluded phrases remain visible for audit but are not sent to the model.'}
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[10px] font-bold leading-5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/15 dark:text-amber-100">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              {configuredEnabled
                ? (isArabic
                    ? 'الإعداد مفعّل، لكن الجلسة لا تحتوي عبارات مصنفة قابلة للإرسال. راجع وجود نصوص المنافسين والكلمات المستهدفة عند إنشاء الجلسة.'
                    : 'The setting is enabled, but this session has no classified phrases to send. Check competitor text and target keywords at session creation.')
                : (isArabic
                    ? 'ذكاء عبارات المنافسين لم يكن مفعّلًا عند إنشاء هذه الجلسة، لذلك لم يُرفق في هذه المرحلة.'
                    : 'Competitor phrase intelligence was not enabled when this session was created, so it was not attached to this stage.')}
            </span>
          </div>
        )}

        {audit.items.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-black text-gray-800 dark:text-gray-100">
                {isArabic ? 'السجل الكامل للعبارات' : 'Complete phrase register'}
              </div>
              <button
                type="button"
                onClick={() => void copyAudit()}
                className="inline-flex items-center gap-1.5 rounded-md border border-fuchsia-200 bg-white px-2 py-1.5 text-[9px] font-black text-fuchsia-700 hover:bg-fuchsia-50 dark:border-fuchsia-900/60 dark:bg-[#252525] dark:text-fuchsia-300"
              >
                {copied ? <Check size={12} /> : <Clipboard size={12} />}
                {copied
                  ? (isArabic ? 'تم النسخ' : 'Copied')
                  : (isArabic ? 'نسخ سجل المرحلة' : 'Copy stage audit')}
              </button>
            </div>

            {decisions.map(decision => {
              const items = audit.items.filter(item => item.decision === decision);
              if (items.length === 0) return null;
              const observedCount = items.filter(item => item.observedInOutput).length;
              const sentCount = items.filter(item => item.sentToStage).length;
              return (
                <details
                  key={decision}
                  open={decision === 'must_cover' && items.length <= 12}
                  className={`overflow-hidden rounded-md border ${decisionStyles[decision]}`}
                >
                  <summary className="cursor-pointer list-none px-2.5 py-2 font-black text-gray-800 dark:text-gray-100">
                    <span>{decisionLabels[decision][isArabic ? 0 : 1]}</span>
                    <span className="mx-1.5 text-gray-400">·</span>
                    <span>{items.length.toLocaleString(locale)}</span>
                    <span className="ms-2 text-[9px] font-bold text-gray-500 dark:text-gray-300">
                      {isArabic
                        ? `أُرسل ${sentCount.toLocaleString('ar')} · ظهر ${observedCount.toLocaleString('ar')}`
                        : `sent ${sentCount.toLocaleString('en')} · observed ${observedCount.toLocaleString('en')}`}
                    </span>
                  </summary>
                  <div className="space-y-1.5 border-t border-black/5 p-2 dark:border-white/10">
                    {items.map(item => <PhraseItem key={item.id} item={item} isArabic={isArabic} />)}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};

export default ContentWritingStageAuditPanel;
