import {
  USER_GUIDE_CATEGORIES,
  type UserGuideArticle,
  type UserGuideCategory,
} from '../constants/userGuide.ts';

export type UserGuideSearchResult = {
  category: UserGuideCategory;
  article: UserGuideArticle;
  score: number;
  snippet: string;
};

export const normalizeUserGuideSearchText = (value: unknown): string => String(value || '')
  .toLocaleLowerCase()
  .normalize('NFKD')
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي')
  .replace(/ؤ/gu, 'و')
  .replace(/ئ/gu, 'ي')
  .replace(/ة/gu, 'ه')
  .replace(/ـ/gu, '')
  .replace(/[^\p{L}\p{N}%+]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const articleSectionText = (article: UserGuideArticle): string => article.sections
  .flatMap(section => [
    section.title,
    ...(section.paragraphs || []),
    ...(section.bullets || []),
    section.note || '',
    section.warning || '',
    ...(section.table?.headers || []),
    ...(section.table?.rows.flat() || []),
  ])
  .filter(Boolean)
  .join(' ');

const countTermMatches = (haystack: string, terms: string[]): number => terms.reduce(
  (count, term) => count + (haystack.includes(term) ? 1 : 0),
  0,
);

const buildSnippet = (article: UserGuideArticle, normalizedQuery: string): string => {
  const candidates = [
    article.summary,
    ...article.sections.flatMap(section => [
      ...(section.paragraphs || []),
      ...(section.bullets || []),
      section.note || '',
      section.warning || '',
    ]),
  ].filter(Boolean);
  return candidates.find(value => normalizeUserGuideSearchText(value).includes(normalizedQuery))
    || candidates.find(value => normalizedQuery.split(' ').some(term => (
      term.length >= 2 && normalizeUserGuideSearchText(value).includes(term)
    )))
    || article.summary;
};

export const searchUserGuide = (
  query: string,
  categories: readonly UserGuideCategory[] = USER_GUIDE_CATEGORIES,
): UserGuideSearchResult[] => {
  const normalizedQuery = normalizeUserGuideSearchText(query);
  if (!normalizedQuery) return [];
  const terms = Array.from(new Set(normalizedQuery.split(' ').filter(term => term.length >= 2)));
  if (terms.length === 0) return [];

  return categories.flatMap(category => category.articles.map(article => {
    const categoryText = normalizeUserGuideSearchText(`${category.title} ${category.shortTitle} ${category.description}`);
    const title = normalizeUserGuideSearchText(article.title);
    const summary = normalizeUserGuideSearchText(article.summary);
    const keywords = normalizeUserGuideSearchText(article.keywords.join(' '));
    const sections = normalizeUserGuideSearchText(articleSectionText(article));
    const exactScore = title.includes(normalizedQuery)
      ? 36
      : keywords.includes(normalizedQuery)
        ? 24
        : summary.includes(normalizedQuery)
          ? 16
          : sections.includes(normalizedQuery)
            ? 10
            : 0;
    const score = exactScore
      + countTermMatches(title, terms) * 10
      + countTermMatches(keywords, terms) * 7
      + countTermMatches(summary, terms) * 5
      + countTermMatches(sections, terms) * 2
      + countTermMatches(categoryText, terms);
    return {
      category,
      article,
      score,
      snippet: buildSnippet(article, normalizedQuery),
    };
  }))
    .filter(result => result.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.category.title.localeCompare(right.category.title, 'ar')
      || left.article.title.localeCompare(right.article.title, 'ar')
    ));
};
