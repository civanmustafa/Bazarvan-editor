import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_PAID_ANALYSIS_MODEL,
} from '../constants/modelRegistry';
import { ArticleAccessPolicyError, requireArticleWriteAccess } from './articleAccessPolicy';
import { aiExecutionEngine, type AiExecutionTelemetryContext } from '../server/aiExecutionEngine';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type AutomationStatus = 'generated' | 'analyzed' | 'skipped' | 'failed';
type GeminiProvider = 'gemini' | 'geminiPaid';
type SupabaseAdmin = SupabaseClient<any, 'public', any>;

type GoalContextPayload = {
  pageType: string;
  objective: string;
  audienceScope: string;
  targetCountry: string;
  searchIntent: string;
};

type KeywordsPayload = {
  primary: string;
  secondaries: string[];
  company: string;
  lsi: string[];
};

class AssignedAutomationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AssignedAutomationError';
    this.status = status;
  }
}

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || GEMINI_ANALYSIS_MODEL;
const DEFAULT_GEMINI_PAID_MODEL = process.env.GEMINI_PAID_MODEL?.trim() || GEMINI_PAID_ANALYSIS_MODEL;

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!supabaseUrl) {
    throw new AssignedAutomationError('SUPABASE_URL or VITE_SUPABASE_URL is not configured on the server.', 503);
  }
  if (!serviceRoleKey) {
    throw new AssignedAutomationError('SUPABASE_SERVICE_ROLE_KEY is not configured on the server.', 503);
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

const readNodeBody = async (req: any): Promise<unknown> => {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req.json === 'function' && typeof req.headers?.get === 'function') {
    return req.json();
  }
  return readNodeBody(req);
};

const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }

  const directValue = req.headers?.[headerName.toLowerCase()] || req.headers?.[headerName];
  return Array.isArray(directValue) ? String(directValue[0] || '') : String(directValue || '');
};

const getContentType = (req: any): string => getHeaderValue(req, 'content-type');

const toWebResponse = (result: ApiResult): Response => new Response(JSON.stringify(result.body), {
  status: result.status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...(result.headers || {}),
  },
});

const sendNodeResponse = (res: any, result: ApiResult) => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(JSON.stringify(result.body));
};

const wait = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));

const callGemini = async (
  prompt: string,
  provider: GeminiProvider,
  telemetry: AiExecutionTelemetryContext,
): Promise<{ text: string; keyFingerprint: string; keySuffix: string; model: string }> => {
  const model = provider === 'geminiPaid' ? DEFAULT_GEMINI_PAID_MODEL : DEFAULT_GEMINI_MODEL;
  const result = await aiExecutionEngine.executeGemini({
    prompt,
    provider,
    model,
    allowModelFallback: provider === 'gemini',
  }, { telemetry });
  const body = isRecord(result.body) ? result.body : {};
  const text = toTrimmedString(body.text);
  if (result.status < 200 || result.status >= 300 || !text) {
    throw new AssignedAutomationError(
      toTrimmedString(body.error) || `Gemini request failed with status ${result.status}.`,
      result.status,
    );
  }
  return {
    text,
    keyFingerprint: toTrimmedString(body.keyFingerprint),
    keySuffix: toTrimmedString(body.keySuffix),
    model: toTrimmedString(body.model) || model,
  };
};

const extractJson = (text: string): any => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const source = fenced || trimmed;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(source.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (isRecord(value)) {
    return toStringList(
      value.term ||
      value.text ||
      value.keyword ||
      value.value ||
      value.name ||
      value.label
    );
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n\r,;\u060C\u061B|*\/#•·]+|(?<!\d)\.(?!\d)|\s+-\s+/g)
    .map(item => item.replace(/^[-–—•·\d.)\s]+/, '').trim())
    .filter(Boolean);
};

const getFirstListFromRecord = (source: unknown, keys: string[]): string[] => {
  if (!isRecord(source)) return [];

  for (const key of keys) {
    const values = toStringList(source[key]);
    if (values.length > 0) return values;
  }

  return [];
};

