export const COMPETITOR_DUAL_EXTRACTION_FAILURE_CODE =
  'firecrawl_and_programmatic_extraction_failed';

export const COMPETITOR_DUAL_EXTRACTION_FAILURE_PREFIX =
  '[تعذر استخراج محتوى المنافس]';

export const COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT =
  `${COMPETITOR_DUAL_EXTRACTION_FAILURE_PREFIX} فشل سحب المحتوى عبر Firecrawl والاستخراج البرمجي. افتح الرابط والصق نص المقالة يدويًا بدل هذه الرسالة لاعتماده في التحليل والكتابة.`;

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const isCompetitorExtractionFailureText = (value: unknown): boolean => (
  toText(value).startsWith(COMPETITOR_DUAL_EXTRACTION_FAILURE_PREFIX)
);

export const getUsableCompetitorText = (value: unknown): string => (
  isCompetitorExtractionFailureText(value) ? '' : toText(value)
);

export type CompetitorCanonicalSource = 'managed_rows' | 'manual_metadata' | 'none';

/**
 * Central provenance rule shared by repositories and tested without database
 * access. Unmarked metadata is a legacy manual input; metadata marked as a
 * competitor-discovery projection must never become authoritative on its own.
 */
export const resolveCompetitorCanonicalSource = (options: {
  managedRowCount: number;
  metadataManagedBy: unknown;
  metadataTextCount: number;
}): CompetitorCanonicalSource => {
  if (Math.max(0, Math.round(Number(options.managedRowCount) || 0)) > 0) {
    return 'managed_rows';
  }
  if (toText(options.metadataManagedBy).toLocaleLowerCase() === 'competitor_discovery') {
    return 'none';
  }
  return Math.max(0, Math.round(Number(options.metadataTextCount) || 0)) > 0
    ? 'manual_metadata'
    : 'none';
};

export const sanitizeCompetitorSlots = (
  texts: readonly unknown[],
  urls: readonly unknown[],
): { texts: string[]; urls: string[] } => {
  const slotCount = Math.max(texts.length, urls.length);
  const sanitizedTexts: string[] = [];
  const sanitizedUrls: string[] = [];

  for (let index = 0; index < slotCount; index += 1) {
    const failed = isCompetitorExtractionFailureText(texts[index]);
    sanitizedTexts[index] = failed ? '' : getUsableCompetitorText(texts[index]);
    sanitizedUrls[index] = failed ? '' : toText(urls[index]);
  }

  return {
    texts: sanitizedTexts,
    urls: sanitizedUrls,
  };
};
