import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { deliverApiResult, getHeaderValue, isRecord, readRequestBody, type ApiResult } from './http.ts';

type ArticleVisibility = 'private' | 'public';
type ArticleStatus = 'draft' | 'in_review' | 'published' | 'archived';
type AccessRole = 'viewer' | 'editor';

type ResolvedProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type IngestResolution = {
  visibility: ArticleVisibility;
  ownerId: string | null;
  assignedToId: string | null;
  accessProfiles: ResolvedProfile[];
  accessRole: AccessRole;
  visibleToEmailsCsv: string;
};

type IngestDefaults = {
  visibility: ArticleVisibility;
  status: ArticleStatus;
  accessRole: AccessRole;
  publicEditorUrl: string;
};

type ArticleLinks = {
  articleUrl: string;
  adminUrl: string;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

class IngestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

const ALLOWED_VISIBILITIES = new Set<ArticleVisibility>(['private', 'public']);
const ALLOWED_STATUSES = new Set<ArticleStatus>(['draft', 'in_review', 'published', 'archived']);
const ALLOWED_ACCESS_ROLES = new Set<AccessRole>(['viewer', 'editor']);
const STATUS_ALIASES: Record<string, ArticleStatus> = {
  ready: 'in_review',
  review: 'in_review',
  reviewing: 'in_review',
  'in review': 'in_review',
  'جاهز': 'in_review',
  'مراجعة': 'in_review',
};

const getPublicBaseUrl = (req: any): string => {
  const configuredUrl = String(
    process.env.EDITOR_PUBLIC_URL ||
    process.env.PUBLIC_EDITOR_URL ||
    process.env.APP_BASE_URL ||
    ''
  ).trim().replace(/\/+$/, '');
  if (configuredUrl) return configuredUrl;

  const host = getHeaderValue(req, 'x-forwarded-host') || getHeaderValue(req, 'host');
  const protocol = getHeaderValue(req, 'x-forwarded-proto') || 'https';
  return host ? `${protocol.split(',')[0].trim()}://${host.split(',')[0].trim()}` : '';
};

const buildAppUrl = (baseUrl: string, path: string): string => (
  baseUrl ? `${baseUrl}${path}` : path
);

const buildArticleLinks = (baseUrl: string, articleId: string): ArticleLinks => {
  const encodedArticleId = encodeURIComponent(articleId);
  return {
    articleUrl: buildAppUrl(baseUrl, `/editor/${encodedArticleId}`),
    adminUrl: buildAppUrl(baseUrl, `/admin/articles/${encodedArticleId}`),
  };
};

const getContentType = (req: any): string => getHeaderValue(req, 'content-type');

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!supabaseUrl) {
    throw new IngestError('SUPABASE_URL or VITE_SUPABASE_URL is not configured on the server.', 503);
  }
  if (!serviceRoleKey) {
    throw new IngestError('SUPABASE_SERVICE_ROLE_KEY is not configured on the server.', 503);
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const authenticateRequest = (req: any) => {
  const configuredToken = String(process.env.N8N_INGEST_TOKEN || '').trim();
  if (!configuredToken) {
    throw new IngestError('N8N_INGEST_TOKEN is not configured on the server.', 503);
  }

  const authorization = getHeaderValue(req, 'authorization');
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  const headerToken = getHeaderValue(req, 'x-n8n-token') || getHeaderValue(req, 'x-bazarvan-token');
  const providedToken = bearerToken || headerToken.trim();

  if (!providedToken || !constantTimeEquals(providedToken, configuredToken)) {
    throw new IngestError('Unauthorized n8n ingest request.', 401);
  }
};

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const getFirstString = (source: Record<string, any>, keys: string[]): string => {
  for (const key of keys) {
    const value = toTrimmedString(source[key]);
    if (value) return value;
  }
  return '';
};

const normalizeToken = (value: unknown): string => toTrimmedString(value).toLowerCase().replace(/\s+/g, '-');
const normalizeChoiceToken = (value: unknown): string => toTrimmedString(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[ًٌٍَُِّْـ]/g, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .replace(/[\s_]+/g, '-')
  .replace(/[|]+/g, '/')
  .replace(/[()]/g, '')
  .trim();

const TERM_SEPARATOR_PATTERN = /[\n\r,،;؛|*\/#•·]+|(?<!\d)\.(?!\d)/g;
const DEFAULT_LIST_SEPARATOR_PATTERN = /[\n\r,،;؛|]+/g;

const toStringList = (value: unknown, separatorPattern: RegExp = DEFAULT_LIST_SEPARATOR_PATTERN): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(item => toStringList(item, separatorPattern));
  }

  if (typeof value === 'string') {
    return value
      .split(separatorPattern)
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (isRecord(value)) {
    const id = toTrimmedString(value.id || value.userId || value.user_id);
    const email = toTrimmedString(value.email || value.userEmail || value.user_email);
    return [id || email].filter(Boolean);
  }

  return [];
};

const resolveMappedChoice = <T extends string>(
  value: unknown,
  aliases: Record<T, string[]>,
  fallback: T,
): T => {
  const token = normalizeChoiceToken(value);
  if (!token) return fallback;

  for (const [targetValue, targetAliases] of Object.entries(aliases) as [T, string[]][]) {
    const acceptedTokens = [targetValue, ...targetAliases].map(normalizeChoiceToken);
    if (acceptedTokens.includes(token)) return targetValue;
  }

  return fallback;
};

const PAGE_TYPE_ALIASES: Record<string, string[]> = {
  article: ['article', 'article/guide', 'مقالة/دليل', 'مقاله/دليل', 'مقالة', 'مقاله', 'مقال'],
  news: ['news', 'خبر', 'اخبار', 'أخبار'],
  service: ['service', 'service-page', 'خدمة', 'خدمه', 'صفحة خدمة', 'صفحه خدمه'],
  category: ['category', 'category-page', 'Product/Service Category', 'تصنيف منتجات/خدمات', 'تصنيف', 'فئة', 'فئه'],
  comparison: ['comparison', 'comparison-page', 'مقارنة', 'مقارنه', 'صفحة مقارنة', 'صفحه مقارنه'],
  product: ['product', 'product-page', 'منتج', 'صفحة منتج', 'صفحه منتج'],
  landing: ['landing', 'landing-page', 'هبوط', 'صفحة هبوط', 'صفحه هبوط'],
  guide: ['guide', 'دليل', 'مرشد'],
};

const OBJECTIVE_ALIASES: Record<string, string[]> = {
  educate: ['educate', 'Explain and educate', 'شرح وتثقيف', 'شرح', 'تثقيف', 'تعليم'],
  compare: ['compare', 'Compare and help choose', 'مقارنة ومساعدة على الاختيار', 'اختيار', 'مقارنة', 'مقارنه'],
  convert: ['convert', 'Direct conversion', 'تحويل مباشر', 'تحويل', 'بيع', 'شراء', 'حجز', 'leads', 'bookings', 'sell'],
  'category-support': ['category-support', 'Support content for a category page', 'محتوى داعم لصفحة تصنيف', 'دعم التصنيف', 'داعم'],
  trust: ['trust', 'Build trust and reduce objections', 'بناء الثقة وتقليل الاعتراضات', 'الثقة', 'ثقة', 'اعتراضات'],
  support: ['support', 'Support after decision or use', 'دعم بعد القرار أو الاستخدام', 'دعم', 'مساعدة', 'retention'],
};

const AUDIENCE_SCOPE_ALIASES: Record<string, string[]> = {
  local: ['local', 'City or local area', 'مدينة أو منطقة محلية', 'محلي', 'مدينة', 'مدينه', 'منطقة محلية', 'منطقه محليه'],
  country: ['country', 'One specific country', 'دولة واحدة محددة', 'دولة', 'دوله', 'بلد'],
  regional: ['regional', 'Region', 'إقليم', 'اقليم', 'منطقة', 'منطقه'],
  global: ['global', 'Global', 'عالمي', 'عام'],
};

const SEARCH_INTENT_ALIASES: Record<string, string[]> = {
  informational: ['informational', 'Explain and learn', 'شرح وتعلّم', 'شرح وتعلم', 'شرح', 'معلوماتي', 'تعليمي', 'info'],
  commercial: ['commercial', 'Compare and choose', 'مقارنة واختيار', 'اختيار', 'تجاري', 'مقارنة'],
  'commercial-support': ['commercial-support', 'Supportive commercial information', 'معلومات تجارية داعمة', 'تجاري داعم'],
  transactional: ['transactional', 'Take an action / buy', 'تنفيذ إجراء/شراء', 'تنفيذ', 'شراء', 'حجز'],
  navigational: ['navigational', 'Reach a specific brand or page', 'الوصول إلى علامة أو صفحة محددة', 'وصول', 'تنقل'],
  'support-intent': ['support-intent', 'Solve a problem or learn usage', 'حل مشكلة أو معرفة طريقة الاستخدام', 'حل', 'مساعدة', 'استخدام'],
};

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter(value => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const compactObject = <T extends Record<string, any>>(value: T): Partial<T> => Object.entries(value)
  .reduce<Partial<T>>((acc, [key, item]) => {
    if (item === null || item === undefined) return acc;
    if (typeof item === 'string' && !item.trim()) return acc;
    if (Array.isArray(item) && item.length === 0) return acc;
    if (isRecord(item) && Object.keys(compactObject(item)).length === 0) return acc;
    (acc as Record<string, any>)[key] = item;
    return acc;
  }, {});

const decodeHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const stripHtml = (html: string): string => decodeHtmlEntities(html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]{2,}/g, ' ')
  .trim());

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const plainTextToHtml = (text: string): string => text
  .split(/\n{2,}/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)
  .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
  .join('\n');

const calculateWordCount = (text: string): number => (
  text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0
);

const normalizeLanguage = (value: unknown): 'ar' | 'en' => {
  const token = normalizeToken(value);
  return token === 'en' || token === 'english' || token === 'انجليزي' || token === 'إنجليزي' ? 'en' : 'ar';
};

const normalizeStatus = (value: unknown, fallback: ArticleStatus = 'draft'): ArticleStatus => {
  const token = normalizeToken(value);
  if (STATUS_ALIASES[token]) return STATUS_ALIASES[token];
  return ALLOWED_STATUSES.has(token as ArticleStatus) ? token as ArticleStatus : fallback;
};

const normalizeVisibility = (value: unknown): ArticleVisibility | null => {
  const token = normalizeToken(value);
  return ALLOWED_VISIBILITIES.has(token as ArticleVisibility) ? token as ArticleVisibility : null;
};

const normalizeAccessRole = (value: unknown, fallback: AccessRole = 'viewer'): AccessRole => {
  const token = normalizeToken(value);
  return ALLOWED_ACCESS_ROLES.has(token as AccessRole) ? token as AccessRole : fallback;
};

const readAppSetting = async (supabase: SupabaseAdmin, key: string): Promise<Record<string, any>> => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    if (error.code === '42P01') return {};
    throw error;
  }

  return isRecord(data?.value) ? data.value : {};
};

