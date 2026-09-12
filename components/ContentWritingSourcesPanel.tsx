import AppSelect from './AppSelect';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  clearContentWritingSourceDraft,
  createContentWritingSource,
  deleteContentWritingSource,
  readContentWritingSourcesState,
  refreshContentWritingSource,
  saveContentWritingSourceDraft,
  updateContentWritingSource,
  type ContentWritingSource,
  type ContentWritingSourceDraft,
  type ContentWritingSourceRole,
  type ContentWritingSourceType,
} from '../utils/contentWritingSources';
import { registerArticleSupplementalSaveHandler } from '../utils/articleSupplementalSave';

type InstructionSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
type EditableSourceDraft = Omit<ContentWritingSourceDraft, 'articleId' | 'updatedAt'>;

const INSTRUCTION_AUTOSAVE_DELAY_MS = 700;
const NEW_SOURCE_DRAFT_AUTOSAVE_DELAY_MS = 700;

const emptyEditableSourceDraft = (): EditableSourceDraft => ({
  sourceType: 'url',
  sourceRole: 'primary',
  title: '',
  url: '',
  rawText: '',
  focusInstructions: '',
});

const normalizeEditableSourceDraft = (draft: EditableSourceDraft): EditableSourceDraft => ({
  sourceType: draft.sourceType === 'raw' ? 'raw' : 'url',
  sourceRole: draft.sourceRole === 'supporting' ? 'supporting' : 'primary',
  title: draft.title.trim().slice(0, 500),
  url: draft.url.trim().slice(0, 2_048),
  rawText: draft.rawText.trim().slice(0, 120_000),
  focusInstructions: draft.focusInstructions.trim().slice(0, 2_000),
});

