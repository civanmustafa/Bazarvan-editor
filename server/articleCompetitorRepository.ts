import {
  getContentWritingCompetitorsFromMetadata,
  normalizeContentWritingCompetitors,
  type ContentWritingCompetitorInput,
} from '../utils/contentWritingContext';
import { resolveCompetitorCanonicalSource } from '../utils/competitorContent';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

export type ManagedArticleCompetitorRow = {
  id: string;
  position: number;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  content_text: string | null;
  status: string;
};

export type ArticleCompetitorRepositorySnapshot = {
  source: 'managed_rows' | 'manual_metadata' | 'none';
  hasManagedRows: boolean;
  competitors: ContentWritingCompetitorInput[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const metadataCompetitorEnvelope = (metadata: unknown): Record<string, unknown> => {
  const root = isRecord(metadata) ? metadata : {};
  const attachments = isRecord(root.attachments) ? root.attachments : {};
  return isRecord(attachments.competitors)
    ? attachments.competitors
    : isRecord(root.competitors)
      ? root.competitors
      : {};
};

/**
 * Metadata without a provenance marker predates managed competitor rows and is
 * therefore treated as a legacy manual input. A competitor_discovery projection
 * must never be resurrected after its managed rows have been removed.
 */
export const isManualCompetitorMetadata = (metadata: unknown): boolean => {
  const envelope = metadataCompetitorEnvelope(metadata);
  const manager = text(envelope.managedBy).toLocaleLowerCase();
  return manager !== 'competitor_discovery';
};

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
    })),
);

/**
 * Resolves one canonical competitor source. The presence of any managed row is
 * authoritative, including queued/failed rows, so stale metadata cannot fill a
 * managed slot or silently mix two generations of competitor content. Metadata
 * is retained only as a lossless compatibility source for manual/legacy inputs
 * when no managed rows exist.
 */
export const resolveArticleCompetitorRepositorySnapshot = (options: {
  rows: readonly ManagedArticleCompetitorRow[];
  metadata: unknown;
}): ArticleCompetitorRepositorySnapshot => {
  const metadataCompetitors = isManualCompetitorMetadata(options.metadata)
    ? getContentWritingCompetitorsFromMetadata(options.metadata)
    : [];
  const source = resolveCompetitorCanonicalSource({
    managedRowCount: options.rows.length,
    metadataManagedBy: metadataCompetitorEnvelope(options.metadata).managedBy,
    metadataTextCount: metadataCompetitors.length,
  });
  if (source === 'managed_rows') {
    return {
      source: 'managed_rows',
      hasManagedRows: true,
      competitors: normalizeManagedRows(options.rows),
    };
  }

  return {
    source,
    hasManagedRows: false,
    competitors: source === 'manual_metadata' ? metadataCompetitors : [],
  };
};

export const readManagedArticleCompetitorRows = async (
  articleId: string,
): Promise<ManagedArticleCompetitorRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .select('id,position,source_url,canonical_url,title,content_text,status')
    .eq('article_id', articleId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data || []) as ManagedArticleCompetitorRow[];
};

export const readManagedArticleCompetitors = async (
  articleId: string,
): Promise<ArticleCompetitorRepositorySnapshot> => {
  const rows = await readManagedArticleCompetitorRows(articleId);
  return resolveArticleCompetitorRepositorySnapshot({ rows, metadata: {} });
};