const normalizeBaseUrl = (value: unknown): string => toTrimmedString(value).replace(/\/+$/, '');

const resolveIngestDefaults = async (supabase: SupabaseAdmin): Promise<IngestDefaults> => {
  const [n8nSettings, articleSettings, systemSettings] = await Promise.all([
    readAppSetting(supabase, 'n8n'),
    readAppSetting(supabase, 'articles'),
    readAppSetting(supabase, 'system'),
  ]);

  return {
    visibility: normalizeVisibility(n8nSettings.defaultVisibility || articleSettings.defaultVisibility) || 'public',
    status: normalizeStatus(n8nSettings.defaultStatus || articleSettings.defaultStatus, 'draft'),
    accessRole: normalizeAccessRole(n8nSettings.defaultAccessRole, 'editor'),
    publicEditorUrl: normalizeBaseUrl(systemSettings.publicEditorUrl),
  };
};

const getKeywordsPayload = (body: Record<string, any>) => {
  const keywords = isRecord(body.keywords) ? body.keywords : {};
  const primary = getFirstString(body, ['primaryKeyword', 'primary_keyword']) || getFirstString(keywords, ['primary', 'main', 'primaryKeyword', 'primary_keyword']);
  const company = getFirstString(body, ['company', 'companyName', 'company_name', 'brand']) || getFirstString(keywords, ['company', 'companyName', 'company_name', 'brand']);
  const secondaries = uniqueStrings([
    ...toStringList(keywords.secondaries, TERM_SEPARATOR_PATTERN),
    ...toStringList(keywords.synonyms, TERM_SEPARATOR_PATTERN),
    ...toStringList(keywords.alternativeForms, TERM_SEPARATOR_PATTERN),
    ...toStringList(keywords.alternatives, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.secondaries, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.synonyms, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.alternativeForms, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.alternative_forms, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.alternatives, TERM_SEPARATOR_PATTERN),
  ]);
  const lsi = uniqueStrings([
    ...toStringList(keywords.lsi, TERM_SEPARATOR_PATTERN),
    ...toStringList(keywords.lsiKeywords, TERM_SEPARATOR_PATTERN),
    ...toStringList(keywords.lsi_keywords, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.lsi, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.lsiKeywords, TERM_SEPARATOR_PATTERN),
    ...toStringList(body.lsi_keywords, TERM_SEPARATOR_PATTERN),
  ]);

  return compactObject({
    primary,
    secondaries,
    company,
    lsi,
  });
};

