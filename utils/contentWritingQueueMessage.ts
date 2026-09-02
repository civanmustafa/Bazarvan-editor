type QueueMessageSession = {
  status: string;
  cancelRequestedAt?: string | null;
  progress: Record<string, unknown>;
};

// Shared by the writing tab and its global activity monitor. Queue diagnostics
// are live, read-only API data, not a persisted claim that a worker is offline.
export const getContentWritingQueueMessage = (
  session: QueueMessageSession | null | undefined,
  isArabic = true,
  now = Date.now(),
): string => {
  if (!session || !['queued', 'retry_scheduled'].includes(session.status)) return '';
  if (session.cancelRequestedAt) return isArabic ? 'بانتظار تأكيد الإلغاء.' : 'Waiting for cancellation confirmation.';
  const raw = session.progress.queue;
  const queue = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const reason = queue.reason;
  const manual = queue.priority === 'manual';
  const priority = manual
    ? (isArabic ? ' طلبك اليدوي له أولوية على المهام التلقائية المنتظرة، دون قطع المقالة الجارية.' : ' Your manual request has priority over waiting automatic jobs, without interrupting the current article.')
    : '';
  const nextAttempt = typeof queue.nextAttemptAt === 'string' ? Date.parse(queue.nextAttemptAt) : NaN;
  if (reason === 'retry_delay') {
    const date = Number.isFinite(nextAttempt)
      ? new Date(nextAttempt).toLocaleString(isArabic ? 'ar' : 'en', { dateStyle: 'short', timeStyle: 'medium' }) : '';
    return (isArabic
      ? `بانتظار موعد إعادة المحاولة${date ? `: ${date}` : ''}. الأولوية اليدوية لا تتجاوز مهلة التهدئة.`
      : `Waiting for the scheduled retry${date ? `: ${date}` : ''}. Manual priority does not bypass the cooldown.`);
  }
  if (reason === 'worker_busy') return (isArabic
    ? 'توجد مقالة قيد التنفيذ. طلبك ينتظر توفر عامل كتابة.'
    : 'An article is currently running. Your request is waiting for an available writing worker.') + priority;
  if (reason === 'earlier_requests') return (isArabic
    ? 'توجد طلبات مؤهلة تسبق طلبك في الطابور.'
    : 'Eligible requests are ahead of yours in the queue.') + priority;
  if (reason === 'awaiting_worker') {
    const delayed = Number.isFinite(nextAttempt) && now - nextAttempt >= 120_000;
    return (isArabic
      ? 'طلبك جاهز وينتظر أن يلتقطه عامل الكتابة.' + (delayed ? ' طال الانتظار؛ إذا استمر، يلزم فحص عامل الكتابة على الخادم.' : '')
      : 'Your request is ready and waiting for the writing worker to pick it up.' + (delayed ? ' The wait is prolonged; if it continues, the server writing worker needs checking.' : '')) + priority;
  }
  return isArabic
    ? 'تم تسجيل طلب الكتابة. جار تحديث سبب الانتظار من الخادم؛ لا حاجة لإرساله مجددًا.'
    : 'Your writing request is saved. Refreshing the wait reason from the server; no need to submit it again.';
};
