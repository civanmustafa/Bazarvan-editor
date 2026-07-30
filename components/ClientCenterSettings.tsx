import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Globe2,
  Link2,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Square,
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
  decodeClientUrlForDisplay,
  deleteClientCenterAssignment,
  deleteClientCenterPage,
  deleteClientLinkDictionary,
  deleteInternalLinkQualityPolicy,
  getCurrentClientCenterUserId,
  listClientCenterClients,
  loadClientCenterDetails,
  normalizeClientPrimaryDomain,
  refreshClientCenterPage,
  rebuildClientSemanticProfiles,
  reviewClientPageAiLinkProfile,
  saveClientCenterAssignment,
  saveClientCenterPrimaryDomain,
  saveClientLinkDictionary,
  saveInternalLinkQualityPolicy,
  setClientLinkDictionaryEnabled,
  setClientCenterPageEnabled,
  updateClientCenterClient,
  type ClientAssignmentAccess,
  type ClientCenterClient,
  type ClientCenterClientInput,
  type ClientCenterDetails,
  type ClientCenterPage,
} from '../utils/clientCenter';
import {
  isClientSemanticProfileCurrent,
  type ClientLinkDictionaryType,
  type ClientPageSemanticProfile,
} from '../utils/clientSemanticIndex';
import type {
  ClientLinkProfileReviewStatus,
  ClientPageAiLinkProfile,
} from '../utils/clientLinkPhraseProfile';
import {
  DEFAULT_INTERNAL_LINK_QUALITY_POLICY,
  normalizeInternalLinkQualityPolicy,
  type InternalLinkQualityPolicyValues,
} from '../utils/internalLinkQualityPolicy';
import { notifyClientDirectoryChanged } from '../hooks/useClientDirectory';
import {
  cancelClientSiteCrawl,
  loadClientSiteCrawlState,
  startClientSiteCrawl,
  type ClientSiteCrawlProvider,
  type ClientSiteCrawlState,
} from '../utils/clientSiteCrawler';

type ClientCenterTab = 'profile' | 'pages' | 'index' | 'access';

