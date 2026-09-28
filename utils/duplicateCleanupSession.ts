import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ExternalAnalysisJobRow } from './externalAnalysis';
import { cleanupPhraseCounts, cleanupRangeMatches, isCleanupEditableRange, simulateCleanup,
  type CleanupDecision, type CleanupPatch, type CleanupSnapshot, type CleanupUndo } from './duplicateCleanup';

export type CleanupSession = {
  id: number | string; snapshot: CleanupSnapshot; patches: CleanupPatch[]; decisions: CleanupDecision[];
  running: boolean; completed: number; total: number; errors: string[];
  counts: Map<string, number>; predicted: Map<string, number>; wordsRemoved: number; stopping: boolean;
  undo: { patches: string[]; ranges: CleanupUndo[]; wordsRemoved: number }[];
  externalJobId?: string; externalUpdatedAt?: string; externalStatus?: string; externalCreatedAt?: string;
};

export function restoreCleanupJob(job: ExternalAnalysisJobRow, doc: ProseMirrorNode, previous?: CleanupSession): CleanupSession {
  const input = job.input_snapshot!;
  const source = input.snapshot as CleanupSnapshot;
  const sameJob = previous?.externalJobId === job.id;
  const state = (job.result?.cleanup || job.progress.cleanup || {}) as Partial<CleanupSession>;
  const matches = doc.eq(doc.type.schema.nodeFromJSON(input.document));
  const snapshot = sameJob ? previous!.snapshot : { ...source,
    units: source.units.map(unit => ({ ...unit, stale: !matches })),
    occurrences: source.occurrences.map(occurrence => ({ ...occurrence, stale: !matches })) };
  const counts = cleanupPhraseCounts(doc, source.phrases, source.language);
  const patches = (state.patches || []).map(patch => {
    const existing = sameJob && previous!.patches.find(item => item.id === `${job.id}:${patch.id}`);
    if (existing && !['pending', 'unnecessary'].includes(existing.status)) return existing;
    const unit = snapshot.units.find(item => item.id === patch.unitId)!;
    const originalUnit = source.units.find(item => item.id === patch.unitId)!;
    const mapped = { ...patch, id: `${job.id}:${patch.id}`, from: patch.from + unit.from - originalUnit.from,
      to: patch.to + unit.from - originalUnit.from };
    const needed = patch.occurrenceIds.some(id => {
      const phraseId = source.occurrences.find(item => item.id === id)?.phraseId;
      return phraseId && (counts.get(phraseId) || 0) > 1;
    });
    const status = !isCleanupEditableRange(doc, mapped) || unit.stale || !cleanupRangeMatches(doc, mapped, patch.original)
      ? 'stale' : !needed ? 'unnecessary' : 'pending';
    return { ...mapped, status } as CleanupPatch;
  });
  let predicted = counts;
  try { predicted = cleanupPhraseCounts(simulateCleanup(doc, patches.filter(patch => patch.status === 'pending')), source.phrases, source.language); } catch { /* Keep conservative actual counts. */ }
  const errors = [...(state.errors || []), ...(job.last_error ? [job.last_error] : [])];
  return { id: job.id, snapshot, patches, decisions: state.decisions || [], running: ['queued', 'running', 'retry_scheduled', 'paused'].includes(job.status),
    completed: state.completed || 0, total: state.total || 0, errors, counts, predicted,
    stopping: Boolean(job.cancel_requested_at), wordsRemoved: sameJob ? previous!.wordsRemoved : 0,
    undo: sameJob ? previous!.undo : [], externalJobId: job.id, externalStatus: job.status, externalUpdatedAt: job.updated_at, externalCreatedAt: job.created_at };
}

export function cleanupGenerationState(session?: CleanupSession): 'not_started' | 'partial' | 'completed' {
  if (!session) return 'not_started';
  const covered = session.snapshot.occurrences.every(item => session.decisions.some(decision => decision.occurrenceId === item.id));
  const unresolved = session.snapshot.phrases.some(phrase => (session.predicted.get(phrase.id) || 0) > 1);
  if (!session.running && covered && !session.errors.length && !unresolved && !session.patches.some(patch => patch.status === 'stale')) return 'completed';
  return session.decisions.length || session.patches.length ? 'partial' : 'not_started';
}
