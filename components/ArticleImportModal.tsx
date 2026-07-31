import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileInput, Link2, Loader2, X } from 'lucide-react';
import { useEditorSelector } from '../contexts/EditorContext';
import { useUser } from '../contexts/UserContext';
import {
  ArticleImportRequestError,
  fetchArticleImportPreview,
  type ArticleImportMode,
  type ArticleImportPreview,
} from '../utils/articleImport';

type ArticleImportModalProps = {
  onClose: () => void;
  initialUrl?: string;
  autoFetch?: boolean;
};

const errorMessage = (error: unknown, isArabic: boolean): string => {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (error instanceof ArticleImportRequestError) {
    if (error.code === 'unsafe_competitor_url') {
      return isArabic
        ? 'الرابط غير صالح أو يشير إلى عنوان محلي/خاص لا يمكن الوصول إليه.'
        : 'The URL is invalid or points to a local/private address.';
    }
    if (error.code.includes('timeout')) {
      return isArabic
        ? 'انتهت مهلة سحب الصفحة. جرّب الرابط مرة أخرى.'
        : 'The page import timed out. Try the URL again.';
    }
    if (error.code === 'article_import_content_not_found' || error.code === 'programmatic_content_not_found') {
      return isArabic
        ? 'لم يتم العثور على محتوى مقالة أو خبر واضح في هذه الصفحة.'
        : 'No clear article or news content was found on this page.';
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : isArabic
      ? 'تعذر سحب المقالة من الرابط.'
      : 'Could not import the article from this URL.';
};

const isValidPublicUrlShape = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

const ArticleImportModal: React.FC<ArticleImportModalProps> = ({ onClose, initialUrl = '', autoFetch = false }) => {
  const { uiLanguage } = useUser();
  const isArabic = uiLanguage === 'ar';
  const editor = useEditorSelector(context => context.editor);
  const applyImportedArticleContent = useEditorSelector(context => context.applyImportedArticleContent);
  const [url, setUrl] = useState(initialUrl);
  const [preview, setPreview] = useState<ArticleImportPreview | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [mode, setMode] = useState<ArticleImportMode>('new');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const isBusyRef = useRef(false);
  const autoFetchStartedRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    isBusyRef.current = isLoading || isApplying;
  }, [isApplying, isLoading]);

  useEffect(() => {
    urlInputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusyRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      abortControllerRef.current?.abort();
    };
  }, []);

  const sourceHost = useMemo(() => {
    if (!preview?.canonicalUrl) return '';
    try {
      return new URL(preview.canonicalUrl).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }, [preview]);

  const loadPreview = useCallback(async (normalizedUrl: string) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);
    setError('');
    setPreview(null);
    try {
      const nextPreview = await fetchArticleImportPreview(normalizedUrl, { signal: controller.signal });
      setPreview(nextPreview);
      setPreviewTitle(nextPreview.title);
    } catch (requestError) {
      const message = errorMessage(requestError, isArabic);
      if (message) setError(message);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsLoading(false);
      }
    }
  }, [isArabic]);

  useEffect(() => {
    if (!autoFetch || autoFetchStartedRef.current) return;
    autoFetchStartedRef.current = true;
    const normalizedUrl = initialUrl.trim();
    if (!isValidPublicUrlShape(normalizedUrl)) {
      setError(isArabic ? 'أدخل رابطًا كاملًا يبدأ بـ http أو https.' : 'Enter a complete http or https URL.');
      return;
    }
    void loadPreview(normalizedUrl);
  }, [autoFetch, initialUrl, isArabic, loadPreview]);

  const handlePreview = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedUrl = url.trim();
    if (!isValidPublicUrlShape(normalizedUrl)) {
      setError(isArabic ? 'أدخل رابطًا كاملًا يبدأ بـ http أو https.' : 'Enter a complete http or https URL.');
      return;
    }
    await loadPreview(normalizedUrl);
  };

  const handleApply = async () => {
    if (!preview || isApplying) return;
    if (mode !== 'insert' && !previewTitle.trim()) {
      setError(isArabic ? 'عنوان المقالة مطلوب قبل الاستيراد.' : 'Article title is required before import.');
      return;
    }
    if (
      mode === 'replace'
      && editor?.getText().trim()
      && !window.confirm(
        isArabic
          ? 'سيُحفظ المحتوى الحالي كنسخة ثم يُستبدل بالمقالة المستوردة. هل تريد المتابعة؟'
          : 'The current content will be saved as a version and then replaced. Continue?',
      )
    ) {
      return;
    }

    setIsApplying(true);
    setError('');
    try {
      const result = await applyImportedArticleContent({
        ...preview,
        title: previewTitle.trim() || preview.title,
      }, mode);
      if (!result.ok) {
        setError(result.error || (isArabic ? 'تعذر إدخال المقالة في المحرر.' : 'Could not apply the article to the editor.'));
        return;
      }
      onClose();
    } catch (applyError) {
      setError(errorMessage(applyError, isArabic));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isLoading && !isApplying) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="article-import-title"
        dir={isArabic ? 'rtl' : 'ltr'}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-[#3C3C3C] dark:bg-[#1F1F1F]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 dark:border-[#3C3C3C]">
          <div>
            <h2 id="article-import-title" className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-gray-100">
              <FileInput size={21} className="text-[#b28b22]" />
              {isArabic ? 'استيراد مقالة من رابط' : 'Import article from URL'}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {isArabic
                ? 'نحافظ على بنية النص والروابط والجداول، ونتجاهل الصور وتصميم الموقع.'
                : 'Text structure, links, and tables are kept. Images and site styling are skipped.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading || isApplying}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 dark:hover:bg-white/5 dark:hover:text-white"
            aria-label={isArabic ? 'إغلاق' : 'Close'}
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <form onSubmit={handlePreview} className="border-b border-gray-200 p-5 dark:border-[#3C3C3C]">
            <label htmlFor="article-import-url" className="mb-2 block text-sm font-bold text-gray-700 dark:text-gray-200">
              {isArabic ? 'رابط المقالة أو الخبر' : 'Article or news URL'}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2
                  size={17}
                  className={`absolute top-1/2 -translate-y-1/2 text-gray-400 ${isArabic ? 'right-3' : 'left-3'}`}
                />
                <input
                  ref={urlInputRef}
                  id="article-import-url"
                  type="url"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError('');
                    setPreview(null);
                    setPreviewTitle('');
                  }}
                  placeholder="https://example.com/article"
                  disabled={isLoading || isApplying}
                  className={`h-11 w-full rounded-xl border border-gray-300 bg-white text-sm text-gray-900 outline-none transition focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 disabled:opacity-60 dark:border-[#444] dark:bg-[#161616] dark:text-gray-100 ${isArabic ? 'pr-10 pl-3' : 'pl-10 pr-3'}`}
                />
              </div>
              <button
                type="submit"
                disabled={isLoading || isApplying || !url.trim()}
                className="inline-flex h-11 min-w-36 items-center justify-center gap-2 rounded-xl bg-[#b28b22] px-5 text-sm font-black text-white transition hover:bg-[#94731c] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? <Loader2 size={17} className="animate-spin" /> : <FileInput size={17} />}
                {isLoading
                  ? (isArabic ? 'جارٍ السحب…' : 'Importing…')
                  : (isArabic ? 'سحب ومعاينة' : 'Fetch preview')}
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:bg-red-950/30 dark:text-red-300">
                <AlertTriangle size={17} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}
          </form>

          {preview && (
            <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="min-w-0">
                <label htmlFor="article-import-preview-title" className="mb-2 block text-sm font-bold text-gray-700 dark:text-gray-200">
                  {isArabic ? 'عنوان المقالة' : 'Article title'}
                </label>
                <input
                  id="article-import-preview-title"
                  type="text"
                  value={previewTitle}
                  onChange={(event) => setPreviewTitle(event.target.value)}
                  disabled={mode === 'insert' || isApplying}
                  className="mb-4 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-base font-bold text-gray-900 outline-none focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 disabled:opacity-55 dark:border-[#444] dark:bg-[#161616] dark:text-gray-100"
                />

                <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-[#3C3C3C]">
                  <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-bold text-gray-500 dark:border-[#3C3C3C] dark:bg-[#181818] dark:text-gray-400">
                    <span>{isArabic ? 'معاينة المحتوى المنسق' : 'Formatted content preview'}</span>
                    {sourceHost && <span dir="ltr">{sourceHost}</span>}
                  </div>
                  <div
                    className="article-import-preview max-h-[42vh] overflow-auto bg-white p-5 text-sm leading-8 text-gray-800 dark:bg-[#202020] dark:text-gray-200 [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:border-s-4 [&_blockquote]:border-gray-300 [&_blockquote]:ps-4 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-black [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-black [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-bold [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:p-2 [&_th]:border [&_th]:border-gray-300 [&_th]:p-2 [&_ul]:list-disc [&_ul]:ps-6 dark:[&_a]:text-blue-400 dark:[&_td]:border-gray-600 dark:[&_th]:border-gray-600"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a')) event.preventDefault();
                    }}
                    dangerouslySetInnerHTML={{ __html: preview.contentHtml }}
                  />
                </div>
              </div>

              <aside className="space-y-4">
                <div className="rounded-xl border border-gray-200 p-4 dark:border-[#3C3C3C]">
                  <h3 className="mb-3 text-sm font-black text-gray-800 dark:text-gray-100">
                    {isArabic ? 'نتيجة الاستخراج' : 'Extraction result'}
                  </h3>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <dt className="text-gray-500">{isArabic ? 'الكلمات' : 'Words'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.wordCount}</dd>
                    <dt className="text-gray-500">{isArabic ? 'العناوين' : 'Headings'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.counts.headings}</dd>
                    <dt className="text-gray-500">{isArabic ? 'الفقرات' : 'Paragraphs'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.counts.paragraphs}</dd>
                    <dt className="text-gray-500">{isArabic ? 'القوائم' : 'Lists'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.counts.lists}</dd>
                    <dt className="text-gray-500">{isArabic ? 'الروابط' : 'Links'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.counts.links}</dd>
                    <dt className="text-gray-500">{isArabic ? 'الجداول' : 'Tables'}</dt>
                    <dd className="font-black text-gray-800 dark:text-gray-100">{preview.counts.tables}</dd>
                  </dl>
                </div>

                {preview.skippedImageCount > 0 && (
                  <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    {isArabic
                      ? `تم تجاهل ${preview.skippedImageCount} صورة كما طلبت.`
                      : `${preview.skippedImageCount} image(s) were skipped as requested.`}
                  </p>
                )}

                <fieldset className="space-y-2 rounded-xl border border-gray-200 p-4 dark:border-[#3C3C3C]">
                  <legend className="px-1 text-sm font-black text-gray-800 dark:text-gray-100">
                    {isArabic ? 'طريقة الإدخال' : 'Import mode'}
                  </legend>
                  {([
                    ['new', isArabic ? 'مقالة جديدة' : 'New article'],
                    ['replace', isArabic ? 'استبدال الحالية' : 'Replace current'],
                    ['insert', isArabic ? 'إدراج عند المؤشر' : 'Insert at cursor'],
                  ] as Array<[ArticleImportMode, string]>).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/5">
                      <input
                        type="radio"
                        name="article-import-mode"
                        value={value}
                        checked={mode === value}
                        onChange={() => setMode(value)}
                        disabled={isApplying}
                        className="accent-[#b28b22]"
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </aside>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4 dark:border-[#3C3C3C] dark:bg-[#181818]">
          <p className="hidden text-xs text-gray-500 sm:block dark:text-gray-400">
            {isArabic ? 'يمكنك تعديل العنوان والمحتوى بعد الاستيراد.' : 'You can edit the title and content after import.'}
          </p>
          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isApplying || isLoading}
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-white disabled:opacity-50 dark:border-[#444] dark:text-gray-200 dark:hover:bg-white/5"
            >
              {isArabic ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={() => { void handleApply(); }}
              disabled={!preview || isApplying || isLoading}
              className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-[#b28b22] px-4 py-2 text-sm font-black text-white hover:bg-[#94731c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApplying ? <Loader2 size={17} className="animate-spin" /> : <FileInput size={17} />}
              {isApplying
                ? (isArabic ? 'جارٍ الإدخال…' : 'Applying…')
                : (isArabic ? 'استيراد' : 'Import')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
};

export default ArticleImportModal;
