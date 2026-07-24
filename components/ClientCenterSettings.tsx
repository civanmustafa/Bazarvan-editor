import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Globe2,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { listRemoteProfiles, type RemoteProfile } from '../utils/supabaseArticles';
import {
  addClientCenterPages,
  createClientCenterClient,
  createClientCenterDomain,
  deleteClientCenterAssignment,
  deleteClientCenterDomain,
  deleteClientCenterPage,
  getCurrentClientCenterUserId,
  listClientCenterClients,
  loadClientCenterDetails,
  refreshClientCenterPage,
  saveClientCenterAssignment,
  setClientCenterPageEnabled,
  updateClientCenterClient,
  updateClientCenterDomain,
  type ClientAssignmentAccess,
  type ClientCenterClient,
  type ClientCenterClientInput,
  type ClientCenterDetails,
  type ClientCenterPage,
} from '../utils/clientCenter';

type ClientCenterTab = 'profile' | 'pages' | 'access';

const EMPTY_DETAILS: ClientCenterDetails = {
  domains: [],
  assignments: [],
  pages: [],
  jobs: [],
};

const EMPTY_CLIENT_INPUT: ClientCenterClientInput = {
  name: '',
  legalName: '',
  country: '',
  defaultLanguage: 'ar',
  industry: '',
  companySummary: '',
  isActive: true,
};

const inputClass = 'w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 outline-none focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';
const secondaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200';
const primaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60';
const dangerButtonClass = 'inline-flex items-center justify-center rounded-md border border-red-200 p-2 text-red-500 hover:bg-red-50 dark:border-red-900/60 dark:hover:bg-red-950/30';

const clientToInput = (client: ClientCenterClient): ClientCenterClientInput => ({
  name: client.name,
  legalName: client.legalName,
  country: client.country,
  defaultLanguage: client.defaultLanguage,
  industry: client.industry,
  companySummary: client.companySummary,
  isActive: client.isActive,
});

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  description?: string;
}> = ({ label, children, description }) => (
  <label className="block space-y-1">
    <span className="text-xs font-black text-gray-600 dark:text-gray-300">{label}</span>
    {description && <span className="block text-[11px] font-semibold leading-5 text-gray-400">{description}</span>}
    {children}
  </label>
);