const EMPTY_DETAILS: ClientCenterDetails = {
  domains: [],
  assignments: [],
  pages: [],
  jobs: [],
  dictionaries: [],
  semanticProfiles: [],
  aiLinkProfiles: [],
  qualityPolicies: [],
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

const EMPTY_SITE_CRAWL_STATE: ClientSiteCrawlState = {
  runs: [],
  activeInternalLinkCount: 0,
  providerAvailability: {
    auto: true,
    local: true,
    firecrawl: false,
    browserless: false,
  },
  links: [],
};

const crawlProviderLabels: Record<ClientSiteCrawlProvider, string> = {
  auto: 'تلقائي: محلي ثم خارجي عند الحاجة',
  local: 'محلي فقط',
  firecrawl: 'Firecrawl',
  browserless: 'Browserless',
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

const QualityPolicyFields: React.FC<{
  value: InternalLinkQualityPolicyValues;
  disabled?: boolean;
  onChange: (patch: Partial<InternalLinkQualityPolicyValues>) => void;
}> = ({ value, disabled = false, onChange }) => (
  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
    <Field label="الحد الأدنى لدرجة الصلة" description="لا يظهر أي اقتراح تقل درجته عن هذه القيمة من 100.">
      <input type="number" min={0} max={100} className={inputClass} disabled={disabled} value={value.minimumScore} onChange={event => onChange({ minimumScore: Number(event.target.value) })} />
    </Field>
    <Field label="الروابط لكل 1000 كلمة" description="يحسب المحرك سقفًا تلقائيًا بحسب طول المقالة.">
      <input type="number" min={0.5} max={20} step={0.5} className={inputClass} disabled={disabled} value={value.maxLinksPer1000Words} onChange={event => onChange({ maxLinksPer1000Words: Number(event.target.value) })} />
    </Field>
    <Field label="الحد الأقصى المطلق للروابط">
      <input type="number" min={1} max={50} className={inputClass} disabled={disabled} value={value.absoluteMaximumLinks} onChange={event => onChange({ absoluteMaximumLinks: Number(event.target.value) })} />
    </Field>
    <Field label="أقصى تكرار للرابط الهدف" description="يشمل الروابط الموجودة في المقالة قبل إضافة اقتراح جديد.">
      <input type="number" min={1} max={5} className={inputClass} disabled={disabled} value={value.maximumLinksPerTarget} onChange={event => onChange({ maximumLinksPerTarget: Number(event.target.value) })} />
    </Field>
    <Field label="أقل عدد كلمات دلالية متطابقة">
      <input type="number" min={2} max={5} className={inputClass} disabled={disabled} value={value.minimumMatchedTerms} onChange={event => onChange({ minimumMatchedTerms: Number(event.target.value) })} />
    </Field>
    <div className="md:col-span-2 lg:col-span-3">
      <Field label="نصوص Anchor Text غير المسموحة" description="ضع كل عبارة في سطر. هذه قائمة خاصة بالروابط، وليست قائمة مصطلحات للكتابة.">
        <textarea
          className={`${inputClass} min-h-28 resize-y`}
          disabled={disabled}
          value={value.forbiddenAnchors.join('\n')}
          onChange={event => onChange({
            forbiddenAnchors: event.target.value.split(/\r?\n/),
          })}
          placeholder={'اضغط هنا\nاعرف المزيد\nاقرأ المزيد'}
        />
      </Field>
    </div>
  </div>
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

const aiGenerationStatusLabels: Record<ClientPageAiLinkProfile['generationStatus'], string> = {
  pending: 'جارٍ التوليد',
  ready: 'تم التوليد',
  skipped: 'تم التجاوز',
  failed: 'فشل التوليد',
};

const aiReviewStatusLabels: Record<ClientPageAiLinkProfile['reviewStatus'], string> = {
  pending: 'بانتظار مراجعة المسؤول',
  approved: 'معتمد',
  rejected: 'مرفوض',
};

const aiIntentLabels: Record<Exclude<ClientPageAiLinkProfile['pageIntent'], ''>, string> = {
  informational: 'معلوماتي',
  commercial: 'تجاري',
  transactional: 'إجرائي',
  navigational: 'تنقلي',
  local: 'محلي',
  mixed: 'مختلط',
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

const PageDetails: React.FC<{
  page: ClientCenterPage;
  semanticProfile?: ClientPageSemanticProfile;
  aiLinkProfile?: ClientPageAiLinkProfile;
  canReviewAiProfile: boolean;
  isSaving: boolean;
  onReviewAiProfile: (status: ClientLinkProfileReviewStatus) => void;
}> = ({
  page,
  semanticProfile,
  aiLinkProfile,
  canReviewAiProfile,
  isSaving,
  onReviewAiProfile,
}) => (
  <div className="mt-3 grid grid-cols-1 gap-2 border-t border-gray-100 pt-3 text-xs dark:border-[#3C3C3C] md:grid-cols-2 lg:grid-cols-3">
    <div><span className="font-black text-gray-400">العنوان:</span> <span className="text-gray-700 dark:text-gray-200">{page.pageTitle || '-'}</span></div>
    <div><span className="font-black text-gray-400">H1:</span> <span className="text-gray-700 dark:text-gray-200">{page.h1 || '-'}</span></div>
    <div><span className="font-black text-gray-400">اللغة:</span> <span className="text-gray-700 dark:text-gray-200">{page.pageLanguage || '-'}</span></div>
    <div><span className="font-black text-gray-400">HTTP:</span> <span className="text-gray-700 dark:text-gray-200">{page.httpStatus || '-'}</span></div>
    <div><span className="font-black text-gray-400">الكلمات:</span> <span className="text-gray-700 dark:text-gray-200">{page.wordCount.toLocaleString('ar')}</span></div>
    <div><span className="font-black text-gray-400">الفهرسة:</span> <span className="text-gray-700 dark:text-gray-200">{page.robotsIndex === false ? 'noindex' : page.robotsIndex === true ? 'index' : '-'}</span></div>
    <div><span className="font-black text-gray-400">اكتمال الملف الخوارزمي:</span> <span className="text-gray-700 dark:text-gray-200">{semanticProfile ? `${semanticProfile.completenessScore}%` : 'غير مبني'}</span></div>
    <div className="md:col-span-2 lg:col-span-3"><span className="font-black text-gray-400">الوصف:</span> <span className="text-gray-700 dark:text-gray-200">{page.metaDescription || '-'}</span></div>
    <div className="md:col-span-2 lg:col-span-3">
      <span className="font-black text-gray-400">الرابط النهائي:</span>{' '}
      <span
        className="break-all text-gray-700 dark:text-gray-200"
        dir="ltr"
        title={page.finalUrl || undefined}
      >
        {decodeClientUrlForDisplay(page.finalUrl) || '-'}
      </span>
    </div>
    <div className="md:col-span-2 lg:col-span-3">
      <div className="rounded-md border border-[#d4af37]/30 bg-[#d4af37]/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-black text-[#9b7d20]">ملف عبارات الربط الذكي</span>
          {aiLinkProfile ? (
            <>
              <span className={`rounded-full px-2 py-1 text-[10px] font-black ${statusClass(
                aiLinkProfile.generationStatus === 'ready'
                  ? 'completed'
                  : aiLinkProfile.generationStatus === 'failed'
                    ? 'failed'
                    : 'pending',
              )}`}>
                {aiGenerationStatusLabels[aiLinkProfile.generationStatus]}
              </span>
              <span className={`rounded-full px-2 py-1 text-[10px] font-black ${
                aiLinkProfile.reviewStatus === 'approved'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : aiLinkProfile.reviewStatus === 'rejected'
                    ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
              }`}>
                {aiReviewStatusLabels[aiLinkProfile.reviewStatus]}
              </span>
              {aiLinkProfile.generationStatus === 'ready' && (
                <span className="font-bold text-gray-400">الثقة: {aiLinkProfile.confidence}%</span>
              )}
              {aiLinkProfile.pageIntent && (
                <span className="font-bold text-gray-400">
                  النية: {aiIntentLabels[aiLinkProfile.pageIntent]}
                </span>
              )}
            </>
          ) : (
            <span className="font-bold text-gray-400">
              يُنشأ بعد إعادة زحف الصفحة عند تفعيل الإثراء الذكي.
            </span>
          )}
        </div>
        {aiLinkProfile?.generationStatus === 'ready' && (
          <div className="mt-3 space-y-2">
            <div>
              <span className="font-black text-gray-500">العبارة الأساسية:</span>{' '}
              <span className="font-black text-gray-800 dark:text-gray-100">
                {aiLinkProfile.primaryPhrase}
              </span>
            </div>
            {aiLinkProfile.alternativePhrases.length > 0 && (
              <div>
                <span className="font-black text-gray-500">الصيغ البديلة:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {aiLinkProfile.alternativePhrases.map(phrase => (
                    <span key={phrase} className="rounded-full bg-blue-50 px-2 py-1 font-bold text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                      {phrase}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {aiLinkProfile.longTailPhrases.length > 0 && (
              <div>
                <span className="font-black text-gray-500">الصيغ الطويلة:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {aiLinkProfile.longTailPhrases.map(phrase => (
                    <span key={phrase} className="rounded-full bg-purple-50 px-2 py-1 font-bold text-purple-700 dark:bg-purple-950/30 dark:text-purple-300">
                      {phrase}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {aiLinkProfile.relatedEntities.length > 0 && (
              <div>
                <span className="font-black text-gray-500">الكيانات المرتبطة:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {aiLinkProfile.relatedEntities.map(entity => (
                    <span key={entity} className="rounded-full bg-cyan-50 px-2 py-1 font-bold text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300">
                      {entity}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {aiLinkProfile.negativePhrases.length > 0 && (
              <div>
                <span className="font-black text-gray-500">سياقات تمنع الاقتراح:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {aiLinkProfile.negativePhrases.map(phrase => (
                    <span key={phrase} className="rounded-full bg-red-50 px-2 py-1 font-bold text-red-700 dark:bg-red-950/30 dark:text-red-300">
                      {phrase}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="font-bold text-gray-400">
              المزود: {aiLinkProfile.provider || '-'} · الموديل: {aiLinkProfile.model || '-'}
            </div>
            {canReviewAiProfile && (
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled={isSaving || aiLinkProfile.reviewStatus === 'approved'}
                  className={secondaryButtonClass}
                  onClick={() => onReviewAiProfile('approved')}
                >
                  <CheckCircle2 size={14} /> اعتماد
                </button>
                <button
                  type="button"
                  disabled={isSaving || aiLinkProfile.reviewStatus === 'rejected'}
                  className={dangerButtonClass}
                  onClick={() => onReviewAiProfile('rejected')}
                >
                  <XCircle size={14} /> رفض
                </button>
              </div>
            )}
          </div>
        )}
        {aiLinkProfile && aiLinkProfile.generationStatus !== 'ready' && (
          <div className="mt-2 font-semibold text-gray-500 dark:text-gray-300">
            {aiLinkProfile.errorMessage || 'لم يكتمل توليد العبارات بعد.'}
          </div>
        )}
      </div>
    </div>
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
  const [assignmentUserId, setAssignmentUserId] = useState('');
  const [assignmentAccess, setAssignmentAccess] = useState<ClientAssignmentAccess>('viewer');
  const [urlsInput, setUrlsInput] = useState('');
  const [siteCrawlState, setSiteCrawlState] = useState<ClientSiteCrawlState>(
    EMPTY_SITE_CRAWL_STATE,
  );
  const [siteCrawlStartUrl, setSiteCrawlStartUrl] = useState('');
  const [siteCrawlMaxPages, setSiteCrawlMaxPages] = useState(250);
  const [siteCrawlMaxDepth, setSiteCrawlMaxDepth] = useState(6);
  const [siteCrawlFollowNofollow, setSiteCrawlFollowNofollow] = useState(false);
  const [siteCrawlProvider, setSiteCrawlProvider] =
    useState<ClientSiteCrawlProvider>('auto');
  const [pageQuery, setPageQuery] = useState('');
  const [expandedPageId, setExpandedPageId] = useState('');
  const [dictionaryType, setDictionaryType] = useState<ClientLinkDictionaryType>('synonym');
  const [dictionaryLabel, setDictionaryLabel] = useState('');
  const [dictionaryTerms, setDictionaryTerms] = useState('');
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const [globalQualityPolicyDraft, setGlobalQualityPolicyDraft] = useState(
    normalizeInternalLinkQualityPolicy(DEFAULT_INTERNAL_LINK_QUALITY_POLICY),
  );
  const [clientQualityPolicyDraft, setClientQualityPolicyDraft] = useState(
    normalizeInternalLinkQualityPolicy(DEFAULT_INTERNAL_LINK_QUALITY_POLICY),
  );
  const [clientQualityPolicyEnabled, setClientQualityPolicyEnabled] = useState(false);

  const selectedClient = clients.find(client => client.id === selectedClientId) || null;
  const ownAssignment = details.assignments.find(assignment => assignment.userId === currentUserId && assignment.isActive);
  const canEditPages = isAdmin || ownAssignment?.accessLevel === 'editor';
  const primaryClientDomain = useMemo(() => (
    details.domains.find(domain => domain.isPrimary && domain.isActive)
    || details.domains.find(domain => domain.isActive)
    || details.domains[0]
    || null
  ), [details.domains]);
  const activeSiteCrawl = siteCrawlState.runs.find(run => (
    run.status === 'queued' || run.status === 'running'
  )) || null;

  const semanticProfileByPage = useMemo(() => new Map(
    details.semanticProfiles.map(profile => [profile.pageId, profile] as const),
  ), [details.semanticProfiles]);
  const aiLinkProfileByPage = useMemo(() => new Map(
    details.aiLinkProfiles.map(profile => [profile.pageId, profile] as const),
  ), [details.aiLinkProfiles]);

  const indexablePages = useMemo(() => details.pages.filter(page => (
    page.crawlStatus === 'ready' && page.isEnabled && page.robotsIndex !== false
  )), [details.pages]);

  const currentSemanticPageIds = useMemo(() => new Set(indexablePages
    .filter(page => isClientSemanticProfileCurrent(
      semanticProfileByPage.get(page.id),
      page,
      details.dictionaries,
    ))
    .map(page => page.id)), [
    details.dictionaries,
    indexablePages,
    semanticProfileByPage,
  ]);

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

  const refreshSiteCrawlState = useCallback(async (clientId: string, quiet = false) => {
    if (!clientId) {
      setSiteCrawlState(EMPTY_SITE_CRAWL_STATE);
      return;
    }
    try {
      setSiteCrawlState(await loadClientSiteCrawlState(clientId));
    } catch (loadError) {
      if (!quiet) showError(loadError);
    }
  }, []);

  useEffect(() => {
    void refreshClients();
  }, [refreshClients]);

  useEffect(() => {
    if (!selectedClientId) {
      setDetails(EMPTY_DETAILS);
      setSiteCrawlState(EMPTY_SITE_CRAWL_STATE);
      return;
    }
    void Promise.all([
      refreshDetails(selectedClientId),
      refreshSiteCrawlState(selectedClientId),
    ]);
  }, [refreshDetails, refreshSiteCrawlState, selectedClientId]);

  useEffect(() => {
    setSiteCrawlStartUrl('');
    setSiteCrawlProvider('auto');
  }, [selectedClientId]);

  useEffect(() => {
    if (!siteCrawlStartUrl && primaryClientDomain?.hostname) {
      setSiteCrawlStartUrl(`https://${primaryClientDomain.hostname}/`);
    }
  }, [primaryClientDomain?.hostname, siteCrawlStartUrl]);

  useEffect(() => {
    if (selectedClient) setClientInput(clientToInput(selectedClient));
  }, [selectedClient]);

  useEffect(() => {
    if (isCreatingClient) return;
    setDomainInput(primaryClientDomain?.hostname || '');
  }, [isCreatingClient, primaryClientDomain, selectedClientId]);

  useEffect(() => {
    const globalPolicy = details.qualityPolicies.find(policy => policy.scope === 'global');
    const clientPolicy = details.qualityPolicies.find(policy => (
      policy.scope === 'client' && policy.clientId === selectedClientId
    ));
    const globalValues = normalizeInternalLinkQualityPolicy(globalPolicy || null);
    setGlobalQualityPolicyDraft(globalValues);
    setClientQualityPolicyDraft(normalizeInternalLinkQualityPolicy(clientPolicy || globalValues));
    setClientQualityPolicyEnabled(Boolean(clientPolicy));
  }, [details.qualityPolicies, selectedClientId]);

  const hasActiveJobs = details.jobs.some(job => (
    job.status === 'queued' || job.status === 'running' || job.status === 'retry_scheduled'
  ));

  useEffect(() => {
    if (!selectedClientId || (!hasActiveJobs && !activeSiteCrawl)) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        refreshDetails(selectedClientId, true),
        refreshSiteCrawlState(selectedClientId, true),
      ]);
    }, 7_000);
    return () => window.clearInterval(timer);
  }, [
    activeSiteCrawl,
    hasActiveJobs,
    refreshDetails,
    refreshSiteCrawlState,
    selectedClientId,
  ]);

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
    if (!domainInput.trim()) {
      showError(new Error('الدومين مطلوب.'));
      return;
    }
    let normalizedDomain: string;
    try {
      normalizedDomain = normalizeClientPrimaryDomain(domainInput);
    } catch (domainError) {
      showError(domainError);
      return;
    }
    setIsSaving(true);
    let createdClient: ClientCenterClient | null = null;
    try {
      createdClient = await createClientCenterClient(clientInput);
      await saveClientCenterPrimaryDomain({
        clientId: createdClient.id,
        hostname: normalizedDomain,
      });
      setIsCreatingClient(false);
      await refreshClients(createdClient.id);
      notifyClientDirectoryChanged();
      showMessage('تم إنشاء العميل وحفظ الدومين الرئيسي.');
    } catch (createError) {
      if (createdClient) {
        setIsCreatingClient(false);
        await refreshClients(createdClient.id);
        showError(new Error(
          `تم إنشاء العميل، لكن تعذر حفظ الدومين: ${createError instanceof Error ? createError.message : 'خطأ غير معروف'}`,
        ));
      } else {
        showError(createError);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveClient = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClient || !clientInput.name?.trim() || !domainInput.trim()) return;
    let normalizedDomain: string;
    try {
      normalizedDomain = normalizeClientPrimaryDomain(domainInput);
    } catch (domainError) {
      showError(domainError);
      return;
    }
    await runMutation(async () => {
      await updateClientCenterClient(selectedClient.id, clientInput);
      await saveClientCenterPrimaryDomain({
        clientId: selectedClient.id,
        hostname: normalizedDomain,
      });
      notifyClientDirectoryChanged();
    }, 'تم حفظ بيانات العميل والدومين الرئيسي.', { refreshClients: true, refreshDetails: true });
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
        + (result.rejected.length > 0 ? `، ورُفض ${result.rejected.length} رابط خارج الدومين الرئيسي.` : '.'),
      );
    } catch (addError) {
      showError(addError);
    } finally {
      setIsSaving(false);
    }
  };

  const handleStartSiteCrawl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClientId || !siteCrawlStartUrl.trim() || isSaving) return;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      await startClientSiteCrawl({
        clientId: selectedClientId,
        startUrl: siteCrawlStartUrl,
        maxPages: siteCrawlMaxPages,
        maxDepth: siteCrawlMaxDepth,
        followNofollow: siteCrawlFollowNofollow,
        provider: siteCrawlProvider,
      });
      await Promise.all([
        refreshDetails(selectedClientId, true),
        refreshSiteCrawlState(selectedClientId, true),
      ]);
      showMessage('بدأ زحف الموقع. سيكتشف النظام الروابط ويضيف الصفحات تلقائيًا ضمن الحدود والمزوّد المحددين.');
    } catch (crawlError) {
      showError(crawlError);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelSiteCrawl = async (runId: string) => {
    if (!selectedClientId || isSaving) return;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      await cancelClientSiteCrawl(selectedClientId, runId);
      await Promise.all([
        refreshDetails(selectedClientId, true),
        refreshSiteCrawlState(selectedClientId, true),
      ]);
      showMessage('تم إيقاف الزحف. قد يُكمل العامل الصفحة التي كان يعالجها دون جدولة صفحات جديدة.');
    } catch (crawlError) {
      showError(crawlError);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDictionary = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedClientId || !dictionaryLabel.trim() || !dictionaryTerms.trim()) return;
    await runMutation(async () => {
      await saveClientLinkDictionary({
        clientId: selectedClientId,
        dictionaryType,
        label: dictionaryLabel,
        terms: dictionaryTerms.split(/[\n,،]+/),
      });
      setDictionaryLabel('');
      setDictionaryTerms('');
    }, 'تم حفظ القاموس. أعد بناء الفهرس لتطبيقه على جميع الصفحات.');
  };

  const handleRebuildSemanticIndex = async () => {
    if (!selectedClientId || isRebuildingIndex) return;
    setIsRebuildingIndex(true);
    setError('');
    setMessage('');
    try {
      const profiles = await rebuildClientSemanticProfiles({
        pages: details.pages,
        dictionaries: details.dictionaries,
      });
      setDetails(current => ({ ...current, semanticProfiles: profiles }));
      showMessage(`تم بناء ${profiles.length.toLocaleString('ar')} ملف خوارزمي من صفحات موقع العميل.`);
    } catch (rebuildError) {
      showError(rebuildError);
    } finally {
      setIsRebuildingIndex(false);
    }
  };

  const handleSaveGlobalQualityPolicy = async () => {
    if (!isAdmin) return;
    await runMutation(async () => {
      await saveInternalLinkQualityPolicy({
        scope: 'global',
        values: globalQualityPolicyDraft,
      });
    }, 'تم حفظ قواعد الجودة العامة وتحديث إصدارها.');
  };

  const handleSaveClientQualityPolicy = async () => {
    if (!selectedClientId || !canEditPages) return;
    const existing = details.qualityPolicies.find(policy => (
      policy.scope === 'client' && policy.clientId === selectedClientId
    ));
    if (!clientQualityPolicyEnabled) {
      if (!existing) {
        showMessage('العميل يستخدم قواعد الجودة العامة بالفعل.');
        return;
      }
      await runMutation(
        () => deleteInternalLinkQualityPolicy(existing.id),
        'تم حذف التخصيص، وسيستخدم العميل قواعد الجودة العامة.',
      );
      return;
    }
    await runMutation(async () => {
      await saveInternalLinkQualityPolicy({
        scope: 'client',
        clientId: selectedClientId,
        values: clientQualityPolicyDraft,
      });
    }, 'تم حفظ قواعد جودة الربط الخاصة بهذا العميل.');
  };

  const renderClientForm = (creating: boolean) => (
    <form onSubmit={creating ? handleCreateClient : handleSaveClient} className="space-y-4">
      <div className="max-w-xl space-y-3">
        <Field
          label="اسم الشركة/العميل"
          description="هذا هو الاسم الموحد الذي يظهر في تبويب الكلمات والأهداف داخل المحرر."
        >
          <input className={inputClass} value={clientInput.name || ''} onChange={event => setClientInput(prev => ({ ...prev, name: event.target.value }))} required maxLength={160} />
        </Field>
        <Field label="الدومين">
          <input
            className={inputClass}
            dir="ltr"
            placeholder="example.com"
            value={domainInput}
            onChange={event => setDomainInput(event.target.value)}
            required
            maxLength={253}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
            ['الدومين', primaryClientDomain?.hostname],
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
    </div>
  );

  const renderPagesTab = () => (
    <div className="space-y-4">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs font-semibold leading-6 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
        تُقرأ صفحات الموقع العامة فقط ولا تُستخدم مقالات المحرر. يستخرج النظام البيانات والفهرس الأساسي بخوارزميات برمجية، ثم يمكنه توليد عبارات ربط ذكية اختيارية عند توفر مزود مفعّل، من دون تخزين النص الكامل للصفحة.
      </div>
      {canEditPages && (
        <form onSubmit={handleStartSiteCrawl} className="rounded-lg border border-[#d4af37]/30 bg-[#d4af37]/5 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div className="min-w-0 flex-1">
              <Field
                label="زحف الموقع عبر API"
                description="يدير المحرر قائمة الصفحات وشبكة الروابط محليًا، ويمكنه استخدام خدمة خارجية لعرض JavaScript عند الحاجة."
              >
                <input
                  dir="ltr"
                  className={`${inputClass} text-left`}
                  value={siteCrawlStartUrl}
                  onChange={event => setSiteCrawlStartUrl(event.target.value)}
                  placeholder="https://example.com/"
                  disabled={Boolean(activeSiteCrawl)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:w-[36rem]">
              <Field label="مزوّد جلب الصفحات">
                <select
                  className={inputClass}
                  value={siteCrawlProvider}
                  disabled={Boolean(activeSiteCrawl)}
                  onChange={event =>
                    setSiteCrawlProvider(event.target.value as ClientSiteCrawlProvider)}
                >
                  {(Object.keys(crawlProviderLabels) as ClientSiteCrawlProvider[]).map(provider => (
                    <option
                      key={provider}
                      value={provider}
                      disabled={!siteCrawlState.providerAvailability[provider]}
                    >
                      {crawlProviderLabels[provider]}
                      {!siteCrawlState.providerAvailability[provider] ? ' — غير مهيأ' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="أقصى عدد صفحات">
                <input
                  type="number"
                  min={1}
                  max={2000}
                  className={inputClass}
                  value={siteCrawlMaxPages}
                  disabled={Boolean(activeSiteCrawl)}
                  onChange={event => setSiteCrawlMaxPages(
                    Math.max(1, Math.min(2000, Number(event.target.value) || 1)),
                  )}
                />
              </Field>
              <Field label="أقصى عمق">
                <input
                  type="number"
                  min={0}
                  max={20}
                  className={inputClass}
                  value={siteCrawlMaxDepth}
                  disabled={Boolean(activeSiteCrawl)}
                  onChange={event => setSiteCrawlMaxDepth(
                    Math.max(0, Math.min(20, Number(event.target.value) || 0)),
                  )}
                />
              </Field>
            </div>
            {activeSiteCrawl ? (
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={isSaving}
                onClick={() => void handleCancelSiteCrawl(activeSiteCrawl.id)}
              >
                <Square size={15} /> إيقاف الزحف
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSaving || !siteCrawlStartUrl.trim()}
                className={primaryButtonClass}
              >
                {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : <Globe2 size={16} />}
                بدء زحف الموقع
              </button>
            )}
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={siteCrawlFollowNofollow}
              disabled={Boolean(activeSiteCrawl)}
              onChange={event => setSiteCrawlFollowNofollow(event.target.checked)}
            />
            تتبّع روابط nofollow أيضًا
          </label>
          <div className="mt-3 flex flex-wrap gap-3 text-[11px] font-bold text-gray-500">
            <span className="text-gray-700 dark:text-gray-200">
              الروابط الداخلية النشطة: {siteCrawlState.activeInternalLinkCount.toLocaleString('ar')}
            </span>
            <span>المزوّد: {crawlProviderLabels[activeSiteCrawl?.provider || siteCrawlProvider]}</span>
            {activeSiteCrawl && (
              <>
                <span>المكتشفة: {activeSiteCrawl.pagesDiscovered.toLocaleString('ar')}</span>
                <span>المجدولة: {activeSiteCrawl.pagesQueued.toLocaleString('ar')}</span>
                <span>المكتملة: {activeSiteCrawl.pagesCompleted.toLocaleString('ar')}</span>
                <span>الفاشلة: {activeSiteCrawl.pagesFailed.toLocaleString('ar')}</span>
              </>
            )}
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] font-semibold leading-5 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
            <CircleHelp className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
            <p>
              يمثّل هذا الرقم علاقات الربط الموجودة في آخر زحف ناجح لكل صفحة مصدر:
              صفحة المصدر + الرابط الهدف + نص الرابط. يُحسب المزيج المتطابق مرة واحدة حتى لو
              تكرر داخل الصفحة، ولا يمثّل عدد صفحات الموقع أو اقتراحات الربط الداخلي.
            </p>
          </div>
        </form>
      )}
      {siteCrawlState.runs.length > 0 && (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {siteCrawlState.runs.slice(0, 4).map(run => (
            <div key={run.id} className="rounded-md border border-gray-200 p-3 text-xs dark:border-[#3C3C3C]">
              <div className="flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-1 font-black ${statusClass(run.status)}`}>
                  {run.status === 'running' ? 'جارٍ زحف الموقع'
                    : run.status === 'queued' ? 'بانتظار البدء'
                      : run.status === 'completed' ? 'اكتمل زحف الموقع'
                        : run.status === 'partial' ? 'اكتمل جزئيًا'
                          : 'ملغى'}
                </span>
                <span className="font-bold text-gray-400">{formatDate(run.createdAt)}</span>
              </div>
              <div dir="ltr" className="mt-2 truncate text-left font-semibold text-gray-500">{run.startUrl}</div>
              <div className="mt-2 flex flex-wrap gap-2 font-bold text-gray-500">
                <span>{crawlProviderLabels[run.provider]}</span>
                <span>{run.pagesCompleted.toLocaleString('ar')} مكتملة</span>
                <span>{run.pagesQueued.toLocaleString('ar')} مجدولة</span>
                <span>عمق {run.maxDepth.toLocaleString('ar')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {canEditPages && (
        <form onSubmit={handleAddPages} className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
          <Field label="إدخال الروابط يدويًا" description="ضع كل رابط في سطر مستقل. الحد الأقصى 100 رابط في العملية، ويجب أن تتبع الروابط الدومين الرئيسي.">
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
              {expanded && (
                <PageDetails
                  page={page}
                  semanticProfile={semanticProfileByPage.get(page.id)}
                  aiLinkProfile={aiLinkProfileByPage.get(page.id)}
                  canReviewAiProfile={isAdmin}
                  isSaving={isSaving}
                  onReviewAiProfile={status => void runMutation(
                    async () => {
                      const reviewed = await reviewClientPageAiLinkProfile(page.id, status);
                      setDetails(current => ({
                        ...current,
                        aiLinkProfiles: [
                          ...current.aiLinkProfiles.filter(profile => profile.pageId !== reviewed.pageId),
                          reviewed,
                        ],
                      }));
                    },
                    status === 'approved'
                      ? 'تم اعتماد ملف عبارات الربط.'
                      : 'تم رفض ملف عبارات الربط.',
                  )}
                />
              )}
            </article>
          );
        })}
      </div>
    </div>
  );

  const dictionaryTypeLabel: Record<ClientLinkDictionaryType, string> = {
    synonym: 'مرادفات',
    topic: 'موضوعات مرتبطة',
    excluded_term: 'كلمات مستبعدة من المطابقة',
  };

  const renderIndexTab = () => {
    const currentProfiles = indexablePages
      .map(page => semanticProfileByPage.get(page.id))
      .filter((profile): profile is ClientPageSemanticProfile => Boolean(
        profile && currentSemanticPageIds.has(profile.pageId),
      ));
    const averageCompleteness = currentProfiles.length > 0
      ? Math.round(
        currentProfiles.reduce((sum, profile) => sum + profile.completenessScore, 0)
        / currentProfiles.length,
      )
      : 0;
    const staleCount = Math.max(0, indexablePages.length - currentProfiles.length);

    return (
      <div className="space-y-5">
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs font-semibold leading-6 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
          يحوّل النظام بيانات صفحات موقع العميل إلى فهرس خوارزمي قابل لإعادة البناء: كلمات موزونة، عبارات من كلمتين إلى خمس، جذور عربية خفيفة، مسارات، مرادفات وموضوعات. لا تُرسل هذه العملية إلى أي نموذج ذكاء اصطناعي ولا تستخدم Search Console أو مقالات المحرر.
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            ['صفحات قابلة للفهرسة', indexablePages.length],
            ['ملفات محدثة', currentProfiles.length],
            ['تحتاج إعادة بناء', staleCount],
            ['متوسط الاكتمال', `${averageCompleteness}%`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
              <div className="text-lg font-black text-[#b8922e]">{typeof value === 'number' ? value.toLocaleString('ar') : value}</div>
              <div className="mt-1 text-[10px] font-bold text-gray-400">{label}</div>
            </div>
          ))}
        </div>

	        <div className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-[#3C3C3C] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-black text-gray-800 dark:text-gray-100">الفهرس الخوارزمي للصفحات</h4>
            <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
              يُبنى تلقائيًا بعد كل زحف ناجح. استخدم إعادة البناء بعد إضافة قاموس أو تغييره، أو لترحيل الصفحات القديمة دفعة واحدة.
            </p>
          </div>
          {canEditPages && (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={isRebuildingIndex || indexablePages.length === 0}
              onClick={() => void handleRebuildSemanticIndex()}
            >
              {isRebuildingIndex ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
              إعادة بناء الفهرس
            </button>
	          )}
	        </div>

	        <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-[#3C3C3C]">
	          <div>
	            <h4 className="flex items-center gap-2 text-sm font-black text-gray-800 dark:text-gray-100">
	              <ShieldCheck className="text-[#d4af37]" size={17} />
	              قواعد جودة الربط الداخلي
	            </h4>
	            <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
	              تُقرأ هذه القواعد من قاعدة البيانات عند فحص المقالة. تخصيص العميل يتقدم على السياسة العامة، وحذف التخصيص يعيده تلقائيًا إلى السياسة العامة.
	            </p>
	          </div>

	          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-[11px] font-semibold leading-5 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
	            قواعد ثابتة لا يمكن تجاوزها: Anchor Text من كلمتين إلى خمس، منع الربط بالمقالة نفسها، ومنع الصفحة المعطلة أو غير الجاهزة أو Noindex، وعدم وضع رابطين على النص نفسه. لا تُضاف الروابط تلقائيًا.
	          </div>

	          <div className="space-y-3 rounded-lg bg-gray-50 p-4 dark:bg-[#1F1F1F]">
	            <div className="flex flex-wrap items-center justify-between gap-2">
	              <div>
	                <div className="text-sm font-black text-gray-800 dark:text-gray-100">السياسة العامة</div>
	                <div className="text-[10px] font-bold text-gray-400">
	                  تطبق على جميع العملاء الذين لا يملكون تخصيصًا
	                  {details.qualityPolicies.find(policy => policy.scope === 'global')
	                    ? ` • الإصدار ${details.qualityPolicies.find(policy => policy.scope === 'global')?.policyVersion}`
	                    : ' • القيم الافتراضية'}
	                </div>
	              </div>
	              {isAdmin && (
	                <button type="button" disabled={isSaving} className={primaryButtonClass} onClick={() => void handleSaveGlobalQualityPolicy()}>
	                  <Save size={15} /> حفظ السياسة العامة
	                </button>
	              )}
	            </div>
	            <QualityPolicyFields
	              value={globalQualityPolicyDraft}
	              disabled={!isAdmin}
	              onChange={patch => setGlobalQualityPolicyDraft(current => normalizeInternalLinkQualityPolicy({
	                ...current,
	                ...patch,
	              }))}
	            />
	          </div>

	          <div className="space-y-3 rounded-lg border border-[#d4af37]/30 p-4">
	            <label className="flex cursor-pointer items-start gap-2">
	              <input
	                type="checkbox"
	                checked={clientQualityPolicyEnabled}
	                disabled={!canEditPages}
	                onChange={event => {
	                  const enabled = event.target.checked;
	                  setClientQualityPolicyEnabled(enabled);
	                  if (enabled) {
	                    setClientQualityPolicyDraft(normalizeInternalLinkQualityPolicy(globalQualityPolicyDraft));
	                  }
	                }}
	                className="mt-1 accent-[#d4af37]"
	              />
	              <span>
	                <span className="block text-sm font-black text-gray-800 dark:text-gray-100">استخدام قواعد مخصصة لهذا العميل</span>
	                <span className="block text-[10px] font-bold leading-5 text-gray-400">
	                  عند إيقافها وحفظها يُحذف التخصيص ويعود العميل إلى السياسة العامة.
	                </span>
	              </span>
	            </label>
	            {clientQualityPolicyEnabled && (
	              <QualityPolicyFields
	                value={clientQualityPolicyDraft}
	                disabled={!canEditPages}
	                onChange={patch => setClientQualityPolicyDraft(current => normalizeInternalLinkQualityPolicy({
	                  ...current,
	                  ...patch,
	                }))}
	              />
	            )}
	            {canEditPages && (
	              <button type="button" disabled={isSaving} className={secondaryButtonClass} onClick={() => void handleSaveClientQualityPolicy()}>
	                <Save size={15} />
	                {clientQualityPolicyEnabled ? 'حفظ تخصيص العميل' : 'اعتماد السياسة العامة'}
	              </button>
	            )}
	          </div>
	        </section>

	        <section className="space-y-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-black text-gray-800 dark:text-gray-100">
              <BookOpen className="text-[#d4af37]" size={17} />
              قواميس العميل
            </h4>
            <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
              المرادفات توسّع المطابقة بين تعبيرات متكافئة، والموضوعات تجمع كلمات المجال، والاستبعاد يمنع كلمات عامة من التأثير في ترتيب الروابط.
            </p>
          </div>

          {canEditPages && (
            <form onSubmit={handleSaveDictionary} className="grid grid-cols-1 gap-3 rounded-lg bg-gray-50 p-4 dark:bg-[#1F1F1F] lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] lg:items-end">
              <Field label="نوع القاموس">
                <select className={inputClass} value={dictionaryType} onChange={event => setDictionaryType(event.target.value as ClientLinkDictionaryType)}>
                  <option value="synonym">مرادفات</option>
                  <option value="topic">موضوعات مرتبطة</option>
                  <option value="excluded_term">كلمات مستبعدة من المطابقة</option>
                </select>
              </Field>
              <Field label="اسم المجموعة">
                <input className={inputClass} value={dictionaryLabel} onChange={event => setDictionaryLabel(event.target.value)} maxLength={160} placeholder="مثال: إدارة علاقات العملاء" />
              </Field>
              <Field label="الكلمات والعبارات" description="افصل بينها بفاصلة أو ضع كل قيمة في سطر.">
                <textarea className={`${inputClass} min-h-20 resize-y`} value={dictionaryTerms} onChange={event => setDictionaryTerms(event.target.value)} placeholder={'CRM\nإدارة علاقات العملاء\nنظام العملاء'} />
              </Field>
              <button type="submit" disabled={isSaving || !dictionaryLabel.trim() || !dictionaryTerms.trim()} className={primaryButtonClass}>
                <Plus size={16} /> إضافة
              </button>
            </form>
          )}

          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold leading-5 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            «كلمات مستبعدة من المطابقة» تخص حساب صلة الرابط فقط؛ لا تمنع الموظف من كتابتها ولا تضيف شروطًا إلى كتابة المقالة.
          </div>

          {details.dictionaries.length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-200 p-5 text-center text-sm font-semibold text-gray-400 dark:border-[#3C3C3C]">
              لا توجد قواميس مخصصة. يعمل الفهرس بالأوزان والجذور والعبارات تلقائيًا، ويمكنك إضافة القواميس لتحسين مجال العميل.
            </div>
          ) : (
            <div className="space-y-2">
              {details.dictionaries.map(dictionary => (
                <article key={dictionary.id} className="rounded-lg border border-gray-200 p-3 dark:border-[#3C3C3C]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-black text-gray-800 dark:text-gray-100">{dictionary.label}</span>
                        <span className="rounded-full bg-[#d4af37]/10 px-2 py-1 text-[10px] font-black text-[#8a6f1d]">{dictionaryTypeLabel[dictionary.dictionaryType]}</span>
                        {!dictionary.isActive && <span className="text-[10px] font-black text-red-500">معطل</span>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {dictionary.terms.map(term => (
                          <span key={term} className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-bold text-gray-600 dark:bg-[#1F1F1F] dark:text-gray-300">{term}</span>
                        ))}
                      </div>
                    </div>
                    {canEditPages && (
                      <div className="flex shrink-0 gap-2">
                        <button type="button" className={secondaryButtonClass} onClick={() => runMutation(
                          () => setClientLinkDictionaryEnabled(dictionary.id, !dictionary.isActive),
                          dictionary.isActive
                            ? 'تم تعطيل القاموس. أعد بناء الفهرس لتطبيق التغيير.'
                            : 'تم تفعيل القاموس. أعد بناء الفهرس لتطبيق التغيير.',
                        )}>
                          {dictionary.isActive ? 'تعطيل' : 'تفعيل'}
                        </button>
                        <button type="button" className={dangerButtonClass} title="حذف القاموس" onClick={() => {
                          if (window.confirm('هل تريد حذف مجموعة القاموس؟ ستحتاج إلى إعادة بناء الفهرس.')) {
                            void runMutation(
                              () => deleteClientLinkDictionary(dictionary.id),
                              'تم حذف القاموس. أعد بناء الفهرس لتطبيق التغيير.',
                            );
                          }
                        }}><Trash2 size={15} /></button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  };

  const getProfileLabel = (profile: RemoteProfile | undefined): string => (
    profile?.fullName?.trim() || profile?.email?.trim() || profile?.id || 'مستخدم غير معروف'
  );

  const renderAccessTab = () => (
    <div className="space-y-4">
      <div className="rounded-md border border-gray-200 p-3 text-xs font-semibold leading-6 text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">
        صلاحية «عرض» تسمح بمشاهدة بيانات العميل والروابط. صلاحية «تعديل» تسمح أيضًا بإضافة الروابط وإعادة زحفها. إنشاء العميل والدومين وتعيين الموظفين يبقى للمسؤول فقط.
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
                setDomainInput('');
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
                setDomainInput('');
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
                  <div className="mt-1 text-xs font-semibold text-gray-400">{primaryClientDomain?.hostname || 'لم يحدد دومين رئيسي'}</div>
                </div>
                <button type="button" className={secondaryButtonClass} onClick={() => void refreshDetails(selectedClient.id)}>
                  <RefreshCw className={isDetailsLoading ? 'animate-spin' : ''} size={15} /> تحديث
                </button>
              </div>
              <div className="mb-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
                {([
                  ['profile', 'البيانات والدومين', <Globe2 size={16} />],
                  ['pages', 'روابط الموقع', <Link2 size={16} />],
                  ['index', 'الفهرس والقواميس', <Network size={16} />],
                  ['access', 'الموظفون والصلاحيات', <ShieldCheck size={16} />],
                ] as const).map(([key, label, icon]) => (
                  <button key={key} type="button" onClick={() => setSelectedTab(key)} className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-xs font-black transition-colors ${selectedTab === key ? 'bg-[#d4af37] text-white' : 'bg-gray-100 text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
                    {icon}<span>{label}</span>
                  </button>
                ))}
              </div>
              {isDetailsLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm font-bold text-gray-400"><LoaderCircle className="animate-spin" size={20} /> جارٍ تحميل بيانات العميل</div>
              ) : selectedTab === 'pages'
                ? renderPagesTab()
                : selectedTab === 'index'
                  ? renderIndexTab()
                  : selectedTab === 'access'
                    ? renderAccessTab()
                    : renderProfileTab()}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default ClientCenterSettings;
