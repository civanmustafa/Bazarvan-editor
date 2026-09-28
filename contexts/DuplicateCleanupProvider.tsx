import React, { useEffect, useRef, useState } from 'react';
import type { Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { Editor } from '@tiptap/core';
import type { Keywords } from '../types';
import { useEditorSelector } from './EditorContext';
import { useAISelector } from './AIContext';
import { enqueueDuplicateCleanup, loadDuplicateCleanupJobs, cancelExternalAnalysisJob, type ExternalAnalysisJobRow } from '../utils/externalAnalysis';
import { restoreCleanupJob, type CleanupSession } from '../utils/duplicateCleanupSession';
import { CleanupContext, type CleanupContextValue } from './DuplicateCleanupContext';
import { runDuplicateAnalysis } from '../utils/analysis/runDuplicateAnalysis';
import { useUnifiedDuplicateCleanup } from '../hooks/useUnifiedDuplicateCleanup';
import {
  batchCleanupSnapshot, buildCleanupPrompt, cleanupPhraseCounts, cleanupRangeMatches,
  collectCleanupSnapshot, inspectCleanupImpact, isCleanupEditableRange, mapCleanupRange, parseCleanupPlan, simulateCleanup,
  type CleanupPatch, type CleanupUndo,
} from '../utils/duplicateCleanup';

export type CleanupTransport = {
  enqueue: (articleId: string, input: Record<string, unknown>) => Promise<{ job: ExternalAnalysisJobRow }>;
  load: (articleId: string, versions?: Record<string, string>) => Promise<ExternalAnalysisJobRow[]>;
  cancel: (articleId: string, jobId: string) => Promise<unknown>;
};
const externalTransport: CleanupTransport = {
  enqueue: async (articleId, input) => { const result = await enqueueDuplicateCleanup(articleId, input); return { job: result.job }; },
  load: loadDuplicateCleanupJobs,
  cancel: cancelExternalAnalysisJob,
};

export const DuplicateCleanupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const editor = useEditorSelector(value => value.editor);
  const articleKey = useEditorSelector(value => value.articleKey);
  const articleId = useEditorSelector(value => value.activeArticleId);
  const language = useEditorSelector(value => value.articleLanguage);
  const keywords = useEditorSelector(value => value.keywords);
  const title = useEditorSelector(value => value.title);
  const runAi = useAISelector(value => value.runPlainAiAnalysis);
  const ready = useEditorSelector(value => value.isArticleContentSettledForAutomation);
  const save = useEditorSelector(value => value.handleSaveDraft);
  const reload = useEditorSelector(value => value.reloadActiveArticleFromRemote);
  const unified = useUnifiedDuplicateCleanup({ editor, articleId, ready, save: () => save({ reason: 'auto' }), reload });
  const value = useDuplicateCleanupController({ editor, articleKey, articleId, language, keywords, title, runAi, external: externalTransport, ready, observer: unified });
  return <CleanupContext.Provider value={{ ...value, busy: value.busy || unified.controls.busy, unified: unified.controls }}>{children}</CleanupContext.Provider>;
};

