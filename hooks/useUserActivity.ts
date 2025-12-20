
import type { FullAnalysis, Keywords } from '../types';

const ACTIVITY_KEY = 'smartEditorUserActivity';

export type ArticleActivity = {
  timeSpentSeconds: number;
  saveCount: number;
  lastSaved: string;
  content: any;
  keywords: Keywords;
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
  logins: string[];
  apiKeys: {
    gemini: string;
    perplexity: string[];
  };
  articles: {
    [title: string]: ArticleActivity;
  };
  preferredHighlightStyle?: 'background' | 'underline';
  preferredKeywordViewMode?: 'classic' | 'modern';
  preferredStructureViewMode?: 'grid' | 'list';
  preferredTheme?: 'dark' | 'light';
  preferredLanguage?: 'ar' | 'en';
  preferredUILanguage?: 'ar' | 'en';
};

type ActivityData = {
  [username: string]: UserActivity;
};

const getDefaultUserActivity = (): UserActivity => ({
  logins: [],
  apiKeys: {
    gemini: '',
    perplexity: [''],
  },
  articles: {},
  preferredHighlightStyle: 'background',
  preferredKeywordViewMode: 'classic',
  preferredStructureViewMode: 'grid',
  preferredTheme: 'dark',
  preferredLanguage: 'ar',
  preferredUILanguage: 'ar',
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

export const getActivityData = (): ActivityData => {
  try {
    const data = localStorage.getItem(ACTIVITY_KEY);
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error("Failed to read activity data from localStorage:", error);
    return {};
  }
};

const saveActivityData = (data: ActivityData) => {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("Failed to save activity data to localStorage:", error);
  }
};

const modifyUserData = (username: string, modification: (user: UserActivity) => void) => {
  const data = getActivityData();
  if (!data[username]) {
    data[username] = getDefaultUserActivity();
  }
  modification(data[username]);
  saveActivityData(data);
};

export const recordLogin = (username: string) => {
  modifyUserData(username, user => {
    user.logins.push(new Date().toISOString());
  });
};

const findOrCreateArticle = (user: UserActivity, currentTitle: string): ArticleActivity => {
    const currentKey = currentTitle.trim() || "(بدون عنوان)";
    const untitledKey = "(بدون عنوان)";

    if (currentKey !== untitledKey && user.articles[untitledKey]) {
        const untitledData = user.articles[untitledKey];
        const existingDataForNewTitle = user.articles[currentKey];
        
        if (existingDataForNewTitle) {
            existingDataForNewTitle.timeSpentSeconds += untitledData.timeSpentSeconds;
            existingDataForNewTitle.saveCount += untitledData.saveCount;
            const oldDate = new Date(untitledData.lastSaved || 0).getTime();
            const newDate = new Date(existingDataForNewTitle.lastSaved || 0).getTime();
            if (oldDate > newDate) {
                existingDataForNewTitle.lastSaved = untitledData.lastSaved;
                existingDataForNewTitle.content = untitledData.content;
                existingDataForNewTitle.keywords = untitledData.keywords;
            }
        } else {
            user.articles[currentKey] = untitledData;
        }

        delete user.articles[untitledKey];
    }
    
    if (!user.articles[currentKey]) {
        user.articles[currentKey] = getDefaultArticleActivity();
    }
    
    return user.articles[currentKey];
};


export const recordTimeSpentOnArticle = (username: string, title: string, seconds: number) => {
  modifyUserData(username, user => {
    const article = findOrCreateArticle(user, title);
    article.timeSpentSeconds += seconds;
  });
};

export const recordArticleSave = (username: string, title: string, content: any, keywords: Keywords, analysis: FullAnalysis, articleLanguage: 'ar' | 'en') => {
  modifyUserData(username, user => {
    const article = findOrCreateArticle(user, title);
    article.saveCount += 1;
    article.lastSaved = new Date().toISOString();
    article.content = content;
    article.keywords = keywords;
    article.articleLanguage = articleLanguage;

    const kwAnalysis = analysis.keywordAnalysis;
    let keywordViolations = 0;
    if (kwAnalysis.primary.status === 'fail') keywordViolations++;
    keywordViolations += kwAnalysis.primary.checks.filter(c => !c.isMet).length;

    if (kwAnalysis.secondariesDistribution.status === 'fail') keywordViolations++;
    kwAnalysis.secondaries.forEach(sec => {
        if (sec.status === 'fail') keywordViolations++;
        keywordViolations += sec.checks.filter(c => !c.isMet).length;
    });

    if (kwAnalysis.company.status === 'fail') keywordViolations++;

    const uniqueWordsPercentage = analysis.duplicateStats.totalWords > 0
        ? (analysis.duplicateStats.uniqueWords / analysis.duplicateStats.totalWords) * 100
        : 0;

    article.stats = {
        wordCount: analysis.wordCount,
        keywordViolations: keywordViolations,
        violatingCriteriaCount: analysis.structureStats.violatingCriteriaCount,
        totalErrorsCount: analysis.structureStats.totalErrorsCount,
        keywordDuplicatesCount: analysis.duplicateStats.keywordDuplicatesCount,
        totalDuplicates: analysis.duplicateStats.totalDuplicates,
        commonDuplicatesCount: analysis.duplicateStats.commonDuplicatesCount,
        uniqueWordsPercentage: uniqueWordsPercentage,
    };
  });
};

export const renameArticleActivity = (username: string, oldTitle: string, newTitle: string): boolean => {
    const data = getActivityData();
    const oldKey = oldTitle.trim() || "(بدون عنوان)";
    const newKey = newTitle.trim();

    if (!newKey || newKey === oldKey) {
        return false;
    }

    const user = data[username];
    if (!user || !user.articles[oldKey]) {
        return false;
    }

    if (user.articles[newKey]) {
        console.warn(`Cannot rename to "${newKey}" because it already exists.`);
        return false;
    }

    user.articles[newKey] = user.articles[oldKey];
    delete user.articles[oldKey];

    saveActivityData(data);
    return true;
};

export const deleteArticleActivity = (username: string, articleTitleToDelete: string) => {
    const data = getActivityData();
    const keyToDelete = articleTitleToDelete.trim() || "(بدون عنوان)";
    if (data[username] && data[username].articles[keyToDelete]) {
        delete data[username].articles[keyToDelete];
        saveActivityData(data);
    }
};

export const saveUserPreference = (username:string, preferences: Partial<Pick<UserActivity, 'preferredHighlightStyle' | 'preferredKeywordViewMode' | 'preferredStructureViewMode' | 'preferredTheme' | 'preferredLanguage' | 'preferredUILanguage'>>) => {
    modifyUserData(username, user => {
        Object.assign(user, preferences);
    });
};

export const saveUserApiKeys = (username: string, apiKeys: UserActivity['apiKeys']) => {
  modifyUserData(username, user => {
    user.apiKeys = apiKeys;
  });
};

export const clearUserActivity = (username: string) => {
  modifyUserData(username, user => {
    user.articles = {};
  });
  // Also clear any lingering draft data from localStorage
  try {
    localStorage.removeItem('editor-draft-content');
    localStorage.removeItem('editor-draft-title');
    localStorage.removeItem('editor-draft-keywords');
    localStorage.removeItem('editor-manual-draft-content');
    localStorage.removeItem('editor-manual-draft-title');
    localStorage.removeItem('editor-manual-draft-keywords');
  } catch (error) {
    console.error("Failed to clear draft data from localStorage:", error);
  }
};
