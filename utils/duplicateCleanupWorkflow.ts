import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Keywords } from '../types';
import { batchCleanupSnapshot, buildCleanupPrompt, inspectCleanupImpact, parseCleanupPlan, simulateCleanup,
  type CleanupPlan, type CleanupSnapshot } from './duplicateCleanup';

export type CleanupJobProgress = CleanupPlan & { processed: number[]; completed: number; total: number; errors: string[] };

export async function runCleanupWorkflow(options: {
  doc: ProseMirrorNode; snapshot: CleanupSnapshot; keywords: Keywords; title: string;
  saved?: CleanupJobProgress; signal: AbortSignal;
  run: (prompt: string, requestIndex: number) => Promise<string>;
  checkpoint: (state: CleanupJobProgress) => Promise<void>;
}): Promise<CleanupJobProgress> {
  const batches = batchCleanupSnapshot(options.snapshot);
  const state: CleanupJobProgress = options.saved || { patches: [], decisions: [], processed: [], completed: 0, total: batches.length, errors: [] };
  await options.checkpoint(state);
  for (const [index, batch] of batches.entries()) {
    if (state.processed.includes(index)) continue;
    options.signal.throwIfAborted();
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildCleanupPrompt(batch, options.title, feedback);
      if (prompt.length > 100_000) { feedback = 'المجموعة أكبر من سعة الطلب؛ عالج التصنيفات الأطول أولًا. لم يتم إسقاط أي موضع.'; break; }
      const raw = await options.run(prompt, index * 2 + attempt + 1);
      options.signal.throwIfAborted();
      try {
        const plan = parseCleanupPlan(raw, batch);
        const after = simulateCleanup(options.doc, [...state.patches, ...plan.patches]);
        const impact = inspectCleanupImpact(options.doc, after, batch, options.keywords);
        if (impact.newDuplicates.length) throw new Error(`New repeated phrases: ${impact.newDuplicates.slice(0, 12).map(item => item.text).join(' | ')}`);
        if (impact.unresolved.some(phrase => !plan.decisions.some(decision => phrase.occurrenceIds.includes(decision.occurrenceId) && decision.action === 'unresolved'))) {
          throw new Error('Some phrases remain repeated without an unresolved decision.');
        }
        state.patches.push(...plan.patches);
        state.decisions.push(...plan.decisions);
        state.completed++;
        feedback = '';
        break;
      } catch (error) { feedback = error instanceof Error ? error.message : String(error); }
    }
    if (feedback) state.errors.push(`${batch.phrases.map(phrase => phrase.text).join('، ')}: ${feedback}`);
    state.processed.push(index);
    await options.checkpoint(state);
  }
  return state;
}
