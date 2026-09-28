import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, LocateFixed, RefreshCw, Square, Undo2, X } from 'lucide-react';
import { useDuplicateCleanup } from '../contexts/DuplicateCleanupContext';
import type { CleanupContextValue } from '../contexts/DuplicateCleanupContext';
import { useUser } from '../contexts/UserContext';
import type { CleanupPatch, CleanupPhrase } from '../utils/duplicateCleanup';
import type { CleanupSession } from '../utils/duplicateCleanupSession';
import { cleanupGenerationState } from '../utils/duplicateCleanupSession';

const iconClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[#d4af37]/15 disabled:opacity-40 disabled:cursor-not-allowed';
const activityLabel = (status: string | undefined, ar: boolean) => {
  if (status === 'queued') return ar ? 'في الطابور' : 'Queued';
  if (status === 'retry_scheduled') return ar ? 'إعادة المحاولة مجدولة' : 'Retry scheduled';
  if (status === 'paused') return ar ? 'متوقفة مؤقتًا' : 'Paused';
  return ar ? 'جارٍ التوليد' : 'Generating';
};

const OccurrenceDetailsTooltip: React.FC<{ phrase: CleanupPhrase; session: CleanupSession; ar: boolean; locate: (id: string) => void }> = ({ phrase, session, ar, locate }) => {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  const show = (element: HTMLElement) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setAnchor(element.getBoundingClientRect());
  };
  const hide = () => { hideTimer.current = setTimeout(() => setAnchor(null), 120); };
  const keepOpen = () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  return <>
    <button type="button" className={iconClass} aria-label={ar ? 'تفاصيل المواضع' : 'Occurrence details'}
      aria-describedby={anchor ? id : undefined} aria-expanded={Boolean(anchor)}
      onMouseEnter={event => show(event.currentTarget)} onMouseLeave={hide}
      onFocus={event => show(event.currentTarget)} onBlur={hide} onClick={event => show(event.currentTarget)}>
      <CircleAlert size={15} />
    </button>
    {anchor && createPortal(<div id={id} role="tooltip" dir={ar ? 'rtl' : 'ltr'}
      onMouseEnter={keepOpen} onMouseLeave={hide} onFocus={keepOpen} onBlur={hide}
      className="fixed z-[100] max-h-[65vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-gray-300 bg-white p-3 text-xs leading-relaxed text-gray-800 shadow-lg dark:border-[#555] dark:bg-[#242424] dark:text-gray-100"
      style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 328)),
        top: anchor.bottom + 230 < window.innerHeight ? anchor.bottom + 4 : undefined,
        bottom: anchor.bottom + 230 >= window.innerHeight ? window.innerHeight - anchor.top + 4 : undefined }}>
      <strong className="block break-words">{phrase.text}</strong>
      <p className="text-gray-500 dark:text-gray-400">{ar ? `حاليًا: ${session.counts.get(phrase.id) ?? 0} · بعد الاقتراحات: ${session.predicted.get(phrase.id) ?? 0}` : `Current: ${session.counts.get(phrase.id) ?? 0} · Proposed: ${session.predicted.get(phrase.id) ?? 0}`}</p>
      <div className="my-2 border-y border-gray-200 py-2 dark:border-[#3C3C3C]">
        <b>{ar ? 'تنقية العبارات العامة' : 'General phrase cleanup'}</b>
        <p>{ar ? `المواضع المحللة: ${session.decisions.length} من ${session.snapshot.occurrences.length}` : `Reviewed occurrences: ${session.decisions.length} of ${session.snapshot.occurrences.length}`}</p>
        {session.running && <p>{session.stopping ? (ar ? 'إيقاف بعد انتهاء الطلب الجاري' : 'Stopping after the current request') : `${activityLabel(session.externalStatus, ar)} (${session.completed}/${session.total})`}</p>}
        <p>{ar ? `عبارات ستبقى مكررة بعد الاقتراحات: ${session.snapshot.phrases.filter(item => (session.predicted.get(item.id) || 0) > 1).length}` : `Phrases still repeated after proposals: ${session.snapshot.phrases.filter(item => (session.predicted.get(item.id) || 0) > 1).length}`}</p>
        <p>{ar ? `عبارات مكررة حاليًا: ${session.snapshot.phrases.filter(item => (session.counts.get(item.id) || 0) > 1).length}` : `Currently repeated: ${session.snapshot.phrases.filter(item => (session.counts.get(item.id) || 0) > 1).length}`}</p>
        <p>{ar ? `صافي الكلمات المحذوفة بالتطبيق: ${session.wordsRemoved}` : `Net words removed by applied edits: ${session.wordsRemoved}`}</p>
      </div>
      <b>{ar ? 'تفاصيل المواضع' : 'Occurrence details'}</b>
      <div className="divide-y divide-gray-200 dark:divide-[#3C3C3C]">{phrase.occurrenceIds.map(occurrenceId => {
        const occurrence = session.snapshot.occurrences.find(item => item.id === occurrenceId)!;
        const decision = session.decisions.find(item => item.occurrenceId === occurrenceId);
        const heading = occurrence.unitIds.map(unitId => session.snapshot.units.find(unit => unit.id === unitId)?.heading).find(Boolean);
        const stale = occurrence.stale || occurrence.unitIds.some(unitId => session.snapshot.units.find(unit => unit.id === unitId)?.stale);
        return <div key={occurrenceId} className="flex items-start justify-between gap-2 py-1.5">
          <div className="min-w-0 break-words"><b>{ar ? `الموضع ${occurrence.ordinal} من ${phrase.occurrenceIds.length}` : `Occurrence ${occurrence.ordinal} of ${phrase.occurrenceIds.length}`}</b>
            {heading && <p className="text-gray-500 dark:text-gray-400">{heading}</p>}
            <p>{decision ? decision.action === 'keep' ? `${ar ? 'إبقاء الموضع: ' : 'Retained: '}${decision.reason}` : decision.reason : ar ? 'لم تكتمل المراجعة' : 'Review incomplete'}</p>
          </div>
          <button type="button" className={iconClass} disabled={stale} title={ar ? 'عرض الموضع' : 'Locate occurrence'} aria-label={ar ? 'عرض الموضع' : 'Locate occurrence'} onClick={() => locate(occurrenceId)}><LocateFixed size={14} /></button>
        </div>;
      })}</div>
    </div>, document.body)}
  </>;
};