const getGoalContextPayload = (body: Record<string, any>) => {
  const source = isRecord(body.goalContext)
    ? body.goalContext
    : isRecord(body.goal_context)
      ? body.goal_context
      : isRecord(body.pageContext)
        ? body.pageContext
        : isRecord(body.page_context)
          ? body.page_context
          : {};

  const pageType = getFirstString(body, ['pageType', 'page_type']) || getFirstString(source, ['pageType', 'page_type', 'type']);
  const objective = getFirstString(body, ['objective', 'pageObjective', 'page_objective']) || getFirstString(source, ['objective', 'pageObjective', 'page_objective']);
  const audienceScope = getFirstString(body, ['audienceScope', 'audience_scope']) || getFirstString(source, ['audienceScope', 'audience_scope', 'scope']);
  const searchIntent = getFirstString(body, ['searchIntent', 'search_intent', 'intent']) || getFirstString(source, ['searchIntent', 'search_intent', 'intent']);

  return compactObject({
    pageType: resolveMappedChoice(pageType, PAGE_TYPE_ALIASES, 'article'),
    objective: resolveMappedChoice(objective, OBJECTIVE_ALIASES, 'educate'),
    audienceScope: resolveMappedChoice(audienceScope, AUDIENCE_SCOPE_ALIASES, 'global'),
    targetCountry: getFirstString(body, ['targetCountry', 'target_country', 'targetLocation', 'target_location']) || getFirstString(source, ['targetCountry', 'target_country', 'targetLocation', 'target_location', 'country']),
    searchIntent: resolveMappedChoice(searchIntent, SEARCH_INTENT_ALIASES, 'informational'),
  });
};

