import React, { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  ListTree,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import {
  presentContentWritingCoverageAudit,
  presentContentWritingOutline,
} from '../utils/contentWritingStepPresentation';
import type { ContentWritingStep } from '../utils/contentWritingSessions';
import ContentWritingKnowledgeResult from './ContentWritingKnowledgeResult';
import ContentWritingEvidenceTrace from './ContentWritingEvidenceTrace';
import {
  buildContentWritingTransparencySnapshot,
  type ContentWritingTransparencySnapshot,
} from '../utils/contentWritingTransparency';
import { reconstructContentWritingEvidenceTrace } from '../utils/contentWritingEvidence';

type ContentWritingStepResultProps = {
  step: ContentWritingStep;
  workflowSteps: ContentWritingStep[];
  contextSnapshot: Record<string, unknown>;
  outputText: string;
  isArabic: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const textList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
  : [];

export const getContentWritingStepDescription = (
  step: ContentWritingStep,
  isArabic: boolean,
): string => {
  const descriptions: Partial<Record<ContentWritingStep['stepType'], [string, string]>> = {
    competitor_index: [
      'يقرأ النظام محتوى المنافسين، ويوحّد الأفكار المتشابهة، ويقيّم المصادر والادعاءات قبل البدء في كتابة المقالة.',
      'Reads competitor content, merges equivalent ideas, and assesses sources and claims before drafting.',
    ],
    outline: [
      'يحوّل النظام المعرفة المستخلصة إلى خطة مرتبة لأقسام المقالة، ويحدد غرض كل قسم وحجمه من دون كتابة النص بعد.',
      'Turns the extracted knowledge into an ordered article plan, defining each section before prose is written.',
    ],
    coverage_audit: [
      'يقارن النظام المسودة المكتوبة بالخطة والمعرفة المطلوبة، ويبحث عن الأفكار الناقصة أو الضعيفة والتكرار والادعاءات غير الآمنة، ثم يحدد الأقسام التي تحتاج إصلاحًا.',
      'Compares the draft with the plan and required knowledge, detecting gaps, repetition, and unsafe claims before targeting repairs.',
    ],
    final_review: [
      'يجمع النظام المقالة كاملة ويراجع ترابطها ونية البحث والأصالة ودقة استخدام الادعاءات، ثم ينتج نسخة تحريرية كاملة محسّنة.',
      'Reviews the assembled article for coherence, search intent, originality, and claim safety, then produces a polished full draft.',
    ],
    quality_repair: [
      'يعالج النظام المخالفات التي اكتشفها قياس الجودة، مثل عدد الكلمات والعناوين والبنية والكلمات المفتاحية، ثم يعيد قياس النسخة الجديدة. قد تتكرر هذه المرحلة أكثر من مرة.',
      'Repairs exact quality-gate failures such as length, headings, structure, and keywords, then measures the new draft again. Multiple passes may run.',
    ],
    section_repair: [
      'يعيد النظام كتابة القسم المحدد فقط لمعالجة نقص التغطية، مع الاحتفاظ ببقية المقالة كما هي.',
      'Rewrites only the targeted section to close a coverage gap while preserving the rest of the article.',
    ],
  };
  const description = descriptions[step.stepType];
  return description ? description[isArabic ? 0 : 1] : '';
};

const StructuredResultUnavailable: React.FC<{ isArabic: boolean }> = ({ isArabic }) => (
  <div className="rounded-md bg-amber-50 p-2.5 font-bold leading-5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
    {isArabic
      ? 'اكتملت المرحلة وحُفظت نتيجتها، لكن تعذر تحويل تفاصيلها إلى العرض المبسّط. لن تُعرض البيانات البرمجية الخام.'
      : 'The step completed and its result was saved, but the details could not be converted to the simplified view. Raw technical data is hidden.'}
  </div>
);

const OutlineResult: React.FC<{
  outputText: string;
  transparency: ContentWritingTransparencySnapshot | null;
  isArabic: boolean;
}> = ({ outputText, transparency, isArabic }) => {
  const sections = useMemo(() => presentContentWritingOutline(outputText), [outputText]);
  if (!sections) return <StructuredResultUnavailable isArabic={isArabic} />;
  return (
    <div className="space-y-1.5" dir={isArabic ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-2 rounded-md bg-blue-50 p-2 font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
        <ListTree size={14} />
        <span>
          {isArabic
            ? `تم اعتماد مخطط من ${sections.length.toLocaleString('ar')} أقسام رئيسية.`
            : `An outline of ${sections.length.toLocaleString('en')} main sections was approved.`}
        </span>
      </div>
      {sections.map((section, index) => (
        <article key={`${section.title}-${index}`} className="rounded-md border border-gray-200 bg-gray-50 p-2.5 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <div className="flex items-start gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#d4af37] text-[10px] font-black text-white">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="font-black leading-5 text-gray-800 dark:text-gray-100">{section.title}</div>
              {section.brief && <p className="mt-1 leading-5 text-gray-600 dark:text-gray-300">{section.brief}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {section.targetWords && (
                  <span className="rounded bg-white px-1.5 py-1 text-[9px] font-black text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-300">
                    {section.targetWords.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة مستهدفة' : 'target words'}
                  </span>
                )}
                {section.subheadings.map(subheading => (
                  <span key={subheading} className="rounded bg-blue-50 px-1.5 py-1 text-[9px] font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                    {subheading}
                  </span>
                ))}
              </div>
              {(section.requiredIdeaIds.length > 0 || section.requiredClaimIds.length > 0) && (
                <details className="mt-2 rounded-md border border-gray-200 bg-white p-2 dark:border-[#3C3C3C] dark:bg-[#252525]">
                  <summary className="cursor-pointer list-none text-[9px] font-black text-blue-700 dark:text-blue-300">
                    {isArabic ? 'ما الذي سيعتمد عليه هذا القسم؟' : 'What will this section rely on?'}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {section.requiredIdeaIds.length > 0 && (
                      <div>
                        <div className="mb-1 text-[9px] font-black text-gray-500">
                          {isArabic ? 'الأفكار المطلوبة' : 'Required ideas'}
                        </div>
                        <div className="space-y-1">
                          {section.requiredIdeaIds.map(id => {
                            const item = transparency?.knowledge.items.find(candidate => candidate.id === id);
                            return (
                              <div key={id} className="rounded bg-gray-50 p-1.5 dark:bg-[#1F1F1F]">
                                <span className="font-mono text-[8px] text-gray-400">{id}</span>
                                <div className="font-bold leading-5 text-gray-700 dark:text-gray-200">
                                  {item?.topic || (isArabic ? 'فكرة موثقة في المصفوفة' : 'Matrix knowledge item')}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {section.requiredClaimIds.length > 0 && (
                      <div>
                        <div className="mb-1 text-[9px] font-black text-gray-500">
                          {isArabic ? 'الادعاءات المرتبطة' : 'Linked claims'}
                        </div>
                        <div className="space-y-1">
                          {section.requiredClaimIds.map(id => {
                            const claim = transparency?.knowledge.claimLedger.claims.find(candidate => candidate.id === id);
                            return (
                              <div key={id} className="rounded bg-gray-50 p-1.5 dark:bg-[#1F1F1F]">
                                <span className="font-mono text-[8px] text-gray-400">{id}</span>
                                <div className="font-bold leading-5 text-gray-700 dark:text-gray-200">
                                  {claim?.statement || (isArabic ? 'ادعاء موثق في السجل' : 'Registered claim')}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
};

const CoverageAuditResult: React.FC<{
  outputText: string;
  workflowSteps: ContentWritingStep[];
  transparency: ContentWritingTransparencySnapshot | null;
  isArabic: boolean;
}> = ({ outputText, workflowSteps, transparency, isArabic }) => {
  const audit = useMemo(() => presentContentWritingCoverageAudit(outputText), [outputText]);
  const outline = useMemo(() => {
    const outlineOutput = workflowSteps.find(step => step.stepType === 'outline')?.outputText || '';
    return presentContentWritingOutline(outlineOutput) || [];
  }, [workflowSteps]);
  if (!audit) return <StructuredResultUnavailable isArabic={isArabic} />;
  const issueCount = audit.missingIdeaCount
    + audit.weakIdeaCount
    + audit.unsupportedClaimCount
    + audit.blockedClaimCount
    + audit.duplicateTopics.length;
  const sectionTitle = (sectionKey: string): string => {
    const match = sectionKey.match(/^section-(\d+)$/);
    const index = match ? Number(match[1]) - 1 : -1;
    return outline[index]?.title || (isArabic ? 'قسم من المقالة' : 'Article section');
  };
  return (
    <div className="space-y-2" dir={isArabic ? 'rtl' : 'ltr'}>
      <div className={`flex items-center gap-2 rounded-md p-2 font-bold ${
        issueCount === 0
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
      }`}>
        {issueCount === 0 ? <CheckCircle2 size={14} /> : <FileSearch size={14} />}
        <span>
          {issueCount === 0
            ? (isArabic ? 'التغطية مكتملة ولم يُكتشف نقص يحتاج إلى إصلاح.' : 'Coverage is complete; no repairable gaps were detected.')
            : (isArabic
              ? `اكتشف التدقيق ${issueCount.toLocaleString('ar')} ملاحظة، وحدد ${audit.repairs.length.toLocaleString('ar')} إصلاحات موجهة.`
              : `The audit found ${issueCount.toLocaleString('en')} observations and scheduled ${audit.repairs.length.toLocaleString('en')} targeted repairs.`)}
        </span>
      </div>
      {issueCount > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {[
            [audit.missingIdeaCount, isArabic ? 'أفكار ناقصة' : 'Missing ideas'],
            [audit.weakIdeaCount, isArabic ? 'تغطية ضعيفة' : 'Weak coverage'],
            [audit.unsupportedClaimCount + audit.blockedClaimCount, isArabic ? 'ادعاءات غير آمنة' : 'Unsafe claims'],
            [audit.duplicateTopics.length, isArabic ? 'موضوعات متكررة' : 'Repeated topics'],
          ].map(([value, label]) => (
            <div key={String(label)} className="rounded-md bg-gray-50 p-2 text-center dark:bg-[#1F1F1F]">
              <div className="font-black text-gray-800 dark:text-gray-100">{value}</div>
              <div className="mt-0.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">{label}</div>
            </div>
          ))}
        </div>
      )}
      {audit.duplicateTopics.length > 0 && (
        <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
          <div className="mb-1 font-black text-gray-700 dark:text-gray-200">{isArabic ? 'التكرار المكتشف' : 'Detected repetition'}</div>
          <div className="flex flex-wrap gap-1">
            {audit.duplicateTopics.map(topic => <span key={topic} className="rounded bg-white px-1.5 py-1 text-[9px] dark:bg-[#2A2A2A]">{topic}</span>)}
          </div>
        </div>
      )}
      {(audit.missingIdeaIds.length > 0 || audit.weakIdeaIds.length > 0) && (
        <details className="overflow-hidden rounded-md border border-gray-200 dark:border-[#3C3C3C]">
          <summary className="cursor-pointer list-none bg-gray-50 px-2.5 py-2 font-black text-gray-700 dark:bg-[#252525] dark:text-gray-200">
            {isArabic ? 'الأفكار الناقصة أو الضعيفة بالتفصيل' : 'Missing or weak ideas in detail'}
          </summary>
          <div className="space-y-1.5 p-2">
            {[
              ...audit.missingIdeaIds.map(id => ({ id, status: isArabic ? 'ناقصة' : 'Missing' })),
              ...audit.weakIdeaIds.map(id => ({ id, status: isArabic ? 'ضعيفة' : 'Weak' })),
            ].map(entry => {
              const item = transparency?.knowledge.items.find(candidate => candidate.id === entry.id);
              return (
                <article key={`${entry.status}-${entry.id}`} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] text-gray-400">{entry.id}</span>
                    <span className="rounded bg-amber-50 px-1.5 py-1 text-[9px] font-black text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                      {entry.status}
                    </span>
                  </div>
                  <div className="mt-1 font-black text-gray-700 dark:text-gray-200">
                    {item?.topic || (isArabic ? 'فكرة من مصفوفة المنافسين' : 'Competitor matrix idea')}
                  </div>
                  {item?.detail && <p className="mt-1 leading-5 text-gray-600 dark:text-gray-300">{item.detail}</p>}
                </article>
              );
            })}
          </div>
        </details>
      )}
      {(audit.unsupportedClaimIds.length > 0 || audit.blockedClaimIds.length > 0) && (
        <details className="overflow-hidden rounded-md border border-red-200 dark:border-red-900/50">
          <summary className="cursor-pointer list-none bg-red-50 px-2.5 py-2 font-black text-red-700 dark:bg-red-900/10 dark:text-red-300">
            {isArabic ? 'الادعاءات غير الآمنة بالتفصيل' : 'Unsafe claims in detail'}
          </summary>
          <div className="space-y-1.5 p-2">
            {[
              ...audit.unsupportedClaimIds.map(id => ({ id, status: isArabic ? 'غير مدعوم' : 'Unsupported' })),
              ...audit.blockedClaimIds.map(id => ({ id, status: isArabic ? 'محظور' : 'Blocked' })),
            ].map(entry => {
              const claim = transparency?.knowledge.claimLedger.claims.find(candidate => candidate.id === entry.id);
              return (
                <article key={`${entry.status}-${entry.id}`} className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] text-gray-400">{entry.id}</span>
                    <span className="rounded bg-red-50 px-1.5 py-1 text-[9px] font-black text-red-700 dark:bg-red-900/20 dark:text-red-300">
                      {entry.status}
                    </span>
                  </div>
                  <p className="mt-1 font-bold leading-5 text-gray-700 dark:text-gray-200">
                    {claim?.statement || (isArabic ? 'ادعاء من سجل المصادر' : 'Claim from the source ledger')}
                  </p>
                  {claim?.usageGuidance && <p className="mt-1 leading-5 text-gray-500 dark:text-gray-400">{claim.usageGuidance}</p>}
                </article>
              );
            })}
          </div>
        </details>
      )}
      {audit.repairs.map((repair, index) => (
        <article key={`${repair.sectionKey}-${index}`} className="rounded-md border border-amber-200 bg-amber-50/60 p-2.5 dark:border-amber-900/50 dark:bg-amber-900/10">
          <div className="flex items-center gap-1.5 font-black text-amber-800 dark:text-amber-200">
            <Wrench size={13} />
            <span>{sectionTitle(repair.sectionKey)}</span>
          </div>
          <p className="mt-1 leading-5 text-gray-700 dark:text-gray-300">{repair.instructions}</p>
          <div className="mt-1.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">
            {isArabic
              ? `${repair.ideaCount.toLocaleString('ar')} أفكار و${repair.claimCount.toLocaleString('ar')} ادعاءات مرتبطة بالإصلاح`
              : `${repair.ideaCount.toLocaleString('en')} ideas and ${repair.claimCount.toLocaleString('en')} claims involved`}
          </div>
          {(repair.ideaIds.length > 0 || repair.claimIds.length > 0 || repair.sourceChunkIds.length > 0) && (
            <div className="mt-2 space-y-1 font-mono text-[9px] text-gray-500 dark:text-gray-400">
              <div>{isArabic ? 'الأفكار: ' : 'Ideas: '}{repair.ideaIds.join('، ') || '—'}</div>
              <div>{isArabic ? 'الادعاءات: ' : 'Claims: '}{repair.claimIds.join('، ') || '—'}</div>
              <div>{isArabic ? 'المقتطفات: ' : 'Excerpts: '}{repair.sourceChunkIds.join('، ') || '—'}</div>
            </div>
          )}
        </article>
      ))}
    </div>
  );
};

const ProseResult: React.FC<{
  outputText: string;
  stepType: ContentWritingStep['stepType'];
  isArabic: boolean;
}> = ({ outputText, stepType, isArabic }) => {
  const html = useMemo(() => parseMarkdownToHtml(outputText), [outputText]);
  const isFullDraft = stepType === 'final_review' || stepType === 'quality_repair';
  return (
    <div dir={isArabic ? 'rtl' : 'ltr'}>
      {isFullDraft && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-blue-50 p-2 font-bold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          {stepType === 'final_review' ? <ClipboardCheck size={14} /> : <RotateCcw size={14} />}
          <span>
            {stepType === 'final_review'
              ? (isArabic ? 'هذه نسخة المقالة الكاملة بعد المراجعة التحريرية.' : 'This is the complete article after editorial review.')
              : (isArabic ? 'هذه نسخة المقالة الكاملة بعد محاولة إصلاح الجودة.' : 'This is the complete article after a quality-repair pass.')}
          </span>
        </div>
      )}
      <div
        className="ai-output max-h-[34rem] overflow-y-auto rounded-md bg-gray-50 p-3 text-xs leading-6 text-gray-700 custom-scrollbar dark:bg-[#1F1F1F] dark:text-gray-200"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
};

const ContentWritingStepResult: React.FC<ContentWritingStepResultProps> = ({
  step,
  workflowSteps,
  contextSnapshot,
  outputText,
  isArabic,
}) => {
  const transparency = useMemo<ContentWritingTransparencySnapshot | null>(() => {
    const knowledgeStep = workflowSteps.find(candidate => candidate.stepType === 'competitor_index');
    return buildContentWritingTransparencySnapshot({
      knowledgeValue: knowledgeStep?.metadata?.knowledge,
      competitorChunks: contextSnapshot.competitorChunks,
      fallbackOutputText: knowledgeStep?.outputText || '',
    });
  }, [contextSnapshot.competitorChunks, workflowSteps]);
  const reconstructedEvidenceTrace = useMemo(() => {
    if (!transparency || (step.stepType !== 'section' && step.stepType !== 'section_repair')) return null;
    const outlineOutput = workflowSteps.find(candidate => candidate.stepType === 'outline')?.outputText || '';
    const outlineSections = presentContentWritingOutline(outlineOutput) || [];
    const sectionKey = step.stepType === 'section_repair'
      ? String(step.metadata.repairedSectionKey || step.metadata.sectionKey || '')
      : step.stepKey;
    const keyMatch = sectionKey.match(/^section-(\d+)$/);
    const sectionIndex = keyMatch
      ? Math.max(0, Number(keyMatch[1]) - 1)
      : Math.max(0, Number(step.metadata.sectionIndex) - 1);
    const section = outlineSections[sectionIndex];
    const repair = isRecord(step.metadata.repair) ? step.metadata.repair : {};
    return reconstructContentWritingEvidenceTrace({
      sectionKey,
      sectionTitle: section?.title || step.title,
      sectionBrief: section?.brief || '',
      requiredIdeaIds: step.stepType === 'section_repair'
        ? textList(repair.ideaIds)
        : section?.requiredIdeaIds,
      requiredClaimIds: step.stepType === 'section_repair'
        ? textList(repair.claimIds)
        : section?.requiredClaimIds,
      requiredSourceChunkIds: step.stepType === 'section_repair'
        ? textList(repair.sourceChunkIds)
        : section?.sourceChunkIds,
      knowledge: transparency.knowledge,
      chunks: transparency.chunks,
    });
  }, [step, transparency, workflowSteps]);
  const evidenceTrace = step.metadata.evidenceTrace || reconstructedEvidenceTrace;

  return (
    <div>
      {step.stepType === 'competitor_index' ? (
        <ContentWritingKnowledgeResult
          outputText={outputText}
          knowledgeValue={step.metadata.knowledge}
          competitorChunks={contextSnapshot.competitorChunks}
          isArabic={isArabic}
        />
      ) : step.stepType === 'outline' ? (
        <OutlineResult outputText={outputText} transparency={transparency} isArabic={isArabic} />
      ) : step.stepType === 'coverage_audit' ? (
        <CoverageAuditResult
          outputText={outputText}
          workflowSteps={workflowSteps}
          transparency={transparency}
          isArabic={isArabic}
        />
      ) : (
        <>
          <ProseResult outputText={outputText} stepType={step.stepType} isArabic={isArabic} />
          {(step.stepType === 'section' || step.stepType === 'section_repair') && (
            <ContentWritingEvidenceTrace
              evidenceTrace={evidenceTrace}
              sectionCoverage={step.metadata.sectionCoverage}
              promptText={step.promptText}
              transparency={transparency}
              isArabic={isArabic}
            />
          )}
        </>
      )}
    </div>
  );
};

export default ContentWritingStepResult;
