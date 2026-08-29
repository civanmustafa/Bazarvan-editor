
import type { ChatGptOpenMode, ClientGoalContexts, EngineeringPrompts, GoalContext, Keywords } from '../types';
import { INITIAL_GOAL_CONTEXT } from '../constants';
import { DEFAULT_ENGINEERING_PROMPTS } from '../constants/engineeringPrompts';

/*
 * localStorage persistence layer for per-user data.
 * Contexts should call these functions instead of reading/writing the activity key directly.
 *
 * Edit ArticleActivity/UserActivity when adding saved fields, then update the default builders
 * and any migration/normalization logic that reads older saved records.
 */
const ACTIVITY_KEY = 'smartEditorUserActivity';

export type ArticleActivity = {
  timeSpentSeconds: number;
  saveCount: number;
  lastSaved: string;
  content: any;
  keywords: Keywords;
  goalContext?: GoalContext;
  articleLanguage: 'ar' | 'en';
  stats?: {
    wordCount: number;
    keywordViolations: number;
    violatingCriteriaCount: number;
    totalErrorsCount: number;
    keywordDuplicatesCount: number;
    totalDuplicates: number;
    commonDuplicatesCount: number;
    uniqueWordsPercentage: number;
  };
};

export type UserActivity = {
  articles: {
    [title: string]: ArticleActivity;
  };
  preferredHighlightStyle?: 'background' | 'underline';
  preferredKeywordViewMode?: 'classic' | 'modern';
  preferredStructureViewMode?: 'grid' | 'list';
  preferredChatGptOpenMode?: ChatGptOpenMode;
  preferredTheme?: 'dark' | 'light';
  preferredLanguage?: 'ar' | 'en';
  preferredUILanguage?: 'ar' | 'en';
  clientGoalContexts?: ClientGoalContexts;
  engineeringPrompts?: EngineeringPrompts;
};

type ActivityData = {
  [username: string]: UserActivity;
};

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const toFiniteNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const toStringArray = (value: unknown, fallback: string[] = []): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
);

export const normalizeKeywords = (value: unknown): Keywords => {
  const source = isRecord(value) ? value : {};
  const clientId = typeof source.clientId === 'string' ? source.clientId.trim() : '';
  return {
    primary: typeof source.primary === 'string' ? source.primary : '',
    secondaries: toStringArray(source.secondaries, ['', '', '', '']),
    company: typeof source.company === 'string' ? source.company : '',
    ...(clientId ? { clientId } : {}),
    lsi: toStringArray(source.lsi),
  };
};

const getDefaultUserActivity = (): UserActivity => ({
  articles: {},
  preferredHighlightStyle: 'background',
  preferredKeywordViewMode: 'classic',
  preferredStructureViewMode: 'grid',
  preferredChatGptOpenMode: 'window',
  preferredTheme: 'dark',
  preferredLanguage: 'ar',
  preferredUILanguage: 'ar',
  clientGoalContexts: {},
  engineeringPrompts: DEFAULT_ENGINEERING_PROMPTS,
});

const getDefaultArticleActivity = (): ArticleActivity => ({
  timeSpentSeconds: 0,
  saveCount: 0,
  lastSaved: '',
  content: null,
  articleLanguage: 'ar',
  keywords: {
    primary: '',
    secondaries: ['', '', '', ''],
    company: '',
    lsi: [],
  },
  goalContext: INITIAL_GOAL_CONTEXT,
  stats: {
    wordCount: 0,
    keywordViolations: 0,
    violatingCriteriaCount: 0,
    totalErrorsCount: 0,
    keywordDuplicatesCount: 0,
    totalDuplicates: 0,
    commonDuplicatesCount: 0,
    uniqueWordsPercentage: 0,
  },
});

const normalizeArticleActivity = (value: unknown): ArticleActivity => {
  const source = isRecord(value) ? value : {};
  const defaults = getDefaultArticleActivity();
  const storedStats = isRecord(source.stats) ? source.stats : {};

  return {
    ...defaults,
    timeSpentSeconds: toFiniteNumber(source.timeSpentSeconds),
    saveCount: toFiniteNumber(source.saveCount),
    lastSaved: typeof source.lastSaved === 'string' ? source.lastSaved : '',
    content: source.content ?? null,
    keywords: normalizeKeywords(source.keywords),
    goalContext: isRecord(source.goalContext) ? source.goalContext as GoalContext : defaults.goalContext,
    articleLanguage: source.articleLanguage === 'en' ? 'en' : 'ar',
    stats: {
      wordCount: toFiniteNumber(storedStats.wordCount),
      keywordViolations: toFiniteNumber(storedStats.keywordViolations),
      violatingCriteriaCount: toFiniteNumber(storedStats.violatingCriteriaCount),
      totalErrorsCount: toFiniteNumber(storedStats.totalErrorsCount),
      keywordDuplicatesCount: toFiniteNumber(storedStats.keywordDuplicatesCount),
      totalDuplicates: toFiniteNumber(storedStats.totalDuplicates),
      commonDuplicatesCount: toFiniteNumber(storedStats.commonDuplicatesCount),
      uniqueWordsPercentage: toFiniteNumber(storedStats.uniqueWordsPercentage),
    },
  };
};