const getTargetIdentifiers = (body: Record<string, any>): string[] => uniqueStrings([
  ...toStringList(body.visibleTo),
  ...toStringList(body.visible_to),
  ...toStringList(body.visibleToUsers),
  ...toStringList(body.visible_to_users),
  ...toStringList(body.visibleToEmails),
  ...toStringList(body.visible_to_emails),
  ...toStringList(body.visibleToEmailsCsv),
  ...toStringList(body.visible_to_emails_csv),
  ...toStringList(body.userEmail),
  ...toStringList(body.user_email),
  ...toStringList(body.ownerEmail),
  ...toStringList(body.owner_email),
  ...toStringList(body.assignedToEmail),
  ...toStringList(body.assigned_to_email),
]);

const lookupProfiles = async (supabase: SupabaseAdmin, identifiers: string[]): Promise<ResolvedProfile[]> => {
  const normalizedIdentifiers = uniqueStrings(identifiers);
  if (normalizedIdentifiers.length === 0) return [];

  const ids = normalizedIdentifiers.filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  const emails = normalizedIdentifiers.filter(value => value.includes('@')).map(value => value.toLowerCase());
  const profilesById = new Map<string, ResolvedProfile>();

  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id,email,full_name')
      .in('id', ids);
    if (error) throw error;
    (data || []).forEach(profile => profilesById.set(profile.id, profile as ResolvedProfile));
  }

  if (emails.length > 0) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id,email,full_name')
      .in('email', emails);
    if (error) throw error;
    (data || []).forEach(profile => profilesById.set(profile.id, profile as ResolvedProfile));
  }

  const foundTokens = new Set<string>();
  profilesById.forEach(profile => {
    foundTokens.add(profile.id.toLowerCase());
    if (profile.email) foundTokens.add(profile.email.toLowerCase());
  });

  const missing = normalizedIdentifiers.filter(identifier => !foundTokens.has(identifier.toLowerCase()));
  if (missing.length > 0) {
    throw new IngestError(`Could not find Supabase profiles for: ${missing.join(', ')}`, 400);
  }

  return [...profilesById.values()];
};