export const DuplicateCleanupReview: React.FC<{ category: number }> = ({ category }) => {
  const controller = useDuplicateCleanup();
  const { uiLanguage } = useUser();
  return <DuplicateCleanupReviewView category={category} controller={controller} ar={uiLanguage === 'ar'} />;
};

export const DuplicateCleanupPhraseReview: React.FC<{ category: number; phraseKey: string }> = ({ category, phraseKey }) => {
  const controller = useDuplicateCleanup();
  const { uiLanguage } = useUser();
  return <DuplicateCleanupReviewView category={category} phraseKey={phraseKey} controller={controller} ar={uiLanguage === 'ar'} />;
};

export const DuplicateCleanupStatus: React.FC<{ category: number; ar: boolean }> = ({ category, ar }) => {
  const session = useDuplicateCleanup().sessions[category];
  return <DuplicateCleanupStatusView session={session} ar={ar} />;
};
export const DuplicateCleanupStatusView: React.FC<{ session?: CleanupContextValue['sessions'][number]; ar: boolean }> = ({ session, ar }) => {
  const state = cleanupGenerationState(session);
  const label = { not_started: ar ? 'لم تتم' : 'Not generated', partial: ar ? 'تمت جزئيًا' : 'Partial', completed: ar ? 'اكتملت' : 'Complete' }[state];
  return <span className={`inline-flex items-center gap-1 text-[10px] ${state === 'completed' ? 'text-emerald-700 dark:text-emerald-300' : state === 'partial' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`} role="status" aria-label={ar ? `حالة التوليد: ${label}` : `Generation status: ${label}`}>
    {session?.running && <RefreshCw size={11} className="animate-spin" />}{label}
    {session?.running && <span>{activityLabel(session.externalStatus, ar)}</span>}
  </span>;
};

