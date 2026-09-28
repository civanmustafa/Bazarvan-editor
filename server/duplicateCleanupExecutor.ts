import { runCleanupWorkflow, type CleanupJobProgress } from '../utils/duplicateCleanupWorkflow';
import { collectCleanupSnapshot } from '../utils/duplicateCleanup';
import type { DuplicatePhrase } from '../types';
import { readCleanupDocument, type CleanupJobInput } from './duplicateCleanupJob';
import { readExternalGeminiSettings } from './externalAnalysisSettings';
import { runExternalGeminiCall } from './externalGeminiRunner';
import { ExternalAnalysisOwnershipLostError, ExternalAnalysisRetryError, registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext } from './externalAnalysisExecutor';

// One durable job owns every batch; checkpoints prevent repeating successful AI calls after a retry.
export async function executeDuplicateCleanup(context: ExternalAnalysisExecutionContext) {
  const input = context.job.input_snapshot as unknown as CleanupJobInput;
  if (input.version !== 1 || !input.snapshot) throw new Error('Unsupported cleanup snapshot.');
  const settings = await readExternalGeminiSettings();
  if (!settings.enabled) throw new ExternalAnalysisRetryError({ code: 'gemini_free_disabled', message: 'External Gemini generation is disabled.' });
  const doc = readCleanupDocument(input.document);
  const snapshot = collectCleanupSnapshot(doc, input.snapshot.phrases.map((phrase): DuplicatePhrase => ({ text: phrase.text, count: phrase.occurrenceIds.length,
    containsKeyword: false, locations: [] })), input.category, input.language);
  const state = await runCleanupWorkflow({
    doc, snapshot, keywords: input.keywords, title: input.title,
    saved: context.job.progress.cleanup as CleanupJobProgress | undefined, signal: context.signal,
    run: async (prompt, requestIndex) => {
      const call = await runExternalGeminiCall({ context, prompt, model: settings.model,
        allowModelFallback: settings.allowModelFallback, requestIndex });
      if (!call.ok) throw new ExternalAnalysisRetryError({ code: `duplicate_cleanup_http_${call.status}`, message: call.error });
      return call.text;
    },
    checkpoint: async cleanup => {
      context.signal.throwIfAborted();
      if (!await context.reportProgress({ progress: { stage: 'duplicate_cleanup', cleanup } })) throw new ExternalAnalysisOwnershipLostError();
    },
  });
  return { result: { status: state.errors.length || state.decisions.some(decision => decision.action === 'unresolved') ? 'partial' : 'completed', cleanup: state },
    progress: { stage: 'duplicate_cleanup_completed', cleanup: state } };
}

registerExternalAnalysisJobExecutor('duplicate_cleanup', executeDuplicateCleanup);