const resolveProfileBySingleIdentifier = async (
  supabase: SupabaseAdmin,
  value: unknown,
): Promise<ResolvedProfile | null> => {
  const identifiers = toStringList(value);
  if (identifiers.length === 0) return null;
  const profiles = await lookupProfiles(supabase, [identifiers[0]]);
  return profiles[0] || null;
};

const resolveIngestAccess = async (
  supabase: SupabaseAdmin,
  body: Record<string, any>,
  defaults: IngestDefaults,
): Promise<IngestResolution> => {
  const rawVisibility = toTrimmedString(body.visibility);
  const explicitVisibility = normalizeVisibility(rawVisibility);
  if (rawVisibility && !explicitVisibility) {
    throw new IngestError('Invalid visibility. Allowed values are: private, public.', 400);
  }
  const selectedProfiles = await lookupProfiles(supabase, getTargetIdentifiers(body));
  const ownerProfile = await resolveProfileBySingleIdentifier(supabase, body.ownerId || body.owner_id || body.ownerEmail || body.owner_email);
  const assignedProfile = await resolveProfileBySingleIdentifier(supabase, body.assignedTo || body.assigned_to || body.assignedToId || body.assigned_to_id || body.assignedToEmail || body.assigned_to_email);

  const accessProfilesById = new Map<string, ResolvedProfile>();
  selectedProfiles.forEach(profile => accessProfilesById.set(profile.id, profile));
  if (ownerProfile) accessProfilesById.set(ownerProfile.id, ownerProfile);
  if (assignedProfile) accessProfilesById.set(assignedProfile.id, assignedProfile);

  const visibility: ArticleVisibility = explicitVisibility || (accessProfilesById.size > 0 ? 'private' : defaults.visibility);

  return {
    visibility,
    ownerId: ownerProfile?.id || (visibility === 'private' ? selectedProfiles[0]?.id || null : null),
    assignedToId: assignedProfile?.id || null,
    accessProfiles: [...accessProfilesById.values()],
    accessRole: normalizeAccessRole(body.accessRole || body.access_role, defaults.accessRole),
    visibleToEmailsCsv: [...accessProfilesById.values()].map(profile => profile.email).filter(Boolean).join(', '),
  };
};

const getListValue = (source: Record<string, any>, keys: string[]): string[] => {
  for (const key of keys) {
    const values = toStringList(source[key]);
    if (values.length > 0) return values;
  }
  return [];
};

