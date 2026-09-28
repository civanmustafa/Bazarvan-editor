import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { Keywords } from '../../types';
import { useDuplicateCleanupController } from '../../contexts/DuplicateCleanupContext';
import { DuplicateCleanupReviewView, DuplicateCleanupStatusView } from '../../components/DuplicateCleanupReview';
import '../../styles/global.css';

const prefix = 'من المهم أن نلاحظ أن ';
const facts = ['التقرير متاح للتصدير بصيغتي PDF وCSV.', 'الجدول يحتوي على خمسة أعمدة.', 'المسودة تحفظ عند انتهاء التحرير.', 'الروابط المضافة تبقى مرتبطة بعناوينها الأصلية.', 'القائمة تعرض أسماء الملفات مرتبة أبجديًا.', 'نتيجة البحث تظهر بعد كتابة اسم المستند.', 'الصور تعرض مع النص البديل المرفق بها.'];
const content = facts.map(fact => `<p>${prefix}${fact}</p>`).join('');
const keywords: Keywords = { primary: '', secondaries: [], lsi: [], company: '' };

function Fixture() {
  const editor = useEditor({ extensions: [StarterKit], content });
  const [scope, setScope] = useState('fixture-1');
  const [delay, setDelay] = useState(false);
  const [requests, setRequests] = useState(0);
  const [sent, setSent] = useState(0);
  const reply = useRef<(() => void) | null>(null);
  const runAi = async (prompt: string) => {
    setRequests(count => count + 1);
    const data = JSON.parse(prompt.split('SOURCE_DATA=')[1]);
    setSent(data.occurrences.length);
    const editedUnits = new Set(data.units.filter((_: unknown, index: number) => index !== 3).map((unit: { id: string }) => unit.id));
    const response = JSON.stringify({
      edits: data.units.filter((unit: { id: string }) => editedUnits.has(unit.id)).map((unit: { id: string }, index: number) => ({
        id: `e${index}`, unitId: unit.id, original: prefix, replacement: '', reason: 'حذف التمهيد العام مع الحفاظ على المعلومة المحددة.',
      })),
      decisions: data.occurrences.map((occurrence: { id: string; unitIds: string[] }) => ({
        occurrenceId: occurrence.id, action: occurrence.unitIds.some(id => editedUnits.has(id)) ? 'edit' : 'keep',
        reason: occurrence.unitIds.some(id => editedUnits.has(id)) ? 'المعلومة مكتملة دون التمهيد.' : 'هذا هو الموضع المختار للإبقاء بعد مقارنة السياقات السبعة.',
      })),
    });
    if (delay) await new Promise<void>(resolve => { reply.current = resolve; });
    return response;
  };
  const controller = useDuplicateCleanupController({ editor, articleKey: scope, articleId: scope, language: 'ar', title: 'ملفات وتقارير', keywords, runAi });
  return <main style={{ maxWidth: 1100, margin: '0 auto', padding: 16, fontFamily: 'Cairo, sans-serif' }}>
    <h1 style={{ fontSize: 20, marginBottom: 12 }}>اختبار تنقية العبارات العامة</h1>
    <p>بيانات اختبار محلية. استجابة الذكاء الاصطناعي محاكاة، دون إرسال طلب خارجي.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '16px 0' }}>
      <button onClick={() => void controller.generate(4)} disabled={controller.busy}>تنقية العبارات الرباعية</button>
      <button onClick={() => editor?.commands.insertContentAt(1, 'مقدمة إضافية. ')}>إضافة قبل المواضع</button>
      <button onClick={() => editor?.commands.insertContentAt(10, 'تعديل ')}>تغيير موضع مستهدف</button>
      <button onClick={() => { editor?.commands.setContent(content); setScope(value => `${value}-reset`); }}>إعادة الاختبار</button>
      <label><input type="checkbox" checked={delay} onChange={event => setDelay(event.target.checked)} />تأخير الرد</label>
      <button onClick={() => { reply.current?.(); reply.current = null; }}>إرجاع الرد</button>
      <button onClick={() => setScope(value => `${value}-other`)}>تبديل المقالة</button>
    </div>
    <p role="status">الطلبات: {requests}، المواضع المرسلة: {sent}</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 24, alignItems: 'start' }}>
      <div style={{ borderTop: '1px solid #ddd', paddingTop: 12, lineHeight: 2 }}><EditorContent editor={editor} /></div>
      <div><DuplicateCleanupStatusView session={controller.sessions[4]} ar /><DuplicateCleanupReviewView category={4} controller={controller} ar />
        {controller.sessions[4]?.snapshot.phrases.map(phrase => <div key={phrase.id} data-phrase-row={phrase.key}><h2 className="mt-4 text-sm font-bold">{phrase.text}</h2><DuplicateCleanupReviewView category={4} phraseKey={phrase.key} controller={controller} ar /></div>)}
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