export const DuplicateCleanupReviewView: React.FC<{ category: number; controller: CleanupContextValue; ar: boolean; phraseKey?: string }> = ({ category, controller, ar, phraseKey }) => {
  const { sessions, busy, generate, apply, skip, locate, undo, stop } = controller;
  const session = sessions[category];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [session?.id]);
  if (!session) return null;
  const phrase = phraseKey ? session.snapshot.phrases.find(item => item.key === phraseKey) : undefined;
  if (phraseKey && !phrase) return null;
  const visiblePatches = phrase ? session.patches.filter(patch => patch.status !== 'stale' && patch.occurrenceIds.some(id => phrase.occurrenceIds.includes(id))) : [];
  const hasPhraseReview = phrase ? session.decisions.some(decision => phrase.occurrenceIds.includes(decision.occurrenceId)) : false;
  if (phrase && !visiblePatches.length && !hasPhraseReview) return null;
  const pending = (phrase ? visiblePatches : session.patches).filter(patch => patch.status === 'pending');
  const selectedIds = pending.filter(patch => selected.has(patch.id)).map(patch => patch.id);
  const label = (patch: CleanupPatch) => ({ pending: '', applied: ar ? 'مطبّق' : 'Applied',
    stale: '', skipped: ar ? 'متجاهَل' : 'Skipped', unnecessary: ar ? 'لم يعد لازمًا' : 'No longer needed' }[patch.status]);
  return (
    <section className={`${phrase ? 'bg-gray-50 px-2 pb-2 pt-1 dark:bg-[#2A2A2A]' : 'mb-1'} text-xs text-gray-800 dark:text-gray-200`} data-cleanup-phrase={phrase?.key} aria-label={phrase ? (ar ? `اقتراحات: ${phrase.text}` : `Suggestions: ${phrase.text}`) : (ar ? 'متابعة تنقية العبارات' : 'Phrase cleanup progress')}>
      {!phrase && <>
      <div className="flex flex-wrap items-center justify-end gap-1">
          {pending.length > 0 && <button type="button" className="inline-flex items-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 font-semibold text-black disabled:opacity-40" disabled={session.running} onClick={() => apply(category, pending.map(patch => patch.id))}><Check size={14} />{ar ? `تطبيق كل الاقتراحات (${pending.length})` : `Apply all suggestions (${pending.length})`}</button>}
          <button type="button" className={iconClass} title={ar ? 'تحديث الاقتراحات' : 'Regenerate suggestions'} aria-label={ar ? 'تحديث الاقتراحات' : 'Regenerate suggestions'} disabled={busy} onClick={() => { setSelected(new Set()); void generate(category); }}><RefreshCw size={15} /></button>
          <button type="button" className={iconClass} title={ar ? 'التراجع عن آخر دفعة' : 'Undo last batch'} aria-label={ar ? 'التراجع عن آخر دفعة' : 'Undo last batch'} disabled={!session.undo.length || session.running} onClick={() => undo(category)}><Undo2 size={15} /></button>
          {session.running && <button type="button" className={iconClass} title={ar ? 'إيقاف التوليد' : 'Stop generation'} aria-label={ar ? 'إيقاف التوليد' : 'Stop generation'} onClick={stop}><Square size={14} /></button>}
      </div>
      {session.errors.length > 0 && <div role="alert" className="my-2 space-y-1 break-words text-red-700 dark:text-red-300">{session.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      </>}
      {phrase && <>
      {!visiblePatches.length && <div className="flex justify-end"><OccurrenceDetailsTooltip phrase={phrase} session={session} ar={ar} locate={id => locate(category, id, true)} /></div>}
      {pending.length > 0 && <div className="my-2 flex flex-wrap items-center justify-between gap-2 border-y border-gray-200 py-2 dark:border-[#3C3C3C]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={selectedIds.length === pending.length} onChange={event => setSelected(event.target.checked ? new Set(pending.map(patch => patch.id)) : new Set())} />{ar ? 'تحديد الكل' : 'Select all'}</label>
        <button type="button" className="inline-flex items-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 font-semibold text-black disabled:opacity-40" disabled={!selectedIds.length || session.running} onClick={() => apply(category, selectedIds)}><Check size={14} />{ar ? `تطبيق المحدد (${selectedIds.length})` : `Apply selected (${selectedIds.length})`}</button>
      </div>}
      <div className="space-y-2">
        {visiblePatches.map(patch => {
          const unit = session.snapshot.units.find(item => item.id === patch.unitId)!;
          const prefix = unit.text.slice(0, patch.unitOffset);
          const suffix = unit.text.slice(patch.unitOffset + patch.original.length);
          const action = !patch.replacement ? (ar ? 'حذف' : 'Delete') : !patch.original ? (ar ? 'إضافة' : 'Add') : (ar ? 'تعديل' : 'Edit');
          return <article key={patch.id} className={`rounded-md border border-gray-200 bg-white p-2 transition-opacity dark:border-[#3C3C3C] dark:bg-[#242424] ${patch.status === 'applied' ? 'opacity-60' : ''}`} data-cleanup-patch={patch.id} data-cleanup-status={patch.status}>
            {patch.status !== 'pending' && <div className="text-end text-gray-500 dark:text-gray-400">{label(patch)}</div>}
            <div className="my-2 space-y-2 whitespace-pre-wrap break-words leading-relaxed" dir={session.snapshot.language === 'ar' ? 'rtl' : 'ltr'}>
              <p><span className="block font-semibold">{ar ? 'قبل' : 'Before'}</span>{prefix}<del className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">{patch.original}</del>{suffix}</p>
              {(prefix || suffix || patch.replacement) && <p><span className="block font-semibold">{ar ? 'بعد' : 'After'}</span>{prefix}<ins className="bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-200">{patch.replacement}</ins>{suffix}</p>}
            </div>
            <p className="break-words text-gray-600 dark:text-gray-400">{patch.reason}</p>
            <div className="mt-2 flex flex-nowrap items-center justify-end gap-1 border-t border-gray-100 pt-1 dark:border-[#3C3C3C]">
              <label className="me-auto inline-flex min-w-0 items-center gap-1 whitespace-nowrap font-semibold"><input type="checkbox" aria-label={ar ? 'تحديد الاقتراح' : 'Select suggestion'} disabled={patch.status !== 'pending'} checked={patch.status === 'pending' && selected.has(patch.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(patch.id); else next.delete(patch.id); return next; })} />{action}</label>
              <OccurrenceDetailsTooltip phrase={phrase} session={session} ar={ar} locate={id => locate(category, id, true)} />
              <button type="button" className={iconClass} disabled={patch.status !== 'pending'} title={ar ? 'عرض موضع التعديل' : 'Locate edit'} aria-label={ar ? 'عرض موضع التعديل' : 'Locate edit'} onClick={() => locate(category, patch.id)}><LocateFixed size={15} /></button>
              <button type="button" className={iconClass} disabled={patch.status !== 'pending' || session.running} title={ar ? 'تجاهل الاقتراح' : 'Ignore suggestion'} aria-label={ar ? 'تجاهل الاقتراح' : 'Ignore suggestion'} onClick={() => skip(category, patch.id)}><X size={15} /></button>
              <button type="button" className={`${iconClass} bg-[#d4af37]/20`} disabled={patch.status !== 'pending' || session.running} title={ar ? 'تطبيق الاقتراح' : 'Apply suggestion'} aria-label={ar ? 'تطبيق الاقتراح' : 'Apply suggestion'} onClick={() => apply(category, [patch.id])}><Check size={15} /></button>
            </div>
          </article>;
        })}
      </div>
      </>}
    </section>
  );
};
