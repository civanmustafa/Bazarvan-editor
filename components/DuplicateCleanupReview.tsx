import React, { useEffect, useState } from 'react';
import { Check, LocateFixed, RefreshCw, Square, Undo2, X } from 'lucide-react';
import { useDuplicateCleanup } from '../contexts/DuplicateCleanupContext';
import type { CleanupContextValue } from '../contexts/DuplicateCleanupContext';
import { useUser } from '../contexts/UserContext';
import type { CleanupPatch } from '../utils/duplicateCleanup';

const iconClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[#d4af37]/15 disabled:opacity-40 disabled:cursor-not-allowed';

export const DuplicateCleanupReview: React.FC<{ category: number }> = ({ category }) => {
  const controller = useDuplicateCleanup();
  const { uiLanguage } = useUser();
  return <DuplicateCleanupReviewView category={category} controller={controller} ar={uiLanguage === 'ar'} />;
};

export const DuplicateCleanupReviewView: React.FC<{ category: number; controller: CleanupContextValue; ar: boolean }> = ({ category, controller, ar }) => {
  const { sessions, busy, generate, apply, skip, locate, undo, stop } = controller;
  const session = sessions[category];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [session?.id]);
  if (!session) return null;
  const pending = session.patches.filter(patch => patch.status === 'pending');
  const selectedIds = pending.filter(patch => selected.has(patch.id)).map(patch => patch.id);
  const unresolved = session.snapshot.phrases.filter(phrase => (session.predicted.get(phrase.id) || 0) > 1).length;
  const label = (patch: CleanupPatch) => ({ pending: ar ? 'بانتظار المراجعة' : 'Pending', applied: ar ? 'مطبّق' : 'Applied',
    stale: ar ? 'يحتاج إلى تحديث' : 'Needs refresh', skipped: ar ? 'متجاهَل' : 'Skipped', unnecessary: ar ? 'لم يعد لازمًا' : 'No longer needed' }[patch.status]);
  return (
    <section className="mt-2 border-t border-gray-200 pt-2 text-xs text-gray-800 dark:border-[#3C3C3C] dark:text-gray-200" aria-label={ar ? 'اقتراحات تنقية العبارات' : 'Phrase cleanup suggestions'}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <strong>{ar ? 'تنقية العبارات العامة' : 'General phrase cleanup'}</strong>
        <div className="flex items-center">
          <button type="button" className={iconClass} title={ar ? 'تحديث الاقتراحات' : 'Regenerate suggestions'} aria-label={ar ? 'تحديث الاقتراحات' : 'Regenerate suggestions'} disabled={busy} onClick={() => { setSelected(new Set()); void generate(category); }}><RefreshCw size={15} /></button>
          <button type="button" className={iconClass} title={ar ? 'التراجع عن آخر دفعة' : 'Undo last batch'} aria-label={ar ? 'التراجع عن آخر دفعة' : 'Undo last batch'} disabled={!session.undo.length || session.running} onClick={() => undo(category)}><Undo2 size={15} /></button>
          {session.running && <button type="button" className={iconClass} title={ar ? 'إيقاف التوليد' : 'Stop generation'} aria-label={ar ? 'إيقاف التوليد' : 'Stop generation'} onClick={stop}><Square size={14} /></button>}
        </div>
      </div>
      <p className="my-2" role="status" aria-live="polite">
        {ar ? `المواضع المحللة: ${session.decisions.length} من ${session.snapshot.occurrences.length}` : `Reviewed occurrences: ${session.decisions.length} of ${session.snapshot.occurrences.length}`}
        {session.running && <span className="block">{session.stopping ? (ar ? 'إيقاف بعد انتهاء الطلب الجاري' : 'Stopping after the current request') : ar ? `جارٍ التوليد (${session.completed}/${session.total})` : `Generating (${session.completed}/${session.total})`}</span>}
        <span className="block">{ar ? `عبارات ستبقى مكررة بعد الاقتراحات: ${unresolved}` : `Phrases still repeated after proposals: ${unresolved}`}</span>
        <span className="block">{ar ? `صافي الكلمات المحذوفة بالتطبيق: ${session.wordsRemoved}` : `Net words removed by applied edits: ${session.wordsRemoved}`}</span>
      </p>
      {session.errors.length > 0 && <div role="alert" className="my-2 space-y-1 break-words text-red-700 dark:text-red-300">{session.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      <div className="divide-y divide-gray-200 dark:divide-[#3C3C3C]">
        {session.snapshot.phrases.map(phrase => (
          <details key={phrase.id} className="py-2">
            <summary className="cursor-pointer break-words font-semibold">{phrase.text}
              <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">{ar ? `حاليًا: ${session.counts.get(phrase.id) ?? 0} · بعد الاقتراحات: ${session.predicted.get(phrase.id) ?? 0}` : `Current: ${session.counts.get(phrase.id) ?? 0} · Proposed: ${session.predicted.get(phrase.id) ?? 0}`}</span>
            </summary>
            {phrase.occurrenceIds.map(id => {
              const occurrence = session.snapshot.occurrences.find(item => item.id === id)!;
              const decision = session.decisions.find(item => item.occurrenceId === id);
              const stale = occurrence.unitIds.some(unitId => session.snapshot.units.find(unit => unit.id === unitId)?.stale);
              return <div key={id} className="flex items-start justify-between gap-1 py-1.5">
                <div className="min-w-0 break-words"><b>{ar ? `الموضع ${occurrence.ordinal} من ${phrase.occurrenceIds.length}` : `Occurrence ${occurrence.ordinal} of ${phrase.occurrenceIds.length}`}</b>
                  <p>{decision ? decision.action === 'keep' ? (ar ? 'إبقاء الموضع الأصعب: ' : 'Retain hardest occurrence: ') + decision.reason : decision.reason : ar ? 'لم تكتمل المراجعة' : 'Review incomplete'}</p>
                </div>
                <button type="button" className={iconClass} disabled={stale || occurrence.stale} title={ar ? 'عرض الموضع' : 'Locate occurrence'} aria-label={ar ? 'عرض الموضع' : 'Locate occurrence'} onClick={() => locate(category, id, true)}><LocateFixed size={14} /></button>
              </div>;
            })}
          </details>
        ))}
      </div>
      {pending.length > 0 && <div className="my-2 flex flex-wrap items-center justify-between gap-2 border-y border-gray-200 py-2 dark:border-[#3C3C3C]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={selectedIds.length === pending.length} onChange={event => setSelected(event.target.checked ? new Set(pending.map(patch => patch.id)) : new Set())} />{ar ? 'تحديد الكل' : 'Select all'}</label>
        <button type="button" className="inline-flex items-center gap-1 rounded-md bg-[#d4af37] px-2 py-1.5 font-semibold text-black disabled:opacity-40" disabled={!selectedIds.length || session.running} onClick={() => apply(category, selectedIds)}><Check size={14} />{ar ? `تطبيق المحدد (${selectedIds.length})` : `Apply selected (${selectedIds.length})`}</button>
      </div>}
      <div className="space-y-2">
        {session.patches.map(patch => {
          const unit = session.snapshot.units.find(item => item.id === patch.unitId)!;
          const prefix = unit.text.slice(0, patch.unitOffset);
          const suffix = unit.text.slice(patch.unitOffset + patch.original.length);
          const occurrences = patch.occurrenceIds.map(id => session.snapshot.occurrences.find(item => item.id === id)!);
          const action = !patch.replacement ? (ar ? 'حذف' : 'Delete') : !patch.original ? (ar ? 'إضافة' : 'Add') : (ar ? 'تعديل' : 'Edit');
          return <article key={patch.id} className="rounded-md border border-gray-200 bg-white p-2 dark:border-[#3C3C3C] dark:bg-[#242424]" data-cleanup-patch={patch.id}>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <label className="flex min-w-0 items-center gap-2 font-semibold"><input type="checkbox" aria-label={ar ? 'تحديد الاقتراح' : 'Select suggestion'} disabled={patch.status !== 'pending'} checked={patch.status === 'pending' && selected.has(patch.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(patch.id); else next.delete(patch.id); return next; })} />{action}</label>
              <span>{label(patch)}</span>
            </div>
            {unit.heading && <p className="my-1 break-words font-semibold">{unit.heading}</p>}
            <p className="my-1 break-words text-gray-500 dark:text-gray-400">{occurrences.map(item => `${session.snapshot.phrases.find(phrase => phrase.id === item.phraseId)!.text} (${item.ordinal}/${session.snapshot.phrases.find(phrase => phrase.id === item.phraseId)!.occurrenceIds.length})`).join(' · ')}</p>
            <div className="my-2 space-y-2 whitespace-pre-wrap break-words leading-relaxed" dir={session.snapshot.language === 'ar' ? 'rtl' : 'ltr'}>
              <p><span className="block font-semibold">{ar ? 'قبل' : 'Before'}</span>{prefix}<del className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">{patch.original}</del>{suffix}</p>
              <p><span className="block font-semibold">{ar ? 'بعد' : 'After'}</span>{prefix}<ins className="bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-200">{patch.replacement}</ins>{suffix}{!prefix && !suffix && !patch.replacement && <span className="text-gray-500">{ar ? 'حذف الجملة' : 'Sentence removed'}</span>}</p>
            </div>
            <p className="break-words text-gray-600 dark:text-gray-400">{patch.reason}</p>
            <div className="mt-2 flex items-center justify-end gap-1">
              <button type="button" className={iconClass} disabled={patch.status !== 'pending'} title={ar ? 'عرض موضع التعديل' : 'Locate edit'} aria-label={ar ? 'عرض موضع التعديل' : 'Locate edit'} onClick={() => locate(category, patch.id)}><LocateFixed size={15} /></button>
              <button type="button" className={iconClass} disabled={patch.status !== 'pending' || session.running} title={ar ? 'تجاهل الاقتراح' : 'Ignore suggestion'} aria-label={ar ? 'تجاهل الاقتراح' : 'Ignore suggestion'} onClick={() => skip(category, patch.id)}><X size={15} /></button>
              <button type="button" className={`${iconClass} bg-[#d4af37]/20`} disabled={patch.status !== 'pending' || session.running} title={ar ? 'تطبيق الاقتراح' : 'Apply suggestion'} aria-label={ar ? 'تطبيق الاقتراح' : 'Apply suggestion'} onClick={() => apply(category, [patch.id])}><Check size={15} /></button>
            </div>
          </article>;
        })}
      </div>
    </section>
  );
};