const formatDate = (value: string | null): string => {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('ar', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
};

const pageStatusLabels: Record<string, string> = {
  pending: 'بانتظار الزحف',
  crawling: 'جارٍ الزحف',
  ready: 'جاهزة',
  needs_review: 'تحتاج مراجعة',
  redirected: 'محولة',
  noindex: 'غير مفهرسة',
  deleted: 'محذوفة',
  blocked: 'محجوبة',
  failed: 'فشل الزحف',
};

const jobStatusLabels: Record<string, string> = {
  queued: 'في قائمة الانتظار',
  running: 'جارٍ التنفيذ',
  retry_scheduled: 'إعادة محاولة مجدولة',
  completed: 'مكتملة',
  failed: 'فشلت',
  cancelled: 'ملغاة',
};

const statusClass = (status: string): string => {
  if (status === 'ready' || status === 'completed') {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (status === 'failed' || status === 'blocked') {
    return 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300';
  }
  if (status === 'crawling' || status === 'running') {
    return 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300';
  }
  return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
};

const PageDetails: React.FC<{ page: ClientCenterPage }> = ({ page }) => (
  <div className="mt-3 grid grid-cols-1 gap-2 border-t border-gray-100 pt-3 text-xs dark:border-[#3C3C3C] md:grid-cols-2 lg:grid-cols-3">
    <div><span className="font-black text-gray-400">العنوان:</span> <span className="text-gray-700 dark:text-gray-200">{page.pageTitle || '-'}</span></div>
    <div><span className="font-black text-gray-400">H1:</span> <span className="text-gray-700 dark:text-gray-200">{page.h1 || '-'}</span></div>
    <div><span className="font-black text-gray-400">اللغة:</span> <span className="text-gray-700 dark:text-gray-200">{page.pageLanguage || '-'}</span></div>
    <div><span className="font-black text-gray-400">HTTP:</span> <span className="text-gray-700 dark:text-gray-200">{page.httpStatus || '-'}</span></div>
    <div><span className="font-black text-gray-400">الكلمات:</span> <span className="text-gray-700 dark:text-gray-200">{page.wordCount.toLocaleString('ar')}</span></div>
    <div><span className="font-black text-gray-400">الفهرسة:</span> <span className="text-gray-700 dark:text-gray-200">{page.robotsIndex === false ? 'noindex' : page.robotsIndex === true ? 'index' : '-'}</span></div>
    <div className="md:col-span-2 lg:col-span-3"><span className="font-black text-gray-400">الوصف:</span> <span className="text-gray-700 dark:text-gray-200">{page.metaDescription || '-'}</span></div>
    <div className="md:col-span-2 lg:col-span-3"><span className="font-black text-gray-400">الرابط النهائي:</span> <span className="break-all text-gray-700 dark:text-gray-200">{page.finalUrl || '-'}</span></div>
    {page.extractedTerms.length > 0 && (
      <div className="md:col-span-2 lg:col-span-3">
        <span className="font-black text-gray-400">أبرز المصطلحات المستخرجة برمجيًا:</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {page.extractedTerms.slice(0, 15).map(term => (
            <span key={term} className="rounded-full bg-gray-100 px-2 py-1 font-bold text-gray-600 dark:bg-[#1F1F1F] dark:text-gray-300">{term}</span>
          ))}
        </div>
      </div>
    )}
  </div>
);

const ClientCenterSettings: React.FC = () => {
  const { currentUserRole } = useUser();
  const isAdmin = currentUserRole === 'admin';
  const [clients, setClients] = useState<ClientCenterClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [details, setDetails] = useState<ClientCenterDetails>(EMPTY_DETAILS);
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [selectedTab, setSelectedTab] = useState<ClientCenterTab>('profile');
  const [clientInput, setClientInput] = useState<ClientCenterClientInput>(EMPTY_CLIENT_INPUT);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailsLoading, setIsDetailsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [domainPrimary, setDomainPrimary] = useState(false);
  const [domainSubdomains, setDomainSubdomains] = useState(false);
  const [assignmentUserId, setAssignmentUserId] = useState('');
  const [assignmentAccess, setAssignmentAccess] = useState<ClientAssignmentAccess>('viewer');
  const [urlsInput, setUrlsInput] = useState('');
  const [pageQuery, setPageQuery] = useState('');
  const [expandedPageId, setExpandedPageId] = useState('');

  const selectedClient = clients.find(client => client.id === selectedClientId) || null;
  const ownAssignment = details.assignments.find(assignment => assignment.userId === currentUserId && assignment.isActive);
  const canEditPages = isAdmin || ownAssignment?.accessLevel === 'editor';

  const showMessage = (value: string): void => {
    setMessage(value);
    setError('');
  };

  const showError = (value: unknown): void => {
    setError(value instanceof Error ? value.message : 'حدث خطأ غير متوقع في مركز العملاء.');
    setMessage('');
  };

  const refreshClients = useCallback(async (preferredClientId?: string) => {
    setIsLoading(true);
    try {
      const [rows, userId, profileRows] = await Promise.all([
        listClientCenterClients(),
        getCurrentClientCenterUserId(),
        isAdmin ? listRemoteProfiles() : Promise.resolve([]),
      ]);
      setClients(rows);
      setCurrentUserId(userId);
      setProfiles(profileRows);
      setSelectedClientId(current => {
        const preferred = preferredClientId || current;
        return rows.some(client => client.id === preferred) ? preferred : rows[0]?.id || '';
      });
      setError('');
    } catch (loadError) {
      showError(loadError);
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin]);

  const refreshDetails = useCallback(async (clientId: string, quiet = false) => {
    if (!clientId) {
      setDetails(EMPTY_DETAILS);
      return;
    }
    if (!quiet) setIsDetailsLoading(true);
    try {
      const value = await loadClientCenterDetails(clientId);
      setDetails(value);
      if (!quiet) setError('');
    } catch (loadError) {
      if (!quiet) showError(loadError);
    } finally {
      if (!quiet) setIsDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshClients();
  }, [refreshClients]);

  useEffect(() => {
    if (!selectedClientId) {
      setDetails(EMPTY_DETAILS);
      return;
    }
    void refreshDetails(selectedClientId);
  }, [refreshDetails, selectedClientId]);

  useEffect(() => {
    if (selectedClient) setClientInput(clientToInput(selectedClient));
  }, [selectedClient]);

  const hasActiveJobs = details.jobs.some(job => (
    job.status === 'queued' || job.status === 'running' || job.status === 'retry_scheduled'
  ));

  useEffect(() => {
    if (!selectedClientId || !hasActiveJobs) return;
    const timer = window.setInterval(() => {
      void refreshDetails(selectedClientId, true);
    }, 7_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, refreshDetails, selectedClientId]);

  const latestJobByPage = useMemo(() => {
    const result = new Map<string, ClientCenterDetails['jobs'][number]>();
    details.jobs.forEach(job => {
      if (!result.has(job.pageId)) result.set(job.pageId, job);
    });
    return result;
  }, [details.jobs]);

  const filteredPages = useMemo(() => {
    const query = pageQuery.trim().toLowerCase();
    if (!query) return details.pages;
    return details.pages.filter(page => [
      page.inputUrl,
      page.finalUrl,
      page.canonicalUrl,
      page.pageTitle,
      page.metaDescription,
      page.h1,
      page.crawlStatus,
      page.lastErrorMessage,
    ].join(' ').toLowerCase().includes(query));
  }, [details.pages, pageQuery]);

  const runMutation = async (
    action: () => Promise<void>,
    successMessage: string,
    options: { refreshClients?: boolean; refreshDetails?: boolean } = { refreshDetails: true },
  ): Promise<void> => {
    if (isSaving) return;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      await action();
      if (options.refreshClients) await refreshClients(selectedClientId);
      if (options.refreshDetails !== false && selectedClientId) await refreshDetails(selectedClientId);
      showMessage(successMessage);
    } catch (mutationError) {
      showError(mutationError);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateClient = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!clientInput.name?.trim()) {
      showError(new Error('اسم العميل مطلوب.'));
      return;
    }
    setIsSaving(true);
    try {
      const created = await createClientCenterClient(clientInput);
      setIsCreatingClient(false);
      await refreshClients(created.id);
      showMessage('تم إنشاء العميل. أضف الدومين قبل إدخال الروابط.');
    } catch (createError) {
      showError(createError);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveClient = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClient || !clientInput.name?.trim()) return;
    await runMutation(async () => {
      await updateClientCenterClient(selectedClient.id, clientInput);
    }, 'تم حفظ بيانات العميل.', { refreshClients: true, refreshDetails: false });
  };

  const handleAddDomain = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClientId || !domainInput.trim()) return;
    await runMutation(async () => {
      await createClientCenterDomain({
        clientId: selectedClientId,
        hostname: domainInput,
        isPrimary: details.domains.length === 0 || domainPrimary,
        includeSubdomains: domainSubdomains,
      });
      setDomainInput('');
      setDomainPrimary(false);
      setDomainSubdomains(false);
    }, 'تمت إضافة الدومين.');
  };

  const handleSaveAssignment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClientId || !assignmentUserId) return;
    await runMutation(async () => {
      await saveClientCenterAssignment({
        clientId: selectedClientId,
        userId: assignmentUserId,
        accessLevel: assignmentAccess,
      });
      setAssignmentUserId('');
      setAssignmentAccess('viewer');
    }, 'تم حفظ صلاحية الموظف.');
  };

  const handleAddPages = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClientId || !urlsInput.trim()) return;
    if (details.domains.length === 0) {
      showError(new Error('أضف دومين العميل أولًا حتى يمنع النظام زحف أي موقع خارج نطاق العميل.'));
      return;
    }
    setIsSaving(true);
    try {
      const result = await addClientCenterPages({
        clientId: selectedClientId,
        urls: urlsInput.split(/[\n,]+/),
        domains: details.domains,
      });
      setUrlsInput(result.rejected.length > 0 ? result.rejected.join('\n') : '');
      await refreshDetails(selectedClientId);
      showMessage(
        `تم قبول ${result.accepted} رابط ووضع ${result.queued} مهمة زحف في قائمة الانتظار`
        + (result.rejected.length > 0 ? `، ورُفض ${result.rejected.length} رابط خارج الدومينات المسجلة.` : '.'),
      );
    } catch (addError) {
      showError(addError);
    } finally {
      setIsSaving(false);
    }
  };

  const renderClientForm = (creating: boolean) => (
    <form onSubmit={creating ? handleCreateClient : handleSaveClient} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="اسم العميل">
          <input className={inputClass} value={clientInput.name || ''} onChange={event => setClientInput(prev => ({ ...prev, name: event.target.value }))} required maxLength={160} />
        </Field>
        <Field label="الاسم القانوني">
          <input className={inputClass} value={clientInput.legalName || ''} onChange={event => setClientInput(prev => ({ ...prev, legalName: event.target.value }))} maxLength={240} />
        </Field>
        <Field label="الدولة">
          <input className={inputClass} value={clientInput.country || ''} onChange={event => setClientInput(prev => ({ ...prev, country: event.target.value }))} maxLength={120} />
        </Field>
        <Field label="اللغة الافتراضية" description="رمز اللغة مثل ar أو en أو ar-sa.">
          <input className={inputClass} dir="ltr" value={clientInput.defaultLanguage || 'ar'} onChange={event => setClientInput(prev => ({ ...prev, defaultLanguage: event.target.value }))} maxLength={24} />
        </Field>
        <Field label="المجال">
          <input className={inputClass} value={clientInput.industry || ''} onChange={event => setClientInput(prev => ({ ...prev, industry: event.target.value }))} maxLength={200} />
        </Field>
        <Field label="حالة العميل">
          <select className={inputClass} value={clientInput.isActive === false ? 'inactive' : 'active'} onChange={event => setClientInput(prev => ({ ...prev, isActive: event.target.value === 'active' }))}>
            <option value="active">نشط</option>
            <option value="inactive">غير نشط</option>
          </select>
        </Field>
      </div>
      <Field label="نبذة الشركة">
        <textarea className={`${inputClass} min-h-28 resize-y`} value={clientInput.companySummary || ''} onChange={event => setClientInput(prev => ({ ...prev, companySummary: event.target.value }))} maxLength={4000} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={isSaving} className={primaryButtonClass}>
          {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : creating ? <Plus size={16} /> : <Save size={16} />}
          <span>{creating ? 'إنشاء العميل' : 'حفظ البيانات'}</span>
        </button>
        {creating && (
          <button type="button" onClick={() => setIsCreatingClient(false)} className={secondaryButtonClass}>إلغاء</button>
        )}
      </div>
    </form>
  );

  const renderProfileTab = () => (
    <div className="space-y-5">
      {isAdmin ? renderClientForm(false) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[
            ['اسم العميل', selectedClient?.name],
            ['الاسم القانوني', selectedClient?.legalName],
            ['الدولة', selectedClient?.country],
            ['اللغة الافتراضية', selectedClient?.defaultLanguage],
            ['المجال', selectedClient?.industry],
            ['نبذة الشركة', selectedClient?.companySummary],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
              <div className="text-xs font-black text-gray-400">{label}</div>
              <div className="mt-1 text-sm font-semibold text-gray-700 dark:text-gray-200">{value || '-'}</div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-gray-100 pt-5 dark:border-[#3C3C3C]">
        <div className="mb-3 flex items-center gap-2">
          <Globe2 className="text-[#d4af37]" size={18} />
          <h3 className="font-black text-gray-800 dark:text-gray-100">دومينات العميل</h3>
        </div>
        <p className="mb-3 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          لا يسمح عامل الزحف بمعالجة رابط إلا إذا كان تابعًا لأحد هذه الدومينات. تفعيل النطاقات الفرعية يسمح مثلًا بـ blog.example.com.
        </p>
        {isAdmin && (
          <form onSubmit={handleAddDomain} className="mb-4 grid grid-cols-1 gap-3 rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F] md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-end">
            <Field label="الدومين أو رابط الموقع">
              <input className={inputClass} dir="ltr" placeholder="example.com" value={domainInput} onChange={event => setDomainInput(event.target.value)} />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-xs font-bold text-gray-600 dark:text-gray-300">
              <input type="checkbox" checked={domainPrimary} onChange={event => setDomainPrimary(event.target.checked)} />
              رئيسي
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs font-bold text-gray-600 dark:text-gray-300">
              <input type="checkbox" checked={domainSubdomains} onChange={event => setDomainSubdomains(event.target.checked)} />
              النطاقات الفرعية
            </label>
            <button type="submit" disabled={isSaving || !domainInput.trim()} className={primaryButtonClass}><Plus size={16} /> إضافة</button>
          </form>
        )}
        <div className="space-y-2">
          {details.domains.length === 0 && <div className="rounded-md border border-dashed border-gray-200 p-4 text-center text-sm font-semibold text-gray-400 dark:border-[#3C3C3C]">لم تتم إضافة دومين بعد.</div>}
          {details.domains.map(domain => (
            <div key={domain.id} className="flex flex-col gap-3 rounded-md border border-gray-200 p-3 dark:border-[#3C3C3C] md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div dir="ltr" className="truncate text-sm font-black text-gray-800 dark:text-gray-100">{domain.hostname}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-bold text-gray-400">
                  {domain.isPrimary && <span>الدومين الرئيسي</span>}
                  {domain.includeSubdomains && <span>يشمل النطاقات الفرعية</span>}
                  {!domain.isActive && <span className="text-red-500">معطل</span>}
                </div>
              </div>
              {isAdmin && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={secondaryButtonClass} onClick={() => runMutation(
                    () => updateClientCenterDomain(domain.id, domain.clientId, { isPrimary: true }),
                    'تم تعيين الدومين رئيسيًا.',
                  )}>تعيين رئيسي</button>
                  <button type="button" className={secondaryButtonClass} onClick={() => runMutation(
                    () => updateClientCenterDomain(domain.id, domain.clientId, { includeSubdomains: !domain.includeSubdomains }),
                    'تم تحديث إعداد النطاقات الفرعية.',
                  )}>{domain.includeSubdomains ? 'منع الفرعية' : 'السماح بالفرعية'}</button>
                  <button type="button" className={dangerButtonClass} title="حذف الدومين" onClick={() => {
                    if (window.confirm('هل تريد حذف هذا الدومين؟')) {
                      void runMutation(() => deleteClientCenterDomain(domain.id), 'تم حذف الدومين.');
                    }
                  }}><Trash2 size={15} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderPagesTab = () => (
    <div className="space-y-4">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs font-semibold leading-6 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
        تُقرأ صفحات الموقع العامة فقط. يستخرج النظام العنوان والوصف والعناوين واللغة والفهرسة والمصطلحات بخوارزميات برمجية، ولا يستخدم مقالات المحرر أو الذكاء الاصطناعي.
      </div>
      {canEditPages && (
        <form onSubmit={handleAddPages} className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <Field label="إدخال الروابط يدويًا" description="ضع كل رابط في سطر مستقل. الحد الأقصى 100 رابط في العملية، ويجب أن تتبع الروابط الدومينات المسجلة.">
            <textarea dir="ltr" className={`${inputClass} min-h-28 resize-y text-left`} placeholder={'https://example.com/page-1\nhttps://example.com/page-2'} value={urlsInput} onChange={event => setUrlsInput(event.target.value)} />
          </Field>
          <button type="submit" disabled={isSaving || !urlsInput.trim()} className={`${primaryButtonClass} mt-3`}>
            {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : <Link2 size={16} />}
            إضافة وبدء الزحف
          </button>
        </form>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2 text-xs font-black text-gray-500">
          <span>إجمالي الروابط: {details.pages.length.toLocaleString('ar')}</span>
          <span>الجاهزة: {details.pages.filter(page => page.crawlStatus === 'ready').length.toLocaleString('ar')}</span>
          <span>قيد التنفيذ: {details.pages.filter(page => page.crawlStatus === 'pending' || page.crawlStatus === 'crawling').length.toLocaleString('ar')}</span>
        </div>
        <label className="relative block sm:w-72">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
          <input className={`${inputClass} pr-9`} placeholder="بحث في الروابط والبيانات..." value={pageQuery} onChange={event => setPageQuery(event.target.value)} />
        </label>
      </div>

      <div className="space-y-2">
        {filteredPages.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-200 p-6 text-center dark:border-[#3C3C3C]">
            <Link2 className="mx-auto text-gray-300" size={28} />
            <div className="mt-2 text-sm font-bold text-gray-400">لا توجد روابط مسجلة.</div>
          </div>
        )}
        {filteredPages.map(page => {
          const latestJob = latestJobByPage.get(page.id);
          const expanded = expandedPageId === page.id;
          return (
            <article key={page.id} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setExpandedPageId(expanded ? '' : page.id)}>
                  <div className="flex min-w-0 items-center gap-2">
                    <ChevronDown className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} size={16} />
                    <span className="truncate text-sm font-black text-gray-800 dark:text-gray-100">{page.pageTitle || page.inputUrl}</span>
                  </div>
                  <div dir="ltr" className="mt-1 truncate pl-1 text-left text-xs font-semibold text-gray-400">{page.inputUrl}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2 py-1 text-[11px] font-black ${statusClass(page.crawlStatus)}`}>{pageStatusLabels[page.crawlStatus] || page.crawlStatus}</span>
                    {latestJob && <span className={`rounded-full px-2 py-1 text-[11px] font-black ${statusClass(latestJob.status)}`}>{jobStatusLabels[latestJob.status] || latestJob.status}</span>}
                    {page.lastCrawledAt && <span className="px-2 py-1 text-[11px] font-bold text-gray-400">آخر زحف: {formatDate(page.lastCrawledAt)}</span>}
                  </div>
                </button>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <a href={page.finalUrl || page.inputUrl} target="_blank" rel="noreferrer" className={secondaryButtonClass}><ExternalLink size={15} /> فتح</a>
                  {canEditPages && (
                    <>
                      <button type="button" className={secondaryButtonClass} onClick={() => runMutation(
                        async () => {
                          const queued = await refreshClientCenterPage(page.clientId, page.id);
                          if (!queued) throw new Error('يوجد زحف نشط لهذا الرابط بالفعل.');
                        },
                        'تمت إضافة مهمة تحديث الرابط.',
                      )}><RefreshCw size={15} /> إعادة الزحف</button>
                      <button type="button" className={secondaryButtonClass} onClick={() => runMutation(
                        () => setClientCenterPageEnabled(page.id, !page.isEnabled),
                        page.isEnabled ? 'تم تعطيل الرابط.' : 'تم تفعيل الرابط.',
                      )}>{page.isEnabled ? <XCircle size={15} /> : <CheckCircle2 size={15} />}{page.isEnabled ? 'تعطيل' : 'تفعيل'}</button>
                      <button type="button" className={dangerButtonClass} title="حذف الرابط" onClick={() => {
                        if (window.confirm('سيُحذف الرابط وسجل مهام زحفه. هل تريد المتابعة؟')) {
                          void runMutation(() => deleteClientCenterPage(page.id), 'تم حذف الرابط.');
                        }
                      }}><Trash2 size={15} /></button>
                    </>
                  )}
                </div>
              </div>
              {(page.lastErrorMessage || latestJob?.errorMessage) && (
                <div className="mt-3 rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  {page.lastErrorMessage || latestJob?.errorMessage}
                </div>
              )}
              {expanded && <PageDetails page={page} />}
            </article>
          );
        })}
      </div>
    </div>
  );

  const getProfileLabel = (profile: RemoteProfile | undefined): string => (
    profile?.fullName?.trim() || profile?.email?.trim() || profile?.id || 'مستخدم غير معروف'
  );

  const renderAccessTab = () => (
    <div className="space-y-4">
      <div className="rounded-md border border-gray-200 p-3 text-xs font-semibold leading-6 text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">
        صلاحية «عرض» تسمح بمشاهدة بيانات العميل والروابط. صلاحية «تعديل» تسمح أيضًا بإضافة الروابط وإعادة زحفها. إنشاء العميل والدومينات وتعيين الموظفين يبقى للمسؤول فقط.
      </div>
      {isAdmin && (
        <form onSubmit={handleSaveAssignment} className="grid grid-cols-1 gap-3 rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F] md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end">
          <Field label="الموظف">
            <select className={inputClass} value={assignmentUserId} onChange={event => setAssignmentUserId(event.target.value)}>
              <option value="">اختر موظفًا</option>
              {profiles.filter(profile => profile.isActive && profile.role !== 'admin').map(profile => (
                <option key={profile.id} value={profile.id}>{getProfileLabel(profile)}</option>
              ))}
            </select>
          </Field>
          <Field label="الصلاحية">
            <select className={inputClass} value={assignmentAccess} onChange={event => setAssignmentAccess(event.target.value as ClientAssignmentAccess)}>
              <option value="viewer">عرض</option>
              <option value="editor">تعديل الروابط</option>
            </select>
          </Field>
          <button type="submit" disabled={isSaving || !assignmentUserId} className={primaryButtonClass}><UserPlus size={16} /> حفظ</button>
        </form>
      )}
      <div className="space-y-2">
        {details.assignments.length === 0 && <div className="rounded-md border border-dashed border-gray-200 p-4 text-center text-sm font-semibold text-gray-400 dark:border-[#3C3C3C]">لا يوجد موظفون معيّنون لهذا العميل.</div>}
        {details.assignments.map(assignment => {
          const profile = profiles.find(item => item.id === assignment.userId);
          const label = isAdmin ? getProfileLabel(profile) : assignment.userId === currentUserId ? 'حسابي' : assignment.userId;
          return (
            <div key={assignment.id} className="flex items-center justify-between gap-3 rounded-md border border-gray-200 p-3 dark:border-[#3C3C3C]">
              <div>
                <div className="text-sm font-black text-gray-800 dark:text-gray-100">{label}</div>
                <div className="mt-1 text-xs font-bold text-gray-400">{assignment.accessLevel === 'editor' ? 'تعديل الروابط والزحف' : 'عرض فقط'}</div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <select className={`${inputClass} w-auto`} value={assignment.accessLevel} onChange={event => {
                    void runMutation(
                      () => saveClientCenterAssignment({
                        clientId: assignment.clientId,
                        userId: assignment.userId,
                        accessLevel: event.target.value as ClientAssignmentAccess,
                      }),
                      'تم تحديث صلاحية الموظف.',
                    );
                  }}>
                    <option value="viewer">عرض</option>
                    <option value="editor">تعديل</option>
                  </select>
                  <button type="button" className={dangerButtonClass} onClick={() => {
                    if (window.confirm('هل تريد إزالة الموظف من هذا العميل؟')) {
                      void runMutation(() => deleteClientCenterAssignment(assignment.id), 'تمت إزالة الموظف.');
                    }
                  }}><Trash2 size={15} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-[#d4af37]/30 bg-[#d4af37]/10 p-4">
        <div className="flex items-start gap-3">
          <Building2 className="mt-0.5 shrink-0 text-[#b8922e]" size={22} />
          <div>
            <h2 className="font-black text-gray-900 dark:text-gray-100">مركز العملاء</h2>
            <p className="mt-1 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
              سجل مركزي مستقل عن مقالات المحرر لإدارة العملاء ودوميناتهم وروابط مواقعهم. لا يتضمن الحقول المستبعدة، ولا يعتمد على Search Console.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          <CircleAlert className="mt-0.5 shrink-0" size={17} /><span>{error}</span>
        </div>
      )}
      {message && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 shrink-0" size={17} /><span>{message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-black text-gray-800 dark:text-gray-100"><Users size={17} /> العملاء</div>
            {isAdmin && (
              <button type="button" className={primaryButtonClass} onClick={() => {
                setClientInput(EMPTY_CLIENT_INPUT);
                setIsCreatingClient(true);
              }}><Plus size={15} /> جديد</button>
            )}
          </div>
          {isLoading && <div className="flex items-center justify-center gap-2 p-5 text-sm font-bold text-gray-400"><LoaderCircle className="animate-spin" size={18} /> جارٍ التحميل</div>}
          {!isLoading && clients.length === 0 && <div className="rounded-md border border-dashed border-gray-200 p-4 text-center text-sm font-semibold text-gray-400 dark:border-[#3C3C3C]">لا يوجد عملاء متاحون.</div>}
          <div className="space-y-1">
            {clients.map(client => (
              <button key={client.id} type="button" onClick={() => {
                setIsCreatingClient(false);
                setSelectedClientId(client.id);
                setSelectedTab('profile');
                setMessage('');
                setError('');
              }} className={`w-full rounded-md px-3 py-2 text-start transition-colors ${selectedClientId === client.id && !isCreatingClient ? 'bg-[#d4af37] text-white' : 'bg-gray-50 text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-200'}`}>
                <div className="truncate text-sm font-black">{client.name}</div>
                <div className={`mt-1 truncate text-[11px] font-bold ${selectedClientId === client.id && !isCreatingClient ? 'text-white/75' : 'text-gray-400'}`}>{client.industry || client.country || 'بدون تصنيف'}{!client.isActive ? ' • غير نشط' : ''}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
          {isCreatingClient && isAdmin ? (
            <div>
              <h3 className="mb-4 text-lg font-black text-gray-900 dark:text-gray-100">إنشاء عميل جديد</h3>
              {renderClientForm(true)}
            </div>
          ) : !selectedClient ? (
            <div className="py-12 text-center">
              <Building2 className="mx-auto text-gray-300" size={36} />
              <div className="mt-3 font-black text-gray-500">اختر عميلًا أو أنشئ عميلًا جديدًا.</div>
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-col gap-3 border-b border-gray-100 pb-4 dark:border-[#3C3C3C] sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-xl font-black text-gray-900 dark:text-gray-100">{selectedClient.name}</h3>
                  <div className="mt-1 text-xs font-semibold text-gray-400">{details.domains.find(domain => domain.isPrimary)?.hostname || 'لم يحدد دومين رئيسي'}</div>
                </div>
                <button type="button" className={secondaryButtonClass} onClick={() => void refreshDetails(selectedClient.id)}>
                  <RefreshCw className={isDetailsLoading ? 'animate-spin' : ''} size={15} /> تحديث
                </button>
              </div>
              <div className="mb-5 grid grid-cols-3 gap-2">
                {([
                  ['profile', 'البيانات والدومينات', <Globe2 size={16} />],
                  ['pages', 'روابط الموقع', <Link2 size={16} />],
                  ['access', 'الموظفون والصلاحيات', <ShieldCheck size={16} />],
                ] as const).map(([key, label, icon]) => (
                  <button key={key} type="button" onClick={() => setSelectedTab(key)} className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-xs font-black transition-colors ${selectedTab === key ? 'bg-[#d4af37] text-white' : 'bg-gray-100 text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
                    {icon}<span>{label}</span>
                  </button>
                ))}
              </div>
              {isDetailsLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm font-bold text-gray-400"><LoaderCircle className="animate-spin" size={20} /> جارٍ تحميل بيانات العميل</div>
              ) : selectedTab === 'pages' ? renderPagesTab() : selectedTab === 'access' ? renderAccessTab() : renderProfileTab()}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default ClientCenterSettings;