const normalizeCompetitorInputs = (body: Record<string, any>) => {
  const competitorRows = Array.isArray(body.competitors) ? body.competitors : [];
  const urlsFromLists = getListValue(body, ['competitorUrls', 'competitor_urls', 'competitorLinks', 'competitor_links']);
  const htmlsFromLists = getListValue(body, ['competitorHtmls', 'competitor_htmls']);
  const textsFromLists = getListValue(body, ['competitorTexts', 'competitor_texts']);
  const urls: string[] = [];
  const htmls: string[] = [];
  const texts: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    const row = isRecord(competitorRows[index]) ? competitorRows[index] : {};
    urls[index] = toTrimmedString(
      row.url ||
      row.link ||
      body[`competitor${index + 1}Url`] ||
      body[`competitor_${index + 1}_url`] ||
      urlsFromLists[index]
    );
    htmls[index] = toTrimmedString(
      row.html ||
      body[`competitor${index + 1}Html`] ||
      body[`competitor_${index + 1}_html`] ||
      htmlsFromLists[index]
    );
    texts[index] = toTrimmedString(
      row.text ||
      row.plainText ||
      row.plain_text ||
      body[`competitor${index + 1}Text`] ||
      body[`competitor_${index + 1}_text`] ||
      body[`competitor${index + 1}PlainText`] ||
      body[`competitor_${index + 1}_plain_text`] ||
      textsFromLists[index]
    );
  }

  return urls.some(Boolean) || htmls.some(Boolean) || texts.some(Boolean)
    ? { urls, htmls, texts }
    : null;
};

const buildStats = (plainText: string, rawStats: unknown) => {
  const stats = isRecord(rawStats) ? rawStats : {};
  return {
    wordCount: typeof stats.wordCount === 'number' ? stats.wordCount : calculateWordCount(plainText),
    keywordViolations: typeof stats.keywordViolations === 'number' ? stats.keywordViolations : 0,
    violatingCriteriaCount: typeof stats.violatingCriteriaCount === 'number' ? stats.violatingCriteriaCount : 0,
    totalErrorsCount: typeof stats.totalErrorsCount === 'number' ? stats.totalErrorsCount : 0,
    keywordDuplicatesCount: typeof stats.keywordDuplicatesCount === 'number' ? stats.keywordDuplicatesCount : 0,
    totalDuplicates: typeof stats.totalDuplicates === 'number' ? stats.totalDuplicates : 0,
    commonDuplicatesCount: typeof stats.commonDuplicatesCount === 'number' ? stats.commonDuplicatesCount : 0,
    uniqueWordsPercentage: typeof stats.uniqueWordsPercentage === 'number' ? stats.uniqueWordsPercentage : 0,
  };
};

