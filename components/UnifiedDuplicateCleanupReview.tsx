import React from 'react';
import { Check, CircleAlert, LocateFixed, RefreshCw, RotateCcw, Sparkles, Square, Undo2 } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { UnifiedCleanupControls } from '../hooks/useUnifiedDuplicateCleanup';
import type { CleanupPatch, CleanupPhrase } from '../utils/duplicateCleanup';
import type { UnifiedCleanupState, UnifiedCleanupStep } from '../utils/unifiedDuplicateCleanup';

const iconClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40';
export function unifiedCleanupLabel(model: UnifiedCleanupControls, ar: boolean): string {
  if (model.job?.status === 'queued') return ar ? 'في الطابور' : 'Queued';
  if (model.busy) return model.state?.phase === 'reviewing' ? (ar ? 'مراجعة الجودة' : 'Quality review') : (ar ? 'جارٍ التنقية' : 'Cleaning up');
  if (model.state?.phase === 'reverted') return ar ? 'تم التراجع' : 'Reverted';
  if (model.job?.status === 'cancelled') return ar ? 'متوقفة' : 'Stopped';
  if (model.job?.status === 'blocked' || model.job?.status === 'failed') return ar ? 'تحتاج مراجعة' : 'Needs review';
  if (model.state?.phase === 'completed') return ar ? 'اكتملت' : 'Complete';
  if (model.state?.phase === 'partial') return ar ? 'تمت جزئيًا' : 'Partial';
  return ar ? 'لم تبدأ' : 'Not started';
}

export const UnifiedCleanupToolbar: React.FC<{ model?: UnifiedCleanupControls; ar: boolean; editable: boolean }> = ({ model, ar, editable }) => {
  if (!model) return null;
  const { state } = model;
  return <section className="mb-2 border-b border-gray-200 pb-2 text-xs dark:border-gray-700" aria-label={ar ? 'التنقية التلقائية' : 'Automatic cleanup'}>
    <div className="flex flex-wrap items-center gap-1">
      <strong className="min-w-0 flex-1">{ar ? 'تنقية العبارات العامة' : 'General phrase cleanup'}</strong>
      <span role="status" className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
        {model.busy && <RefreshCw size={12} className="animate-spin" />}{unifiedCleanupLabel(model, ar)}
      </span>
      <button className={iconClass} disabled={model.busy || !editable} onClick={() => void model.run()}
        title={ar ? 'تنقية جميع التصنيفات' : 'Clean up all categories'} aria-label={ar ? 'تنقية جميع التصنيفات' : 'Clean up all categories'}><Sparkles size={16} /></button>
      {model.busy && <button className={iconClass} onClick={() => void model.stop()} title={ar ? 'إيقاف' : 'Stop'} aria-label={ar ? 'إيقاف' : 'Stop'}><Square size={14} /></button>}
      {!!state?.appliedCount && <>
        <button className={iconClass} disabled={model.busy || !editable} onClick={() => void model.undo('round')}
          title={ar ? 'التراجع عن آخر جولة' : 'Undo last round'} aria-label={ar ? 'التراجع عن آخر جولة' : 'Undo last round'}><Undo2 size={16} /></button>
        <button className={iconClass} disabled={model.busy || !editable} onClick={() => void model.undo('all')}
          title={ar ? 'التراجع عن التنقية كاملة' : 'Undo all cleanup'} aria-label={ar ? 'التراجع عن التنقية كاملة' : 'Undo all cleanup'}><RotateCcw size={16} /></button>
      </>}
    </div>
    {model.error && <p role="alert" className="break-words text-amber-700 dark:text-amber-300">{model.error}</p>}
    {!model.error && state?.errors.length ? <p className="break-words text-amber-700 dark:text-amber-300">{ar ? 'بعض المواضع تحتاج مراجعة.' : 'Some occurrences need review.'}</p> : null}
  </section>;
};

