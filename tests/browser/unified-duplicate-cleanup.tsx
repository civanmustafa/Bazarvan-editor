import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { UnifiedCleanupToolbar, UnifiedCleanupPhraseHistory, unifiedHistoryPhrases } from '../../components/UnifiedDuplicateCleanupReview';
import { collectUnifiedCleanupSnapshot, runUnifiedCleanupWorkflow, CLEANUP_CATEGORIES, type UnifiedCleanupState } from '../../utils/unifiedDuplicateCleanup';
import type { ExternalAnalysisJobRow } from '../../utils/externalAnalysis';
import type { Keywords } from '../../types';
import { cleanupDocumentIdentity } from '../../utils/cleanupDocumentIdentity';
import '../../styles/global.css';

const prefix = 'من المفيد في هذا السياق الإشارة إلى ';
const facts = ['التقرير متاح بصيغتي PDF وCSV.', 'الجدول يحتوي على خمسة أعمدة.', 'المسودة تحفظ عند انتهاء التحرير.',
  'القائمة ترتب الملفات أبجديًا.', 'نتائج البحث تظهر بعد كتابة اسم المستند.', 'الصور تعرض مع النص البديل المرفق بها.'];
const content = `<h2>${prefix}ملفات المشروع</h2>${facts.map(fact => `<p>${prefix}${fact}</p>`).join('')}
  <table><tbody><tr><th>الصيغة</th><th>الاستخدام</th></tr><tr><td>CSV</td><td>البيانات المجدولة</td></tr></tbody></table>`;
const keywords: Keywords = { primary: '', company: '', secondaries: [], lsi: [] };

