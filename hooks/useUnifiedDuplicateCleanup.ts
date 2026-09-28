import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { cancelExternalAnalysisJob, enqueueDuplicateCleanup, loadDuplicateCleanupJobs,
  undoUnifiedDuplicateCleanup, type ExternalAnalysisJobRow } from '../utils/externalAnalysis';
import { cleanupDocumentIdentity } from '../utils/cleanupDocumentIdentity';
import type { UnifiedCleanupState } from '../utils/unifiedDuplicateCleanup';

export const isCleanupJobActive = (job: ExternalAnalysisJobRow | null) => Boolean(job
  && ['queued', 'running', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'].includes(job.status));
export type UnifiedCleanupControls = {
  job: ExternalAnalysisJobRow | null; state?: UnifiedCleanupState; busy: boolean; error: string; articleStatus: string;
  run: () => Promise<void>; stop: () => Promise<void>; undo: (scope: 'round' | 'all') => Promise<void>;
};
type Options = {
  editor: Editor | null; articleId: string | null; ready: boolean; articleStatus: string;
  save: () => Promise<boolean>;
  reload: (articleId: string, guard: { localDocument: unknown; remoteDocument: unknown }) => Promise<boolean>;
};

export function useUnifiedDuplicateCleanup(options: Options) {
  const latest = useRef(options); latest.current = options;
  const jobRef = useRef<ExternalAnalysisJobRow | null>(null);
  const [job, setJob] = useState<ExternalAnalysisJobRow | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const syncedDocument = useRef<unknown>(null);
  const syncing = useRef(false);
  const scope = useRef(options.articleId); scope.current = options.articleId;
  const remember = (value: ExternalAnalysisJobRow) => { jobRef.current = value; setJob(value); };
  useEffect(() => {
    jobRef.current = null; setJob(null); setError(''); syncedDocument.current = null;
    submitting.current = false; setPending(false);
  }, [options.articleId, options.editor]);

  const receive = useCallback(async (jobs: ExternalAnalysisJobRow[]) => {
    const { editor, articleId, reload } = latest.current;
    if (!editor || editor.isDestroyed || !articleId) return;
    const incoming = jobs.filter(item => item.input_snapshot?.version === 2)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!incoming || (jobRef.current && incoming.created_at < jobRef.current.created_at)) return;
    const previous = jobRef.current;
    remember(incoming);
    const state = incoming.progress?.unified as UnifiedCleanupState | undefined;
    if (!state || syncing.current || !editor.isEditable) return;
    const identity = (document: unknown) => cleanupDocumentIdentity(editor.schema.nodeFromJSON(document).toJSON());
    const local = editor.getJSON();
    if (identity(local) === identity(state.document)) { syncedDocument.current = state.document; return; }
    const known = [syncedDocument.current, previous?.progress?.unified && (previous.progress.unified as UnifiedCleanupState).document,
      incoming.input_snapshot.document].filter(Boolean);
    if (!known.some(document => identity(document) === identity(local))) {
      if (isCleanupJobActive(incoming)) {
        setError('تغيّر النص محليًا؛ أُوقف التطبيق التلقائي لحماية تعديلاتك.');
        await cancelExternalAnalysisJob(articleId, incoming.id);
      }
      return;
    }
    if (!state.appliedCount && state.phase !== 'reverted') return;
    syncing.current = true;
    try {
      const success = await reload(articleId, { localDocument: local, remoteDocument: state.document });
      if (scope.current !== articleId) return;
      if (success) { syncedDocument.current = state.document; setError(''); }
      else setError('نتائج التنقية محفوظة على الخادم؛ تعذرت مزامنتها دون المساس بتغييرات المحرر.');
    } finally { syncing.current = false; }
  }, []);

  const start = useCallback(async () => {
    const { editor, articleId, ready, save, articleStatus } = latest.current;
    if (!articleId || !editor?.isEditable || !ready || articleStatus !== 'draft'
      || submitting.current || isCleanupJobActive(jobRef.current)) return;
    submitting.current = true; setPending(true); setError('');
    try {
      if (!await save() || scope.current !== articleId) return;
      const result = await enqueueDuplicateCleanup(articleId, { version: 2, automatic: false, requestId: crypto.randomUUID() });
      if (scope.current === articleId && result.job?.input_snapshot?.version === 2) await receive([result.job]);
    } catch (failure) { if (scope.current === articleId) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (scope.current === articleId) { submitting.current = false; setPending(false); } }
  }, [receive]);

  useEffect(() => {
    const { editor, articleId } = options;
    if (!editor || !articleId) return;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || syncing.current || !isCleanupJobActive(jobRef.current)) return;
      if (cleanupDocumentIdentity(transaction.before.toJSON()) === cleanupDocumentIdentity(transaction.doc.toJSON())) return;
      setError('تغيّر النص محليًا؛ طُلب إيقاف التنقية لحماية تعديلاتك.');
      void cancelExternalAnalysisJob(articleId, jobRef.current!.id).catch(failure => setError(String(failure)));
    };
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [options.editor, options.articleId]);

  const stop = async () => {
    const articleId = latest.current.articleId; const current = jobRef.current;
    if (!articleId || !current) return;
    try { await cancelExternalAnalysisJob(articleId, current.id); }
    catch (failure) { setError(String(failure)); }
  };
  const undo = async (undoScope: 'round' | 'all') => {
    const { articleId, editor, articleStatus } = latest.current; const current = jobRef.current;
    if (!articleId || !editor?.isEditable || articleStatus !== 'draft' || !current || isCleanupJobActive(current) || submitting.current) return;
    const document = (current.progress?.unified as UnifiedCleanupState | undefined)?.document;
    if (!document || cleanupDocumentIdentity(editor.getJSON()) !== cleanupDocumentIdentity(editor.schema.nodeFromJSON(document).toJSON())) {
      setError('تغيّر النص بعد التطبيق؛ لم يُنفّذ التراجع حفاظًا على تعديلاتك.'); return;
    }
    submitting.current = true; setPending(true); setError('');
    try {
      await undoUnifiedDuplicateCleanup(articleId, current.id, undoScope);
      const jobs = await loadDuplicateCleanupJobs(articleId);
      if (scope.current === articleId) await receive(jobs);
    } catch (failure) { if (scope.current === articleId) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (scope.current === articleId) { submitting.current = false; setPending(false); } }
  };
  return {
    controls: { job, state: job?.progress?.unified as UnifiedCleanupState | undefined,
      busy: pending || isCleanupJobActive(job), error, articleStatus: options.articleStatus, run: start, stop, undo } satisfies UnifiedCleanupControls,
    receive, versions: () => {
      const current = jobRef.current;
      const state = current?.progress?.unified as UnifiedCleanupState | undefined;
      if (state && (state.appliedCount || state.phase === 'reverted')
        && cleanupDocumentIdentity(syncedDocument.current) !== cleanupDocumentIdentity(state.document)) return {};
      return current ? { [current.id]: current.updated_at } : {};
    },
    active: () => submitting.current || isCleanupJobActive(jobRef.current),
  };
}
