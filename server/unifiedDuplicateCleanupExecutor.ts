import { isDeepStrictEqual } from 'node:util';
import type { Keywords } from '../types';
import { runUnifiedCleanupWorkflow, type UnifiedCleanupState } from '../utils/unifiedDuplicateCleanup';
import { readCleanupDocument, serializeCleanupDocument } from './duplicateCleanupJob';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { assertAutomaticArticlePolicy } from './articleAutomationPolicy';
import { readExternalGeminiSettings } from './externalAnalysisSettings';
import { runExternalGeminiCall } from './externalGeminiRunner';
import { ExternalAnalysisBlockedError, ExternalAnalysisOwnershipLostError, ExternalAnalysisRetryError,
  type ExternalAnalysisExecutionContext } from './externalAnalysisExecutor';

export async function executeUnifiedDuplicateCleanup(context: ExternalAnalysisExecutionContext) {
  const input = context.job.input_snapshot;
  const saved = context.job.progress.unified as UnifiedCleanupState | undefined;
  let expectedDocument = saved?.document || input.document as Record<string, unknown>;
  const admin = getExternalAnalysisSupabaseAdmin();
  const assertCurrent = async () => {
    context.signal.throwIfAborted();
    await assertAutomaticArticlePolicy(context.job);
    const { data, error } = await admin.from('articles').select('content_json,keywords,article_language,title,status')
      .eq('id', context.job.article_id).single();
    if (error) throw error;
    if (data.status !== 'draft'
      || !isDeepStrictEqual(data.content_json, expectedDocument) || !isDeepStrictEqual(data.keywords, input.keywords)
      || data.article_language !== input.language || data.title !== input.title) {
      throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_article_changed',
        message: 'تغيّرت المقالة أثناء التنقية؛ توقف التطبيق لحماية التعديلات الجديدة.' });
    }
    if (context.job.origin === 'auto') {
      const { data: ready, error: readinessError } = await admin.rpc('unified_duplicate_cleanup_auto_ready',
        { p_article_id: context.job.article_id });
      if (readinessError) throw readinessError;
      if (!ready) throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_not_ready',
        message: 'تأجلت المعالجة التلقائية لأن المقالة مفتوحة أو لم يستقر نصها بعد.' });
    }
  };
  await assertCurrent();
  const settings = await readExternalGeminiSettings();
  if (!settings.enabled) throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_disabled', message: 'التوليد الخارجي معطّل.' });
  const terms = input.keywords as Partial<Keywords> | undefined;
  const keywordList = (value: unknown): string[] => Array.isArray(value) ? value.filter((term): term is string => typeof term === 'string') : [];
  const keywords: Keywords = { primary: String(terms?.primary || ''), company: String(terms?.company || ''),
    secondaries: keywordList(terms?.secondaries), lsi: keywordList(terms?.lsi) };
  let doc;
  try { doc = readCleanupDocument(input.document); }
  catch (error) { throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_document_unsupported', message: String(error) }); }
  const state = await runUnifiedCleanupWorkflow({ doc,
    initialDocument: input.document as Record<string, unknown>,
    keywords, language: input.language === 'en' ? 'en' : 'ar', title: String(input.title || ''),
    saved, signal: context.signal, assertCurrent,
    run: async (prompt, requestIndex) => {
      const result = await runExternalGeminiCall({ context, prompt, model: settings.model, allowModelFallback: settings.allowModelFallback, requestIndex });
      if (!result.ok) throw new ExternalAnalysisRetryError({ code: `duplicate_cleanup_http_${result.status}`, message: result.error });
      return result.text;
    },
    checkpoint: async unified => {
      if (!await context.reportProgress({ progress: { stage: 'unified_duplicate_cleanup', unified } })) throw new ExternalAnalysisOwnershipLostError();
    },
    commit: async (_before, after, unified) => {
      const content = serializeCleanupDocument(after.toJSON());
      const { error } = await admin.rpc('apply_unified_duplicate_cleanup', { p_job_id: context.job.id, p_worker_id: context.workerId,
        p_lease_generation: context.job.lease_generation, p_before: expectedDocument, p_state: unified, p_html: content.html, p_text: content.text });
      if (error?.code === '40001') throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_article_changed', message: 'تغيّرت المقالة قبل التطبيق؛ بقيت التعديلات الجديدة محفوظة.' });
      if (error?.code === '55000' && error.message?.includes('Automatic cleanup is no longer ready'))
        throw new ExternalAnalysisBlockedError({ code: 'duplicate_cleanup_not_ready',
          message: 'فُتحت المقالة أو تغيّر وضعها قبل التطبيق؛ لم يُطبّق الاقتراح.' });
      if (error?.code === '55000') throw new ExternalAnalysisOwnershipLostError();
      if (error) throw error;
      expectedDocument = unified.document;
    },
  });
  return { result: { status: state.phase === 'completed' ? 'completed' : 'partial', unified: state },
    progress: { stage: 'unified_duplicate_cleanup_finished', unified: state } };
}
