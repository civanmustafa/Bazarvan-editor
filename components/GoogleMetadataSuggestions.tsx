import React, { useEffect, useRef, useState } from 'react';
import { Copy, Loader2, Sparkles } from 'lucide-react';

import { useEditorSelector } from '../contexts/EditorContext';
import { useUser } from '../contexts/UserContext';
import {
  enqueueGoogleMetadataGeneration, ExternalAnalysisRequestError,
  loadExternalAnalysisJobsByIds, getExternalMissingFieldLabels,
} from '../utils/externalAnalysis';

const GoogleMetadataSuggestions: React.FC = () => {
  const { t, uiLanguage: locale } = useUser();
  const keywords = useEditorSelector(context => context.keywords);
  const setTitle = useEditorSelector(context => context.setTitle);
  const setMetaDescription = useEditorSelector(context => context.setMetaDescription);
  const articleId = useEditorSelector(context => context.activeArticleId);
  const settled = useEditorSelector(context => context.isArticleContentSettledForAutomation);
  const handleSaveDraft = useEditorSelector(context => context.handleSaveDraft);
  const reloadSavedGoogleMetadata = useEditorSelector(context => context.reloadSavedGoogleMetadata);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const requestVersion = useRef(0);
  const requestInFlight = useRef(false);
  const isArabic = locale === 'ar';
  useEffect(() => {
    requestVersion.current += 1;
    setBusy(false);
    setJobId(null);
    setNotice(null);
    requestInFlight.current = false;
    return () => { requestVersion.current += 1; };
  }, [articleId]);

  useEffect(() => {
    if (!jobId || !articleId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const jobs = await loadExternalAnalysisJobsByIds([jobId]);
        if (disposed) return;
        const job = jobs.find(value => value.id === jobId);
        if (!job) {
          setNotice({ error: true, text: isArabic
            ? 'لم يعد سجل المهمة متاحًا لحسابك. حدّث الصفحة للتحقق من النتيجة والصلاحيات.'
            : 'The task is no longer accessible. Refresh to check the result and permissions.' });
          setBusy(false);
          requestInFlight.current = false;
          setJobId(null);
          return;
        }
        if (job?.status === 'completed') {
          const applied = ['applied', 'already_populated'].includes(String(job.result?.status));
          const loaded = applied && await reloadSavedGoogleMetadata(articleId);
          if (disposed) return;
          setNotice({ error: !applied, text: applied
            ? (loaded
              ? (isArabic ? 'تم توليد العناوين والأوصاف وحفظها. سيعكس الطابور اكتمالها.' : 'Titles and descriptions saved. The queue will reflect completion.')
              : (isArabic ? 'تم حفظ المقترحات. أعد فتح المقالة بعد حفظ تعديلاتك لعرضها.' : 'Suggestions saved. Save your edits and reopen the article to load them.'))
            : (isArabic ? 'تغيرت بيانات المقالة قبل اعتماد النتيجة. أعد التوليد.' : 'The article changed before the result could be saved. Generate again.') });
          setBusy(false);
          requestInFlight.current = false;
          setJobId(null);
          return;
        }
        if (job && ['failed', 'blocked', 'cancelled'].includes(job.status)) {
          setNotice({ error: true, text: isArabic
            ? 'لم يكتمل التوليد. يمكنك إعادة المحاولة بهذا الزر بعد معالجة السبب أو انتهاء تهدئة المزود.'
            : 'Generation did not complete. Retry after addressing the cause or the provider cooldown.' });
          setBusy(false);
          requestInFlight.current = false;
          setJobId(null);
          return;
        }
      } catch {
        if (!disposed) setNotice({ error: false, text: isArabic
          ? 'تعذر تحديث الحالة مؤقتًا؛ المهمة مستمرة في الخلفية وسنعيد التحقق.'
          : 'Status temporarily unavailable; the task continues in the background. Checking again.' });
      }
      if (!disposed) timer = setTimeout(() => { void poll(); }, 5000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [articleId, isArabic, jobId, reloadSavedGoogleMetadata]);

  const generateManually = async () => {
    if (requestInFlight.current || busy || !articleId || !settled || !keywords.primary.trim()) return;
    requestInFlight.current = true;
    const version = requestVersion.current;
    setBusy(true);
    setNotice(null);
    try {
      // Persist the current prerequisites before the worker reads them. A failed
      // save must never enqueue a task for stale article inputs.
      const saved = await handleSaveDraft();
      if (requestVersion.current !== version) return;
      if (!saved) throw new Error(isArabic ? 'احفظ المقالة وعالج تعارض الحفظ أولًا.' : 'Save the article and resolve any save conflict first.');
      const result = await enqueueGoogleMetadataGeneration(articleId);
      if (requestVersion.current !== version) return;
      if (!result.job?.id) throw new Error(isArabic ? 'تعذر إنشاء مهمة التوليد.' : 'Could not create the generation task.');
      setJobId(String(result.job.id));
      setNotice({ error: false, text: isArabic
        ? 'جار توليد عناوين وأوصاف Google فقط وحفظها في الخلفية؛ لن تتغير الصيغ وLSI.'
        : 'Generating and saving Google suggestions in the background; alternatives and LSI are preserved.' });
    } catch (error) {
      if (requestVersion.current !== version) return;
      let message = error instanceof Error ? error.message : (isArabic ? 'تعذر بدء التوليد.' : 'Could not start generation.');
      if (error instanceof ExternalAnalysisRequestError) {
        if (error.code === 'semantic_already_active') message = isArabic
          ? 'توجد مهمة دلالات نشطة بالفعل. انتظر اكتمالها ثم أعد المحاولة عند الحاجة.'
          : 'A semantic task is already active. Wait for completion before retrying.';
        if (error.missingFields.length) message = (isArabic ? 'أكمل المتطلبات: ' : 'Complete the prerequisites: ')
          + getExternalMissingFieldLabels(error.missingFields, locale).join('، ');
      }
      setNotice({ error: true, text: message });
      setBusy(false);
      requestInFlight.current = false;
    }
  };
  const labels = t.leftSidebar;
  const googleTitles = keywords.googleTitles || [];
  const googleDescriptions = keywords.googleDescriptions || [];
  const hasSuggestions = googleTitles.length > 0 || googleDescriptions.length > 0;

  return (
    <section
      className="mx-auto mb-8 mt-4 w-full max-w-[52rem] space-y-3 px-4"
      aria-label={labels.googleMetadataSuggestions}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">{labels.googleMetadataSuggestions}</h3>
        <button type="button" onClick={() => void generateManually()}
          disabled={busy || !articleId || !settled || !keywords.primary.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#d4af37]/50 px-3 py-2 text-xs font-bold text-[#8a6f1d] hover:bg-[#d4af37]/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#f2d675]">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? (isArabic ? 'جار التوليد…' : 'Generating…') : (isArabic ? 'توليد العناوين والأوصاف يدويًا' : 'Generate titles & descriptions manually')}
        </button>
      </div>
      {notice && <p role={notice.error ? 'alert' : 'status'} className={`text-xs leading-5 ${notice.error ? 'text-red-600 dark:text-red-300' : 'text-gray-600 dark:text-gray-300'}`}>{notice.text}</p>}
      {(!articleId || !keywords.primary.trim()) && <p className="text-xs text-gray-500">{isArabic ? 'احفظ المقالة وأدخل الكلمة المفتاحية لتفعيل التوليد اليدوي.' : 'Save the article and enter its primary keyword to enable manual generation.'}</p>}
      {!hasSuggestions && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/10">
          <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{labels.googleMetadataSuggestionsPending}</p>
        </div>
      )}

      {googleTitles.length > 0 && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-white p-3 dark:border-[#d4af37]/30 dark:bg-[#2A2A2A]">
          <h3 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{labels.googleTitleSuggestions}</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {googleTitles.map((suggestion, index) => (
              <article key={`${suggestion}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <p className="text-xs font-bold leading-5 text-gray-800 dark:text-gray-200">{suggestion}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setTitle(suggestion)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                    {labels.useGoogleTitle}
                  </button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(suggestion)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                    <Copy size={12} /> {labels.copy}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {googleDescriptions.length > 0 && (
        <div className="rounded-xl border border-[#d4af37]/35 bg-white p-3 dark:border-[#d4af37]/30 dark:bg-[#2A2A2A]">
          <h3 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{labels.googleDescriptionSuggestions}</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {googleDescriptions.map((suggestion, index) => (
              <article key={`${suggestion.text}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <p className="text-xs font-medium leading-5 text-gray-700 dark:text-gray-300">{suggestion.text}</p>
                {suggestion.callToAction && (
                  <p className="mt-1 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">{labels.callToAction}: {suggestion.callToAction}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setMetaDescription(suggestion.text)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                    {labels.useGoogleDescription}
                  </button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(suggestion.text)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                    <Copy size={12} /> {labels.copy}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export default GoogleMetadataSuggestions;
