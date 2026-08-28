import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import { readExternalGeminiSettings } from './externalAnalysisSettings';
import { reportExternalGeminiCall, runExternalGeminiCall } from './externalGeminiRunner';
import {
  buildMetaDescriptionPrompt,
  extractArticleTableOfContents,
  parseGeneratedMetaDescription,
  validateMetaDescription,
} from '../utils/metaDescription';

type ArticleRow = {
  id: string;
  status: string;
  title: string | null;
  content_html: string | null;
  plain_text: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  updated_at: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const retry = (
  code: string,
  message: string,
  progress: ExternalAnalysisJson,
): never => {
  throw new ExternalAnalysisRetryError({ code, message, progress });
};

const readArticle = async (articleId: string): Promise<ArticleRow> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('id,status,title,content_html,plain_text,keywords,goal_context,article_language,updated_at')
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Article ${articleId} was not found.`);
  return data as ArticleRow;
};

const executeMetaDescriptionGeneration = async (
  context: ExternalAnalysisExecutionContext,
) => {
  await context.reportProgress({ progress: { stage: 'loading_article' } });
  const article = await readArticle(context.job.article_id);
  if (article.status !== 'in_review') {
    return {
      result: { status: 'superseded', reason: 'article_is_not_ready' },
      progress: { stage: 'completed', reason: 'article_is_not_ready' },
    };
  }

  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const goalContext = isRecord(article.goal_context) ? article.goal_context : {};
  const primaryKeyword = text(keywords.primary);
  const title = text(article.title);
  const tableOfContents = extractArticleTableOfContents(article.content_html, article.plain_text);
  if (!title || !primaryKeyword || tableOfContents.length === 0) {
    retry(
      'meta_description_inputs_missing',
      'The article title, primary keyword, and table of contents are required.',
      { stage: 'waiting_for_prerequisites', reason: 'meta_description_inputs_missing' },
    );
  }

  const aiSettings = await readExternalGeminiSettings();
  if (!aiSettings.enabled) {
    retry(
      'gemini_free_disabled',
      'Free Gemini analysis is disabled in system settings.',
      { stage: 'retry_scheduled', reason: 'gemini_free_disabled' },
    );
  }

  const attempts: ExternalAnalysisJson[] = [];
  let description = '';
  let previousInvalidDescription = '';
  let provider = 'gemini';
  let model = aiSettings.model;
  let keySuffix = '';

  for (let requestIndex = 1; requestIndex <= 2; requestIndex += 1) {
    await context.reportProgress({
      progress: {
        stage: requestIndex === 1 ? 'generating_meta_description' : 'repairing_meta_description',
        requestIndex,
      },
    });
    const call = await runExternalGeminiCall({
      context,
      prompt: buildMetaDescriptionPrompt({
        title,
        primaryKeyword,
        articleLanguage: article.article_language === 'en' ? 'en' : 'ar',
        tableOfContents,
        goalContext,
        previousInvalidDescription,
      }),
      model: aiSettings.model,
      allowModelFallback: aiSettings.allowModelFallback,
      requestIndex,
    });
    attempts.push(...call.attempts);
    await reportExternalGeminiCall(context, call, attempts);
    provider = call.provider;
    model = call.model;
    keySuffix = call.keySuffix;
    if (!call.ok) {
      if (requestIndex === 2) {
        retry(
          `meta_description_http_${call.status}`,
          call.error,
          { stage: 'retry_scheduled', provider, model, keyAttemptCount: attempts.length },
        );
      }
      continue;
    }
    const candidate = parseGeneratedMetaDescription(call.text);
    const validation = validateMetaDescription(candidate, primaryKeyword);
    if (validation.valid) {
      description = validation.normalized;
      break;
    }
    previousInvalidDescription = candidate;
  }

  if (!description) {
    retry(
      'meta_description_response_invalid',
      'The generated meta description did not meet the 140–150 character and primary-keyword rules.',
      { stage: 'retry_scheduled', provider, model, keyAttemptCount: attempts.length },
    );
  }

  await context.reportProgress({
    progress: { stage: 'applying_meta_description' },
    provider,
    model,
    keyAttempts: attempts,
  });
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'apply_generated_article_meta_description',
    {
      p_job_id: context.job.id,
      p_worker_id: context.workerId,
      p_lease_generation: Number(context.job.lease_generation || 0),
      p_article_id: article.id,
      p_expected_updated_at: article.updated_at,
      p_source_signature: context.job.readiness_signature || '',
      p_description: description,
    },
  );
  if (error) throw error;
  const result = isRecord(data) ? data : {};
  if (result.applied !== true) {
    return {
      result: {
        status: 'superseded',
        reason: text(result.reason) || 'article_changed_before_apply',
      },
      progress: { stage: 'completed', reason: text(result.reason) || 'article_changed_before_apply' },
    };
  }

  return {
    result: {
      status: 'applied',
      metaDescription: description,
      characterCount: Array.from(description).length,
      provider,
      model,
      keySuffix,
      keyAttempts: attempts,
      sourceArticleUpdatedAt: article.updated_at,
      articleUpdatedAt: text(result.articleUpdatedAt),
      completedAt: new Date().toISOString(),
    },
    progress: {
      stage: 'applied',
      provider,
      model,
      keySuffix,
      keyAttemptCount: attempts.length,
    },
  };
};

registerExternalAnalysisJobExecutor(
  'meta_description_generation',
  executeMetaDescriptionGeneration,
);