const sameEditableSourceDraft = (left: EditableSourceDraft, right: EditableSourceDraft): boolean => (
  left.sourceType === right.sourceType
  && left.sourceRole === right.sourceRole
  && left.title === right.title
  && left.url === right.url
  && left.rawText === right.rawText
  && left.focusInstructions === right.focusInstructions
);

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
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({});
  const [instructionSaveStatuses, setInstructionSaveStatuses] = useState<Record<string, InstructionSaveStatus>>({});
  const [newSourceDraftSaveStatus, setNewSourceDraftSaveStatus] = useState<InstructionSaveStatus>('idle');
  const instructionDraftsRef = useRef<Record<string, string>>({});
  const savedInstructionsRef = useRef<Record<string, string>>({});
  const instructionSaveTimersRef = useRef<Map<string, number>>(new Map());
  const instructionSavePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const newSourceDraftRef = useRef<EditableSourceDraft>(emptyEditableSourceDraft());
  const savedNewSourceDraftRef = useRef<EditableSourceDraft>(emptyEditableSourceDraft());
  const newSourceDraftSaveTimerRef = useRef<number | null>(null);
  const newSourceDraftSavePromiseRef = useRef<Promise<void> | null>(null);

  const applyNewSourceDraftState = useCallback((draft: EditableSourceDraft) => {
    newSourceDraftRef.current = draft;
    setSourceType(draft.sourceType);
    setSourceRole(draft.sourceRole);
    setTitle(draft.title);
    setUrl(draft.url);
    setRawText(draft.rawText);
    setFocusInstructions(draft.focusInstructions);
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const loaded = await readContentWritingSourcesState(articleId);
      const loadedSources = loaded.sources;
      const serverDraft: EditableSourceDraft = {
        sourceType: loaded.draft.sourceType,
        sourceRole: loaded.draft.sourceRole,
        title: loaded.draft.title,
        url: loaded.draft.url,
        rawText: loaded.draft.rawText,
        focusInstructions: loaded.draft.focusInstructions,
      };
      const currentNewSourceDraft = newSourceDraftRef.current;
      const newSourceDraftWasDirty = !sameEditableSourceDraft(
        normalizeEditableSourceDraft(currentNewSourceDraft),
        savedNewSourceDraftRef.current,
      );
      savedNewSourceDraftRef.current = serverDraft;
      if (!newSourceDraftWasDirty) applyNewSourceDraftState(serverDraft);
      setNewSourceDraftSaveStatus(newSourceDraftWasDirty ? 'dirty' : 'idle');
      const currentDrafts = instructionDraftsRef.current;
      const previousSaved = savedInstructionsRef.current;
      const nextDrafts: Record<string, string> = {};
      const nextSaved: Record<string, string> = {};
      const nextStatuses: Record<string, InstructionSaveStatus> = {};
      for (const source of loadedSources) {
        const currentDraft = currentDrafts[source.id];
        const wasDirty = currentDraft !== undefined && currentDraft !== previousSaved[source.id];
        nextDrafts[source.id] = wasDirty ? currentDraft : source.focusInstructions;
        nextSaved[source.id] = source.focusInstructions;
        nextStatuses[source.id] = wasDirty ? 'dirty' : 'idle';
      }
      instructionDraftsRef.current = nextDrafts;
      savedInstructionsRef.current = nextSaved;
      setInstructionDrafts(nextDrafts);
      setInstructionSaveStatuses(nextStatuses);
      setSources(loadedSources);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : (isArabic ? 'تعذر تحميل المصادر.' : 'Could not load sources.'));
    } finally {
      setIsLoading(false);
    }
  }, [applyNewSourceDraftState, articleId, isArabic]);

  useEffect(() => {
    setSources([]);
    const emptyDraft = emptyEditableSourceDraft();
    savedNewSourceDraftRef.current = emptyDraft;
    applyNewSourceDraftState(emptyDraft);
    setNewSourceDraftSaveStatus('idle');
    void load();
  }, [applyNewSourceDraftState, load]);

  const blockingCount = useMemo(() => sources.filter(source => (
    source.enabled && source.sourceRole === 'primary' && source.status !== 'ready'
  )).length, [sources]);

  useEffect(() => {
    onReadinessChange?.(!isLoading && !error && blockingCount === 0, blockingCount);
  }, [blockingCount, error, isLoading, onReadinessChange]);

  const merge = (incoming: ContentWritingSource) => {
    setSources(current => current.map(source => source.id === incoming.id ? incoming : source));
  };

  const flushNewSourceDraft = useCallback(async (): Promise<void> => {
    if (newSourceDraftSaveTimerRef.current !== null) {
      window.clearTimeout(newSourceDraftSaveTimerRef.current);
      newSourceDraftSaveTimerRef.current = null;
    }

    const activeSave = newSourceDraftSavePromiseRef.current;
    if (activeSave) {
      await activeSave;
      return;
    }

    const savePromise = (async () => {
      while (true) {
        const currentDraft = newSourceDraftRef.current;
        const draftToSave = normalizeEditableSourceDraft(currentDraft);
        if (sameEditableSourceDraft(draftToSave, savedNewSourceDraftRef.current)) {
          if (!sameEditableSourceDraft(currentDraft, draftToSave)) applyNewSourceDraftState(draftToSave);
          break;
        }

        setNewSourceDraftSaveStatus('saving');
        try {
          const savedDraft = await saveContentWritingSourceDraft({
            articleId,
            ...draftToSave,
          });
          const normalizedSavedDraft: EditableSourceDraft = {
            sourceType: savedDraft.sourceType,
            sourceRole: savedDraft.sourceRole,
            title: savedDraft.title,
            url: savedDraft.url,
            rawText: savedDraft.rawText,
            focusInstructions: savedDraft.focusInstructions,
          };
          savedNewSourceDraftRef.current = normalizedSavedDraft;
          if (sameEditableSourceDraft(newSourceDraftRef.current, currentDraft)) {
            applyNewSourceDraftState(normalizedSavedDraft);
          }
          setError('');
        } catch (saveError) {
          const message = saveError instanceof Error
            ? saveError.message
            : (isArabic ? 'تعذر حفظ مسودة المصدر.' : 'Could not save the source draft.');
          setNewSourceDraftSaveStatus('error');
          setError(message);
          throw saveError;
        }
      }
      setNewSourceDraftSaveStatus('saved');
    })().finally(() => {
      newSourceDraftSavePromiseRef.current = null;
    });

    newSourceDraftSavePromiseRef.current = savePromise;
    await savePromise;
  }, [applyNewSourceDraftState, articleId, isArabic]);

  const scheduleNewSourceDraftSave = useCallback(() => {
    if (newSourceDraftSaveTimerRef.current !== null) {
      window.clearTimeout(newSourceDraftSaveTimerRef.current);
    }
    newSourceDraftSaveTimerRef.current = window.setTimeout(() => {
      newSourceDraftSaveTimerRef.current = null;
      void flushNewSourceDraft().catch((): void => undefined);
    }, NEW_SOURCE_DRAFT_AUTOSAVE_DELAY_MS);
  }, [flushNewSourceDraft]);

  const updateNewSourceDraft = useCallback((patch: Partial<EditableSourceDraft>) => {
    const nextDraft = { ...newSourceDraftRef.current, ...patch };
    applyNewSourceDraftState(nextDraft);
    setNewSourceDraftSaveStatus('dirty');
    scheduleNewSourceDraftSave();
  }, [applyNewSourceDraftState, scheduleNewSourceDraftSave]);

  const flushSourceInstructions = useCallback(async (sourceId: string): Promise<void> => {
    const timer = instructionSaveTimersRef.current.get(sourceId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      instructionSaveTimersRef.current.delete(sourceId);
    }

    const activeSave = instructionSavePromisesRef.current.get(sourceId);
    if (activeSave) {
      await activeSave;
      return;
    }

    const savePromise = (async () => {
      while (true) {
        const currentDraft = instructionDraftsRef.current[sourceId] || '';
        const instructionsToSave = currentDraft.trim();
        const savedInstructions = savedInstructionsRef.current[sourceId] || '';
        if (instructionsToSave === savedInstructions) {
          if (currentDraft !== savedInstructions) {
            instructionDraftsRef.current = {
              ...instructionDraftsRef.current,
              [sourceId]: savedInstructions,
            };
            setInstructionDrafts(current => ({ ...current, [sourceId]: savedInstructions }));
          }
          break;
        }
        setInstructionSaveStatuses(current => ({ ...current, [sourceId]: 'saving' }));
        try {
          const updated = await updateContentWritingSource({
            articleId,
            sourceId,
            focusInstructions: instructionsToSave,
          });
          savedInstructionsRef.current = {
            ...savedInstructionsRef.current,
            [sourceId]: updated.focusInstructions,
          };
          if ((instructionDraftsRef.current[sourceId] || '') === currentDraft) {
            instructionDraftsRef.current = {
              ...instructionDraftsRef.current,
              [sourceId]: updated.focusInstructions,
            };
            setInstructionDrafts(current => ({ ...current, [sourceId]: updated.focusInstructions }));
          }
          setSources(current => current.map(source => source.id === updated.id ? updated : source));
          setError('');
        } catch (saveError) {
          const message = saveError instanceof Error
            ? saveError.message
            : (isArabic ? 'تعذر حفظ تعليمات المصدر.' : 'Could not save source instructions.');
          setInstructionSaveStatuses(current => ({ ...current, [sourceId]: 'error' }));
          setError(message);
          throw saveError;
        }
      }
      setInstructionSaveStatuses(current => ({ ...current, [sourceId]: 'saved' }));
    })().finally(() => {
      instructionSavePromisesRef.current.delete(sourceId);
    });

    instructionSavePromisesRef.current.set(sourceId, savePromise);
    await savePromise;
  }, [articleId, isArabic]);

  const flushAllSourceInstructions = useCallback(async (): Promise<void> => {
    const dirtySourceIds = Object.keys(instructionDraftsRef.current).filter(sourceId => (
      (instructionDraftsRef.current[sourceId] || '') !== (savedInstructionsRef.current[sourceId] || '')
      || instructionSavePromisesRef.current.has(sourceId)
    ));
    await Promise.all(dirtySourceIds.map(sourceId => flushSourceInstructions(sourceId)));
  }, [flushSourceInstructions]);

  const flushAllWritingSourceChanges = useCallback(async (): Promise<void> => {
    await Promise.all([
      flushNewSourceDraft(),
      flushAllSourceInstructions(),
    ]);
  }, [flushAllSourceInstructions, flushNewSourceDraft]);

  const scheduleSourceInstructionsSave = useCallback((sourceId: string) => {
    const currentTimer = instructionSaveTimersRef.current.get(sourceId);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    const timer = window.setTimeout(() => {
      instructionSaveTimersRef.current.delete(sourceId);
      void flushSourceInstructions(sourceId).catch((): void => undefined);
    }, INSTRUCTION_AUTOSAVE_DELAY_MS);
    instructionSaveTimersRef.current.set(sourceId, timer);
  }, [flushSourceInstructions]);

  useEffect(() => (
    registerArticleSupplementalSaveHandler(articleId, flushAllWritingSourceChanges)
  ), [articleId, flushAllWritingSourceChanges]);

  useEffect(() => () => {
    for (const timer of instructionSaveTimersRef.current.values()) window.clearTimeout(timer);
    instructionSaveTimersRef.current.clear();
    if (newSourceDraftSaveTimerRef.current !== null) {
      window.clearTimeout(newSourceDraftSaveTimerRef.current);
      newSourceDraftSaveTimerRef.current = null;
    }
    void flushAllWritingSourceChanges().catch((): void => undefined);
  }, [flushAllWritingSourceChanges]);

  const handleCreate = async () => {
    const pendingDraft = normalizeEditableSourceDraft(newSourceDraftRef.current);
    if (disabled || busyId || (pendingDraft.sourceType === 'url'
      ? !pendingDraft.url
      : pendingDraft.rawText.split(/\s+/).length < 5)) return;
    setBusyId('create');
    setError('');
    try {
      await flushNewSourceDraft();
      const draftToCreate = normalizeEditableSourceDraft(newSourceDraftRef.current);
      const source = await createContentWritingSource({
        articleId,
        ...draftToCreate,
      });
      setSources(current => [...current, source]);
      instructionDraftsRef.current = { ...instructionDraftsRef.current, [source.id]: source.focusInstructions };
      savedInstructionsRef.current = { ...savedInstructionsRef.current, [source.id]: source.focusInstructions };
      setInstructionDrafts(current => ({ ...current, [source.id]: source.focusInstructions }));
      setInstructionSaveStatuses(current => ({ ...current, [source.id]: 'saved' }));
      const emptyDraft = emptyEditableSourceDraft();
      savedNewSourceDraftRef.current = emptyDraft;
      applyNewSourceDraftState(emptyDraft);
      setNewSourceDraftSaveStatus('saved');
      try {
        await clearContentWritingSourceDraft(articleId);
      } catch {
        try {
          await saveContentWritingSourceDraft({ articleId, ...emptyDraft });
        } catch (clearError) {
          setNewSourceDraftSaveStatus('error');
          setError(clearError instanceof Error
            ? clearError.message
            : (isArabic ? 'تمت إضافة المصدر، لكن تعذر تنظيف مسودته.' : 'The source was added, but its draft could not be cleared.'));
        }
      }
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
            onClick={() => updateNewSourceDraft({ sourceType: type })}
            disabled={disabled || Boolean(busyId)}
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
          onChange={event => updateNewSourceDraft({ title: event.target.value })}
          onBlur={() => void flushNewSourceDraft().catch((): void => undefined)}
          disabled={disabled || Boolean(busyId)}
          maxLength={500}
          placeholder={isArabic ? 'عنوان اختياري للمصدر' : 'Optional source title'}
          className="h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-[11px] outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
        />
        {sourceType === 'url' ? (
          <input
            value={url}
            onChange={event => updateNewSourceDraft({ url: event.target.value })}
            onBlur={() => void flushNewSourceDraft().catch((): void => undefined)}
            disabled={disabled || Boolean(busyId)}
            dir="ltr"
            inputMode="url"
            placeholder="https://example.com/article"
            className="h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-[11px] outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
          />
        ) : (
          <textarea
            value={rawText}
            onChange={event => updateNewSourceDraft({ rawText: event.target.value })}
            onBlur={() => void flushNewSourceDraft().catch((): void => undefined)}
            disabled={disabled || Boolean(busyId)}
            maxLength={120000}
            rows={5}
            placeholder={isArabic ? 'الصق النص الذي تريد التركيز عليه أثناء الكتابة...' : 'Paste the text to focus on while writing...'}
            className="w-full resize-y rounded-md border border-gray-200 bg-white p-2 text-[11px] leading-5 outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
          />
        )}
        <textarea
          value={focusInstructions}
          onChange={event => updateNewSourceDraft({ focusInstructions: event.target.value })}
          onBlur={() => void flushNewSourceDraft().catch((): void => undefined)}
          disabled={disabled || Boolean(busyId)}
          maxLength={2000}
          rows={3}
          placeholder={sourceInstructionsPlaceholder}
          className="w-full resize-y rounded-md border border-gray-200 bg-white p-2 text-[11px] leading-5 outline-none focus:border-[#d4af37] dark:border-[#444] dark:bg-[#1f1f1f]"
        />
        <div className={`flex items-center gap-1 text-[9px] font-bold ${newSourceDraftSaveStatus === 'error'
          ? 'text-red-600 dark:text-red-300'
          : newSourceDraftSaveStatus === 'dirty'
            ? 'text-amber-600 dark:text-amber-300'
            : newSourceDraftSaveStatus === 'saved'
              ? 'text-emerald-600 dark:text-emerald-300'
              : 'text-gray-400'}`}>
          {newSourceDraftSaveStatus === 'saving' && <Loader2 size={10} className="animate-spin" />}
          {newSourceDraftSaveStatus === 'saved' && <CheckCircle2 size={10} />}
          <span>
            {newSourceDraftSaveStatus === 'saving'
              ? (isArabic ? 'جار حفظ مسودة المصدر...' : 'Saving source draft...')
              : newSourceDraftSaveStatus === 'dirty'
                ? (isArabic ? 'سيتم حفظ مسودة المصدر تلقائيًا' : 'The source draft will be saved automatically')
                : newSourceDraftSaveStatus === 'error'
                  ? (isArabic ? 'تعذر حفظ مسودة المصدر — أعد المحاولة' : 'Source draft save failed — try again')
                  : (isArabic
                    ? 'المسودة محفوظة، ولن تدخل في الكتابة حتى الضغط على «إضافة وتجهيز»'
                    : 'Draft saved; it will not be used until you select “Add and prepare”')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <AppSelect
            size="compact"
            value={sourceRole}
            disabled={disabled || Boolean(busyId)}
            onChange={event => updateNewSourceDraft({
              sourceRole: event.target.value === 'supporting' ? 'supporting' : 'primary',
            })}
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
                      const timer = instructionSaveTimersRef.current.get(source.id);
                      if (timer !== undefined) window.clearTimeout(timer);
                      instructionSaveTimersRef.current.delete(source.id);
                      delete instructionDraftsRef.current[source.id];
                      delete savedInstructionsRef.current[source.id];
                      setInstructionDrafts(current => {
                        const next = { ...current };
                        delete next[source.id];
                        return next;
                      });
                      setInstructionSaveStatuses(current => {
                        const next = { ...current };
                        delete next[source.id];
                        return next;
                      });
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
                value={instructionDrafts[source.id] ?? source.focusInstructions}
                id={`writing-source-focus-${source.id}`}
                rows={3}
                maxLength={2000}
                disabled={disabled || busyId === source.id}
                onChange={event => {
                  const nextValue = event.target.value;
                  instructionDraftsRef.current = { ...instructionDraftsRef.current, [source.id]: nextValue };
                  setInstructionDrafts(current => ({ ...current, [source.id]: nextValue }));
                  setInstructionSaveStatuses(current => ({ ...current, [source.id]: 'dirty' }));
                  scheduleSourceInstructionsSave(source.id);
                }}
                onBlur={() => void flushSourceInstructions(source.id).catch((): void => undefined)}
                placeholder={sourceInstructionsPlaceholder}
                className="min-w-0 flex-1 resize-y rounded border border-gray-200 bg-white p-1.5 text-[10px] leading-4 dark:border-[#444] dark:bg-[#1f1f1f]"
              />
              <button
                type="button"
                disabled={disabled || busyId === source.id}
                onClick={() => void flushSourceInstructions(source.id).catch((): void => undefined)}
                className="flex size-7 items-center justify-center rounded border border-[#d4af37]/40 text-[#8a6f1d]"
                title={isArabic ? 'حفظ تعليمات المصدر' : 'Save source instructions'}
              >
                {busyId === source.id || instructionSaveStatuses[source.id] === 'saving'
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Save size={12} />}
              </button>
            </div>
            <div className={`mt-1 text-[9px] font-bold ${instructionSaveStatuses[source.id] === 'error'
              ? 'text-red-600 dark:text-red-300'
              : instructionSaveStatuses[source.id] === 'dirty'
                ? 'text-amber-600 dark:text-amber-300'
                : 'text-gray-400'}`}>
              {instructionSaveStatuses[source.id] === 'saving'
                ? (isArabic ? 'جار حفظ التعليمات...' : 'Saving instructions...')
                : instructionSaveStatuses[source.id] === 'dirty'
                  ? (isArabic ? 'سيتم الحفظ تلقائيًا' : 'Will be saved automatically')
                  : instructionSaveStatuses[source.id] === 'error'
                    ? (isArabic ? 'تعذر الحفظ — أعد المحاولة' : 'Save failed — try again')
                    : (isArabic ? 'تُحفظ التعليمات تلقائيًا ومع حفظ المقالة' : 'Instructions save automatically and with the article')}
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