const buildArticlePayload = async (supabase: SupabaseAdmin, body: Record<string, any>, defaults: IngestDefaults) => {
  const title = getFirstString(body, ['title', 'articleTitle', 'article_title', 'headline']);
  if (!title) throw new IngestError('Article title is required.', 400);

  const providedHtml = getFirstString(body, ['contentHtml', 'content_html', 'html', 'articleHtml', 'article_html']);
  const providedPlainText = getFirstString(body, ['plainText', 'plain_text', 'text', 'contentText', 'content_text', 'articleText', 'article_text']);
  const fallbackContent = getFirstString(body, ['content', 'body']);
  const contentHtml = providedHtml || (providedPlainText || fallbackContent ? plainTextToHtml(providedPlainText || fallbackContent) : '');
  const plainText = providedPlainText || (providedHtml ? stripHtml(providedHtml) : fallbackContent);

  if (!contentHtml && !plainText) {
    throw new IngestError('Article contentHtml or plainText is required.', 400);
  }

  const externalId = getFirstString(body, ['externalId', 'external_id', 'id']);
  const workflowId = getFirstString(body, ['workflowId', 'workflow_id']) || getFirstString(isRecord(body.metadata) ? body.metadata : {}, ['workflowId', 'workflow_id']);
  const executionId = getFirstString(body, ['executionId', 'execution_id']) || getFirstString(isRecord(body.metadata) ? body.metadata : {}, ['executionId', 'execution_id']);
  const access = await resolveIngestAccess(supabase, body, defaults);
  const pageContextRaw = toTrimmedString(body.pageContext || body.page_context);
  const contentJson = isRecord(body.contentJson) ? body.contentJson : isRecord(body.content_json) ? body.content_json : {};
  const articleLanguage = normalizeLanguage(body.articleLanguage || body.article_language || body.language);
  const articleStatus = normalizeStatus(body.status, defaults.status);
  const competitors = normalizeCompetitorInputs(body);

  return {
    article: {
      owner_id: access.ownerId,
      created_by: access.ownerId,
      assigned_to: access.assignedToId,
      source: 'n8n',
      visibility: access.visibility,
      status: articleStatus,
      title,
      content_json: contentJson,
      content_html: contentHtml || null,
      plain_text: plainText || stripHtml(contentHtml),
      keywords: getKeywordsPayload(body),
      goal_context: getGoalContextPayload(body),
      article_language: articleLanguage,
      analysis: isRecord(body.analysis) ? body.analysis : null,
      stats: buildStats(plainText || stripHtml(contentHtml), body.stats),
      n8n_workflow_id: workflowId || null,
      n8n_execution_id: executionId || null,
      external_id: externalId || null,
      metadata: compactObject({
        importedBy: 'n8n',
        importedAt: new Date().toISOString(),
        workflowId,
        executionId,
        externalId,
        pageContextRaw,
        n8nSettings: compactObject({
          visibility: access.visibility,
          accessRole: access.accessRole,
          visibleToEmailsCsv: access.visibleToEmailsCsv,
          articleLanguage,
          status: articleStatus,
        }),
        visibleTo: access.accessProfiles.map(profile => compactObject({
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          role: access.accessRole,
        })),
        attachments: compactObject({
          competitors,
        }),
        requestMetadata: isRecord(body.metadata) ? body.metadata : undefined,
      }),
    },
    access,
    externalId,
  };
};

const syncArticleAccess = async (supabase: SupabaseAdmin, articleId: string, access: IngestResolution) => {
  const { error: deleteError } = await supabase
    .from('article_access')
    .delete()
    .eq('article_id', articleId);

  if (deleteError && deleteError.code !== '42P01') throw deleteError;

  if (access.accessProfiles.length === 0) return;

  const { error } = await supabase
    .from('article_access')
    .insert(access.accessProfiles.map(profile => ({
      article_id: articleId,
      user_id: profile.id,
      role: access.accessRole,
    })));

  if (error) throw error;
};

const createIngestLog = async (
  supabase: SupabaseAdmin,
  status: 'received' | 'imported' | 'failed',
  body: Record<string, any>,
  options: {
    articleId?: string | null;
    articleUrl?: string;
    adminUrl?: string;
    errorMessage?: string;
  } = {},
) => {
  const workflowId = getFirstString(body, ['workflowId', 'workflow_id']) || getFirstString(isRecord(body.metadata) ? body.metadata : {}, ['workflowId', 'workflow_id']);
  const executionId = getFirstString(body, ['executionId', 'execution_id']) || getFirstString(isRecord(body.metadata) ? body.metadata : {}, ['executionId', 'execution_id']);
  const externalId = getFirstString(body, ['externalId', 'external_id', 'id']);

  await supabase
    .from('n8n_ingest_logs')
    .insert({
      article_id: options.articleId || null,
      workflow_id: workflowId || null,
      execution_id: executionId || null,
      external_id: externalId || null,
      status,
      payload: compactObject({
        title: getFirstString(body, ['title', 'articleTitle', 'article_title', 'headline']),
        externalId,
        workflowId,
        executionId,
        articleUrl: options.articleUrl,
        adminUrl: options.adminUrl,
      }),
      error_message: options.errorMessage || null,
      processed_at: new Date().toISOString(),
    });
};