export function useDuplicateCleanupController({ editor, articleKey, articleId, language, keywords, title, runAi, external, ready = true, observer }: {
  editor: Editor | null;
  articleKey: string;
  articleId: string | null;
  language: 'ar' | 'en';
  keywords: Keywords;
  title: string;
  runAi: (prompt: string, options?: { source?: string; commandId?: string; commandLabel?: string; action?: string }) => Promise<string>;
  external?: CleanupTransport;
  ready?: boolean;
  observer?: { receive: (jobs: ExternalAnalysisJobRow[]) => Promise<void>; versions: () => Record<string, string>; active: () => boolean };
}): CleanupContextValue {
  const observerRef = useRef(observer); observerRef.current = observer;
  const [sessions, setSessions] = useState<Record<number, CleanupSession>>({});
  const [busy, setBusy] = useState(false);
  const sessionsRef = useRef(sessions);
  const generation = useRef(0);
  const running = useRef(false);
  const stopped = useRef(false);
  const scope = `${articleId || articleKey}:${language}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const publish = (next: Record<number, CleanupSession>) => {
    sessionsRef.current = next;
    setSessions(next);
  };
  const update = (category: number, change: (session: CleanupSession) => CleanupSession) => {
    const current = sessionsRef.current[category];
    if (current) publish({ ...sessionsRef.current, [category]: change(current) });
  };

  useEffect(() => {
    generation.current++;
    running.current = false;
    setBusy(false);
    publish({});
    return () => { generation.current++; };
  }, [scope, editor]);

  useEffect(() => {
    if (!external || !articleId || !editor || !ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const refresh = async () => {
      try {
        const versions = Object.fromEntries(Object.values(sessionsRef.current).filter(session => session.externalJobId)
          .map(session => [session.externalJobId!, session.externalUpdatedAt || '']));
        const jobs = await external.load(articleId, { ...versions, ...observerRef.current?.versions() });
        if (disposed || editor.isDestroyed) return;
        await observerRef.current?.receive(jobs);
        if (disposed || editor.isDestroyed) return;
        failures = 0;
        const next = { ...sessionsRef.current };
        for (const job of jobs) {
          if (job.input_snapshot?.language !== language || job.input_snapshot?.version !== 1) continue;
          const category = Number(job.input_snapshot.category);
          const previous = next[category];
          if (previous?.externalJobId && previous.externalJobId !== job.id
            && Date.parse(previous.externalCreatedAt || '') >= Date.parse(job.created_at)) continue;
          if (previous?.externalJobId === job.id && previous.externalUpdatedAt === job.updated_at) continue;
          // Never overwrite a locally submitted start with an older response.
          if (previous && !previous.externalJobId && running.current) continue;
          next[category] = restoreCleanupJob(job, editor.state.doc, previous);
        }
        publish(next);
        setBusy(running.current || Object.values(next).some(session => session.running));
      } catch {
        if (disposed) return;
        failures++;
        if (failures === 3) for (const category of Object.keys(sessionsRef.current)) update(Number(category), session => ({ ...session,
          errors: [...session.errors, language === 'ar' ? 'تعذر متابعة الخادم مؤقتًا؛ المهمة تستمر خارجيًا.' : 'Connection interrupted; the job continues on the server.'] }));
      } finally {
        if (!disposed) timer = setTimeout(refresh, observerRef.current?.active() || Object.values(sessionsRef.current).some(session => session.running) ? 2000 : 15000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [scope, editor, external, ready]);

  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      const next: Record<number, CleanupSession> = {};
      for (const [category, session] of Object.entries(sessionsRef.current)) {
        const units = session.snapshot.units.map(unit => {
          const mapped = mapCleanupRange(unit, transaction.mapping);
          return { ...mapped, stale: !cleanupRangeMatches(transaction.doc, mapped, unit.text) };
        });
        const snapshot = { ...session.snapshot, units,
          occurrences: session.snapshot.occurrences.map(item => mapCleanupRange(item, transaction.mapping)) };
        const counts = cleanupPhraseCounts(transaction.doc, snapshot.phrases, snapshot.language);
        const patches = session.patches.map(patch => {
          const mapped = mapCleanupRange(patch, transaction.mapping);
          if (patch.status !== 'pending' && patch.status !== 'unnecessary') return mapped;
          if (units.find(unit => unit.id === patch.unitId)?.stale || !isCleanupEditableRange(transaction.doc, mapped)
            || !cleanupRangeMatches(transaction.doc, mapped, patch.original)) {
            return { ...mapped, status: 'stale' as const };
          }
          const needed = patch.occurrenceIds.some(id => {
            const phraseId = snapshot.occurrences.find(item => item.id === id)?.phraseId;
            return phraseId && (counts.get(phraseId) || 0) > 1;
          });
          return { ...mapped, status: needed ? 'pending' as const : 'unnecessary' as const };
        });
        let predicted = counts;
        try { predicted = cleanupPhraseCounts(simulateCleanup(transaction.doc, patches.filter(patch => patch.status === 'pending')), snapshot.phrases, snapshot.language); } catch { /* Stale proposals stay visible for regeneration. */ }
        next[Number(category)] = { ...session, snapshot, patches, counts, predicted,
          undo: session.undo.map(batch => ({ ...batch, ranges: batch.ranges.map(range => {
            const mapped = mapCleanupRange(range, transaction.mapping);
            return { ...mapped, stale: !cleanupRangeMatches(transaction.doc, mapped, range.after) };
          }) })) };
      }
      publish(next);
    };
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [editor]);

  const generate = async (category: number) => {
    if (!editor || editor.isDestroyed || !editor.isEditable || running.current || !ready || observerRef.current?.active()
      || Object.values(sessionsRef.current).some(session => session.running)) return;
    const requestScope = scope;
    const requestId = ++generation.current;
    stopped.current = false;
    running.current = true;
    setBusy(true);
    const doc = editor.state.doc;
    const analysis = runDuplicateAnalysis(doc.textBetween(0, doc.content.size, '\n\n', '\uFFFC'), keywords, 0, language);
    const phrases = analysis.duplicateAnalysis[category as keyof typeof analysis.duplicateAnalysis] || [];
    const snapshot = collectCleanupSnapshot(doc, phrases, category, language);
    const batches = batchCleanupSnapshot(snapshot);
    const counts = cleanupPhraseCounts(doc, snapshot.phrases, language);
    publish({ ...sessionsRef.current, [category]: { id: requestId, snapshot, patches: [], decisions: [], running: true, stopping: false,
      completed: 0, total: batches.length, errors: [], counts, predicted: counts,
      wordsRemoved: sessionsRef.current[category]?.wordsRemoved || 0,
      undo: sessionsRef.current[category]?.undo || [] } });
    const isCurrent = () => generation.current === requestId && scopeRef.current === requestScope && !editor.isDestroyed;
    if (external) {
      try {
        if (!articleId) throw new Error(language === 'ar' ? 'احفظ المقالة قبل تشغيل التوليد الخارجي.' : 'Save the article before external generation.');
        const { job } = await external.enqueue(articleId, { requestId: crypto.randomUUID(), category, language,
          document: doc.toJSON(), keywords, title });
        if (!isCurrent()) return;
        if (job?.input_snapshot?.version === 2) {
          await observerRef.current?.receive([job]);
          update(category, current => ({ ...current, running: false, errors: [] }));
          return;
        }
        if (!job) throw new Error('تعذر بدء التنقية لهذه المقالة.');
        const current = sessionsRef.current[category];
        const sameSource = JSON.stringify(job.input_snapshot?.document) === JSON.stringify(doc.toJSON());
        publish({ ...sessionsRef.current, [category]: restoreCleanupJob(job, editor.state.doc,
          sameSource ? { ...current, externalJobId: job.id } : undefined) });
        if (stopped.current) {
          update(category, session => ({ ...session, stopping: true }));
          try { await external.cancel(articleId, job.id); }
          catch (error) {
            if (isCurrent()) update(category, session => ({ ...session, stopping: false,
              errors: [error instanceof Error ? error.message : String(error)] }));
          }
        }
      } catch (error) {
        if (isCurrent()) update(category, current => ({ ...current, running: false,
          errors: [error instanceof Error ? error.message : String(error)] }));
      } finally {
        if (isCurrent()) {
          running.current = false;
          setBusy(Object.values(sessionsRef.current).some(session => session.running));
        }
      }
      return;
    }
    const accepted: CleanupPatch[] = [];
    try {
      for (const batch of batches) {
        if (!isCurrent() || stopped.current) break;
        let feedback = '';
        let acceptedBatch = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          let receivedResponse = false;
          try {
            const prompt = buildCleanupPrompt(batch, title, feedback);
            if (prompt.length > 100_000) throw new Error(language === 'ar'
              ? 'المجموعة المترابطة أكبر من سعة الطلب. لم يتم إسقاط أي موضع؛ عالج التصنيفات الأطول ثم أعد المحاولة.'
              : 'This connected group exceeds the request size. No occurrences were dropped. Process longer phrases first.');
            const raw = await runAi(prompt, { source: 'duplicate_cleanup', commandId: `duplicate-cleanup-${category}`,
              commandLabel: language === 'ar' ? 'تنقية العبارات العامة' : 'Clean up general phrases', action: 'review' });
            receivedResponse = true;
            if (!isCurrent() || stopped.current) break;
            const plan = parseCleanupPlan(raw, batch);
            const after = simulateCleanup(doc, [...accepted, ...plan.patches]);
            const impact = inspectCleanupImpact(doc, after, batch, keywords);
            if (impact.newDuplicates.length) throw new Error(`New/increased repeated phrases: ${impact.newDuplicates.slice(0, 12).map(item => item.text).join(' | ')}`);
            const unexplained = impact.unresolved.filter(phrase => !plan.decisions.some(decision => phrase.occurrenceIds.includes(decision.occurrenceId) && decision.action === 'unresolved'));
            if (unexplained.length) throw new Error(`Still repeated: ${unexplained.map(phrase => phrase.id).join(', ')}. Edit the remaining occurrences or explicitly mark unresolved.`);
            accepted.push(...plan.patches);
            update(category, current => {
              const patches = plan.patches.map(patch => {
                const originalUnit = snapshot.units.find(unit => unit.id === patch.unitId)!;
                const liveUnit = current.snapshot.units.find(unit => unit.id === patch.unitId)!;
                const delta = liveUnit.from - originalUnit.from;
                return { ...patch, id: `${requestId}:${patch.id}`, from: patch.from + delta, to: patch.to + delta,
                  status: liveUnit.stale ? 'stale' as const : 'pending' as const };
              });
              const allPatches = [...current.patches, ...patches];
              let predicted = current.counts;
              try { predicted = cleanupPhraseCounts(simulateCleanup(editor.state.doc, allPatches.filter(item => item.status === 'pending')), snapshot.phrases, language); } catch { /* Live edits can invalidate a proposal while AI is running. */ }
              return { ...current, patches: allPatches, decisions: [...current.decisions, ...plan.decisions], predicted };
            });
            acceptedBatch = true;
            break;
          } catch (error) {
            feedback = error instanceof Error ? error.message : String(error);
            if (!isCurrent() || stopped.current) break;
            if (error instanceof Error && ['GeminiAnalysisCancelledError', 'AbortError'].includes(error.name)) {
              stopped.current = true;
              break;
            }
            if (attempt === 1 || !receivedResponse) update(category, current => ({ ...current,
              errors: [...current.errors, `${batch.phrases.map(phrase => phrase.text).join('، ')}: ${feedback}`] }));
            if (!receivedResponse) break;
          }
        }
        if (!isCurrent()) break;
        update(category, current => ({ ...current, completed: current.completed + (acceptedBatch ? 1 : 0) }));
      }
    } finally {
      if (isCurrent()) {
        update(category, current => ({ ...current, running: false, stopping: false }));
        running.current = false;
        setBusy(false);
      }
    }
  };

  const apply = (category: number, ids: string[]) => {
    const session = sessionsRef.current[category];
    if (!editor?.isEditable || !session || session.running || observerRef.current?.active()) return;
    const patches = session.patches.filter(patch => ids.includes(patch.id) && patch.status === 'pending');
    if (!patches.length) return;
    try {
      const doc = editor.state.doc;
      for (const patch of patches) {
        const unit = session.snapshot.units.find(item => item.id === patch.unitId)!;
        if (!cleanupRangeMatches(doc, unit, unit.text)) throw new Error(language === 'ar' ? 'تغيّر سياق الاقتراح. أعد توليده.' : 'The context changed. Regenerate suggestions.');
      }
      const after = simulateCleanup(doc, patches);
      const countWords = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) || []).length;
      const wordsRemoved = countWords(doc.textBetween(0, doc.content.size, ' ')) - countWords(after.textBetween(0, after.content.size, ' '));
      const impact = inspectCleanupImpact(doc, after, session.snapshot, keywords);
      if (impact.newDuplicates.length) throw new Error(language === 'ar'
        ? 'هذه المجموعة تولّد تكرارًا جديدًا. اختر التعديلات المرتبطة معًا أو أعد توليد الاقتراحات.'
        : 'This selection creates new repetition. Select related edits together or regenerate.');
      const tr = closeHistory(editor.state.tr);
      const undo: CleanupUndo[] = [];
      for (const patch of [...patches].sort((a, b) => b.from - a.from)) {
        const before = tr.doc.slice(patch.from, patch.to);
        const marks = tr.doc.resolve(patch.from).marks().filter(mark => mark.type.name !== 'highlight' && mark.type.name !== 'link');
        if (patch.replacement) tr.replaceWith(patch.from, patch.to, tr.doc.type.schema.text(patch.replacement, marks));
        else tr.delete(patch.from, patch.to);
        undo.push({ from: patch.from, to: patch.to, before, after: patch.replacement });
      }
      const ranges = undo.map(range => {
        const from = tr.mapping.map(range.from, -1);
        return { ...range, from, to: from + range.after.length };
      });
      update(category, current => ({ ...current, patches: current.patches.map(patch => ids.includes(patch.id) && patch.status === 'pending' ? { ...patch, status: 'applied' } : patch) }));
      editor.view.dispatch(tr.scrollIntoView());
      editor.view.dispatch(closeHistory(editor.state.tr));
      update(category, current => ({ ...current, wordsRemoved: current.wordsRemoved + wordsRemoved,
        undo: [...current.undo, { patches: patches.map(patch => patch.id), ranges, wordsRemoved }] }));
    } catch (error) {
      update(category, current => ({ ...current, errors: [error instanceof Error ? error.message : String(error)] }));
    }
  };

  const undo = (category: number) => {
    const session = sessionsRef.current[category];
    const batch = session?.undo.at(-1);
    if (!editor?.isEditable || !batch || session.running || observerRef.current?.active()) return;
    if (batch.ranges.some(range => !cleanupRangeMatches(editor.state.doc, range, range.after))) {
      update(category, current => ({ ...current, errors: [language === 'ar' ? 'تغيّر النص بعد التطبيق؛ تعذر التراجع عن هذه الدفعة بدقة.' : 'Applied text changed; this batch cannot be safely reverted.'] }));
      return;
    }
    const tr = closeHistory(editor.state.tr);
    for (const range of [...batch.ranges].sort((a, b) => b.from - a.from)) tr.replace(range.from, range.to, range.before);
    update(category, current => ({ ...current, undo: current.undo.slice(0, -1), wordsRemoved: current.wordsRemoved - batch.wordsRemoved,
      patches: current.patches.map(patch => batch.patches.includes(patch.id) ? { ...patch, status: 'stale' } : patch) }));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.dispatch(closeHistory(editor.state.tr));
  };

  const locate = (category: number, id: string, occurrence = false) => {
    const session = sessionsRef.current[category];
    if (!editor || !session) return;
    const range = occurrence ? session.snapshot.occurrences.find(item => item.id === id) : session.patches.find(item => item.id === id);
    if (!range || range.stale || range.to > editor.state.doc.content.size) return;
    if (!occurrence && !cleanupRangeMatches(editor.state.doc, range, (range as CleanupPatch).original)) return;
    editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).scrollIntoView().run();
  };

  const skip = (category: number, id: string) => update(category, current => {
    const patches = current.patches.map(patch => patch.id === id ? { ...patch, status: 'skipped' as const } : patch);
    let predicted = current.counts;
    if (editor) try { predicted = cleanupPhraseCounts(simulateCleanup(editor.state.doc, patches.filter(patch => patch.status === 'pending')), current.snapshot.phrases, language); } catch { /* Keep actual counts. */ }
    return { ...current, patches, predicted };
  });

  return { sessions, busy, generate, apply, skip, locate, undo, stop: () => {
    stopped.current = true;
    publish(Object.fromEntries(Object.entries(sessionsRef.current).map(([key, session]) => [key, session.running ? { ...session, stopping: true } : session])));
    if (external && articleId) for (const [category, session] of Object.entries(sessionsRef.current)) {
      if (session.running && session.externalJobId) void external.cancel(articleId, session.externalJobId).catch(error => {
        if (scopeRef.current === scope) update(Number(category), current => ({ ...current, stopping: false,
          errors: [...current.errors, error instanceof Error ? error.message : String(error)] }));
      });
    }
  } };
}


export default DuplicateCleanupProvider;
