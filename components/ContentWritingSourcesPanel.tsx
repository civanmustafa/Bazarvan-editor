import AppSelect from './AppSelect';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import {
  createContentWritingSource,
  deleteContentWritingSource,
  listContentWritingSources,
  refreshContentWritingSource,
  updateContentWritingSource,
  type ContentWritingSource,
  type ContentWritingSourceRole,
  type ContentWritingSourceType,
} from '../utils/contentWritingSources';

type Props = {
  articleId: string;
  isArabic: boolean;
  disabled?: boolean;
  onReadinessChange?: (ready: boolean, blockingCount: number) => void;
};

const ContentWritingSourcesPanel: React.FC<Props> = ({
  articleId,
  isArabic,
  disabled = false,
  onReadinessChange,
}) => {
  const [sources, setSources] = useState<ContentWritingSource[]>([]);
  const [sourceType, setSourceType] = useState<ContentWritingSourceType>('url');
  const [sourceRole, setSourceRole] = useState<ContentWritingSourceRole>('primary');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [focusInstructions, setFocusInstructions] = useState('');
  const [busyId, setBusyId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setSources(await listContentWritingSources(articleId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : (isArabic ? 'تعذر تحميل المصادر.' : 'Could not load sources.'));
    } finally {
      setIsLoading(false);
    }
  }, [articleId, isArabic]);

  useEffect(() => {
    setSources([]);
    setSourceType('url');
    setSourceRole('primary');
    setTitle('');
    setUrl('');
    setRawText('');
    setFocusInstructions('');
    void load();
  }, [load]);

  const blockingCount = useMemo(() => sources.filter(source => (
    source.enabled && source.sourceRole === 'primary' && source.status !== 'ready'
  )).length, [sources]);

  useEffect(() => {
    onReadinessChange?.(!isLoading && !error && blockingCount === 0, blockingCount);
  }, [blockingCount, error, isLoading, onReadinessChange]);

  const merge = (incoming: ContentWritingSource) => {
    setSources(current => current.map(source => source.id === incoming.id ? incoming : source));
  };

  const handleCreate = async () => {
    if (disabled || busyId || (sourceType === 'url' ? !url.trim() : rawText.trim().split(/\s+/).length < 5)) return;
    setBusyId('create');
    setError('');
    try {
      const source = await createContentWritingSource({
        articleId,
        sourceType,
        sourceRole,
        title,
        url,
        rawText,
        focusInstructions,
      });
      setSources(current => [...current, source]);
      setTitle('');
      setUrl('');
      setRawText('');
      setFocusInstructions('');
      setSourceRole('primary');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : (isArabic ? 'تعذر إضافة المصدر.' : 'Could not add source.'));
      await load();
    } finally {
      setBusyId('');
    }
  };

  const updateSource = async (
    source: ContentWritingSource,
    patch: Parameters<typeof updateContentWritingSource>[0],
  ) => {
    setBusyId(source.id);
    setError('');
    try {
      merge(await updateContentWritingSource({ articleId, sourceId: source.id, ...patch }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : (isArabic ? 'تعذر تحديث المصدر.' : 'Could not update source.'));
    } finally {
      setBusyId('');
    }
  };

  const statusLabel = (source: ContentWritingSource): string => {
    if (source.status === 'ready') return isArabic ? 'جاهز' : 'Ready';
    if (source.status === 'extracting') return isArabic ? 'جار الاستخراج' : 'Extracting';
    if (source.status === 'pending') return isArabic ? 'بانتظار التجهيز' : 'Pending';
    return isArabic ? 'تعذر الاستخراج' : 'Extraction failed';
  };

  const sourceInstructionsPlaceholder = isArabic
    ? 'اكتب تعليمات التركيز لهذا المصدر أو أي تعليمات أخرى تريد من الذكاء الاصطناعي مراعاتها (اختياري)'
    : 'Enter focus instructions for this source or any other instructions you want the AI to consider (optional)';

  return (
    <div className="rounded-lg border border-[#d4af37]/35 bg-[#d4af37]/5 p-2 dark:bg-[#d4af37]/[0.06]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-black text-gray-800 dark:text-gray-100">
            <FileText size={14} className="text-[#b8922e]" />
            <span>{isArabic ? 'مصادر الكتابة' : 'Writing sources'}</span>
          </div>
          <p className="mt-1 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'أضف رابطًا أو نصًا خامًا ليُفهرس مع مصادر المنافسين. المصدر الجديد أساسي افتراضيًا، ونص المحرر الحالي لا يدخل في الكتابة.'
              : 'Add a URL or raw text to index with competitor sources. New sources are primary by default; current editor text is excluded.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading || Boolean(busyId)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#d4af37]/30 text-[#8a6f1d] disabled:opacity-50"
          title={isArabic ? 'تحديث المصادر' : 'Refresh sources'}
        >
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-white/80 p-1 dark:bg-[#222]/80">
        {(['url', 'raw'] as const).map(type => (
          <button
            key={type}
            type="button"
            onClick={() => setSourceType(type)}
            className={`flex h-8 items-center justify-center gap-1 rounded text-[11px] font-bold ${sourceType === type
              ? 'bg-[#d4af37] text-white'
              : 'text-gray-500 hover:bg-[#d4af37]/10 dark:text-gray-300'}`}
          >
            {type === 'url' ? <Link2 size={13} /> : <FileText size={13} />}
            {type === 'url' ? (isArabic ? 'رابط' : 'URL') : (isArabic ? 'نص خام' : 'Raw text')}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-1.5">
        <input
          value={title}
          onChange={event => setTitle(event.target.value)}
          maxLength={500}
          placeholder={isArabic ? 'عنوان اختياري للمصدر' : 'Optional source title'}
          className="h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-[11px] outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
        />
        {sourceType === 'url' ? (
          <input
            value={url}
            onChange={event => setUrl(event.target.value)}
            dir="ltr"
            inputMode="url"
            placeholder="https://example.com/article"
            className="h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-[11px] outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
          />
        ) : (
          <textarea
            value={rawText}
            onChange={event => setRawText(event.target.value)}
            maxLength={120000}
            rows={5}
            placeholder={isArabic ? 'الصق النص الذي تريد التركيز عليه أثناء الكتابة...' : 'Paste the text to focus on while writing...'}
            className="w-full resize-y rounded-md border border-gray-200 bg-white p-2 text-[11px] leading-5 outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
          />
        )}
        <textarea
          value={focusInstructions}
          onChange={event => setFocusInstructions(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder={sourceInstructionsPlaceholder}
          className="w-full resize-y rounded-md border border-gray-200 bg-white p-2 text-[11px] leading-5 outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
        />
        <div className="flex items-center gap-1">
          <AppSelect
            size="compact"
            value={sourceRole}
            onChange={event => setSourceRole(event.target.value === 'supporting' ? 'supporting' : 'primary')}
            className="h-8 flex-1 rounded-md border border-gray-200 bg-white px-2 text-[11px] font-bold dark:border-[#444] dark:bg-[#1f1f1f]"
          >
            <option value="primary">{isArabic ? 'أساسي — افتراضي' : 'Primary — default'}</option>
            <option value="supporting">{isArabic ? 'مساند' : 'Supporting'}</option>
          </AppSelect>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={disabled || Boolean(busyId) || (sourceType === 'url' ? !url.trim() : rawText.trim().split(/\s+/).length < 5)}
            className="flex h-8 items-center justify-center gap-1 rounded-md bg-[#d4af37] px-3 text-[11px] font-black text-white disabled:opacity-50"
          >
            {busyId === 'create' ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {isArabic ? 'إضافة وتجهيز' : 'Add and prepare'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-red-50 p-2 text-[10px] font-bold text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        {isLoading && sources.length === 0 ? (
          <div className="flex items-center justify-center gap-1 py-3 text-[10px] text-gray-500"><Loader2 size={13} className="animate-spin" />{isArabic ? 'جار التحميل...' : 'Loading...'}</div>
        ) : sources.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-300 p-2 text-center text-[10px] font-semibold text-gray-500 dark:border-[#444]">
            {isArabic ? 'لا توجد مصادر مضافة. يمكنك الاعتماد على المنافسين فقط.' : 'No added sources. You can still use competitor sources only.'}
          </div>
        ) : sources.map(source => (
          <div key={source.id} className={`rounded-md border p-2 ${source.enabled ? 'border-gray-200 bg-white dark:border-[#444] dark:bg-[#242424]' : 'border-gray-200 bg-gray-50 opacity-65 dark:border-[#3a3a3a] dark:bg-[#202020]'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="truncate text-[11px] font-black text-gray-800 dark:text-gray-100">{source.title || source.sourceUrl || (isArabic ? 'نص خام' : 'Raw text')}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${source.status === 'ready' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : source.status === 'failed' ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                    {statusLabel(source)}
                  </span>
                  <span className="rounded bg-[#d4af37]/10 px-1.5 py-0.5 text-[9px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {source.sourceRole === 'primary' ? (isArabic ? 'أساسي' : 'Primary') : (isArabic ? 'مساند' : 'Supporting')}
                  </span>
                </div>
                {source.sourceUrl && <div className="mt-1 truncate text-[9px] text-gray-400" dir="ltr">{source.sourceUrl}</div>}
                <div className="mt-1 text-[9px] font-semibold text-gray-500 dark:text-gray-400">
                  {source.wordCount.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة' : 'words'} · {source.extractionMethod || '—'}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1 text-[9px] font-bold text-gray-500">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  disabled={disabled || busyId === source.id}
                  onChange={event => void updateSource(source, { articleId, sourceId: source.id, enabled: event.target.checked })}
                />
                {isArabic ? 'مفعّل' : 'Enabled'}
              </label>
            </div>

            {source.contentText && (
              <p className="mt-1.5 line-clamp-3 rounded bg-gray-50 p-1.5 text-[10px] leading-5 text-gray-600 dark:bg-[#1c1c1c] dark:text-gray-300">
                {source.contentText.slice(0, 450)}
              </p>
            )}
            {source.lastError && <p className="mt-1 text-[9px] font-semibold text-red-600 dark:text-red-300">{source.lastError}</p>}

            <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-1">
              <AppSelect
                size="compact"
                value={source.sourceRole}
                disabled={disabled || busyId === source.id}
                onChange={event => void updateSource(source, {
                  articleId,
                  sourceId: source.id,
                  sourceRole: event.target.value === 'supporting' ? 'supporting' : 'primary',
                })}
                className="h-7 rounded border border-gray-200 bg-white px-1.5 text-[10px] font-bold dark:border-[#444] dark:bg-[#1f1f1f]"
              >
                <option value="primary">{isArabic ? 'مصدر أساسي' : 'Primary source'}</option>
                <option value="supporting">{isArabic ? 'مصدر مساند' : 'Supporting source'}</option>
              </AppSelect>
              <div className="flex gap-1">
                {source.sourceType === 'url' && (
                  <button
                    type="button"
                    disabled={disabled || busyId === source.id}
                    onClick={async () => {
                      setBusyId(source.id);
                      try { merge(await refreshContentWritingSource(articleId, source.id)); }
                      catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : 'Refresh failed.'); }
                      finally { setBusyId(''); }
                    }}
                    className="flex size-7 items-center justify-center rounded border border-gray-200 text-gray-500 dark:border-[#444]"
                    title={isArabic ? 'إعادة استخراج الرابط' : 'Re-extract URL'}
                  >
                    <RefreshCw size={12} className={busyId === source.id ? 'animate-spin' : ''} />
                  </button>
                )}
                <button
                  type="button"
                  disabled={disabled || busyId === source.id}
                  onClick={async () => {
                    setBusyId(source.id);
                    try {
                      await deleteContentWritingSource(articleId, source.id);
                      setSources(current => current.filter(item => item.id !== source.id));
                    } catch (deleteError) {
                      setError(deleteError instanceof Error ? deleteError.message : 'Delete failed.');
                    } finally { setBusyId(''); }
                  }}
                  className="flex size-7 items-center justify-center rounded border border-red-200 text-red-500 dark:border-red-900/50"
                  title={isArabic ? 'حذف المصدر' : 'Delete source'}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            <div className="mt-1.5 flex items-end gap-1">
              <textarea
                defaultValue={source.focusInstructions}
                id={`writing-source-focus-${source.id}`}
                rows={3}
                maxLength={2000}
                disabled={disabled || busyId === source.id}
                placeholder={sourceInstructionsPlaceholder}
                className="min-w-0 flex-1 resize-y rounded border border-gray-200 bg-white p-1.5 text-[10px] leading-4 dark:border-[#444] dark:bg-[#1f1f1f]"
              />
              <button
                type="button"
                disabled={disabled || busyId === source.id}
                onClick={() => {
                  const input = document.getElementById(`writing-source-focus-${source.id}`) as HTMLTextAreaElement | null;
                  void updateSource(source, { articleId, sourceId: source.id, focusInstructions: input?.value || '' });
                }}
                className="flex size-7 items-center justify-center rounded border border-[#d4af37]/40 text-[#8a6f1d]"
                title={isArabic ? 'حفظ تعليمات المصدر' : 'Save source instructions'}
              >
                {busyId === source.id ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {blockingCount > 0 ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-[10px] font-bold text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{isArabic ? `تتوقف الكتابة حتى تجهيز أو تعطيل ${blockingCount} من المصادر الأساسية.` : `Writing waits until ${blockingCount} primary source(s) are ready or disabled.`}</span>
        </div>
      ) : sources.some(source => source.enabled && source.status === 'ready') ? (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={13} />
          {isArabic ? 'سيتم تثبيت هذه المصادر داخل الجلسة القادمة.' : 'These sources will be frozen into the next session.'}
        </div>
      ) : null}
    </div>
  );
};

export default ContentWritingSourcesPanel;
