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
import { readPromptRegistrySettings } from './promptRegistrySettings';
import { PROMPT_TEMPLATE_IDS, getPromptTemplate } from '../constants/promptRegistry';
import { buildContentBriefPrompt, parseContentBriefText } from '../utils/contentBriefGeneration';

type ArticleRow = {
  id: string;
  title: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  updated_at: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(text).filter(Boolean) : []
);

const retry = (
  code: string,
  message: string,
  progress: ExternalAnalysisJson,
): never => {
  throw new ExternalAnalysisRetryError({
    code,
    message: message.slice(0, 2_000),
    progress,
  });
};

const readArticle = async (articleId: string): Promise<ArticleRow> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('id,title,keywords,goal_context,article_language,updated_at')
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Article ${articleId} was not found.`);
  return data as ArticleRow;
};

const executeContentBriefGeneration = async (
  context: ExternalAnalysisExecutionContext,
) => {
  await context.reportProgress({ progress: { stage: 'loading_article' } });
  const article = await readArticle(context.job.article_id);
  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const goalContext = isRecord(article.goal_context) ? article.goal_context : {};
  const primaryKeyword = text(keywords.primary);
  const alternativeKeywords = list(keywords.secondaries);
  if (!text(article.title) && !primaryKeyword && alternativeKeywords.length === 0) {
    retry(
      'content_brief_inputs_missing',
      'The article title or primary keyword is required before generating the smart brief.',
      { stage: 'retry_scheduled', reason: 'content_brief_inputs_missing' },
    );
  }

  const [aiSettings, promptRegistry] = await Promise.all([
    readExternalGeminiSettings(),
    readPromptRegistrySettings(),
  ]);
  if (!aiSettings.enabled) {
    retry(
      'gemini_free_disabled',
      'Free Gemini analysis is disabled in system settings.',
      { stage: 'retry_scheduled', reason: 'gemini_free_disabled' },
    );
  }

  const prompt = buildContentBriefPrompt({
    title: text(article.title),
    primaryKeyword,
    alternativeKeywords,
    articleLanguage: article.article_language === 'en' ? 'en' : 'ar',
    goalContext,
  }, getPromptTemplate(
    promptRegistry.templates,
    PROMPT_TEMPLATE_IDS.contentBriefGeneration,
  ));
  const attempts: ExternalAnalysisJson[] = [];
  const call = await runExternalGeminiCall({
    context,
    prompt,
    model: aiSettings.model,
    allowModelFallback: aiSettings.allowModelFallback,
    requestIndex: 1,
  });
  attempts.push(...call.attempts);
  await reportExternalGeminiCall(context, call, attempts);
  if (!call.ok) {
    retry(
      `content_brief_http_${call.status}`,
      call.error,
      {
        stage: 'retry_scheduled',
        provider: call.provider,
        model: call.model,
        keyAttemptCount: attempts.length,
      },
    );
  }

  const briefText = parseContentBriefText(call.text);
  if (!briefText) {
    retry(
      'content_brief_response_invalid',
      'The AI response did not contain a valid editable content brief.',
      {
        stage: 'retry_scheduled',
        provider: call.provider,
        model: call.model,
        keyAttemptCount: attempts.length,
      },
    );
  }

  await context.reportProgress({
    progress: { stage: 'applying_content_brief' },
    provider: call.provider,
    model: call.model,
    keyAttempts: attempts,
  });
  const latest = await readArticle(article.id);
  const latestGoalContext = isRecord(latest.goal_context) ? latest.goal_context : {};
  const now = new Date().toISOString();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .update({
      goal_context: {
        ...latestGoalContext,
        generatedBrief: briefText,
      },
      last_saved_at: now,
    })
    .eq('id', article.id)
    .eq('updated_at', latest.updated_at)
    .select('id,updated_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    retry(
      'article_changed_during_content_brief_apply',
      'The article changed while the generated content brief was being saved.',
      { stage: 'retry_scheduled', reason: 'article_changed' },
    );
  }

  return {
    result: {
      status: 'applied',
      briefText,
      provider: call.provider,
      model: call.model,
      keySuffix: call.keySuffix,
      keyAttempts: attempts,
      sourceArticleUpdatedAt: article.updated_at,
      articleUpdatedAt: String(data.updated_at || now),
      completedAt: now,
    },
    progress: {
      stage: 'applied',
      provider: call.provider,
      model: call.model,
      keySuffix: call.keySuffix,
      keyAttemptCount: attempts.length,
    },
  };
};

registerExternalAnalysisJobExecutor(
  'content_brief_generation',
  executeContentBriefGeneration,
);
