import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Activity,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Calendar,
  CheckCircle2,
  Clock,
  Copy,
  Edit,
  ExternalLink,
  FileText,
  Key,
  ListTree,
  Monitor,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  Users,
  UserPlus,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import ExternalAnalysisReportsTable from './ExternalAnalysisReportsTable';
import {
  getArticleTrashInfo,
  getRemoteAppSessionById,
  getRemoteArticleById,
  listRemoteAppActivityEvents,
  listRemoteAppSessions,
  listRemoteArticleVersions,
  listRemoteArticles,
  listRemoteN8nIngestLogs,
  listRemoteProfiles,
  loadRemoteArticleSnapshot,
  type RemoteAppActivityEvent,
  type RemoteAppSession,
  type RemoteArticleActivity,
  type RemoteArticleVersion,
  type RemoteN8nIngestLog,
  type RemoteProfile,
} from '../utils/supabaseArticles';
import type { ArticleStorageSnapshot } from '../utils/editorContentStore';
import {
  buildAdminArticlePath,
  buildAdminSessionPath,
  buildAdminUserPath,
  buildDailyReportPath,
  buildEditorArticlePath,
  navigateToAppPath,
  type AdminRouteSection,
} from '../utils/appRoutes';
import { createRemoteAdminUser, type CreateAdminUserInput } from '../utils/adminUsers';
import { formatIstanbulDateTime, getIstanbulDateKey, getIstanbulDayEnd, getIstanbulDayStart } from '../utils/dateTime';
import { loadSystemSettings, type SecretStatus } from '../utils/systemSettings';
import {
  listExternalAnalysisReportJobs,
  type ExternalAnalysisReportJob,
} from '../utils/externalAnalysis';

type AdminAppProps = {
  section: AdminRouteSection;
  id: string | null;
  date: string | null;
};

type AdminAction = {
  label: string;
  icon: React.ReactNode;
  path: string;
  active: boolean;
};

type BreadcrumbItem = {
  label: string;
  path?: string;
};

type AdminArticleFilters = {
  profileId: string;
  status: string;
  language: string;
  source: string;
  company: string;
  dateFrom: string;
  dateTo: string;
};

type CreateUserFormState = CreateAdminUserInput & {
  confirmPassword: string;
};

const EMPTY_ADMIN_ARTICLE_FILTERS: AdminArticleFilters = {
  profileId: 'all',
  status: 'all',
  language: 'all',
  source: 'all',
  company: 'all',
  dateFrom: '',
  dateTo: '',
};

const EMPTY_CREATE_USER_FORM: CreateUserFormState = {
  email: '',
  password: '',
  confirmPassword: '',
  fullName: '',
  role: 'user',
  isActive: true,
};

const formatSeconds = (seconds: number, t: typeof translations.ar): string => {
  if (!seconds || seconds < 60) return `${Math.floor(seconds || 0)} ${t.secondsAbbr}`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [
    h > 0 ? `${h} ${t.hoursAbbr}` : '',
    m > 0 ? `${m} ${t.minutesAbbr}` : '',
  ].filter(Boolean).join(' ').trim() || `0 ${t.secondsAbbr}`;
};

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const getProfileLabel = (profile?: RemoteProfile | null): string => (
  profile?.fullName?.trim() || profile?.email?.trim() || 'مستخدم غير معروف'
);

const getArticleOwnerId = (article: RemoteArticleActivity): string | null => (
  article.ownerId || article.createdBy || article.assignedTo || null
);

const articleBelongsToProfile = (article: RemoteArticleActivity, profileId: string): boolean => (
  article.ownerId === profileId || article.createdBy === profileId || article.assignedTo === profileId
);

const getSortTime = (article: RemoteArticleActivity): number => Math.max(
  new Date(article.updatedAt || 0).getTime(),
  new Date(article.lastSaved || 0).getTime(),
  new Date(article.createdAt || 0).getTime(),
);

const sortArticles = (articles: RemoteArticleActivity[]): RemoteArticleActivity[] => (
  [...articles].sort((left, right) => getSortTime(right) - getSortTime(left))
);

const getN8nSettings = (article?: Partial<RemoteArticleActivity> | null) => {
  const metadata = isRecord(article?.metadata) ? article.metadata : {};
  const settings = isRecord(metadata.n8nSettings) ? metadata.n8nSettings : {};
  const visibleTo = Array.isArray(metadata.visibleTo) ? metadata.visibleTo : [];
  const visibleToEmailsCsv = typeof settings.visibleToEmailsCsv === 'string' && settings.visibleToEmailsCsv.trim()
    ? settings.visibleToEmailsCsv.trim()
    : visibleTo
      .map(item => isRecord(item) && typeof item.email === 'string' ? item.email.trim() : '')
      .filter(Boolean)
      .join(', ');

  return {
    visibility: typeof settings.visibility === 'string' ? settings.visibility : article?.visibility || '',
    accessRole: typeof settings.accessRole === 'string' ? settings.accessRole : '',
    visibleToEmailsCsv,
    articleLanguage: typeof settings.articleLanguage === 'string' ? settings.articleLanguage : article?.articleLanguage || '',
    status: typeof settings.status === 'string' ? settings.status : article?.status || '',
  };
};

const getArticleSearchText = (article: RemoteArticleActivity, ownerLabel: string): string => {
  const keywords = article.keywords || { primary: '', secondaries: [], company: '', lsi: [] };
  const goalContext: Record<string, any> = isRecord(article.goalContext) ? article.goalContext : {};
  return [
    article.title,
    keywords.primary,
    keywords.company,
    ...(Array.isArray(keywords.secondaries) ? keywords.secondaries : []),
    ...(Array.isArray(keywords.lsi) ? keywords.lsi : []),
    article.plainText,
    article.source,
    article.status,
    article.visibility,
    ownerLabel,
    goalContext.pageType,
    goalContext.objective,
    goalContext.audienceScope,
    goalContext.targetCountry,
    goalContext.searchIntent,
  ].map(value => String(value || '').toLowerCase()).join(' ');
};

const getLatestSavedAt = (articles: RemoteArticleActivity[]): string => (
  articles
    .map(article => article.lastSaved)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || ''
);

const getArticleCompany = (article: RemoteArticleActivity): string => (
  article.keywords?.company?.trim() || ''
);

const getArticleFilterDate = (article: RemoteArticleActivity): string => (
  article.updatedAt || article.lastSaved || article.createdAt || ''
);

const getUniqueArticleValues = (
  articles: RemoteArticleActivity[],
  getter: (article: RemoteArticleActivity) => string | null | undefined,
): string[] => Array.from(new Set(
  articles
    .map(article => getter(article)?.trim() || '')
    .filter(Boolean)
)).sort((left, right) => left.localeCompare(right));

const hasActiveArticleFilters = (filters: AdminArticleFilters): boolean => (
  filters.profileId !== 'all' ||
  filters.status !== 'all' ||
  filters.language !== 'all' ||
  filters.source !== 'all' ||
  filters.company !== 'all' ||
  Boolean(filters.dateFrom) ||
  Boolean(filters.dateTo)
);

const copyAbsoluteLink = async (path: string) => {
  const url = `${window.location.origin}${path}`;
  await navigator.clipboard?.writeText(url);
};