function Fixture() {
  const editor = useEditor({ extensions: [StarterKit, Table, TableRow, TableCell, TableHeader], content });
  const [state, setState] = useState<UnifiedCleanupState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requests, setRequests] = useState(0);
  const [sent, setSent] = useState(0);
  const [reject, setReject] = useState(false);
  const [delay, setDelay] = useState(false);
  const [mobile, setMobile] = useState(false);
  const pending = useRef<() => void>(undefined);
  const abort = useRef<AbortController>(undefined);
  const original = useRef<Record<string, unknown>>(undefined);
  const run = async () => {
    if (!editor || busy) return;
    original.current = editor.getJSON();
    let expected = editor.state.doc;
    setBusy(true); setError(''); setRequests(0); setSent(0);
    abort.current = new AbortController();
    try {
      const result = await runUnifiedCleanupWorkflow({ doc: editor.state.doc, keywords, language: 'ar', title: 'ملفات المشروع', signal: abort.current.signal,
        assertCurrent: async () => { if (!editor.state.doc.eq(expected)) throw new Error('تغير النص؛ لم يتم استبدال التعديل اليدوي.'); },
        checkpoint: async next => { setState(next); },
        commit: async (_before, after, next) => { editor.commands.setContent(after.toJSON()); expected = editor.state.doc; setState(next); },
        run: async prompt => {
          setRequests(count => count + 1);
          const data = JSON.parse(prompt.split('SOURCE_DATA=')[1]);
          if (delay) await new Promise<void>(resolve => { pending.current = resolve; });
          if (data.edits) return JSON.stringify({ reviews: data.edits.map((edit: any) => ({ id: edit.id,
            preservesMeaning: !reject, preservesFacts: !reject, grammar: true, coherence: true, removesFiller: true, safeShortPhrase: true,
            reason: reject ? 'قد يؤثر التعديل في المعنى؛ تُرك للمراجعة.' : 'حذف التمهيد لا يمس المعلومة أو ترابط الجملة.' })) });
          setSent(data.occurrences.length);
          const editable = data.units.filter((unit: any) => unit.editable
            && data.blocks.find((block: any) => block.id === unit.blockId).text.slice(unit.start, unit.end).startsWith(prefix));
          const ids = new Set(editable.map((unit: any) => unit.id));
          return JSON.stringify({ edits: editable.map((unit: any) => ({ unitId: unit.id, original: prefix, replacement: '', reason: 'حذف تمهيد عام مع حفظ المعلومة.' })),
            decisions: data.occurrences.map((item: any) => ({ occurrenceId: item.id,
              action: item.unitIds.some((id: string) => ids.has(id)) ? 'edit' : 'keep', reason: 'حفظ العناوين والجداول والمعلومات.' })) });
        },
      });
      setState(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const undo = async (scope: 'round' | 'all') => {
    if (!editor || !state || busy || cleanupDocumentIdentity(editor.getJSON()) !== cleanupDocumentIdentity(state.document)) return;
    const target = scope === 'all' ? original.current : state.rounds.at(-1)?.document;
    if (target) { editor.commands.setContent(target); setState({ ...state, document: target, phase: 'reverted', appliedCount: 0, steps: [] }); }
  };
  const job = state ? { id: 'fixture', status: busy ? 'running' : 'completed', input_snapshot: { version: 2 }, progress: { unified: state } } as unknown as ExternalAnalysisJobRow : null;
  const model = { job, state, busy, error, articleStatus: 'draft', run, stop: async () => { abort.current?.abort(new Error('تم الإيقاف.')); pending.current?.(); }, undo };
  return <main dir="rtl" style={{ maxWidth: mobile ? 360 : 1100, margin: 'auto', padding: 12, fontFamily: 'Cairo, sans-serif' }}>
    <h1 className="text-lg font-bold">اختبار التنقية التلقائية</h1>
    <div className="my-3 flex flex-wrap gap-3 text-xs">
      <label><input type="checkbox" checked={reject} onChange={event => setReject(event.target.checked)} /> رفض الجودة</label>
      <label><input type="checkbox" checked={delay} onChange={event => setDelay(event.target.checked)} /> تأخير الرد</label>
      <label><input type="checkbox" checked={mobile} onChange={event => setMobile(event.target.checked)} /> عرض ضيق</label>
      <button onClick={() => pending.current?.()}>إرجاع الرد</button>
      <button disabled={busy} onClick={() => { editor?.commands.setContent(content); setState(undefined); setError(''); setRequests(0); setSent(0); }}>إعادة الاختبار</button>
      <button onClick={() => editor?.commands.insertContentAt(1, 'تعديل يدوي. ')}>تعديل أثناء المعالجة</button>
    </div>
    <p data-testid="metrics" className="mb-3 text-xs">الطلبات: {requests} · المواضع المرسلة: {sent} · التعديلات المطبقة: {state?.appliedCount || 0}</p>
    {state?.errors.map((message, index) => <pre key={index} className="whitespace-pre-wrap text-xs" role="alert">{message}</pre>)}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 20, alignItems: 'start' }}>
      <div className="border-t pt-3 leading-loose"><EditorContent editor={editor} /></div>
      <div className="min-w-0"><UnifiedCleanupToolbar model={model} ar editable />
        {CLEANUP_CATEGORIES.map(category => {
          const historical = unifiedHistoryPhrases(state, category);
          const current = editor ? collectUnifiedCleanupSnapshot(editor.state.doc, keywords, 'ar').phrases.filter(phrase => phrase.key.split(' ').length === category) : [];
          const all = new Map([...current, ...historical].map(phrase => [phrase.key, phrase]));
          if (!all.size) return null;
          return <section key={category} className="mb-3 border-b py-2"><h2 className="mb-1 text-sm font-bold">عبارات من {category} كلمات</h2>
            {[...all.values()].map(phrase => <div key={phrase.key} className="mb-2 border-s-2 border-teal-600 ps-1">
              <p className="bg-gray-100 p-2 text-sm">{phrase.text}</p>
              <UnifiedCleanupPhraseHistory state={state} phraseKey={phrase.key} ar editor={editor} />
            </div>)}
          </section>;
        })}
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