const saveIngestedArticle = async (
  supabase: SupabaseAdmin,
  body: Record<string, any>,
  defaults: IngestDefaults,
  publicBaseUrl: string,
) => {
  const { article, access, externalId } = await buildArticlePayload(supabase, body, defaults);
  const savedAt = new Date().toISOString();
  const existingArticle = externalId
    ? await supabase
        .from('articles')
        .select('id,save_count')
        .eq('source', 'n8n')
        .eq('external_id', externalId)
        .maybeSingle()
    : { data: null, error: null };

  if (existingArticle.error) throw existingArticle.error;

  if (existingArticle.data?.id) {
    const nextSaveCount = Number(existingArticle.data.save_count || 0) + 1;
    const { data, error } = await supabase
      .from('articles')
      .update({
        ...article,
        save_count: nextSaveCount,
        last_saved_at: savedAt,
      })
      .eq('id', existingArticle.data.id)
      .select('id,title,visibility,status,updated_at,last_saved_at')
      .single();

    if (error) throw error;
    await syncArticleAccess(supabase, data.id, access);
    const links = buildArticleLinks(publicBaseUrl, data.id);
    await createIngestLog(supabase, 'imported', body, { articleId: data.id, ...links });
    return { mode: 'updated' as const, article: data, access, links };
  }

  const { data, error } = await supabase
    .from('articles')
    .insert({
      ...article,
      save_count: 1,
      time_spent_seconds: 0,
      last_saved_at: savedAt,
    })
    .select('id,title,visibility,status,created_at,last_saved_at')
    .single();

  if (error) throw error;
  await syncArticleAccess(supabase, data.id, access);
  const links = buildArticleLinks(publicBaseUrl, data.id);
  await createIngestLog(supabase, 'imported', body, { articleId: data.id, ...links });
  return { mode: 'created' as const, article: data, access, links };
};

const handleN8nArticleRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-N8N-Token, X-Bazarvan-Token',
      },
    };
  }

  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed. Use POST.' } };
  }

  let body: Record<string, any> = {};
  let supabase: SupabaseAdmin | null = null;

  try {
    authenticateRequest(req);

    if (!getContentType(req).includes('application/json')) {
      return { status: 415, body: { error: 'Content-Type must be application/json.' } };
    }

    const parsedBody = await readRequestBody(req);
    if (!isRecord(parsedBody)) {
      return { status: 400, body: { error: 'JSON body must be an object.' } };
    }

    body = parsedBody;
    supabase = getSupabaseAdmin();
    await createIngestLog(supabase, 'received', body);
    const defaults = await resolveIngestDefaults(supabase);
    const publicBaseUrl = defaults.publicEditorUrl || getPublicBaseUrl(req);
    const result = await saveIngestedArticle(supabase, body, defaults, publicBaseUrl);

    return {
      status: result.mode === 'created' ? 201 : 200,
      body: {
        success: true,
        ok: true,
        status: result.mode,
        mode: result.mode,
        articleId: result.article.id,
        articleUrl: result.links.articleUrl,
        adminUrl: result.links.adminUrl,
        title: result.article.title,
        visibility: result.article.visibility,
        articleStatus: result.article.status,
        defaultVisibility: defaults.visibility,
        defaultAccessRole: defaults.accessRole,
        visibleTo: result.access.accessProfiles.map(profile => compactObject({
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          role: result.access.accessRole,
        })),
      },
    };
  } catch (error) {
    const status = error instanceof IngestError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown n8n ingest error.';
    console.error('n8n article ingest failed:', error);

    if (supabase && Object.keys(body).length > 0 && status !== 401) {
      await createIngestLog(supabase, 'failed', body, { errorMessage: message }).catch(logError => {
        console.error('Failed to write n8n ingest error log:', logError);
      });
    }

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
  const result = await handleN8nArticleRequest(req);
  return deliverApiResult(result, res);
}
