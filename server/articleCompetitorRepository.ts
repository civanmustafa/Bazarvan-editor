import {
  normalizeContentWritingCompetitors,
  type ContentWritingCompetitorInput,
} from '../utils/contentWritingContext';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

export type ManagedArticleCompetitorRow = {
  id: string;
  position: number;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  content_text: string | null;
  status: string;
  source_origin?: string | null;
  source_class?: 'commercial' | 'government' | null;
  content_weight?: number | null;
};

export type ArticleCompetitorRepositorySnapshot = {
  source: 'managed_rows' | 'none';
  hasManagedRows: boolean;
  competitors: ContentWritingCompetitorInput[];
};

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeManagedRows = (
  rows: readonly ManagedArticleCompetitorRow[],
): ContentWritingCompetitorInput[] => normalizeContentWritingCompetitors(
  rows
    .filter(row => row.status === 'completed' && Boolean(text(row.content_text)))
    .map(row => ({
      id: row.id,
      position: row.position,
      title: row.title || '',
      url: row.canonical_url || row.source_url || '',
      content: row.content_text || '',
      sourceClass: 'commercial',
      contentWeight: 1,
    })),
);

/**
 * Resolves the canonical competitor source. article_competitors is the only
 * persisted repository; browser/article metadata copies are intentionally
 * ignored even when no managed row exists.
 */
export const resolveArticleCompetitorRepositorySnapshot = (options: {
  rows: readonly ManagedArticleCompetitorRow[];
}): ArticleCompetitorRepositorySnapshot => {
  if (options.rows.length > 0) {
    return {
      source: 'managed_rows',
      hasManagedRows: true,
      competitors: normalizeManagedRows(options.rows),
    };
  }

  return {
    source: 'none',
    hasManagedRows: false,
    competitors: [],
  };
};

export const readManagedArticleCompetitorRows = async (
  articleId: string,
): Promise<ManagedArticleCompetitorRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .select('id,position,source_url,canonical_url,title,content_text,status,source_origin,source_class,content_weight')
    .eq('article_id', articleId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data || []) as ManagedArticleCompetitorRow[];
};

export const readManagedArticleCompetitors = async (
  articleId: string,
): Promise<ArticleCompetitorRepositorySnapshot> => {
  const rows = await readManagedArticleCompetitorRows(articleId);
  return resolveArticleCompetitorRepositorySnapshot({ rows });
};
