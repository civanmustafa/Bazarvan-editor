export const MAX_ARTICLE_COMPETITORS = 5;
export const COMPETITOR_SEARCH_RESULT_LIMIT = 15;
export const COMPETITOR_SEARCH_CANDIDATE_LIMIT = 20;
export const COMPETITOR_CONTENT_MAX_CHARS = 120_000;
export const COMPETITOR_EXTRACTION_MAX_ATTEMPTS = 3;

export const UNSUPPORTED_COMPETITOR_FILE_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'odt',
  'rtf',
  'txt',
  'tex',
  'xls',
  'xlsx',
  'xlsm',
  'ods',
  'csv',
  'tsv',
  'ppt',
  'pptx',
  'odp',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'epub',
  'mobi',
  'azw',
  'azw3',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'aac',
  'flac',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'mpeg',
  'mpg',
  'wmv',
  'json',
  'xml',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'apk',
  'ipa',
  'iso',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'otf',
] as const;

export type CompetitorSearchMode = 'title' | 'primary_keyword';

export const createEmptyCompetitorSlots = (): string[] => (
  Array.from({ length: MAX_ARTICLE_COMPETITORS }, () => '')
);

export const normalizeCompetitorSlots = (value: unknown): string[] => {
  const source = Array.isArray(value) ? value : [];
  return createEmptyCompetitorSlots().map((_, index) => (
    typeof source[index] === 'string' ? source[index].trim() : ''
  ));
};
