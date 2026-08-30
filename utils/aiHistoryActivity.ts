import type { AIHistoryItem } from '../types';
import type { AiExecutionActivity } from './aiExecutionActivity';

export type ArticleAiHistoryIdentity = {
  articleScope: string;
  articleId: string | null;
  articleKey?: string;
};

const NON_EDITOR_SURFACES = new Set([
  'assigned_article_automation',
  'automatic_content_writing',
]);

const SURFACE_LABELS: Record<string, { ar: string; en: string }> = {
  smart_analysis: { ar: 'التحليل الذكي', en: 'Smart analysis' },
  quick_provider: { ar: 'أمر سريع', en: 'Quick command' },
  ready_commands_batch: { ar: 'حزمة الأوامر الجاهزة', en: 'Ready command bundle' },
  competitor_comparison_map: { ar: 'تحليل منافس مستقل', en: 'Independent competitor analysis' },
  competitor_comparison_synthesis: { ar: 'دمج نتائج المنافسين', en: 'Competitor result synthesis' },
  competitor_comparison_synthesis_repair: { ar: 'إصلاح دمج المنافسين', en: 'Competitor synthesis repair' },
  bulk_fix_review: { ar: 'مراجعة إصلاح المخالفات', en: 'Violation repair review' },
  bulk_fix_all: { ar: 'إصلاح المخالفات', en: 'Fix violations' },
  content_writing: { ar: 'كتابة المقالة', en: 'Article writing' },
  internal_linking_ai_review: { ar: 'مراجعة الربط الداخلي', en: 'Internal-link review' },
  internal_link_review: { ar: 'مراجعة الربط الداخلي', en: 'Internal-link review' },
  goal_context_generation: { ar: 'توليد سياق وهدف الصفحة', en: 'Page goal context generation' },
  draft_title_generation: { ar: 'اقتراح عنوان المقالة', en: 'Draft title generation' },
  floating_toolbar: { ar: 'أمر الشريط العائم', en: 'Floating toolbar command' },
  heading_analysis: { ar: 'تحليل العناوين', en: 'Heading analysis' },
  plain_ai_analysis: { ar: 'أمر ذكاء اصطناعي مباشر', en: 'Direct AI command' },
  semantic_keywords_lsi: { ar: 'توليد الصيغ وLSI', en: 'Alternatives and LSI generation' },
};

const toTime = (value?: string): number => {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const getLegacyHistoryTime = (item: AIHistoryItem): number => {
  const leadingTimestamp = Number(String(item.id).split('-')[0]);
  return Number.isFinite(leadingTimestamp) ? leadingTimestamp : 0;
};

export const getAiHistoryItemTime = (item: AIHistoryItem): number => (
  toTime(item.updatedAt)
  || toTime(item.createdAt)
  || toTime(item.execution?.updatedAt)
  || toTime(item.execution?.startedAt)
  || getLegacyHistoryTime(item)
);

export const sortAiHistoryItems = (items: readonly AIHistoryItem[]): AIHistoryItem[] => (
  [...items].sort((left, right) => getAiHistoryItemTime(right) - getAiHistoryItemTime(left))
);

export const getEditorAiExecutionSurfaceLabel = (
  surface: string,
  locale: 'ar' | 'en',
): string => {
  const normalized = surface.trim();
  return SURFACE_LABELS[normalized]?.[locale]
    || normalized.replace(/[_-]+/g, ' ')
    || (locale === 'ar' ? 'عملية ذكاء اصطناعي داخل المحرر' : 'AI operation inside the editor');
};

export const isEditorAiExecutionActivity = (
  activity: AiExecutionActivity,
  identity: ArticleAiHistoryIdentity,
): boolean => {
  if (!activity.id.trim() || activity.id.startsWith('external-analysis:')) return false;
  if (NON_EDITOR_SURFACES.has(activity.surface)) return false;

  const articleId = identity.articleId?.trim() || '';
  const articleKey = identity.articleKey?.trim() || '';
  const activityArticleId = activity.articleId.trim();
  const activityArticleKey = activity.articleKey.trim();

  // The execution store is shared by the dashboard and every editor route.
  // Never attach an unscoped activity to whichever article happens to open
  // next, and only use the key fallback when both sides actually have a key.
  if (!activityArticleId && !activityArticleKey) return false;
  if (activityArticleId) {
    if (!articleId || activityArticleId !== articleId) return false;
  } else if (!articleKey || activityArticleKey !== articleKey) {
    return false;
  }

  return Boolean(activity.surface || activity.action || activity.commandId);
};

export const mergeEditorAiExecutionIntoHistory = (
  history: readonly AIHistoryItem[],
  activity: AiExecutionActivity,
  identity: ArticleAiHistoryIdentity,
): AIHistoryItem[] => {
  if (!isEditorAiExecutionActivity(activity, identity)) return history as AIHistoryItem[];

  const itemId = `ai-execution:${activity.id}`;
  const existing = history.find(item => item.id === itemId);
  const nextItem: AIHistoryItem = {
    ...(existing || {}),
    ...identity,
    id: itemId,
    type: 'ai-execution',
    createdAt: existing?.createdAt || activity.startedAt,
    updatedAt: activity.updatedAt,
    ruleTitle: activity.action || getEditorAiExecutionSurfaceLabel(activity.surface, 'ar'),
    originalText: '',
    suggestions: [],
    from: 0,
    to: 0,
    commandId: activity.commandId || undefined,
    execution: {
      activityId: activity.id,
      state: activity.state,
      stage: activity.stage,
      surface: activity.surface,
      action: activity.action,
      message: activity.message,
      provider: activity.provider,
      requestedProvider: activity.requestedProvider,
      model: activity.model,
      requestedModel: activity.requestedModel,
      commandId: activity.commandId,
      startedAt: activity.startedAt,
      updatedAt: activity.updatedAt,
      completedAt: activity.completedAt,
    },
  };

  const unchanged = existing && JSON.stringify(existing.execution) === JSON.stringify(nextItem.execution);
  if (unchanged) return history as AIHistoryItem[];
  return sortAiHistoryItems([nextItem, ...history.filter(item => item.id !== itemId)]);
};
