import type { AutomationTaskInventoryItem } from './contentWritingAutomation';

const AUTOMATIC_ARTICLE_LANE_OPERATIONS = new Set([
  'alternative_keywords',
  'lsi_keywords',
  'google_metadata',
  'competitor_discovery',
  'competitor_extraction',
  'external_analysis',
  'content_writing',
  'duplicate_suggestions',
]);

const taskPriority = (task: AutomationTaskInventoryItem): number => {
  if (task.status === 'running') return 0;
  if (task.status === 'ready' || task.status === 'scheduled') return 1;
  return 2;
};

const taskTime = (task: AutomationTaskInventoryItem): number => {
  const timestamp = Date.parse(task.startedAt || task.readyAt || task.scheduleAt || task.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
};

export const selectExpectedNextAutomaticArticle = (
  tasks: AutomationTaskInventoryItem[],
  currentArticleId?: string | null,
): AutomationTaskInventoryItem | null => {
  const candidatesByArticle = new Map<string, AutomationTaskInventoryItem>();

  for (const task of tasks) {
    if (
      !task.articleId
      || task.articleId === currentArticleId
      || task.manualReview
      || task.status === 'failed'
      || !AUTOMATIC_ARTICLE_LANE_OPERATIONS.has(task.operationKey)
    ) continue;

    const existing = candidatesByArticle.get(task.articleId);
    if (!existing) {
      candidatesByArticle.set(task.articleId, task);
      continue;
    }

    const priorityDifference = taskPriority(task) - taskPriority(existing);
    const timeDifference = taskTime(task) - taskTime(existing);
    if (
      priorityDifference < 0
      || (priorityDifference === 0 && timeDifference < 0)
      || (priorityDifference === 0 && timeDifference === 0 && task.priorityRank < existing.priorityRank)
    ) {
      candidatesByArticle.set(task.articleId, task);
    }
  }

  return [...candidatesByArticle.values()].sort((left, right) => (
    taskPriority(left) - taskPriority(right)
    || taskTime(left) - taskTime(right)
    || left.priorityRank - right.priorityRank
    || left.articleId.localeCompare(right.articleId)
  ))[0] || null;
};