const normalizeUserActivity = (value: unknown): UserActivity => {
  const source = isRecord(value) ? value : {};
  const defaults = getDefaultUserActivity();
  const articles = isRecord(source.articles)
    ? Object.entries(source.articles).reduce<UserActivity['articles']>((normalized, [title, article]) => {
        if (isRecord(article)) {
          normalized[title] = normalizeArticleActivity(article);
        }
        return normalized;
      }, {})
    : {};

  return {
    ...defaults,
    articles,
    preferredHighlightStyle: source.preferredHighlightStyle === 'underline' ? 'underline' : 'background',
    preferredKeywordViewMode: source.preferredKeywordViewMode === 'modern' ? 'modern' : 'classic',
    preferredStructureViewMode: source.preferredStructureViewMode === 'list' ? 'list' : 'grid',
    preferredChatGptOpenMode: source.preferredChatGptOpenMode === 'tab' ? 'tab' : 'window',
    preferredTheme: source.preferredTheme === 'light' ? 'light' : 'dark',
    preferredLanguage: source.preferredLanguage === 'en' ? 'en' : 'ar',
    preferredUILanguage: source.preferredUILanguage === 'en' ? 'en' : 'ar',
    clientGoalContexts: isRecord(source.clientGoalContexts) ? source.clientGoalContexts as ClientGoalContexts : {},
    engineeringPrompts: isRecord(source.engineeringPrompts) ? source.engineeringPrompts as EngineeringPrompts : defaults.engineeringPrompts,
  };
};

const normalizeActivityData = (value: unknown): ActivityData => {
  if (!isRecord(value)) return {};

  return Object.entries(value).reduce<ActivityData>((normalized, [username, activity]) => {
    if (isRecord(activity)) {
      normalized[username] = normalizeUserActivity(activity);
    }
    return normalized;
  }, {});
};

export const getActivityData = (): ActivityData => {
  try {
    const data = localStorage.getItem(ACTIVITY_KEY);
    return data ? normalizeActivityData(JSON.parse(data)) : {};
  } catch (error) {
    console.error("Failed to read activity data from localStorage:", error);
    return {};
  }
};

const compactEditorContentFallbacks = (data: ActivityData): { data: ActivityData; changed: boolean } => {
  let changed = false;
  const compacted: ActivityData = {};

  Object.entries(data).forEach(([username, user]) => {
    compacted[username] = {
      ...user,
      articles: {},
    };

    Object.entries(user.articles).forEach(([title, article]) => {
      const content = article.content;
      if (
        isRecord(content) &&
        content.storage === 'indexeddb' &&
        Object.prototype.hasOwnProperty.call(content, 'fallbackContent')
      ) {
        const contentWithoutFallback = { ...content };
        delete contentWithoutFallback.fallbackContent;
        compacted[username].articles[title] = {
          ...article,
          content: contentWithoutFallback,
        };
        changed = true;
        return;
      }

      compacted[username].articles[title] = article;
    });
  });

  return { data: compacted, changed };
};

const saveActivityData = (data: ActivityData): boolean => {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
    return true;
  } catch (error) {
    const compacted = compactEditorContentFallbacks(data);
    if (compacted.changed) {
      try {
        localStorage.setItem(ACTIVITY_KEY, JSON.stringify(compacted.data));
        return true;
      } catch (compactError) {
        console.error("Failed to save compacted activity data to localStorage:", compactError);
      }
    } else {
      console.error("Failed to save activity data to localStorage:", error);
    }
  }

  return false;
};

const modifyUserData = (username: string, modification: (user: UserActivity) => void) => {
  // Single write path keeps localStorage updates consistent.
  const data = getActivityData();
  if (!data[username]) {
    data[username] = getDefaultUserActivity();
  }
  modification(data[username]);
  saveActivityData(data);
};

export const saveUserPreference = (username:string, preferences: Partial<Pick<UserActivity, 'preferredHighlightStyle' | 'preferredKeywordViewMode' | 'preferredStructureViewMode' | 'preferredChatGptOpenMode' | 'preferredTheme' | 'preferredLanguage' | 'preferredUILanguage'>>) => {
    modifyUserData(username, user => {
        Object.assign(user, preferences);
    });
};

export const saveUserClientGoalContexts = (username: string, clientGoalContexts: ClientGoalContexts) => {
  modifyUserData(username, user => {
    user.clientGoalContexts = clientGoalContexts;
  });
};

export const saveUserEngineeringPrompts = (username: string, engineeringPrompts: EngineeringPrompts) => {
  modifyUserData(username, user => {
    user.engineeringPrompts = engineeringPrompts;
  });
};