export function unifiedPatchOwner(step: UnifiedCleanupStep, patch: CleanupPatch) {
  return step.snapshot.phrases.filter(phrase => phrase.occurrenceIds.some(id => patch.occurrenceIds.includes(id)))
    .sort((a, b) => b.key.split(' ').length - a.key.split(' ').length)[0];
}
export function unifiedHistoryPhrases(state: UnifiedCleanupState | undefined, category: number) {
  const phrases = new Map<string, CleanupPhrase>();
  for (const step of state?.steps || []) for (const patch of step.patches) {
    const owner = unifiedPatchOwner(step, patch);
    if (owner?.key.split(' ').length === category) phrases.set(owner.key, owner);
  }
  return [...phrases.values()];
}
function locatePatch(editor: Editor | null, step: UnifiedCleanupStep, patch: CleanupPatch) {
  if (!editor || editor.isDestroyed) return null;
  const unit = step.snapshot.units.find(item => item.id === patch.unitId);
  if (!unit) return null;
  const sentence = patch.status === 'applied' ? unit.text.slice(0, patch.unitOffset) + patch.replacement
    + unit.text.slice(patch.unitOffset + patch.original.length) : unit.text;
  if (!sentence.trim()) return null;
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '', '\uFFFC');
    for (let index = text.indexOf(sentence); index >= 0; index = text.indexOf(sentence, index + 1)) positions.push(pos + 1 + index);
  });
  return positions.length === 1 ? { from: positions[0], to: positions[0] + sentence.length } : null;
}
export const UnifiedCleanupPhraseHistory: React.FC<{ state?: UnifiedCleanupState; phraseKey: string; ar: boolean; editor: Editor | null }> = ({ state, phraseKey, ar, editor }) => {
  const records = (state?.steps || []).flatMap(step => step.patches.filter(patch => unifiedPatchOwner(step, patch)?.key === phraseKey).map(patch => ({ step, patch })));
  if (!records.length) return null;
  return <div className="space-y-1 px-2 pb-2 text-xs" aria-label={ar ? 'تعديلات العبارة' : 'Phrase edits'}>{records.map(({ step, patch }) => {
    const applied = patch.status === 'applied';
    const verdict = step.review.find(item => item.id === patch.id);
    const owner = unifiedPatchOwner(step, patch)!;
    const details = [verdict?.reason || patch.reason,
      ar ? `الجولة: ${step.round + 1} · المواضع المحللة: ${owner.occurrenceIds.length}` : `Round: ${step.round + 1} · Occurrences: ${owner.occurrenceIds.length}`,
      ...owner.occurrenceIds.map(id => {
        const occurrence = step.snapshot.occurrences.find(item => item.id === id)!;
        const decision = step.decisions.find(item => item.occurrenceId === id);
        return `${occurrence.ordinal}: ${decision?.reason || ''}`;
      })].join('\n');
    const range = locatePatch(editor, step, patch);
    return <div key={`${step.id}:${patch.id}`} className={`border-t border-gray-200 pt-1 dark:border-gray-700 ${applied ? 'opacity-50' : ''}`} data-cleanup-applied={applied}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1">{applied && <Check size={14} />}{patch.replacement ? (ar ? 'تعديل' : 'Edit') : (ar ? 'حذف' : 'Delete')}</span>
        {!applied && <span className="text-amber-700 dark:text-amber-300">{ar ? 'للمراجعة' : 'For review'}</span>}
        <button className={iconClass} disabled={!range} title={ar ? 'عرض الموضع' : 'Locate occurrence'} aria-label={ar ? 'عرض الموضع' : 'Locate occurrence'}
          onClick={() => range && editor?.chain().focus().setTextSelection(range).scrollIntoView().run()}><LocateFixed size={14} /></button>
        <button className={iconClass} title={details} aria-label={ar ? 'تفاصيل المواضع ومراجعة الجودة' : 'Occurrences and quality review'}><CircleAlert size={14} /></button>
      </div>
      <p className="break-words text-gray-500 dark:text-gray-400"><del>{patch.original}</del></p>
      {patch.replacement && <p className="break-words text-emerald-700 dark:text-emerald-300">{patch.replacement}</p>}
    </div>;
  })}</div>;
};