const extractSemanticTerms = (parsed: unknown): { title: string; secondaries: string[]; lsi: string[] } => {
  const source = isRecord(parsed) ? parsed : {};
  const nestedKeywords = isRecord(source.keywords) ? source.keywords : {};
  const semantic = isRecord(source.semantic) ? source.semantic : {};
  const seo = isRecord(source.seo) ? source.seo : {};

  return {
    title: toTrimmedString(source.title || source.articleTitle || source.seoTitle),
    secondaries: mergeUniqueTerms([], [
      ...getFirstListFromRecord(source, ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms']),
      ...getFirstListFromRecord(nestedKeywords, ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms']),
      ...getFirstListFromRecord(semantic, ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms']),
      ...getFirstListFromRecord(seo, ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms']),
    ], 16),
    lsi: mergeUniqueTerms([], [
      ...getFirstListFromRecord(source, ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms']),
      ...getFirstListFromRecord(nestedKeywords, ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms']),
      ...getFirstListFromRecord(semantic, ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms']),
      ...getFirstListFromRecord(seo, ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms']),
    ], 36),
  };
};

const normalizeKeywordsPayload = (value: unknown): KeywordsPayload => {
  const source = isRecord(value) ? value : {};
  return {
    primary: toTrimmedString(source.primary),
    secondaries: Array.isArray(source.secondaries) ? source.secondaries.map(toTrimmedString).filter(Boolean) : toStringList(source.secondaries),
    company: toTrimmedString(source.company),
    lsi: Array.isArray(source.lsi) ? source.lsi.map(toTrimmedString).filter(Boolean) : toStringList(source.lsi),
  };
};

const normalizeGoalContextPayload = (value: unknown): GoalContextPayload => {
  const source = isRecord(value) ? value : {};
  return {
    pageType: toTrimmedString(source.pageType),
    objective: toTrimmedString(source.objective),
    audienceScope: toTrimmedString(source.audienceScope),
    targetCountry: toTrimmedString(source.targetCountry),
    searchIntent: toTrimmedString(source.searchIntent),
  };
};

const hasCompleteGoalContext = (context: GoalContextPayload): boolean => Boolean(
  context.pageType &&
  context.objective &&
  context.audienceScope &&
  context.searchIntent
);

const mergeUniqueTerms = (existing: string[], incoming: string[], maxItems: number): string[] => {
  const seen = new Set<string>();
  return [...existing, ...incoming]
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
};

const isPlaceholderTitle = (title: string): boolean => {
  const normalized = title.trim().toLowerCase();
  return !normalized || normalized === '(untitled)' || normalized === 'untitled' || normalized === 'draft';
};

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trim()}\n\n[Text shortened for request size.]`;
};

const countWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const formatCompetitorEvidence = (value: string): string => truncateText(value, 9000)
  .split(/\n{2,}/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)
  .map((paragraph, index) => `[Paragraph ${index + 1}] ${paragraph}`)
  .join('\n\n');

const getCompetitorData = (metadata: Record<string, any>): { texts: string[]; urls: string[] } => {
  const attachments = isRecord(metadata.attachments) ? metadata.attachments : {};
  const competitors = isRecord(attachments.competitors)
    ? attachments.competitors
    : isRecord(metadata.competitors)
      ? metadata.competitors
      : {};
  const texts = Array.isArray(competitors.texts) ? competitors.texts.map(toTrimmedString) : [];
  const urls = Array.isArray(competitors.urls) ? competitors.urls.map(toTrimmedString) : [];

  return {
    texts: texts.filter(Boolean),
    urls,
  };
};

const buildCompetitorBlocks = (texts: string[], urls: string[]): string => texts
  .map((value, index) => {
    const text = value.trim();
    if (!text) return '';

    return [
      `### Competitor ${index + 1}`,
      `URL: ${urls[index]?.trim() || 'not provided'}`,
      `Word count: ${countWords(text)}`,
      'When citing an idea, use: source competitor number + evidence paragraph number.',
      '',
      'Evidence text:',
      '---',
      formatCompetitorEvidence(text),
      '---',
    ].join('\n');
  })
  .filter(Boolean)
  .join('\n\n');

const buildSemanticPrompt = (
  article: Record<string, any>,
  keywords: KeywordsPayload,
  goalContext: GoalContextPayload,
): string => [
  'You are an expert semantic SEO editor.',
  'Generate useful alternative keyword forms and LSI terms for the assigned draft.',
  'Do not rewrite the article.',
  'Use the page context, audience, search intent, and primary keyword.',
  'Return strict JSON only, without Markdown, without code fences, and without explanation.',
  'Use exactly these keys: title, secondaries, lsi.',
  'Return at least 6 items in secondaries and at least 12 items in lsi when possible.',
  'Do not include empty strings. Avoid repeating existing terms unless there is no better variant.',
  '',
  `Article language: ${article.article_language === 'en' ? 'English' : 'Arabic'}`,
  `Article title: ${article.title || '-'}`,
  `Primary keyword: ${keywords.primary}`,
  `Current alternative forms: ${keywords.secondaries.join(', ') || '-'}`,
  `Current LSI terms: ${keywords.lsi.join(', ') || '-'}`,
  `Company/brand: ${keywords.company || '-'}`,
  `Page context: pageType=${goalContext.pageType}; objective=${goalContext.objective}; audienceScope=${goalContext.audienceScope}; targetCountry=${goalContext.targetCountry || '-'}; searchIntent=${goalContext.searchIntent}`,
  '',
  'Required JSON shape:',
  '{ "title": "one SEO title only if the current title is missing or generic", "secondaries": ["..."], "lsi": ["..."] }',
].join('\n');

const buildSemanticRetryPrompt = (
  article: Record<string, any>,
  keywords: KeywordsPayload,
  goalContext: GoalContextPayload,
  previousAnswer: string,
): string => [
  'Your previous answer could not be parsed into usable keyword lists.',
  'Return JSON only with exactly these keys: title, secondaries, lsi.',
  'secondaries must be an array of alternative keyword forms.',
  'lsi must be an array of semantic LSI terms.',
  '',
  `Article language: ${article.article_language === 'en' ? 'English' : 'Arabic'}`,
  `Primary keyword: ${keywords.primary}`,
  `Article title: ${article.title || '-'}`,
  `Page context: pageType=${goalContext.pageType}; objective=${goalContext.objective}; audienceScope=${goalContext.audienceScope}; targetCountry=${goalContext.targetCountry || '-'}; searchIntent=${goalContext.searchIntent}`,
  '',
  'Previous answer:',
  truncateText(previousAnswer, 4000) || '-',
  '',
  'Required JSON only:',
  '{ "title": "", "secondaries": ["..."], "lsi": ["..."] }',
].join('\n');

const buildProCompetitorPrompt = (
  article: Record<string, any>,
  keywords: KeywordsPayload,
  goalContext: GoalContextPayload,
  competitorBlocks: string,
): string => [
  'You are a strict SEO content analyst.',
  'Run this ready manual command: New/conflicting competitor ideas.',
  'Find useful ideas competitors cover but the article does not cover clearly, and find conflicting claims if they exist.',
  'Use the competitor number and evidence paragraph number when referring to competitor content.',
  article.article_language === 'en'
    ? 'Write the final report in English.'
    : 'Write the final report in Arabic.',
  '',
  `Article title: ${article.title || '-'}`,
  `Primary keyword: ${keywords.primary}`,
  `Alternative forms: ${keywords.secondaries.join(', ')}`,
  `LSI terms: ${keywords.lsi.join(', ')}`,
  `Company/brand: ${keywords.company || '-'}`,
  `Page context: pageType=${goalContext.pageType}; objective=${goalContext.objective}; audienceScope=${goalContext.audienceScope}; targetCountry=${goalContext.targetCountry || '-'}; searchIntent=${goalContext.searchIntent}`,
  '',
  'Current article text:',
  '---',
  truncateText(toTrimmedString(article.plain_text), 12000) || '-',
  '---',
  '',
  'Competitor evidence:',
  competitorBlocks,
].join('\n');

const appendAutomationMetadata = (
  metadata: Record<string, any>,
  statusPatch: Record<string, any>,
): Record<string, any> => {
  const automation = isRecord(metadata.automation) ? metadata.automation : {};
  const assignedArticleAi = isRecord(automation.assignedArticleAi) ? automation.assignedArticleAi : {};
  return {
    ...metadata,
    automation: {
      ...automation,
      assignedArticleAi: {
        ...assignedArticleAi,
        ...statusPatch,
        updatedAt: new Date().toISOString(),
      },
    },
  };
};

const saveGeminiPaidResultInMetadata = (
  metadata: Record<string, any>,
  result: {
    text: string;
    keyFingerprint: string;
    keySuffix: string;
    model: string;
    savedAt: string;
  },
): Record<string, any> => {
  const aiResults = isRecord(metadata.aiResults) ? metadata.aiResults : {};
  const providerResults = isRecord(aiResults.geminiPaid) ? aiResults.geminiPaid : {};
  const history = Array.isArray(providerResults.history) ? providerResults.history : [];
  const entry = {
    result: result.text,
    keyFingerprint: result.keyFingerprint,
    keySuffix: result.keySuffix,
    model: result.model,
    savedAt: result.savedAt,
    commandId: 'smartAnalysis.competitorContentComparison',
    commandLabel: 'New/conflicting competitor ideas',
    trigger: 'assigned-user',
  };

  return {
    ...metadata,
    aiResults: {
      ...aiResults,
      geminiPaid: {
        ...providerResults,
        latest: entry,
        history: [entry, ...history].slice(0, 10),
      },
    },
  };
};

const authenticateUser = async (supabase: SupabaseAdmin, req: any) => {
  const token = getHeaderValue(req, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (!token) {
    throw new AssignedAutomationError('Authentication is required.', 401);
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) {
    throw new AssignedAutomationError('Invalid Supabase session.', 401);
  }

  return data.user;
};

const authorizeArticleAutomation = async (
  supabase: SupabaseAdmin,
  userId: string,
  article: Record<string, any>,
): Promise<void> => {
  await requireArticleWriteAccess(supabase, String(article.id || ''), userId);
};

const updateArticle = async (
  supabase: SupabaseAdmin,
  articleId: string,
  payload: Record<string, any>,
): Promise<void> => {
  const { error } = await supabase
    .from('articles')
    .update(payload)
    .eq('id', articleId);

  if (error) throw error;
};

const readArticleById = async (
  supabase: SupabaseAdmin,
  articleId: string,
): Promise<Record<string, any>> => {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('id', articleId)
    .single();

  if (error || !data) {
    throw new AssignedAutomationError('Article was not found after automation update.', 404);
  }

  return data as Record<string, any>;
};

const getAssignedAutomationPauseMs = (): number => {
  const value = Number.parseInt(process.env.ASSIGNED_ARTICLE_AI_PAUSE_MS || '5000', 10);
  if (!Number.isFinite(value)) return 5000;
  return Math.max(0, Math.min(value, 30000));
};

const runSemanticGeneration = async (
  supabase: SupabaseAdmin,
  article: Record<string, any>,
  metadata: Record<string, any>,
  reasons: string[],
  telemetry: AiExecutionTelemetryContext,
): Promise<{
  status: Exclude<AutomationStatus, 'analyzed'>;
  keywords: KeywordsPayload;
  metadata: Record<string, any>;
  title: string;
}> => {
  const keywords = normalizeKeywordsPayload(article.keywords);
  const goalContext = normalizeGoalContextPayload(article.goal_context);

  if (article.status !== 'draft') {
    reasons.push('Semantic generation skipped: article status is not draft.');
    return { status: 'skipped', keywords, metadata, title: toTrimmedString(article.title) };
  }
  if (!keywords.primary) {
    reasons.push('Semantic generation skipped: primary keyword is missing.');
    return { status: 'skipped', keywords, metadata, title: toTrimmedString(article.title) };
  }
  if (!hasCompleteGoalContext(goalContext)) {
    reasons.push('Semantic generation skipped: page context is incomplete.');
    return { status: 'skipped', keywords, metadata, title: toTrimmedString(article.title) };
  }

  try {
    let gemini = await callGemini(
      buildSemanticPrompt(article, keywords, goalContext),
      'gemini',
      { ...telemetry, source: 'assigned_automation_semantic' },
    );
    let semanticTerms = extractSemanticTerms(extractJson(gemini.text));
    let incomingSecondaries = mergeUniqueTerms([], semanticTerms.secondaries, 12);
    let incomingLsi = mergeUniqueTerms([], semanticTerms.lsi, 30);
    let hasMergedTerms = Boolean(
      mergeUniqueTerms(keywords.secondaries, incomingSecondaries, 12).length &&
      mergeUniqueTerms(keywords.lsi, incomingLsi, 30).length
    );

    if (!hasMergedTerms) {
      const retry = await callGemini(
        buildSemanticRetryPrompt(article, keywords, goalContext, gemini.text),
        'gemini',
        { ...telemetry, source: 'assigned_automation_semantic_retry' },
      );
      const retryTerms = extractSemanticTerms(extractJson(retry.text));
      const retrySecondaries = mergeUniqueTerms([], retryTerms.secondaries, 12);
      const retryLsi = mergeUniqueTerms([], retryTerms.lsi, 30);
      const retryHasMergedTerms = Boolean(
        mergeUniqueTerms(keywords.secondaries, retrySecondaries, 12).length &&
        mergeUniqueTerms(keywords.lsi, retryLsi, 30).length
      );

      if (retryHasMergedTerms) {
        gemini = retry;
        semanticTerms = retryTerms;
        incomingSecondaries = retrySecondaries;
        incomingLsi = retryLsi;
        hasMergedTerms = true;
      }
    }

    if (!hasMergedTerms) {
      throw new AssignedAutomationError('Gemini did not return usable alternative forms and LSI terms.', 502);
    }

    const nextKeywords: KeywordsPayload = {
      ...keywords,
      secondaries: mergeUniqueTerms(keywords.secondaries, incomingSecondaries, 12),
      lsi: mergeUniqueTerms(keywords.lsi, incomingLsi, 30),
    };
    const generatedTitle = semanticTerms.title;
    const nextTitle = isPlaceholderTitle(toTrimmedString(article.title)) && generatedTitle
      ? generatedTitle
      : toTrimmedString(article.title);
    const now = new Date().toISOString();
    const nextMetadata = appendAutomationMetadata(metadata, {
      semantic: {
        status: 'generated',
        ranAt: now,
        provider: 'gemini',
        model: gemini.model,
        keyFingerprint: gemini.keyFingerprint,
        keySuffix: gemini.keySuffix,
        addedSecondaries: nextKeywords.secondaries.length - keywords.secondaries.length,
        addedLsi: nextKeywords.lsi.length - keywords.lsi.length,
      },
    });

    await updateArticle(supabase, article.id, {
      title: nextTitle,
      keywords: nextKeywords,
      metadata: nextMetadata,
      last_saved_at: now,
    });

    return {
      status: 'generated',
      keywords: nextKeywords,
      metadata: nextMetadata,
      title: nextTitle,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown semantic generation error.';
    reasons.push(`Semantic generation failed: ${message}`);
    const nextMetadata = appendAutomationMetadata(metadata, {
      semantic: {
        status: 'failed',
        ranAt: new Date().toISOString(),
        error: message,
      },
    });
    await updateArticle(supabase, article.id, { metadata: nextMetadata });
    return { status: 'failed', keywords, metadata: nextMetadata, title: toTrimmedString(article.title) };
  }
};

const runGeminiPaidCompetitorAnalysis = async (
  supabase: SupabaseAdmin,
  article: Record<string, any>,
  keywords: KeywordsPayload,
  metadata: Record<string, any>,
  reasons: string[],
  telemetry: AiExecutionTelemetryContext,
): Promise<{
  status: Extract<AutomationStatus, 'analyzed' | 'skipped' | 'failed'>;
  metadata: Record<string, any>;
}> => {
  const goalContext = normalizeGoalContextPayload(article.goal_context);
  const competitors = getCompetitorData(metadata);
  const competitorBlocks = buildCompetitorBlocks(competitors.texts, competitors.urls);

  if (article.status !== 'draft') {
    reasons.push('Gemini Pro analysis skipped: article status is not draft.');
    return { status: 'skipped', metadata };
  }
  if (!competitorBlocks.trim()) {
    reasons.push('Gemini Pro analysis skipped: competitor texts are missing.');
    return { status: 'skipped', metadata };
  }
  if (!keywords.primary) {
    reasons.push('Gemini Pro analysis skipped: primary keyword is missing.');
    return { status: 'skipped', metadata };
  }
  if (!keywords.secondaries.some(Boolean)) {
    reasons.push('Gemini Pro analysis skipped: alternative forms are missing.');
    return { status: 'skipped', metadata };
  }
  if (!keywords.lsi.some(Boolean)) {
    reasons.push('Gemini Pro analysis skipped: LSI terms are missing.');
    return { status: 'skipped', metadata };
  }
  if (!hasCompleteGoalContext(goalContext)) {
    reasons.push('Gemini Pro analysis skipped: page context is incomplete.');
    return { status: 'skipped', metadata };
  }

  try {
    const gemini = await callGemini(
      buildProCompetitorPrompt(article, keywords, goalContext, competitorBlocks),
      'geminiPaid',
      {
        ...telemetry,
        source: 'assigned_automation_competitor',
        commandId: 'smartAnalysis.competitorContentComparison',
        commandLabel: 'New/conflicting competitor ideas',
      },
    );
    const now = new Date().toISOString();
    const metadataWithResult = saveGeminiPaidResultInMetadata(metadata, {
      text: gemini.text,
      keyFingerprint: gemini.keyFingerprint,
      keySuffix: gemini.keySuffix,
      model: gemini.model,
      savedAt: now,
    });
    const nextMetadata = appendAutomationMetadata(metadataWithResult, {
      geminiPaid: {
        status: 'analyzed',
        ranAt: now,
        provider: 'geminiPaid',
        model: gemini.model,
        keyFingerprint: gemini.keyFingerprint,
        keySuffix: gemini.keySuffix,
        commandId: 'smartAnalysis.competitorContentComparison',
      },
    });

    await updateArticle(supabase, article.id, {
      metadata: nextMetadata,
      last_saved_at: now,
    });

    return { status: 'analyzed', metadata: nextMetadata };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini Pro analysis error.';
    reasons.push(`Gemini Pro analysis failed: ${message}`);
    const nextMetadata = appendAutomationMetadata(metadata, {
      geminiPaid: {
        status: 'failed',
        ranAt: new Date().toISOString(),
        error: message,
      },
    });
    await updateArticle(supabase, article.id, { metadata: nextMetadata });
    return { status: 'failed', metadata: nextMetadata };
  }
};

const handleAssignedArticleAutomationRequest = async (req: any): Promise<ApiResult> => {
  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed. Use POST.' } };
  }

  try {
    if (!getContentType(req).includes('application/json')) {
      return { status: 415, body: { error: 'Content-Type must be application/json.' } };
    }

    const parsedBody = await readRequestBody(req);
    if (!isRecord(parsedBody)) {
      return { status: 400, body: { error: 'JSON body must be an object.' } };
    }

    const articleId = toTrimmedString(parsedBody.articleId || parsedBody.article_id);
    if (!articleId) {
      return { status: 400, body: { error: 'articleId is required.' } };
    }

    const supabase = getSupabaseAdmin();
    const user = await authenticateUser(supabase, req);
    const { data: article, error: articleError } = await supabase
      .from('articles')
      .select('*')
      .eq('id', articleId)
      .single();

    if (articleError || !article) {
      throw new AssignedAutomationError('Article was not found.', 404);
    }

    await authorizeArticleAutomation(supabase, user.id, article as Record<string, any>);

    const reasons: string[] = [];
    const metadata = isRecord((article as Record<string, any>).metadata) ? (article as Record<string, any>).metadata : {};
    const telemetry: AiExecutionTelemetryContext = {
      actorUserId: user.id,
      actorEmail: user.email || null,
      articleId,
      articleTitle: toTrimmedString((article as Record<string, any>).title),
    };
    const semantic = await runSemanticGeneration(
      supabase,
      article as Record<string, any>,
      metadata,
      reasons,
      telemetry,
    );

    if (semantic.status === 'generated') {
      const pauseMs = getAssignedAutomationPauseMs();
      if (pauseMs > 0) {
        reasons.push(`Waiting ${pauseMs}ms before Gemini Pro analysis so saved keywords are available.`);
        await wait(pauseMs);
      }
    }

    const latestArticle = await readArticleById(supabase, articleId);
    const latestMetadata = isRecord(latestArticle.metadata) ? latestArticle.metadata : semantic.metadata;
    const latestKeywords = normalizeKeywordsPayload(latestArticle.keywords || semantic.keywords);
    const geminiPaid = await runGeminiPaidCompetitorAnalysis(
      supabase,
      latestArticle,
      latestKeywords,
      latestMetadata,
      reasons,
      telemetry,
    );

    return {
      status: 200,
      body: {
        ok: true,
        articleId,
        semantic: semantic.status,
        geminiPaid: geminiPaid.status,
        reasons,
      },
    };
  } catch (error) {
    const status = error instanceof AssignedAutomationError || error instanceof ArticleAccessPolicyError
      ? error.status
      : 500;
    const message = error instanceof Error ? error.message : 'Unknown assigned article automation error.';
    console.error('Assigned article automation failed:', error);
    return {
      status,
      body: {
        ok: false,
        error: message,
      },
    };
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = await handleAssignedArticleAutomationRequest(req);
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
}