const AdminButton: React.FC<AdminAction> = ({ label, icon, path, active }) => (
  <button
    type="button"
    onClick={() => navigateToAppPath(path)}
    className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-bold transition-colors ${
      active
        ? 'bg-[#d4af37] text-white'
        : 'bg-white text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:text-gray-300 dark:hover:bg-[#d4af37]/20'
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

const AdminBreadcrumbs: React.FC<{ items: BreadcrumbItem[] }> = ({ items }) => (
  <nav className="mt-4 flex flex-wrap items-center gap-2 text-xs font-black text-gray-400" aria-label="Breadcrumb">
    {items.map((item, index) => (
      <React.Fragment key={`${item.label}-${index}`}>
        {index > 0 && <span>/</span>}
        {item.path && index < items.length - 1 ? (
          <button
            type="button"
            onClick={() => navigateToAppPath(item.path || '/admin')}
            className="text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
          >
            {item.label}
          </button>
        ) : (
          <span className="text-gray-600 dark:text-gray-300">{item.label}</span>
        )}
      </React.Fragment>
    ))}
  </nav>
);

const AdminStat: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = ({ icon, label, value }) => (
  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
    <div className="flex items-center gap-3">
      <div className="rounded-md bg-[#d4af37]/10 p-2 text-[#d4af37] dark:bg-[#d4af37]/20">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs font-bold text-gray-400">{label}</div>
        <div className="mt-1 truncate text-xl font-black text-gray-800 dark:text-gray-100">{value}</div>
      </div>
    </div>
  </div>
);

const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
    <div className="text-[11px] font-bold text-gray-400">{label}</div>
    <div className="mt-1 break-words text-sm font-semibold text-gray-700 dark:text-gray-200">
      {value === null || value === undefined || value === '' ? '-' : value}
    </div>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2 className="mb-3 text-lg font-black text-gray-800 dark:text-gray-100">{children}</h2>
);

const ArticleRow: React.FC<{
  article: RemoteArticleActivity;
  ownerLabel: string;
  t: typeof translations.ar;
}> = ({ article, ownerLabel, t }) => {
  const adminPath = buildAdminArticlePath(article.id);
  const editorPath = buildEditorArticlePath(article.id);
  const trashInfo = getArticleTrashInfo(article);
  const n8nSettings = getN8nSettings(article);

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3 transition-colors hover:border-[#d4af37]/50 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          onClick={() => navigateToAppPath(adminPath)}
          className="min-w-0 text-start"
        >
          <div className="truncate text-sm font-black text-gray-800 hover:text-[#8a6f1d] dark:text-gray-100 dark:hover:text-[#f2d675]">
            {article.title || t.untitled}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
            <span>{ownerLabel}</span>
            <span>{article.source}</span>
            <span>{article.status}</span>
            <span>{article.visibility}</span>
            <span>{(article.articleLanguage || 'ar').toUpperCase()}</span>
            {trashInfo && <span className="text-red-500">محذوف</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
            <span className="inline-flex items-center gap-1"><Calendar size={12} />{formatIstanbulDateTime(article.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="inline-flex items-center gap-1"><Clock size={12} />{formatSeconds(article.timeSpentSeconds, t)}</span>
            <span className="inline-flex items-center gap-1"><FileText size={12} />{article.stats?.wordCount ?? 0}</span>
            {n8nSettings.visibleToEmailsCsv && <span>{n8nSettings.visibleToEmailsCsv}</span>}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => navigateToAppPath(editorPath)}
            className="rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-300"
            title="فتح في المحرر"
          >
            <Edit size={15} />
          </button>
          <button
            type="button"
            onClick={() => copyAbsoluteLink(adminPath)}
            className="rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-300"
            title="نسخ رابط المتابعة"
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            onClick={() => window.open(`${window.location.origin}${editorPath}`, '_blank', 'noopener,noreferrer')}
            className="rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:text-gray-300"
            title="فتح في تبويب جديد"
          >
            <ExternalLink size={15} />
          </button>
        </div>
      </div>
    </li>
  );
};

const UserRow: React.FC<{
  profile: RemoteProfile;
  articles: RemoteArticleActivity[];
  t: typeof translations.ar;
}> = ({ profile, articles, t }) => {
  const profileArticles = articles.filter(article => articleBelongsToProfile(article, profile.id));
  const lastSaved = getLatestSavedAt(profileArticles) || profile.lastSeenAt || '';
  const totalTime = profileArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);
  return (
    <tr
      className="cursor-pointer border-b border-gray-100 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:hover:bg-[#d4af37]/15"
      onClick={() => navigateToAppPath(buildAdminUserPath(profile.id))}
    >
      <td className="px-3 py-3">
        <div className="font-black text-gray-700 dark:text-gray-100">{getProfileLabel(profile)}</div>
        <div className="text-xs text-gray-400">{profile.email || '-'}</div>
      </td>
      <td className="px-3 py-3">
        <span className={`rounded-full px-2 py-1 text-xs font-black ${profile.role === 'admin' ? 'bg-[#d4af37]/15 text-[#8a6f1d] dark:text-[#f2d675]' : 'bg-gray-100 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
          {profile.role}
        </span>
      </td>
      <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{profileArticles.length}</td>
      <td className="px-3 py-3 text-gray-500">{formatSeconds(totalTime, t)}</td>
      <td className="px-3 py-3 text-gray-500">{lastSaved ? formatIstanbulDateTime(lastSaved, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
      <td className="px-3 py-3 text-gray-500">{profile.lastSeenAt ? formatIstanbulDateTime(profile.lastSeenAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
    </tr>
  );
};

const ArticleDetailPage: React.FC<{
  article: RemoteArticleActivity | null;
  snapshot: ArticleStorageSnapshot | null;
  versions: RemoteArticleVersion[];
  ownerLabel: string;
  loading: boolean;
  t: typeof translations.ar;
}> = ({ article, snapshot, versions, ownerLabel, loading, t }) => {
  if (loading && !article) {
    return <EmptyState icon={<RefreshCw size={24} />} title="جار تحميل المقالة..." />;
  }

  if (!article) {
    return <EmptyState icon={<AlertCircle size={24} />} title="لم يتم العثور على المقالة" />;
  }

  const keywords = snapshot?.keywords || article.keywords;
  const goalContext = snapshot?.goalContext || article.goalContext;
  const plainText = snapshot?.plainText || article.plainText || '';
  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const n8nSettings = getN8nSettings(article);
  const trashInfo = getArticleTrashInfo(article);
  const geminiPaidLatest = isRecord(metadata.aiResults?.geminiPaid?.latest)
    ? metadata.aiResults.geminiPaid.latest
    : null;
  const secondaryKeywords = keywords?.secondaries?.filter(keyword => keyword.trim()) || [];
  const lsiKeywords = keywords?.lsi?.filter(keyword => keyword.trim()) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-gray-200 pb-5 dark:border-[#3C3C3C] md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-black text-[#d4af37]">مركز المتابعة / المقالات / {article.id}</div>
          <h1 className="mt-1 text-2xl font-black text-gray-900 dark:text-gray-100">{article.title || t.untitled}</h1>
          <p className="mt-1 text-sm font-semibold text-gray-500 dark:text-gray-400">{ownerLabel}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigateToAppPath(buildEditorArticlePath(article.id))}
            className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
          >
            <Edit size={16} />
            <span>فتح في المحرر</span>
          </button>
          <button
            type="button"
            onClick={() => copyAbsoluteLink(buildAdminArticlePath(article.id))}
            className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
          >
            <Copy size={16} />
            <span>نسخ الرابط</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-sm font-bold text-[#8a6f1d] dark:text-[#f2d675]">
          جار تحديث تفاصيل المقالة...
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <DetailRow label="الحالة" value={article.status} />
        <DetailRow label="المصدر" value={article.source} />
        <DetailRow label="الظهور" value={article.visibility} />
        <DetailRow label="لغة المقال" value={(article.articleLanguage || 'ar').toUpperCase()} />
        <DetailRow label="من أنشأها" value={article.createdBy || '-'} />
        <DetailRow label="من حجزها" value={article.assignedTo || '-'} />
        <DetailRow label="عدد مرات الحفظ" value={article.saveCount} />
        <DetailRow label="الوقت المستغرق" value={formatSeconds(article.timeSpentSeconds, t)} />
        <DetailRow label="تاريخ الإنشاء" value={article.createdAt ? formatIstanbulDateTime(article.createdAt, t.locale) : '-'} />
        <DetailRow label="آخر تعديل" value={article.updatedAt ? formatIstanbulDateTime(article.updatedAt, t.locale) : '-'} />
        <DetailRow label="آخر حفظ" value={article.lastSaved ? formatIstanbulDateTime(article.lastSaved, t.locale) : '-'} />
        {trashInfo && <DetailRow label="حالة الحذف" value={`${formatIstanbulDateTime(trashInfo.deletedAt, t.locale)} - ${trashInfo.deletedScope || '-'}`} />}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>إعدادات n8n</SectionTitle>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DetailRow label="visibility" value={n8nSettings.visibility} />
            <DetailRow label="accessRole" value={n8nSettings.accessRole} />
            <DetailRow label="visibleToEmailsCsv" value={n8nSettings.visibleToEmailsCsv} />
            <DetailRow label="status" value={n8nSettings.status} />
          </div>
        </section>

        <section>
          <SectionTitle>التحليلات</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <DetailRow label="عدد الكلمات" value={article.stats?.wordCount ?? 0} />
            <DetailRow label="مخالفات الكلمات" value={article.stats?.keywordViolations ?? 0} />
            <DetailRow label="معايير مخالفة" value={article.stats?.violatingCriteriaCount ?? 0} />
            <DetailRow label="أخطاء الهيكل" value={article.stats?.totalErrorsCount ?? 0} />
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>الكلمات المفتاحية</SectionTitle>
          <div className="space-y-3 rounded-lg border border-gray-100 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
            <DetailRow label="الرئيسية" value={keywords?.primary || '-'} />
            <DetailRow label="الشركة" value={keywords?.company || '-'} />
            <DetailRow label="الثانوية" value={secondaryKeywords.length ? secondaryKeywords.join('، ') : '-'} />
            <DetailRow label="LSI" value={lsiKeywords.length ? lsiKeywords.join('، ') : '-'} />
          </div>
        </section>
        <section>
          <SectionTitle>بيانات Gemini</SectionTitle>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <DetailRow label="الموديل" value={geminiPaidLatest?.model || '-'} />
            <DetailRow label="آخر أحرف المفتاح" value={formatApiKeySuffixLabel(geminiPaidLatest?.keySuffix)} />
            <DetailRow label="وقت الحفظ" value={geminiPaidLatest?.savedAt ? formatIstanbulDateTime(geminiPaidLatest.savedAt, t.locale) : '-'} />
          </div>
          {geminiPaidLatest?.result && (
            <div className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm leading-7 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
              {geminiPaidLatest.result}
            </div>
          )}
        </section>
      </div>

      <section>
        <SectionTitle>بيانات الهدف وسجل النظام</SectionTitle>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200" dir="ltr">
            {JSON.stringify(goalContext || {}, null, 2)}
          </pre>
          <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200" dir="ltr">
            {JSON.stringify(metadata || {}, null, 2)}
          </pre>
        </div>
      </section>

      <section>
        <SectionTitle>سجل التغييرات</SectionTitle>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
          <table className="w-full min-w-[680px] text-start text-sm">
            <thead className="text-xs uppercase text-gray-400">
              <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
                <th className="px-3 py-2 text-start">النسخة</th>
                <th className="px-3 py-2 text-start">العنوان</th>
                <th className="px-3 py-2 text-start">بواسطة</th>
                <th className="px-3 py-2 text-start">التاريخ</th>
                <th className="px-3 py-2 text-start">الكلمات</th>
              </tr>
            </thead>
            <tbody>
              {versions.length > 0 ? versions.map(version => (
                <tr key={version.id} className="border-b border-gray-100 dark:border-[#3C3C3C]">
                  <td className="px-3 py-3 font-black text-gray-700 dark:text-gray-200">#{version.versionNumber}</td>
                  <td className="px-3 py-3 text-gray-600 dark:text-gray-300">{version.title}</td>
                  <td className="px-3 py-3 font-mono text-xs text-gray-500">{version.createdBy || '-'}</td>
                  <td className="px-3 py-3 text-gray-500">{formatIstanbulDateTime(version.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-3 py-3 text-gray-500">{version.stats?.wordCount ?? 0}</td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">لا توجد نسخ محفوظة بعد.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionTitle>معاينة النص</SectionTitle>
        <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-white p-4 text-sm leading-7 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200">
          {plainText.trim() || 'لا توجد معاينة نصية محفوظة.'}
        </div>
      </section>
    </div>
  );
};

const EmptyState: React.FC<{ icon: React.ReactNode; title: string; subtitle?: string }> = ({ icon, title, subtitle }) => (
  <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-center dark:border-[#3C3C3C]">
    <div className="mb-3 text-gray-400">{icon}</div>
    <h2 className="text-lg font-black text-gray-700 dark:text-gray-200">{title}</h2>
    {subtitle && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
  </div>
);

type ApiUsageFailedAttempt = {
  keySuffixLabel: string;
  model: string;
  status?: number;
  reason?: string;
};

type ApiUsageRequest = {
  id: string;
  service: string;
  provider: string;
  model: string;
  keySuffixLabel: string;
  outcome: 'success' | 'failed' | 'cancelled';
  userId: string | null;
  source: string;
  createdAt: string;
  failedAttempts: ApiUsageFailedAttempt[];
};

const getActivityMetadata = (event: RemoteAppActivityEvent): Record<string, any> => (
  isRecord(event.metadata) ? event.metadata : {}
);

const getApiProviderLabel = (service?: string, provider?: string): string => {
  if (provider === 'geminiPaid') return 'Gemini Pro';
  if (provider === 'gemini') return 'Gemini المجاني';
  if (provider === 'openai' || service === 'openai') return 'OpenAI';
  return provider || service || '-';
};

const getApiSourceLabel = (source?: string): string => {
  const labels: Record<string, string> = {
    semantic_keywords_lsi: 'توليد الصيغ و LSI',
    goal_context_generation: 'توليد سياق الأهداف',
    draft_title_generation: 'اقتراح عنوان',
    smart_analysis: 'التحليل الذكي',
    ready_commands_batch: 'الأوامر الجاهزة',
    floating_toolbar: 'القائمة العائمة',
    heading_analysis: 'تحليل العناوين',
    bulk_fix_review: 'الإصلاح المتعدد',
    bulk_fix_all: 'الإصلاح المجمع',
    competitor_extraction: 'استخراج المنافسين',
    engineering_command: 'أمر تحليل خارجي',
    assigned_automation_semantic: 'أتمتة الصيغ و LSI',
    assigned_automation_semantic_retry: 'إعادة أتمتة الصيغ و LSI',
    assigned_automation_competitor: 'أتمتة تحليل المنافسين',
    quick_provider: 'أمر سريع',
    unknown: 'غير محدد',
  };
  return labels[source || 'unknown'] || source || 'غير محدد';
};

const formatApiKeySuffixLabel = (value: unknown): string => {
  const keySuffix = typeof value === 'string' && value.trim() ? value.trim() : '';
  return keySuffix ? `••••${keySuffix.slice(-6)}` : 'غير متاح';
};

const getApiUsageEvents = (events: RemoteAppActivityEvent[]): RemoteAppActivityEvent[] => (
  events.filter(event => event.eventType === 'api_key_used')
);

const getApiAttemptReasonLabel = (reason?: string): string => {
  const labels: Record<string, string> = {
    quota: 'الحصة مستنفدة',
    auth: 'المفتاح غير صالح أو غير مصرح',
    server: 'خطأ مؤقت من الخادم',
    blocked: 'محظور من خدمة Gemini',
    unknown: 'سبب غير معروف',
  };
  return labels[reason || ''] || reason || 'فشل الطلب';
};

const normalizeApiUsageFailedAttempts = (metadata: Record<string, any>): ApiUsageFailedAttempt[] => {
  const attempts = Array.isArray(metadata.failedAttempts)
    ? metadata.failedAttempts.filter(isRecord).map((attempt): ApiUsageFailedAttempt => ({
      keySuffixLabel: formatApiKeySuffixLabel(attempt.keySuffix),
      model: typeof attempt.model === 'string' && attempt.model.trim() ? attempt.model.trim() : '-',
      status: typeof attempt.status === 'number' ? attempt.status : undefined,
      reason: typeof attempt.reason === 'string' && attempt.reason.trim() ? attempt.reason.trim() : undefined,
    }))
    : [];

  if (attempts.length > 0) return attempts;
  if (metadata.outcome !== 'failed') return [];
  if (!metadata.keySuffix && !metadata.keyFingerprint && !metadata.reason) return [];

  return [{
    keySuffixLabel: formatApiKeySuffixLabel(metadata.keySuffix),
    model: typeof metadata.model === 'string' && metadata.model.trim() ? metadata.model.trim() : '-',
    status: typeof metadata.status === 'number' ? metadata.status : undefined,
    reason: typeof metadata.reason === 'string' && metadata.reason.trim() ? metadata.reason.trim() : undefined,
  }];
};

const buildApiUsageRequests = (events: RemoteAppActivityEvent[]): ApiUsageRequest[] => (
  events.map(event => {
    const metadata = getActivityMetadata(event);
    const service = typeof metadata.service === 'string' && metadata.service.trim() ? metadata.service.trim() : 'ai';
    const provider = typeof metadata.provider === 'string' && metadata.provider.trim() ? metadata.provider.trim() : service;
    const failedAttempts = normalizeApiUsageFailedAttempts(metadata);
    const lastFailedAttempt = failedAttempts[failedAttempts.length - 1];
    const model = typeof metadata.model === 'string' && metadata.model.trim()
      ? metadata.model.trim()
      : lastFailedAttempt?.model || '-';
    const source = typeof metadata.source === 'string' && metadata.source.trim() ? metadata.source.trim() : 'unknown';
    const rawOutcome = typeof metadata.outcome === 'string' ? metadata.outcome : 'success';
    const outcome: ApiUsageRequest['outcome'] = rawOutcome === 'failed'
      ? 'failed'
      : rawOutcome === 'cancelled'
        ? 'cancelled'
        : 'success';

    return {
      id: event.id,
      service,
      provider,
      model,
      keySuffixLabel: formatApiKeySuffixLabel(metadata.keySuffix),
      outcome,
      userId: event.userId || null,
      source,
      createdAt: event.createdAt,
      failedAttempts,
    };
  }).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
);

const ServerSecretsStatusPanel: React.FC<{
  secretStatus: SecretStatus;
  isLoading: boolean;
  onRefresh: () => void;
}> = ({ secretStatus, isLoading, onRefresh }) => {
  const cards = [
    {
      title: 'Gemini المجاني',
      configured: secretStatus.ai.gemini.configured,
      count: secretStatus.ai.gemini.keyCount,
      detail: secretStatus.ai.gemini.model || '-',
    },
    {
      title: 'Gemini Pro',
      configured: secretStatus.ai.geminiPaid.configured,
      count: secretStatus.ai.geminiPaid.keyCount,
      detail: secretStatus.ai.geminiPaid.model || '-',
    },
    {
      title: 'OpenAI',
      configured: secretStatus.ai.openAi.configured,
      count: secretStatus.ai.openAi.keyCount,
      detail: secretStatus.ai.openAi.model || '-',
    },
    {
      title: 'N8N_INGEST_TOKEN',
      configured: secretStatus.n8n.tokenConfigured,
      detail: secretStatus.n8n.ingestUrl || '/api/n8n/articles',
    },
    {
      title: 'SUPABASE_SERVICE_ROLE_KEY',
      configured: secretStatus.n8n.serviceRoleConfigured,
      detail: secretStatus.n8n.publicEditorUrl || '-',
    },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>مفاتيح API المحفوظة على السيرفر فقط</SectionTitle>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 hover:bg-[#d4af37]/10 disabled:cursor-wait disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          <span>{isLoading ? 'جار التحديث...' : 'تحديث الحالة'}</span>
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {cards.map(card => (
          <div key={card.title} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">{card.title}</div>
            <div className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-black ${
              card.configured
                ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
                : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
            }`}>
              {card.configured ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              <span>{card.configured ? 'مفعل' : 'غير مفعل'}</span>
              {typeof card.count === 'number' && <span>({card.count})</span>}
            </div>
            <div className="mt-2 truncate text-xs font-semibold text-gray-500" dir="ltr" title={card.detail}>
              {card.detail}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const ReportsPage: React.FC<{
  articles: RemoteArticleActivity[];
  logs: RemoteN8nIngestLog[];
  activityEvents: RemoteAppActivityEvent[];
  profiles: RemoteProfile[];
  externalAnalysisJobs: ExternalAnalysisReportJob[];
  isExternalAnalysisLoading: boolean;
  externalAnalysisError: string;
  secretStatus: SecretStatus;
  isSecretStatusLoading: boolean;
  onRefreshSecretStatus: () => void;
  date: string;
  t: typeof translations.ar;
}> = ({
  articles,
  logs,
  activityEvents,
  profiles,
  externalAnalysisJobs,
  isExternalAnalysisLoading,
  externalAnalysisError,
  secretStatus,
  isSecretStatusLoading,
  onRefreshSecretStatus,
  date,
  t,
}) => {
  const start = getIstanbulDayStart(date);
  const end = getIstanbulDayEnd(date);
  const inDay = (value?: string | null) => {
    if (!value) return false;
    const dateValue = new Date(value);
    return dateValue >= start && dateValue <= end;
  };
  const changedArticles = articles.filter(article => inDay(article.updatedAt) || inDay(article.lastSaved));
  const deletedArticles = articles.filter(article => inDay(getArticleTrashInfo(article)?.deletedAt));
  const reservedArticles = articles.filter(article => inDay(isRecord(article.metadata?.claim) ? article.metadata.claim.claimedAt : ''));
  const n8nArticles = articles.filter(article => article.source === 'n8n' && inDay(article.createdAt));
  const n8nLogs = logs.filter(log => inDay(log.createdAt));
  const dayActivityEvents = activityEvents.filter(event => inDay(event.createdAt));
  const apiUsageEvents = getApiUsageEvents(dayActivityEvents);
  const apiUsageRequests = buildApiUsageRequests(apiUsageEvents);
  const apiKeyCount = new Set(apiUsageRequests.flatMap(request => [
    request.keySuffixLabel,
    ...request.failedAttempts.map(attempt => attempt.keySuffixLabel),
  ]).filter(label => label !== 'غير متاح')).size;
  const freeGeminiApiCalls = apiUsageRequests.filter(request => request.provider === 'gemini').length;
  const paidGeminiApiCalls = apiUsageRequests.filter(request => request.provider === 'geminiPaid').length;
  const openAiApiCalls = apiUsageRequests.filter(request => request.provider === 'openai' || request.service === 'openai').length;
  const aiErrors = articles.filter(article => JSON.stringify(article.metadata || {}).toLowerCase().includes('error'));
  const activeUserIds = new Set(dayActivityEvents.map(event => event.userId).filter(Boolean));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-gray-200 pb-5 dark:border-[#3C3C3C] md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-xs font-black text-[#d4af37]">مركز المتابعة / التقارير / {date}</div>
          <h1 className="mt-1 text-2xl font-black text-gray-900 dark:text-gray-100">تقرير يومي</h1>
        </div>
        <input
          type="date"
          value={date}
          onChange={event => navigateToAppPath(buildDailyReportPath(event.target.value))}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-100"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-6">
        <AdminStat icon={<FileText size={18} />} label="المقالات المعدلة" value={changedArticles.length} />
        <AdminStat icon={<Trash2 size={18} />} label="المقالات المحذوفة" value={deletedArticles.length} />
        <AdminStat icon={<Shield size={18} />} label="المقالات المحجوزة" value={reservedArticles.length} />
        <AdminStat icon={<Workflow size={18} />} label="مقالات n8n" value={n8nArticles.length} />
        <AdminStat icon={<AlertCircle size={18} />} label="أخطاء الذكاء الاصطناعي" value={aiErrors.length} />
        <AdminStat icon={<Activity size={18} />} label="مستخدمون عملوا" value={activeUserIds.size} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <AdminStat icon={<Key size={18} />} label="استدعاءات API" value={apiUsageRequests.length} />
        <AdminStat icon={<Shield size={18} />} label="مفاتيح مستخدمة" value={apiKeyCount} />
        <AdminStat icon={<Sparkles size={18} />} label="Gemini المجاني" value={freeGeminiApiCalls} />
        <AdminStat icon={<BrainCircuit size={18} />} label="OpenAI / Pro" value={paidGeminiApiCalls + openAiApiCalls} />
      </div>

      <ServerSecretsStatusPanel
        secretStatus={secretStatus}
        isLoading={isSecretStatusLoading}
        onRefresh={onRefreshSecretStatus}
      />

      <section className="space-y-4">
        <SectionTitle>تقارير التحليل الخارجي</SectionTitle>
        <ExternalAnalysisReportsTable
          jobs={externalAnalysisJobs}
          articles={articles}
          profiles={profiles}
          isLoading={isExternalAnalysisLoading}
          error={externalAnalysisError}
          locale={t.locale === 'en' ? 'en' : 'ar'}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle>استخدام مفاتيح API</SectionTitle>
        <ApiUsageRequestTable requests={apiUsageRequests} profiles={profiles} t={t} />
      </section>

      <section>
        <SectionTitle>طلبات n8n</SectionTitle>
        <LogsTable logs={n8nLogs} t={t} />
      </section>
    </div>
  );
};

const ApiUsageRequestTable: React.FC<{
  requests: ApiUsageRequest[];
  profiles: RemoteProfile[];
  t: typeof translations.ar;
}> = ({ requests, profiles, t }) => {
  const getUserLabel = (userId?: string | null): string => {
    const profile = userId ? profiles.find(item => item.id === userId) : null;
    return getProfileLabel(profile);
  };

  const renderFailedAttempts = (attempts: ApiUsageFailedAttempt[]) => {
    if (attempts.length === 0) return <span className="text-gray-400">-</span>;

    return (
      <details className="max-w-[360px] rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">
        <summary className="cursor-pointer font-black">{attempts.length} مفاتيح فاشلة</summary>
        <ul className="mt-2 space-y-1.5 border-t border-red-100 pt-2 dark:border-red-900/50">
          {attempts.map((attempt, index) => (
            <li key={`${attempt.keySuffixLabel}-${attempt.model}-${index}`} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <span className="font-mono font-black">{attempt.keySuffixLabel}</span>
              <span className="min-w-0 break-words">{getApiAttemptReasonLabel(attempt.reason)}</span>
              <span className="col-span-2 text-[11px] text-red-600/80 dark:text-red-300/80">
                {attempt.model}{typeof attempt.status === 'number' ? ` · HTTP ${attempt.status}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </details>
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <table className="w-full min-w-[1320px] text-start text-sm">
        <thead className="text-xs uppercase text-gray-400">
          <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <th className="px-3 py-2 text-start">نوع النموذج</th>
            <th className="px-3 py-2 text-start">الموديل</th>
            <th className="px-3 py-2 text-start">آخر أحرف المفتاح</th>
            <th className="px-3 py-2 text-start">النتيجة</th>
            <th className="px-3 py-2 text-start">المفاتيح الفاشلة</th>
            <th className="px-3 py-2 text-start">المستخدم</th>
            <th className="px-3 py-2 text-start">المصدر</th>
            <th className="px-3 py-2 text-start">تاريخ ووقت الاستدعاء</th>
          </tr>
        </thead>
        <tbody>
          {requests.length > 0 ? requests.map(request => (
            <tr key={request.id} className="border-b border-gray-100 align-top dark:border-[#3C3C3C]">
              <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{getApiProviderLabel(request.service, request.provider)}</td>
              <td className="px-3 py-3 font-mono text-xs text-gray-500">{request.model}</td>
              <td className="px-3 py-3 font-mono text-xs font-black text-gray-600 dark:text-gray-300">{request.keySuffixLabel}</td>
              <td className="px-3 py-3">
                <span className={request.outcome === 'success'
                  ? 'font-black text-emerald-600 dark:text-emerald-300'
                  : request.outcome === 'cancelled'
                    ? 'font-black text-gray-500 dark:text-gray-300'
                    : 'font-black text-red-600 dark:text-red-300'}>
                  {request.outcome === 'success' ? 'نجح' : request.outcome === 'cancelled' ? 'تم الإيقاف' : 'فشل'}
                </span>
              </td>
              <td className="px-3 py-3">{renderFailedAttempts(request.failedAttempts)}</td>
              <td className="max-w-[220px] px-3 py-3 text-gray-600 dark:text-gray-300">{getUserLabel(request.userId)}</td>
              <td className="max-w-[220px] px-3 py-3 text-gray-600 dark:text-gray-300">{getApiSourceLabel(request.source)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-gray-500">{formatIstanbulDateTime(request.createdAt, t.locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
            </tr>
          )) : (
            <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-500">لا توجد استدعاءات API مسجلة لهذا اليوم.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

const LogsTable: React.FC<{ logs: RemoteN8nIngestLog[]; t: typeof translations.ar }> = ({ logs, t }) => (
  <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
    <table className="w-full min-w-[780px] text-start text-sm">
      <thead className="text-xs uppercase text-gray-400">
        <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
          <th className="px-3 py-2 text-start">الحالة</th>
          <th className="px-3 py-2 text-start">articleId</th>
          <th className="px-3 py-2 text-start">externalId</th>
          <th className="px-3 py-2 text-start">workflow</th>
          <th className="px-3 py-2 text-start">التاريخ</th>
          <th className="px-3 py-2 text-start">الخطأ</th>
        </tr>
      </thead>
      <tbody>
        {logs.length > 0 ? logs.map(log => (
          <tr key={log.id} className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{log.status}</td>
            <td className="px-3 py-3 font-mono text-xs text-gray-500">
              {log.articleId ? (
                <button
                  type="button"
                  onClick={() => navigateToAppPath(buildAdminArticlePath(log.articleId!))}
                  className="inline-flex max-w-[220px] items-center gap-1 text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
                  title="فتح مقالة طلب n8n"
                >
                  <ExternalLink size={12} className="shrink-0" />
                  <span className="truncate">{log.articleId}</span>
                </button>
              ) : '-'}
            </td>
            <td className="px-3 py-3 text-gray-500">{log.externalId || '-'}</td>
            <td className="px-3 py-3 text-gray-500">{log.workflowId || '-'}</td>
            <td className="px-3 py-3 text-gray-500">{formatIstanbulDateTime(log.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td className="px-3 py-3 text-red-600 dark:text-red-300">{log.errorMessage || '-'}</td>
          </tr>
        )) : (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">لا توجد سجلات.</td></tr>
        )}
      </tbody>
    </table>
  </div>
);

const ActivityTable: React.FC<{
  events: RemoteAppActivityEvent[];
  profiles: RemoteProfile[];
  t: typeof translations.ar;
}> = ({ events, profiles, t }) => {
  const getUserLabel = (userId?: string | null): string => {
    const profile = userId ? profiles.find(item => item.id === userId) : null;
    return getProfileLabel(profile);
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <table className="w-full min-w-[900px] text-start text-sm">
        <thead className="text-xs uppercase text-gray-400">
          <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <th className="px-3 py-2 text-start">الوقت</th>
            <th className="px-3 py-2 text-start">المستخدم</th>
            <th className="px-3 py-2 text-start">الحدث</th>
            <th className="px-3 py-2 text-start">السجل</th>
            <th className="px-3 py-2 text-start">الرابط</th>
            <th className="px-3 py-2 text-start">الجلسة</th>
          </tr>
        </thead>
        <tbody>
          {events.length > 0 ? events.map(event => (
            <tr key={event.id} className="border-b border-gray-100 dark:border-[#3C3C3C]">
              <td className="px-3 py-3 text-gray-500">{formatIstanbulDateTime(event.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{getUserLabel(event.userId)}</td>
              <td className="px-3 py-3">
                <span className="rounded-full bg-[#d4af37]/10 px-2 py-1 text-xs font-black text-[#8a6f1d] dark:text-[#f2d675]">
                  {event.eventType}
                </span>
              </td>
              <td className="px-3 py-3 font-mono text-xs text-gray-500">{event.entityType ? `${event.entityType}:${event.entityId || '-'}` : '-'}</td>
              <td className="max-w-[240px] truncate px-3 py-3 text-gray-500" title={event.path}>{event.path || '-'}</td>
              <td className="px-3 py-3">
                {event.sessionId ? (
                  <button
                    type="button"
                    onClick={() => navigateToAppPath(buildAdminSessionPath(event.sessionId || ''))}
                    className="font-mono text-xs font-bold text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
                  >
                    {event.sessionId.slice(0, 8)}
                  </button>
                ) : '-'}
              </td>
            </tr>
          )) : (
            <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">لا توجد أحداث نشاط.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

type SessionActivityRow = {
  id: string;
  session: RemoteAppSession | null;
  events: RemoteAppActivityEvent[];
  userIds: Set<string>;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  path: string;
};

const SessionsActivityTable: React.FC<{
  sessions: RemoteAppSession[];
  events: RemoteAppActivityEvent[];
  profiles: RemoteProfile[];
  t: typeof translations.ar;
  query: string;
}> = ({ sessions, events, profiles, t, query }) => {
  const getUserLabel = (userId?: string | null): string => {
    const profile = userId ? profiles.find(item => item.id === userId) : null;
    return getProfileLabel(profile);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const rowMap = new Map<string, SessionActivityRow>();

    sessions.forEach(session => {
      rowMap.set(session.id, {
        id: session.id,
        session,
        events: [],
        userIds: new Set(session.userId ? [session.userId] : []),
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
        endedAt: session.endedAt,
        path: session.path,
      });
    });

    events.forEach(event => {
      const rowId = event.sessionId || `no-session:${event.userId || 'unknown'}`;
      const existing = rowMap.get(rowId);
      const row = existing || {
        id: rowId,
        session: null,
        events: [],
        userIds: new Set<string>(),
        startedAt: event.createdAt,
        lastSeenAt: event.createdAt,
        endedAt: null,
        path: event.path,
      };

      row.events.push(event);
      if (event.userId) row.userIds.add(event.userId);
      if (!row.path && event.path) row.path = event.path;
      if (new Date(event.createdAt).getTime() < new Date(row.startedAt).getTime()) {
        row.startedAt = event.createdAt;
      }
      if (new Date(event.createdAt).getTime() > new Date(row.lastSeenAt).getTime()) {
        row.lastSeenAt = event.createdAt;
      }
      rowMap.set(rowId, row);
    });

    return Array.from(rowMap.values())
      .map(row => ({
        ...row,
        events: [...row.events].sort((left, right) => (
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
        )),
      }))
      .filter(row => {
        if (!normalizedQuery) return true;
        const userLabels = Array.from(row.userIds).map(getUserLabel);
        const eventText = row.events.map(event => [
          event.eventType,
          event.entityType,
          event.entityId,
          event.path,
          event.sessionId,
          JSON.stringify(event.metadata || {}),
        ].join(' ')).join(' ');
        return [
          row.id,
          row.session?.userAgent,
          row.path,
          row.endedAt ? 'منتهية ended' : 'نشطة active',
          ...userLabels,
          eventText,
        ].map(value => String(value || '').toLowerCase()).join(' ').includes(normalizedQuery);
      })
      .sort((left, right) => (
        new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime()
      ));
  }, [events, getUserLabel, normalizedQuery, sessions]);

  const getUsersLabel = (row: SessionActivityRow): string => {
    const labels = Array.from(row.userIds).map(getUserLabel).filter(Boolean);
    if (labels.length === 0) return '-';
    return `${labels.slice(0, 2).join('، ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}`;
  };

  const getEventEntityLabel = (event: RemoteAppActivityEvent): string => (
    event.entityType ? `${event.entityType}:${event.entityId || '-'}` : '-'
  );

  const getEventTypeCounts = (row: SessionActivityRow): string[] => {
    const counts = new Map<string, number>();
    row.events.forEach(event => counts.set(event.eventType, (counts.get(event.eventType) || 0) + 1));
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([eventType, count]) => `${eventType} (${count})`);
  };

  const renderRecentEvents = (row: SessionActivityRow) => {
    const recentEvents = row.events.slice(0, 4);
    if (recentEvents.length === 0) {
      return <span className="text-gray-400">لا توجد أحداث مسجلة.</span>;
    }

    return (
      <div className="space-y-2">
        {recentEvents.map(event => (
          <div key={event.id} className="rounded-md bg-gray-50 px-2 py-1.5 text-xs leading-5 text-gray-600 dark:bg-[#232323] dark:text-gray-300">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-gray-500">{formatIstanbulDateTime(event.createdAt, t.locale, { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="font-black text-[#8a6f1d] dark:text-[#f2d675]">{event.eventType}</span>
              <span className="font-mono text-gray-400">{getEventEntityLabel(event)}</span>
            </div>
            {event.path ? (
              <div className="mt-0.5 truncate text-gray-400" title={event.path}>{event.path}</div>
            ) : null}
          </div>
        ))}
        {row.events.length > recentEvents.length ? (
          <div className="text-xs font-bold text-gray-400">+{row.events.length - recentEvents.length} أحداث أخرى</div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <table className="w-full min-w-[1320px] text-start text-sm">
        <thead className="text-xs uppercase text-gray-400">
          <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <th className="px-3 py-2 text-start">الجلسة</th>
            <th className="px-3 py-2 text-start">المستخدمون</th>
            <th className="px-3 py-2 text-start">الحالة</th>
            <th className="px-3 py-2 text-start">بدأت</th>
            <th className="px-3 py-2 text-start">آخر نشاط</th>
            <th className="px-3 py-2 text-start">المدة</th>
            <th className="px-3 py-2 text-start">المسار</th>
            <th className="px-3 py-2 text-start">ملخص النشاط</th>
            <th className="px-3 py-2 text-start">آخر الأحداث</th>
            <th className="px-3 py-2 text-start">فتح</th>
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? rows.map(row => {
            const durationSeconds = Math.max(0, Math.floor((new Date(row.lastSeenAt).getTime() - new Date(row.startedAt).getTime()) / 1000));
            const eventTypeCounts = getEventTypeCounts(row);
            const canOpenSession = Boolean(row.session);

            return (
            <tr key={row.id} className="border-b border-gray-100 dark:border-[#3C3C3C]">
              <td className="px-3 py-3">
                <div className="font-mono text-xs font-bold text-gray-700 dark:text-gray-200">
                  {row.session ? row.id.slice(0, 8) : row.id.startsWith('no-session') ? 'بدون جلسة' : row.id.slice(0, 8)}
                </div>
                {!row.session && !row.id.startsWith('no-session') ? (
                  <div className="mt-1 text-xs text-gray-400">جلسة غير محملة</div>
                ) : null}
              </td>
              <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{getUsersLabel(row)}</td>
              <td className="px-3 py-3">
                <span className={`rounded-full px-2 py-1 text-xs font-black ${row.session && !row.endedAt ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
                  {row.session ? (row.endedAt ? 'منتهية' : 'نشطة') : 'أحداث فقط'}
                </span>
              </td>
              <td className="px-3 py-3 text-gray-500">{formatIstanbulDateTime(row.startedAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-3 py-3 text-gray-500">{formatIstanbulDateTime(row.lastSeenAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-3 py-3 text-gray-500">{formatSeconds(durationSeconds, t)}</td>
              <td className="max-w-[240px] truncate px-3 py-3 text-gray-500" title={row.path}>{row.path || '-'}</td>
              <td className="max-w-[260px] px-3 py-3 text-gray-500" title={eventTypeCounts.join('، ')}>
                <div className="font-black text-gray-700 dark:text-gray-200">{row.events.length} حدث</div>
                <div className="mt-1 text-xs">{eventTypeCounts.join('، ') || '-'}</div>
              </td>
              <td className="max-w-[380px] px-3 py-3">{renderRecentEvents(row)}</td>
              <td className="px-3 py-3">
                {canOpenSession ? (
                  <button
                    type="button"
                    onClick={() => navigateToAppPath(buildAdminSessionPath(row.id))}
                    className="inline-flex items-center gap-1 rounded-md border border-[#d4af37]/40 px-2 py-1 text-xs font-black text-[#8a6f1d] hover:bg-[#d4af37]/10 dark:text-[#f2d675]"
                  >
                    <ExternalLink size={12} />
                    فتح
                  </button>
                ) : '-'}
              </td>
            </tr>
            );
          }) : (
            <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-500">لا توجد جلسات أو أحداث نشاط.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

const SessionDetailPage: React.FC<{
  session: RemoteAppSession | null;
  events: RemoteAppActivityEvent[];
  profiles: RemoteProfile[];
  loading: boolean;
  t: typeof translations.ar;
}> = ({ session, events, profiles, loading, t }) => {
  if (loading && !session) {
    return <EmptyState icon={<RefreshCw size={24} />} title="جار تحميل الجلسة..." />;
  }

  if (!session) {
    return <EmptyState icon={<Monitor size={24} />} title="لم يتم العثور على الجلسة" />;
  }

  const profile = session.userId ? profiles.find(item => item.id === session.userId) : null;
  const durationSeconds = Math.max(
    0,
    (new Date(session.endedAt || session.lastSeenAt).getTime() - new Date(session.startedAt).getTime()) / 1000,
  );

  return (
    <div className="space-y-6">
      <div className="border-b border-gray-200 pb-5 dark:border-[#3C3C3C]">
        <div className="text-xs font-black text-[#d4af37]">مركز المتابعة / الجلسات / {session.id}</div>
        <h1 className="mt-1 text-2xl font-black text-gray-900 dark:text-gray-100">{getProfileLabel(profile)}</h1>
        <p className="mt-1 font-mono text-xs font-semibold text-gray-500">{session.id}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <DetailRow label="بدأت" value={formatIstanbulDateTime(session.startedAt, t.locale)} />
        <DetailRow label="آخر نشاط" value={formatIstanbulDateTime(session.lastSeenAt, t.locale)} />
        <DetailRow label="انتهت" value={session.endedAt ? formatIstanbulDateTime(session.endedAt, t.locale) : 'نشطة'} />
        <DetailRow label="المدة" value={formatSeconds(durationSeconds, t)} />
        <DetailRow label="آخر رابط" value={session.path || '-'} />
        <DetailRow label="المستخدم" value={getProfileLabel(profile)} />
        <DetailRow label="الأحداث" value={events.length} />
      </div>

      <section>
        <SectionTitle>نشاط الجلسة</SectionTitle>
        <ActivityTable events={events} profiles={profiles} t={t} />
      </section>

      <section>
        <SectionTitle>بيانات الجهاز</SectionTitle>
        <pre className="max-h-64 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200" dir="ltr">
          {JSON.stringify({
            userAgent: session.userAgent,
            metadata: session.metadata,
          }, null, 2)}
        </pre>
      </section>
    </div>
  );
};

const EMPTY_SECRET_STATUS: SecretStatus = {
  ai: {
    gemini: { configured: false, keyCount: 0, model: '', allowedModels: [] },
    geminiPaid: { configured: false, keyCount: 0, model: '' },
    openAi: { configured: false, keyCount: 0, model: '' },
  },
  n8n: {
    tokenConfigured: false,
    serviceRoleConfigured: false,
    ingestUrl: '/api/n8n/articles',
    publicEditorUrl: '',
  },
};

const AdminApp: React.FC<AdminAppProps> = ({ section, id, date }) => {
  const {
    currentUser,
    currentUserRole,
    isDarkMode,
    t,
  } = useUser();
  const [articles, setArticles] = useState<RemoteArticleActivity[]>([]);
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [logs, setLogs] = useState<RemoteN8nIngestLog[]>([]);
  const [sessions, setSessions] = useState<RemoteAppSession[]>([]);
  const [activityEvents, setActivityEvents] = useState<RemoteAppActivityEvent[]>([]);
  const [externalAnalysisJobs, setExternalAnalysisJobs] = useState<ExternalAnalysisReportJob[]>([]);
  const [isExternalAnalysisLoading, setIsExternalAnalysisLoading] = useState(false);
  const [externalAnalysisError, setExternalAnalysisError] = useState('');
  const [sessionDetail, setSessionDetail] = useState<RemoteAppSession | null>(null);
  const [sessionDetailEvents, setSessionDetailEvents] = useState<RemoteAppActivityEvent[]>([]);
  const [snapshot, setSnapshot] = useState<ArticleStorageSnapshot | null>(null);
  const [versions, setVersions] = useState<RemoteArticleVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [articleFilters, setArticleFilters] = useState<AdminArticleFilters>(EMPTY_ADMIN_ARTICLE_FILTERS);
  const [isCreateUserOpen, setIsCreateUserOpen] = useState(false);
  const [createUserForm, setCreateUserForm] = useState<CreateUserFormState>(EMPTY_CREATE_USER_FORM);
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState('');
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(EMPTY_SECRET_STATUS);
  const [isSecretStatusLoading, setIsSecretStatusLoading] = useState(false);

  const isAdmin = currentUserRole === 'admin';
  const selectedReportDate = date || getIstanbulDateKey();

  const refreshSecretStatus = useCallback(async () => {
    if (!currentUser || !isAdmin) return;
    setIsSecretStatusLoading(true);
    try {
      const response = await loadSystemSettings();
      setSecretStatus(response.secretStatus || EMPTY_SECRET_STATUS);
    } catch (secretError) {
      console.error('Failed to load server secret status:', secretError);
      setError('تعذر تحميل حالة مفاتيح السيرفر.');
    } finally {
      setIsSecretStatusLoading(false);
    }
  }, [currentUser, isAdmin]);

  const refreshData = useCallback(async () => {
    if (!currentUser || !isAdmin) return;
    setIsLoading(true);
    setError('');
    const shouldLoadExternalAnalysis = section === 'reports' || section === 'dailyReport';
    setIsExternalAnalysisLoading(shouldLoadExternalAnalysis);
    if (shouldLoadExternalAnalysis) setExternalAnalysisError('');
    try {
      let externalReportLoadError = '';
      const externalReportPromise = shouldLoadExternalAnalysis
        ? listExternalAnalysisReportJobs({
            from: getIstanbulDayStart(selectedReportDate).toISOString(),
            to: getIstanbulDayEnd(selectedReportDate).toISOString(),
            limit: 500,
          }).catch(reportError => {
            console.error('Failed to load external analysis reports:', reportError);
            externalReportLoadError = 'تعذر تحميل تقارير التحليل الخارجي من Supabase.';
            return [] as ExternalAnalysisReportJob[];
          })
        : Promise.resolve(null);
      const [articleRows, profileRows, logRows, sessionRows, activityRows, externalReportRows] = await Promise.all([
        listRemoteArticles(),
        listRemoteProfiles(),
        listRemoteN8nIngestLogs(80),
        listRemoteAppSessions(120),
        listRemoteAppActivityEvents({ limit: 1000 }),
        externalReportPromise,
      ]);
      setArticles(sortArticles(articleRows));
      setProfiles(profileRows);
      setLogs(logRows);
      setSessions(sessionRows);
      setActivityEvents(activityRows);
      if (externalReportRows) setExternalAnalysisJobs(externalReportRows);
      if (shouldLoadExternalAnalysis) setExternalAnalysisError(externalReportLoadError);
    } catch (loadError) {
      console.error('Failed to load admin data:', loadError);
      setError('تعذر تحميل بيانات مركز المتابعة من Supabase.');
    } finally {
      setIsLoading(false);
      setIsExternalAnalysisLoading(false);
    }
  }, [currentUser, isAdmin, section, selectedReportDate]);

  useEffect(() => {
    void refreshData();
    const handleActivityUpdated = () => {
      void refreshData();
    };
    window.addEventListener('smart-editor-activity-updated', handleActivityUpdated);
    return () => window.removeEventListener('smart-editor-activity-updated', handleActivityUpdated);
  }, [refreshData]);

  useEffect(() => {
    if (section !== 'reports' && section !== 'dailyReport') return;
    void refreshSecretStatus();
  }, [refreshSecretStatus, section]);

  useEffect(() => {
    if (section !== 'settings') return;
    navigateToAppPath('/settings', { replace: true });
  }, [section]);

  useEffect(() => {
    if (!currentUser || !isAdmin || section !== 'articleDetail' || !id) return;
    let cancelled = false;
    setIsDetailLoading(true);
    setSnapshot(null);
    setVersions([]);

    const loadDetail = async () => {
      try {
        const [articleRow, snapshotRow, versionRows] = await Promise.all([
          articles.some(article => article.id === id) ? Promise.resolve(null) : getRemoteArticleById(id),
          loadRemoteArticleSnapshot(id, currentUser),
          listRemoteArticleVersions(id, 30),
        ]);
        if (cancelled) return;
        if (articleRow) {
          setArticles(prev => sortArticles([articleRow, ...prev.filter(article => article.id !== articleRow.id)]));
        }
        setSnapshot(snapshotRow);
        setVersions(versionRows);
      } catch (detailError) {
        console.error(`Failed to load admin article "${id}":`, detailError);
        if (!cancelled) setError('تعذر تحميل المقالة المطلوبة.');
      } finally {
        if (!cancelled) setIsDetailLoading(false);
      }
    };

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [articles, currentUser, id, isAdmin, section]);

  useEffect(() => {
    if (!currentUser || !isAdmin || section !== 'sessionDetail' || !id) return;
    let cancelled = false;
    setIsDetailLoading(true);
    setSessionDetail(null);
    setSessionDetailEvents([]);

    const loadSessionDetail = async () => {
      try {
        const [sessionRow, eventRows] = await Promise.all([
          getRemoteAppSessionById(id),
          listRemoteAppActivityEvents({ sessionId: id, limit: 200 }),
        ]);
        if (cancelled) return;
        setSessionDetail(sessionRow);
        setSessionDetailEvents(eventRows);
        if (sessionRow) {
          setSessions(prev => [sessionRow, ...prev.filter(session => session.id !== sessionRow.id)]);
        }
      } catch (sessionError) {
        console.error(`Failed to load admin session "${id}":`, sessionError);
        if (!cancelled) setError('تعذر تحميل الجلسة المطلوبة.');
      } finally {
        if (!cancelled) setIsDetailLoading(false);
      }
    };

    void loadSessionDetail();
    return () => {
      cancelled = true;
    };
  }, [currentUser, id, isAdmin, section]);

  const activeArticles = useMemo(() => articles.filter(article => !getArticleTrashInfo(article)), [articles]);
  const trashedArticles = useMemo(() => articles.filter(article => getArticleTrashInfo(article)), [articles]);
  const n8nArticles = useMemo(() => activeArticles.filter(article => article.source === 'n8n'), [activeArticles]);
  const currentArticle = section === 'articleDetail' && id
    ? articles.find(article => article.id === id) || null
    : null;
  const currentProfile = section === 'userDetail' && id
    ? profiles.find(profile => profile.id === id) || null
    : null;

  const getOwnerLabel = (article: RemoteArticleActivity): string => {
    const ownerId = getArticleOwnerId(article);
    const owner = ownerId ? profiles.find(profile => profile.id === ownerId) : null;
    return getProfileLabel(owner);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const isArticleFilterActive = normalizedQuery.length > 0 || hasActiveArticleFilters(articleFilters);
  const shouldShowArticleFilters = ['overview', 'articles', 'trash', 'n8n', 'userDetail'].includes(section);
  const articleFilterOptions = useMemo(() => ({
    statuses: getUniqueArticleValues(articles, article => article.status),
    languages: getUniqueArticleValues(articles, article => article.articleLanguage || 'ar'),
    sources: getUniqueArticleValues(articles, article => article.source),
    companies: getUniqueArticleValues(articles, getArticleCompany),
  }), [articles]);

  const filteredArticles = useMemo(() => {
    const source = section === 'trash'
      ? trashedArticles
      : section === 'n8n'
        ? n8nArticles
        : activeArticles;

    return source.filter(article => {
      if (section === 'userDetail' && id && !articleBelongsToProfile(article, id)) return false;
      if (normalizedQuery && !getArticleSearchText(article, getOwnerLabel(article)).includes(normalizedQuery)) return false;
      if (articleFilters.profileId !== 'all' && !articleBelongsToProfile(article, articleFilters.profileId)) return false;
      if (articleFilters.status !== 'all' && article.status !== articleFilters.status) return false;
      if (articleFilters.language !== 'all' && (article.articleLanguage || 'ar') !== articleFilters.language) return false;
      if (articleFilters.source !== 'all' && article.source !== articleFilters.source) return false;
      if (articleFilters.company !== 'all' && getArticleCompany(article) !== articleFilters.company) return false;
      if (articleFilters.dateFrom) {
        const articleDate = getArticleFilterDate(article);
        if (!articleDate || new Date(articleDate) < getIstanbulDayStart(articleFilters.dateFrom)) return false;
      }
      if (articleFilters.dateTo) {
        const articleDate = getArticleFilterDate(article);
        if (!articleDate || new Date(articleDate) > getIstanbulDayEnd(articleFilters.dateTo)) return false;
      }
      return true;
    });
  }, [activeArticles, articleFilters, id, n8nArticles, normalizedQuery, section, trashedArticles, profiles]);

  const filteredProfiles = useMemo(() => (
    profiles.filter(profile => {
      if (!normalizedQuery) return true;
      return [
        profile.id,
        profile.email,
        profile.fullName,
        profile.role,
        profile.isActive ? 'active' : 'inactive',
      ].map(value => String(value || '').toLowerCase()).join(' ').includes(normalizedQuery);
    })
  ), [normalizedQuery, profiles]);

  const filteredLogs = useMemo(() => (
    logs.filter(log => {
      if (!normalizedQuery) return true;
      return [
        log.articleId,
        log.externalId,
        log.workflowId,
        log.executionId,
        log.status,
        log.errorMessage,
        JSON.stringify(log.payload || {}),
      ].map(value => String(value || '').toLowerCase()).join(' ').includes(normalizedQuery);
    })
  ), [logs, normalizedQuery]);

  const handleArticleFilterChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = event.target;
    setArticleFilters(prev => ({ ...prev, [name]: value }));
  };

  const resetArticleFilters = () => {
    setArticleFilters(EMPTY_ADMIN_ARTICLE_FILTERS);
    setQuery('');
  };

  const updateCreateUserForm = (field: keyof CreateUserFormState, value: string | boolean) => {
    setCreateUserForm(prev => ({ ...prev, [field]: value }));
    setCreateUserError('');
  };

  const closeCreateUserForm = () => {
    if (isCreatingUser) return;
    setIsCreateUserOpen(false);
    setCreateUserForm(EMPTY_CREATE_USER_FORM);
    setCreateUserError('');
  };

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isCreatingUser) return;

    const email = createUserForm.email.trim().toLowerCase();
    const fullName = createUserForm.fullName.trim();
    const password = createUserForm.password.trim();
    const confirmPassword = createUserForm.confirmPassword.trim();

    if (!email || !password) {
      setCreateUserError('البريد الإلكتروني وكلمة المرور مطلوبان.');
      return;
    }
    if (password.length < 8) {
      setCreateUserError('كلمة المرور المؤقتة يجب أن تكون 8 أحرف على الأقل.');
      return;
    }
    if (password !== confirmPassword) {
      setCreateUserError('كلمة المرور وتأكيدها غير متطابقين.');
      return;
    }

    setIsCreatingUser(true);
    setCreateUserError('');
    try {
      await createRemoteAdminUser({
        email,
        fullName,
        password,
        role: createUserForm.role,
        isActive: createUserForm.isActive,
      });
      setIsCreateUserOpen(false);
      setCreateUserForm(EMPTY_CREATE_USER_FORM);
      await refreshData();
    } catch (createError) {
      console.error('Failed to create admin user:', createError);
      setCreateUserError(createError instanceof Error ? createError.message : 'تعذر إنشاء المستخدم.');
    } finally {
      setIsCreatingUser(false);
    }
  };

  const totalTime = activeArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);
  const navActions: AdminAction[] = [
    { label: 'نظرة عامة', icon: <BarChart3 size={16} />, path: '/admin', active: section === 'overview' },
    { label: 'المستخدمون', icon: <Users size={16} />, path: '/admin/users', active: section === 'users' || section === 'userDetail' },
    { label: 'السلة', icon: <Trash2 size={16} />, path: '/admin/trash', active: section === 'trash' },
    { label: 'التقارير', icon: <Calendar size={16} />, path: buildDailyReportPath(selectedReportDate), active: section === 'reports' || section === 'dailyReport' },
    { label: 'الجلسات والنشاط', icon: <Monitor size={16} />, path: '/admin/sessions', active: section === 'sessions' || section === 'activity' || section === 'sessionDetail' },
  ];

  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [{ label: 'مركز المتابعة', path: '/admin' }];
    if (section === 'overview') return [{ label: 'مركز المتابعة' }];
    if (section === 'articles') return [...items, { label: 'المقالات' }];
    if (section === 'articleDetail') return [
      ...items,
      { label: 'المقالات', path: '/admin/articles' },
      { label: currentArticle?.title || id || 'مقالة' },
    ];
    if (section === 'users') return [...items, { label: 'المستخدمون' }];
    if (section === 'userDetail') return [
      ...items,
      { label: 'المستخدمون', path: '/admin/users' },
      { label: getProfileLabel(currentProfile) },
    ];
    if (section === 'trash') return [...items, { label: 'السلة' }];
    if (section === 'n8n') return [...items, { label: 'n8n' }];
    if (section === 'settings') return [...items, { label: 'الإعدادات' }];
    if (section === 'activity' || section === 'sessions') return [...items, { label: 'الجلسات والنشاط' }];
    if (section === 'sessionDetail') return [
      ...items,
      { label: 'الجلسات والنشاط', path: '/admin/sessions' },
      { label: id || 'جلسة' },
    ];
    if (section === 'reports' || section === 'dailyReport') return [
      ...items,
      { label: 'التقارير', path: '/admin/reports' },
      { label: selectedReportDate },
    ];
    return items;
  }, [currentArticle?.title, currentProfile, id, section, selectedReportDate]);

  if (!isAdmin) {
    return (
      <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 p-6 dark:bg-[#181818]`}>
        <div className="mx-auto max-w-2xl rounded-lg border border-red-200 bg-white p-6 text-center dark:border-red-900/50 dark:bg-[#2A2A2A]">
          <Shield className="mx-auto mb-3 text-red-500" size={32} />
          <h1 className="text-xl font-black text-gray-900 dark:text-gray-100">لا تملك صلاحية فتح هذه الصفحة</h1>
          <button
            type="button"
            onClick={() => navigateToAppPath('/dashboard')}
            className="mt-4 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
          >
            العودة للوحة التحكم
          </button>
        </div>
      </div>
    );
  }

  const renderMain = () => {
    if (section === 'settings') {
      return (
        <EmptyState icon={<Settings size={24} />} title="جار فتح الإعدادات الرئيسية..." />
      );
    }

    if (section === 'articleDetail') {
      return (
        <ArticleDetailPage
          article={currentArticle}
          snapshot={snapshot}
          versions={versions}
          ownerLabel={currentArticle ? getOwnerLabel(currentArticle) : '-'}
          loading={isDetailLoading}
          t={t}
        />
      );
    }

    if (section === 'users') {
      return (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SectionTitle>المستخدمون</SectionTitle>
            <button
              type="button"
              onClick={() => setIsCreateUserOpen(prev => !prev)}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
            >
              {isCreateUserOpen ? <X size={16} /> : <UserPlus size={16} />}
              <span>{isCreateUserOpen ? 'إغلاق النموذج' : 'إنشاء مستخدم'}</span>
            </button>
          </div>

          {isCreateUserOpen && (
            <form
              onSubmit={handleCreateUser}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]"
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-xs font-black text-gray-500 dark:text-gray-400">الاسم</span>
                  <input
                    type="text"
                    value={createUserForm.fullName}
                    onChange={event => updateCreateUserForm('fullName', event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                    placeholder="اسم المستخدم"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-black text-gray-500 dark:text-gray-400">البريد الإلكتروني</span>
                  <input
                    type="email"
                    value={createUserForm.email}
                    onChange={event => updateCreateUserForm('email', event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                    placeholder="user@example.com"
                    dir="ltr"
                    required
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-black text-gray-500 dark:text-gray-400">الدور</span>
                  <select
                    value={createUserForm.role}
                    onChange={event => updateCreateUserForm('role', event.target.value as CreateUserFormState['role'])}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-black text-gray-500 dark:text-gray-400">كلمة مرور مؤقتة</span>
                  <input
                    type="password"
                    value={createUserForm.password}
                    onChange={event => updateCreateUserForm('password', event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                    minLength={8}
                    required
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-black text-gray-500 dark:text-gray-400">تأكيد كلمة المرور</span>
                  <input
                    type="password"
                    value={createUserForm.confirmPassword}
                    onChange={event => updateCreateUserForm('confirmPassword', event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                    minLength={8}
                    required
                  />
                </label>
                <label className="flex items-center gap-2 self-end rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <input
                    type="checkbox"
                    checked={createUserForm.isActive}
                    onChange={event => updateCreateUserForm('isActive', event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
                  />
                  <span>مستخدم فعال</span>
                </label>
              </div>

              {createUserError && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
                  {createUserError}
                </div>
              )}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreateUserForm}
                  disabled={isCreatingUser}
                  className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isCreatingUser}
                  className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-60"
                >
                  <UserPlus size={16} />
                  <span>{isCreatingUser ? 'جار الإنشاء...' : 'إنشاء المستخدم'}</span>
                </button>
              </div>
            </form>
          )}

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
            <table className="w-full min-w-[900px] text-start text-sm">
              <thead className="text-xs uppercase text-gray-400">
                <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
                  <th className="px-3 py-2 text-start">المستخدم</th>
                  <th className="px-3 py-2 text-start">الدور</th>
                  <th className="px-3 py-2 text-start">عدد المقالات</th>
                  <th className="px-3 py-2 text-start">الوقت</th>
                  <th className="px-3 py-2 text-start">آخر حفظ</th>
                  <th className="px-3 py-2 text-start">آخر نشاط</th>
                </tr>
              </thead>
              <tbody>
                {filteredProfiles.map(profile => (
                  <UserRow key={profile.id} profile={profile} articles={articles} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    }

    if (section === 'userDetail') {
      if (!currentProfile && !isLoading) {
        return <EmptyState icon={<Users size={24} />} title="لم يتم العثور على المستخدم" />;
      }

      const allProfileArticles = currentProfile ? articles.filter(article => articleBelongsToProfile(article, currentProfile.id)) : [];
      const profileArticles = currentProfile ? filteredArticles.filter(article => articleBelongsToProfile(article, currentProfile.id)) : [];
      const reservedArticles = currentProfile ? allProfileArticles.filter(article => article.assignedTo === currentProfile.id) : [];
      const profileN8nArticles = allProfileArticles.filter(article => article.source === 'n8n');
      const profileTime = allProfileArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);
      return (
        <div className="space-y-6">
          <div className="border-b border-gray-200 pb-5 dark:border-[#3C3C3C]">
            <div className="text-xs font-black text-[#d4af37]">مركز المتابعة / المستخدمون / {currentProfile?.id}</div>
            <h1 className="mt-1 text-2xl font-black text-gray-900 dark:text-gray-100">{getProfileLabel(currentProfile)}</h1>
            <p className="mt-1 text-sm font-semibold text-gray-500 dark:text-gray-400">{currentProfile?.email || '-'}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
            <AdminStat icon={<BookOpen size={18} />} label="كل المقالات" value={profileArticles.length} />
            <AdminStat icon={<Shield size={18} />} label="محجوزة له" value={reservedArticles.length} />
            <AdminStat icon={<Workflow size={18} />} label="مرتبطة بـ n8n" value={profileN8nArticles.length} />
            <AdminStat icon={<Clock size={18} />} label="الوقت" value={formatSeconds(profileTime, t)} />
            <AdminStat icon={<Calendar size={18} />} label="آخر نشاط" value={currentProfile?.lastSeenAt ? formatIstanbulDateTime(currentProfile.lastSeenAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'} />
          </div>
          <section>
            <SectionTitle>مقالاته</SectionTitle>
            <ArticleList articles={profileArticles} profiles={profiles} t={t} />
          </section>
        </div>
      );
    }

    if (section === 'n8n') {
      return (
        <div className="space-y-6">
          <section>
            <SectionTitle>مقالات n8n</SectionTitle>
            <ArticleList articles={filteredArticles} profiles={profiles} t={t} />
          </section>
          <section>
            <SectionTitle>سجلات n8n</SectionTitle>
            <LogsTable logs={filteredLogs} t={t} />
          </section>
        </div>
      );
    }

    if (section === 'activity' || section === 'sessions') {
      return (
        <div className="space-y-6">
          <section>
            <SectionTitle>الجلسات والنشاط</SectionTitle>
            <SessionsActivityTable sessions={sessions} events={activityEvents} profiles={profiles} t={t} query={normalizedQuery} />
          </section>
        </div>
      );
    }

    if (section === 'sessionDetail') {
      return (
        <SessionDetailPage
          session={sessionDetail || (id ? sessions.find(session => session.id === id) || null : null)}
          events={sessionDetailEvents}
          profiles={profiles}
          loading={isDetailLoading}
          t={t}
        />
      );
    }

    if (section === 'reports' || section === 'dailyReport') {
      return (
        <ReportsPage
          articles={articles}
          logs={logs}
          activityEvents={activityEvents}
          profiles={profiles}
          externalAnalysisJobs={externalAnalysisJobs}
          isExternalAnalysisLoading={isExternalAnalysisLoading}
          externalAnalysisError={externalAnalysisError}
          secretStatus={secretStatus}
          isSecretStatusLoading={isSecretStatusLoading}
          onRefreshSecretStatus={refreshSecretStatus}
          date={selectedReportDate}
          t={t}
        />
      );
    }

    if (section === 'overview') {
      return (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
            <AdminStat icon={<BookOpen size={18} />} label="المقالات النشطة" value={activeArticles.length} />
            <AdminStat icon={<Trash2 size={18} />} label="في السلة" value={trashedArticles.length} />
            <AdminStat icon={<Users size={18} />} label="المستخدمون" value={profiles.length} />
            <AdminStat icon={<Workflow size={18} />} label="n8n" value={n8nArticles.length} />
            <AdminStat icon={<Clock size={18} />} label="وقت التحرير" value={formatSeconds(totalTime, t)} />
          </div>
          <section>
            <SectionTitle>{isArticleFilterActive ? 'نتائج البحث والفلاتر' : 'آخر المقالات'}</SectionTitle>
            <ArticleList articles={(isArticleFilterActive ? filteredArticles : activeArticles).slice(0, 24)} profiles={profiles} t={t} />
          </section>
          <section>
            <SectionTitle>مقالات n8n</SectionTitle>
            <ArticleList articles={n8nArticles.slice(0, 12)} profiles={profiles} t={t} />
          </section>
          <section>
            <SectionTitle>سجلات n8n</SectionTitle>
            <LogsTable logs={logs.slice(0, 12)} t={t} />
          </section>
        </div>
      );
    }

    return (
      <section>
        <SectionTitle>{section === 'trash' ? 'سلة المقالات' : 'المقالات'}</SectionTitle>
        <ArticleList articles={filteredArticles} profiles={profiles} t={t} />
      </section>
    );
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 dark:bg-[#181818]`}>
      <div className="mx-auto max-w-screen-xl p-4 sm:p-6 md:p-8">
        <header className="mb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-xs font-black text-[#d4af37]">Bazarvan Monitor</div>
              <h1 className="mt-1 text-3xl font-black text-gray-900 dark:text-gray-100">مركز المتابعة</h1>
              <p className="mt-1 text-sm font-semibold text-gray-500 dark:text-gray-400">{currentUser}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => navigateToAppPath('/dashboard')}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
              >
                <BookOpen size={16} />
                <span>لوحة المستخدم</span>
              </button>
              <button
                type="button"
                onClick={() => navigateToAppPath('/settings')}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
              >
                <Settings size={16} />
                <span>الإعدادات</span>
              </button>
              <button
                type="button"
                onClick={refreshData}
                className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
              >
                <RefreshCw size={16} />
                <span>تحديث</span>
              </button>
            </div>
          </div>
          <nav className="mt-5 flex flex-wrap gap-2">
            {navActions.map(action => <AdminButton key={action.path} {...action} />)}
          </nav>
          <AdminBreadcrumbs items={breadcrumbs} />
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
          <div className="flex items-center gap-2">
            <Search size={16} className="text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="بحث عام داخل مركز المتابعة: مقالة، مستخدم، شركة، n8n، جلسة، نشاط..."
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-100"
            />
            {(query || hasActiveArticleFilters(articleFilters)) && (
              <button
                type="button"
                onClick={resetArticleFilters}
                className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-300"
              >
                <X size={14} />
                <span>إعادة ضبط</span>
              </button>
            )}
          </div>

          {shouldShowArticleFilters && (
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-gray-100 pt-3 text-xs dark:border-[#3C3C3C] sm:grid-cols-2 lg:grid-cols-7">
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><Users size={13} /> المستخدم</span>
                <select name="profileId" value={articleFilters.profileId} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <option value="all">الكل</option>
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{getProfileLabel(profile)}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><Shield size={13} /> الحالة</span>
                <select name="status" value={articleFilters.status} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <option value="all">الكل</option>
                  {articleFilterOptions.statuses.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><FileText size={13} /> اللغة</span>
                <select name="language" value={articleFilters.language} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <option value="all">الكل</option>
                  {articleFilterOptions.languages.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><Workflow size={13} /> المصدر</span>
                <select name="source" value={articleFilters.source} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <option value="all">الكل</option>
                  {articleFilterOptions.sources.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><BookOpen size={13} /> الشركة</span>
                <select name="company" value={articleFilters.company} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                  <option value="all">الكل</option>
                  {articleFilterOptions.companies.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><Calendar size={13} /> من تاريخ</span>
                <input name="dateFrom" type="date" value={articleFilters.dateFrom} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" />
              </label>
              <label className="space-y-1">
                <span className="inline-flex items-center gap-1 font-black text-gray-500 dark:text-gray-400"><Calendar size={13} /> إلى تاريخ</span>
                <input name="dateTo" type="date" value={articleFilters.dateTo} onChange={handleArticleFilterChange} className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-2 font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" />
              </label>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="mb-4 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-sm font-bold text-[#8a6f1d] dark:text-[#f2d675]">
            جار تحميل بيانات Supabase...
          </div>
        )}

        {renderMain()}
      </div>
    </div>
  );
};

const ArticleList: React.FC<{
  articles: RemoteArticleActivity[];
  profiles: RemoteProfile[];
  t: typeof translations.ar;
}> = ({ articles, profiles, t }) => {
  if (articles.length === 0) {
    return <EmptyState icon={<FileText size={24} />} title="لا توجد مقالات في هذا النطاق" />;
  }

  const getOwnerLabel = (article: RemoteArticleActivity): string => {
    const ownerId = getArticleOwnerId(article);
    const owner = ownerId ? profiles.find(profile => profile.id === ownerId) : null;
    return getProfileLabel(owner);
  };

  return (
    <ul className="space-y-2">
      {sortArticles(articles).map(article => (
        <ArticleRow key={article.id} article={article} ownerLabel={getOwnerLabel(article)} t={t} />
      ))}
    </ul>
  );
};

export default AdminApp;
