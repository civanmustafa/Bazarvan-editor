
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LogOut, Edit, RefreshCw, Clock, Key, Save, Book, Trash2, AlertCircle, Repeat, FileText, PlusSquare, PaintRoller, Baseline, LayoutGrid, ListTree, List, FileDown, Filter, X, Calendar, Settings, Languages, AppWindow, NotebookTabs, ExternalLink, Users, Eye, Shield, Copy } from 'lucide-react';
import { getActivityData, UserActivity, ArticleActivity } from '../hooks/useUserActivity';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import ClientGoalSettings from './ClientGoalSettings';
import EngineeringPromptsSettings from './EngineeringPromptsSettings';
import NewArticleLanguageModal from './NewArticleLanguageModal';
import { formatIstanbulDateTime, getIstanbulDateKey, getIstanbulDayEnd, getIstanbulDayStart } from '../utils/dateTime';
import {
    claimRemoteArticle,
    deleteRemoteArticle,
    getArticleTrashInfo,
    listRemoteN8nIngestLogs,
    listRemoteProfiles,
    listRemoteArticles,
    loadRemoteArticleSnapshot,
    moveRemoteArticleToTrash,
    purgeExpiredRemoteArticleTrash,
    renameRemoteArticle,
    restoreRemoteArticleFromTrash,
    triggerAssignedArticleAutomation,
    updateRemoteArticleSettings,
    type RemoteProfile,
    type RemoteArticleActivity,
    type RemoteArticleTrashInfo,
    type RemoteN8nIngestLog,
    type RemoteArticleSettingsPatch,
} from '../utils/supabaseArticles';
import { getSupabaseClient, isSupabaseConfigured } from '../utils/supabaseClient';
import type { ArticleStorageSnapshot } from '../utils/editorContentStore';
import { buildEditorArticlePath, navigateToAppPath } from '../utils/appRoutes';

/*
 * Dashboard is the user workspace:
 * saved articles, activity summary, filters, report export, and user-facing settings.
 *
 * Edit here for dashboard layout or article list actions.
 * Edit hooks/useUserActivity.ts for the saved data shape and persistence behavior.
 */
type ActivityData = {
  [username: string]: UserActivity;
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

const SummaryStat: React.FC<{ icon: React.ReactNode; label: string; value: string | number }> = ({ icon, label, value }) => (
  <div className="flex items-center gap-4 p-4 bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C]">
    <div className="p-3 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-lg">
      {icon}
    </div>
    <div className="text-start">
      <div className="text-xl font-bold text-[#333333] dark:text-[#b7b7b7]">{value}</div>
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  </div>
);

const getProfileLabel = (profile?: RemoteProfile): string => (
  profile?.fullName?.trim() || profile?.email?.trim() || 'مستخدم غير معروف'
);

const getArticleOwnerId = (article: RemoteArticleActivity): string | null => (
  article.ownerId || article.createdBy || article.assignedTo || null
);

const articleBelongsToProfile = (article: RemoteArticleActivity, profileId: string): boolean => (
  article.ownerId === profileId || article.createdBy === profileId || article.assignedTo === profileId
);

const getLatestSavedAt = (articles: RemoteArticleActivity[]): string => (
  articles
    .map(article => article.lastSaved)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || ''
);

const getProfileKeywords = (articles: RemoteArticleActivity[]): string[] => {
  const keywords = new Set<string>();
  articles.forEach(article => {
    const title = article.title?.trim();
    if (title) keywords.add(title);
  });
  return Array.from(keywords).slice(0, 4);
};

const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const isProfileOnline = (profile: RemoteProfile): boolean => (
  Boolean(profile.lastSeenAt && Date.now() - new Date(profile.lastSeenAt).getTime() <= ONLINE_WINDOW_MS)
);

const getArticleSortTime = (article: RemoteArticleActivity): number => Math.max(
  new Date(article.updatedAt || 0).getTime(),
  new Date(article.lastSaved || 0).getTime(),
  new Date(article.createdAt || 0).getTime(),
);

const getArticleCreatedTime = (article: RemoteArticleActivity): number => (
  new Date(article.createdAt || 0).getTime()
);

const sortArticlesByLastChange = (articles: RemoteArticleActivity[]): RemoteArticleActivity[] => (
  [...articles].sort((left, right) => getArticleSortTime(right) - getArticleSortTime(left))
);

const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
    <div className="text-[11px] font-bold text-gray-400">{label}</div>
    <div className="mt-1 break-words text-sm font-semibold text-gray-700 dark:text-gray-200">{value === null || value === undefined || value === '' ? '-' : value}</div>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="mb-3 text-sm font-black text-gray-700 dark:text-gray-200">{children}</h3>
);

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const normalizeSearchText = (value: unknown): string => (
  String(value || '').toLowerCase().trim()
);

const getUniqueArticleValues = (
  articles: RemoteArticleActivity[],
  getter: (article: RemoteArticleActivity) => string | undefined | null,
): string[] => Array.from(new Set(
  articles
    .map(article => getter(article)?.trim() || '')
    .filter(Boolean)
)).sort((left, right) => left.localeCompare(right));

const getArticleSearchText = (article: RemoteArticleActivity, ownerLabel: string, ownerId: string): string => {
  const keywords = article.keywords || { primary: '', secondaries: [], company: '', lsi: [] };
  const goalContext = article.goalContext || {};
  return [
    article.title,
    keywords.primary,
    ...(Array.isArray(keywords.secondaries) ? keywords.secondaries : []),
    ...(Array.isArray(keywords.lsi) ? keywords.lsi : []),
    keywords.company,
    goalContext.pageType,
    goalContext.objective,
    goalContext.audienceScope,
    goalContext.targetCountry,
    goalContext.searchIntent,
    article.plainText,
    article.source,
    article.status,
    article.visibility,
    ownerLabel,
    ownerId,
  ].map(normalizeSearchText).join(' ');
};

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

const isPublicClaimOpportunity = (article: RemoteArticleActivity): boolean => (
  article.visibility === 'public' &&
  !article.ownerId &&
  !article.createdBy &&
  !article.assignedTo &&
  !getN8nSettings(article).visibleToEmailsCsv
);

const canProfileSeeArticle = (
  article: RemoteArticleActivity,
  profileId: string,
  isAdmin: boolean,
): boolean => (
  isAdmin ||
  Boolean(profileId && (
    articleBelongsToProfile(article, profileId) ||
    isPublicClaimOpportunity(article)
  ))
);

const canProfileSeeTrashedArticle = (
  article: RemoteArticleActivity,
  profileId: string,
  isAdmin: boolean,
): boolean => (
  isAdmin ||
  Boolean(profileId && articleBelongsToProfile(article, profileId))
);

type N8nSettingFieldKey = keyof Pick<RemoteArticleSettingsPatch, 'visibility' | 'accessRole' | 'articleLanguage' | 'status'>;
type N8nDisplayFieldKey = N8nSettingFieldKey | 'visibleToEmailsCsv';

const isEditableN8nSettingField = (field: N8nDisplayFieldKey): field is N8nSettingFieldKey => (
  field !== 'visibleToEmailsCsv'
);

const N8N_SETTING_OPTIONS: Record<N8nSettingFieldKey, { value: string; label: string }[]> = {
  visibility: [
    { value: 'private', label: 'خاص' },
    { value: 'public', label: 'عام' },
  ],
  accessRole: [
    { value: 'viewer', label: 'عرض' },
    { value: 'editor', label: 'تعديل' },
  ],
  articleLanguage: [
    { value: 'ar', label: 'عربي' },
    { value: 'en', label: 'English' },
  ],
  status: [
    { value: 'draft', label: 'مسودة' },
    { value: 'in_review', label: 'جاهز' },
    { value: 'published', label: 'منشور' },
    { value: 'archived', label: 'أرشيف' },
  ],
};

const getN8nOptionLabel = (field: N8nSettingFieldKey, value: string): string => (
  N8N_SETTING_OPTIONS[field].find(option => option.value === value)?.label || value
);

const getArticleCompetitors = (
  article: RemoteArticleActivity,
  snapshot?: ArticleStorageSnapshot | null,
) => {
  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const metadataAttachments = isRecord(metadata.attachments) ? metadata.attachments : {};
  const competitors = snapshot?.attachments?.competitors || (isRecord(metadataAttachments.competitors) ? metadataAttachments.competitors : null);
  const urls = Array.isArray(competitors?.urls) ? competitors.urls : [];
  const texts = Array.isArray(competitors?.texts) ? competitors.texts : [];
  const htmls = Array.isArray(competitors?.htmls) ? competitors.htmls : [];

  return [0, 1, 2].map(index => ({
    index: index + 1,
    url: typeof urls[index] === 'string' ? urls[index] : '',
    text: typeof texts[index] === 'string' ? texts[index] : '',
    html: typeof htmls[index] === 'string' ? htmls[index] : '',
  })).filter(item => item.url.trim() || item.text.trim() || item.html.trim());
};

const N8nSettingChip: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <span className="inline-flex min-w-0 max-w-[180px] shrink-0 items-center gap-1 rounded-md bg-[#d4af37]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]" title={String(value || '-')}>
    <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}:</span>
    <span className="min-w-0 truncate">{value || '-'}</span>
  </span>
);

const EditableN8nSettingField: React.FC<{
  field: N8nSettingFieldKey;
  value: string;
  disabled: boolean;
  onChange: (field: N8nSettingFieldKey, value: string) => void;
}> = ({ field, value, disabled, onChange }) => (
  <label
    className="inline-flex min-w-[104px] max-w-[150px] shrink-0 items-center gap-1 rounded-md bg-[#d4af37]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]"
    onClick={event => event.stopPropagation()}
  >
    <span className="shrink-0 text-gray-500 dark:text-gray-400">{field}:</span>
    <select
      value={value || ''}
      disabled={disabled}
      onClick={event => event.stopPropagation()}
      onChange={event => onChange(field, event.target.value)}
      className="min-w-0 flex-1 cursor-pointer rounded border border-transparent bg-transparent text-[10px] font-black text-[#8a6f1d] outline-none focus:border-[#d4af37] disabled:cursor-wait disabled:opacity-60 dark:text-[#f2d675]"
    >
      {!value && <option value="">-</option>}
      {N8N_SETTING_OPTIONS[field].map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

const EditableN8nTextField: React.FC<{
  field: 'visibleToEmailsCsv';
  value?: string;
  disabled: boolean;
  onChange: (field: 'visibleToEmailsCsv', value: string) => void;
}> = ({ field, value = '', disabled, onChange }) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const nextValue = draft.trim();
    if (nextValue !== value.trim()) {
      onChange(field, nextValue);
    }
  };

  return (
    <label
      className="inline-flex min-w-[145px] max-w-[220px] shrink-0 items-center gap-1 rounded-md bg-[#d4af37]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]"
      onClick={event => event.stopPropagation()}
      title={draft || '-'}
    >
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{field}:</span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-[10px] font-black text-[#8a6f1d] outline-none focus:border-[#d4af37] disabled:cursor-wait disabled:opacity-60 dark:text-[#f2d675]"
        placeholder="-"
      />
    </label>
  );
};

const AdminUsersTable: React.FC<{
  profiles: RemoteProfile[];
  articles: RemoteArticleActivity[];
  selectedProfileId: string | null;
  onSelectProfile: (profileId: string | null) => void;
  t: typeof translations.ar;
}> = ({ profiles, articles, selectedProfileId, onSelectProfile, t }) => {
  const allArticlesLastSaved = getLatestSavedAt(articles);
  const allProfilesOnlineCount = profiles.filter(isProfileOnline).length;

  return (
    <div className="mb-8 rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold text-gray-800 dark:text-gray-100">
          <Users size={20} />
          <span>جدول المستخدمين</span>
        </h2>
        <button
          onClick={() => onSelectProfile(null)}
          className={`rounded-md px-3 py-1.5 text-xs font-bold ${selectedProfileId === null ? 'bg-[#d4af37] text-white' : 'bg-gray-100 text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-300'}`}
        >
          كل المستخدمين
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-start text-sm">
          <thead className="text-xs uppercase text-gray-400">
            <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
              <th className="px-3 py-2 text-start">المستخدم</th>
              <th className="px-3 py-2 text-start">الحالة</th>
              <th className="px-3 py-2 text-start">الدور</th>
              <th className="px-3 py-2 text-start">عدد المقالات</th>
              <th className="px-3 py-2 text-start">آخر عمل</th>
              <th className="px-3 py-2 text-start">الوقت</th>
              <th className="px-3 py-2 text-start">العناوين</th>
            </tr>
          </thead>
          <tbody>
            <tr
              className={`cursor-pointer border-b border-gray-100 transition-colors hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:hover:bg-[#d4af37]/15 ${selectedProfileId === null ? 'bg-[#d4af37]/10' : ''}`}
              onClick={() => onSelectProfile(null)}
            >
              <td className="px-3 py-3 font-black text-gray-700 dark:text-gray-100">كل المستخدمين</td>
              <td className="px-3 py-3">
                <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-black text-green-700 dark:bg-green-500/15 dark:text-green-300">
                  {allProfilesOnlineCount} أونلاين
                </span>
              </td>
              <td className="px-3 py-3 text-gray-500">admin view</td>
              <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{articles.length}</td>
              <td className="px-3 py-3 text-gray-500">{allArticlesLastSaved ? formatIstanbulDateTime(allArticlesLastSaved, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
              <td className="px-3 py-3 text-gray-500">{formatSeconds(articles.reduce((sum, article) => sum + article.timeSpentSeconds, 0), t)}</td>
              <td className="px-3 py-3 text-gray-500">{getProfileKeywords(articles).join('، ') || '-'}</td>
            </tr>
            {profiles.map(profile => {
              const profileArticles = articles.filter(article => articleBelongsToProfile(article, profile.id));
              const lastSaved = getLatestSavedAt(profileArticles);
              const isSelected = selectedProfileId === profile.id;
              const online = isProfileOnline(profile);
              const lastWorkAt = profile.lastSeenAt || lastSaved;

              return (
                <tr
                  key={profile.id}
                  className={`cursor-pointer border-b border-gray-100 transition-colors hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:hover:bg-[#d4af37]/15 ${isSelected ? 'bg-[#d4af37]/10' : ''}`}
                  onClick={() => onSelectProfile(profile.id)}
                >
                  <td className="px-3 py-3">
                    <div className="font-black text-gray-700 dark:text-gray-100">{getProfileLabel(profile)}</div>
                    <div className="text-xs text-gray-400">{profile.email}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-black ${online ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
                      {online ? 'أونلاين' : 'غير متصل'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-black ${profile.role === 'admin' ? 'bg-[#d4af37]/15 text-[#8a6f1d] dark:text-[#f2d675]' : 'bg-gray-100 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-300'}`}>
                      {profile.role}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{profileArticles.length}</td>
                  <td className="px-3 py-3 text-gray-500">{lastWorkAt ? formatIstanbulDateTime(lastWorkAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                  <td className="px-3 py-3 text-gray-500">{formatSeconds(profileArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0), t)}</td>
                  <td className="px-3 py-3 text-gray-500">{getProfileKeywords(profileArticles).join('، ') || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const getN8nLogTitle = (log: RemoteN8nIngestLog): string => {
  const payload = log.payload && typeof log.payload === 'object' && !Array.isArray(log.payload) ? log.payload : {};
  return String(payload.title || payload.articleTitle || payload.article_title || payload.headline || log.externalId || '-');
};

const N8nLogsPanel: React.FC<{
  logs: RemoteN8nIngestLog[];
  isLoading: boolean;
  t: typeof translations.ar;
}> = ({ logs, isLoading, t }) => {
  const latestError = logs.find(log => log.status === 'failed' || log.errorMessage);

  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">سجل طلبات n8n</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">آخر الطلبات الواردة من n8n وحالة إنشاء المقالات.</p>
        </div>
        <span className="rounded-full bg-[#d4af37]/10 px-2.5 py-1 text-[11px] font-black text-[#8a6f1d] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
          {logs.length} طلب
        </span>
      </div>
      {latestError && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <div className="font-bold">آخر خطأ n8n</div>
          <div className="mt-1">{latestError.errorMessage || 'فشل غير محدد.'}</div>
          <div className="mt-1 text-red-500/80">
            {formatIstanbulDateTime(latestError.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-right text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-400">
            <tr>
              <th className="px-2 py-2">الحالة</th>
              <th className="px-2 py-2">العنوان</th>
              <th className="px-2 py-2">External ID</th>
              <th className="px-2 py-2">Workflow</th>
              <th className="px-2 py-2">الوقت</th>
              <th className="px-2 py-2">الخطأ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-[#3C3C3C]">
            {isLoading ? (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-gray-500">جار تحميل سجل n8n...</td></tr>
            ) : logs.length > 0 ? logs.map(log => (
              <tr key={log.id} className="align-top text-gray-600 dark:text-gray-300">
                <td className="px-2 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                    log.status === 'failed'
                      ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                      : 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
                  }`}>
                    {log.status}
                  </span>
                </td>
                <td className="max-w-[180px] truncate px-2 py-2" title={getN8nLogTitle(log)}>{getN8nLogTitle(log)}</td>
                <td className="max-w-[130px] truncate px-2 py-2" title={log.externalId || ''}>{log.externalId || '-'}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={log.workflowId || ''}>{log.workflowId || '-'}</td>
                <td className="whitespace-nowrap px-2 py-2">{formatIstanbulDateTime(log.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="max-w-[240px] truncate px-2 py-2 text-red-600 dark:text-red-300" title={log.errorMessage || ''}>{log.errorMessage || '-'}</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-gray-500">لا توجد طلبات n8n مسجلة بعد.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const ArticleDetailsModal: React.FC<{
  article: RemoteArticleActivity;
  snapshot: ArticleStorageSnapshot | null;
  ownerLabel: string;
  isLoading: boolean;
  onClose: () => void;
  onOpenArticle: () => void;
  t: typeof translations.ar;
}> = ({ article, snapshot, ownerLabel, isLoading, onClose, onOpenArticle, t }) => {
  const keywords = snapshot?.keywords || article.keywords;
  const goalContext = snapshot?.goalContext || article.goalContext;
  const analysis = snapshot?.analysis || article.analysis;
  const plainText = snapshot?.plainText || article.plainText || '';
  const analysisSummary = snapshot?.analysisSummary;
  const secondaryKeywords = keywords?.secondaries?.filter(keyword => keyword.trim()) || [];
  const lsiKeywords = keywords?.lsi?.filter(keyword => keyword.trim()) || [];
  const n8nSettings = getN8nSettings(article);
  const competitors = getArticleCompetitors(article, snapshot);
  const metadata = article.metadata && typeof article.metadata === 'object' && !Array.isArray(article.metadata) ? article.metadata : {};
  const geminiPaidLatest = metadata.aiResults?.geminiPaid?.latest;
  const trashInfo = getArticleTrashInfo(article);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-5 dark:border-[#3C3C3C]">
          <div className="min-w-0">
            <div className="text-xs font-black text-[#d4af37]">تفاصيل المقالة</div>
            <h2 className="mt-1 truncate text-2xl font-black text-gray-800 dark:text-gray-100">{article.title || t.untitled}</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{ownerLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onOpenArticle} className="rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e]">
              فتح في المحرر
            </button>
            <button onClick={onClose} className="rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#1F1F1F]" title="إغلاق">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-5">
          {isLoading && (
            <div className="mb-4 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-sm font-bold text-[#8a6f1d] dark:text-[#f2d675]">
              جار تحميل التفاصيل الكاملة...
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <DetailRow label="المالك" value={ownerLabel} />
            <DetailRow label="الحالة" value={getN8nOptionLabel('status', article.status)} />
            <DetailRow label="المصدر" value={article.source} />
            <DetailRow label="الظهور" value={article.visibility} />
            <DetailRow label="لغة المقال" value={(article.articleLanguage || 'ar').toUpperCase()} />
            <DetailRow label="عدد مرات الحفظ" value={article.saveCount} />
            <DetailRow label="تاريخ الإنشاء" value={article.createdAt ? formatIstanbulDateTime(article.createdAt, t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'} />
            <DetailRow label="آخر حفظ" value={article.lastSaved ? formatIstanbulDateTime(article.lastSaved, t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'} />
            <DetailRow label="الوقت المستغرق" value={formatSeconds(article.timeSpentSeconds, t)} />
            {trashInfo && (
              <>
                <DetailRow label="تاريخ الحذف" value={formatIstanbulDateTime(trashInfo.deletedAt, t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
                <DetailRow label="حذف بواسطة" value={trashInfo.deletedBy || '-'} />
              </>
            )}
          </div>

          <div className="mt-6">
            <SectionTitle>إعدادات المقالة من n8n</SectionTitle>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              <DetailRow label="visibility" value={n8nSettings.visibility} />
              <DetailRow label="accessRole" value={n8nSettings.accessRole} />
              <DetailRow label="visibleToEmailsCsv" value={n8nSettings.visibleToEmailsCsv} />
              <DetailRow label="articleLanguage" value={n8nSettings.articleLanguage} />
              <DetailRow label="status" value={getN8nOptionLabel('status', n8nSettings.status)} />
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <SectionTitle>الكلمات المفتاحية</SectionTitle>
              <div className="space-y-3 rounded-lg border border-gray-100 p-4 dark:border-[#3C3C3C]">
                <DetailRow label="الرئيسية" value={keywords?.primary || '-'} />
                <DetailRow label="الشركة" value={keywords?.company || '-'} />
                <DetailRow label="الثانوية" value={secondaryKeywords.length ? secondaryKeywords.join('، ') : '-'} />
                <DetailRow label="LSI" value={lsiKeywords.length ? lsiKeywords.join('، ') : '-'} />
              </div>
            </div>

            <div>
              <SectionTitle>نتائج التحليل</SectionTitle>
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-100 p-4 dark:border-[#3C3C3C]">
                <DetailRow label="عدد الكلمات" value={article.stats?.wordCount ?? 0} />
                <DetailRow label="مخالفات الكلمات" value={article.stats?.keywordViolations ?? 0} />
                <DetailRow label="معايير مخالفة" value={article.stats?.violatingCriteriaCount ?? 0} />
                <DetailRow label="أخطاء الهيكل" value={article.stats?.totalErrorsCount ?? 0} />
                <DetailRow label="إجمالي التكرارات" value={article.stats?.totalDuplicates ?? 0} />
                <DetailRow label="تكرارات الكلمات" value={article.stats?.keywordDuplicatesCount ?? 0} />
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <SectionTitle>بيانات الهدف</SectionTitle>
              <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200" dir="ltr">
                {JSON.stringify(goalContext || {}, null, 2)}
              </pre>
            </div>
            <div>
              <SectionTitle>ملخص التحليل الكامل</SectionTitle>
              <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs leading-6 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200" dir="ltr">
                {JSON.stringify({
                  analysisSummary,
                  structureStats: analysis?.structureStats,
                  duplicateStats: analysis?.duplicateStats,
                  wordCount: analysis?.wordCount,
                }, null, 2)}
              </pre>
            </div>
          </div>

          {competitors.length > 0 && (
            <div className="mt-6">
              <SectionTitle>محتوى المنافسين من n8n</SectionTitle>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {competitors.map(competitor => (
                  <div key={competitor.index} className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                    <div className="text-xs font-black text-gray-700 dark:text-gray-200">المنافس {competitor.index}</div>
                    <div className="mt-2 text-[11px] font-bold text-gray-400">الرابط</div>
                    <div className="mt-1 break-words text-xs font-semibold text-[#8a6f1d] dark:text-[#f2d675]">{competitor.url || '-'}</div>
                    <div className="mt-3 text-[11px] font-bold text-gray-400">النص</div>
                    <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-6 text-gray-600 dark:text-gray-300">
                      {competitor.text || (competitor.html ? 'تم استلام HTML فقط.' : '-')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {geminiPaidLatest?.result && (
            <div className="mt-6">
              <SectionTitle>آخر نتيجة Gemini Pro محفوظة</SectionTitle>
              <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <DetailRow label="الموديل" value={geminiPaidLatest.model || '-'} />
                <DetailRow label="بصمة المفتاح" value={geminiPaidLatest.keyFingerprint || '-'} />
                <DetailRow label="وقت الحفظ" value={geminiPaidLatest.savedAt ? formatIstanbulDateTime(geminiPaidLatest.savedAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'} />
              </div>
              <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm leading-7 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
                {geminiPaidLatest.result}
              </div>
            </div>
          )}

          <div className="mt-6">
            <SectionTitle>معاينة النص</SectionTitle>
            <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm leading-7 text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
              {plainText.trim() || 'لا توجد معاينة نصية محفوظة.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const createApiKeyFingerprint = (key: string): string => {
  const normalizedKey = key.trim();
  let hash = 2166136261;
  for (let index = 0; index < normalizedKey.length; index += 1) {
    hash ^= normalizedKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const maskApiKey = (key: string): string => {
  const trimmedKey = key.trim();
  if (!trimmedKey) return '';
  const tail = trimmedKey.slice(-4);
  return `**** ${tail}`;
};

const SeoScoreIndicator: React.FC<{ score: number }> = ({ score }) => {
  const getScoreColor = () => {
    if (score >= 85) return 'text-green-500 bg-green-500/10 border-green-500/20';
    if (score >= 60) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
    return 'text-red-500 bg-red-500/10 border-red-500/20';
  };

  return (
    <div className={`flex h-10 w-10 flex-col items-center justify-center rounded-full border ${getScoreColor()}`}>
      <span className="text-sm font-bold leading-4">{Math.round(score)}</span>
      <span className="text-[9px] font-medium opacity-80">SEO</span>
    </div>
  );
};


interface ArticleItemProps {
    title: string;
    activity: ArticleActivity | RemoteArticleActivity;
    ownerLabel?: string;
    trashInfo?: RemoteArticleTrashInfo | null;
    deletedByLabel?: string;
    isSelected?: boolean;
    isSelectable?: boolean;
    onToggleSelected?: () => void;
    onLoad: () => void;
    onDetails?: () => void;
    onDelete: () => void;
    onPermanentDelete?: () => void;
    onRestore?: () => void;
    onRename: (newTitle: string) => boolean | Promise<boolean>;
    onUpdateSettings?: (articleId: string, patch: RemoteArticleSettingsPatch) => Promise<boolean>;
    onClaim?: (articleId: string) => Promise<boolean>;
    visibleSettingFields?: N8nDisplayFieldKey[];
    editableSettingFields?: N8nDisplayFieldKey[];
    isTrashView?: boolean;
    showAdminMetadata?: boolean;
    t: typeof translations.ar;
}

const ArticleListItem: React.FC<ArticleItemProps> = ({
    title,
    activity,
    ownerLabel,
    trashInfo,
    deletedByLabel,
    isSelected = false,
    isSelectable = false,
    onToggleSelected,
    onLoad,
    onDetails,
    onDelete,
    onPermanentDelete,
    onRestore,
    onRename,
    onUpdateSettings,
    onClaim,
    visibleSettingFields = [],
    editableSettingFields = [],
    isTrashView = false,
    showAdminMetadata = false,
    t,
}) => {
    const [isRenaming, setIsRenaming] = useState(false);
    const [newTitle, setNewTitle] = useState(title);
    const [savingSettingField, setSavingSettingField] = useState<N8nDisplayFieldKey | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(`هل تريد نقل "${title}" إلى سلة المهملات؟`)) {
            onDelete();
        }
    };

    const handlePermanentDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!onPermanentDelete) return;
        if (window.confirm(`سيتم حذف "${title}" نهائيا ولا يمكن استعادتها. هل أنت متأكد؟`)) {
            onPermanentDelete();
        }
    };

    const handleStartRename = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsRenaming(true);
    };

    const handleCancelRename = () => {
        setIsRenaming(false);
        setNewTitle(title);
    };

    const handleRenameSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (await onRename(newTitle)) {
            setIsRenaming(false);
        } else {
            alert(t.renameArticleError.replace('{title}', newTitle));
            inputRef.current?.focus();
        }
    };

    const handleSettingChange = async (field: N8nDisplayFieldKey, value: string) => {
        const articleId = (activity as RemoteArticleActivity).id;
        if (!articleId || !onUpdateSettings || savingSettingField) return;

        const patch: RemoteArticleSettingsPatch = field === 'articleLanguage'
            ? { articleLanguage: value as RemoteArticleSettingsPatch['articleLanguage'] }
            : field === 'visibleToEmailsCsv'
              ? { visibleToEmailsCsv: value }
              : { [field]: value } as RemoteArticleSettingsPatch;

        setSavingSettingField(field);
        const isSaved = await onUpdateSettings(articleId, patch);
        setSavingSettingField(null);
        if (!isSaved) {
            alert('تعذر حفظ إعداد المقالة. حاول مرة أخرى.');
        }
    };

    const handleClaimArticle = async (event: React.MouseEvent) => {
        event.stopPropagation();
        const articleId = (activity as RemoteArticleActivity).id;
        if (!articleId || !onClaim || savingSettingField) return;

        setSavingSettingField('visibleToEmailsCsv');
        const isClaimed = await onClaim(articleId);
        setSavingSettingField(null);
        if (!isClaimed) {
            alert('تعذر حجز المقالة. ربما قام مستخدم آخر بحجزها الآن.');
        }
    };
    
    const calculateSeoScore = () => {
        if (!activity.stats) return 0;
        const { violatingCriteriaCount = 0, totalErrorsCount = 0, keywordViolations = 0 } = activity.stats;
        const deductions = (violatingCriteriaCount * 3) + (totalErrorsCount * 0.5) + (keywordViolations * 2);
        const score = Math.max(0, 100 - deductions);
        return score;
    };
    const seoScore = calculateSeoScore();

    if (isRenaming) {
      return (
          <li className="p-2.5 bg-gray-100 dark:bg-[#3C3C3C] rounded-md ring-2 ring-[#d4af37]">
              <form onSubmit={handleRenameSubmit}>
                  <input
                      ref={inputRef}
                      type="text"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full p-2 text-sm font-bold bg-white dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#4A4A4A] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-[#333333] dark:text-gray-200"
                      aria-label="New article title"
                  />
                  <div className="flex justify-end gap-2 mt-2">
                      <button type="button" onClick={(e)=>{e.stopPropagation(); handleCancelRename();}} className="px-3 py-1 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-[#d4af37]/20 dark:bg-[#4A4A4A] dark:text-gray-200 dark:hover:bg-[#d4af37]/25">
                          {t.cancel}
                      </button>
                      <button type="submit" className="px-3 py-1 text-xs font-semibold text-white bg-[#d4af37] rounded-md hover:bg-[#b8922e]">
                          {t.save}
                      </button>
                  </div>
              </form>
          </li>
      );
    }
    
    const untranslatedTitle = title || t.untitled;
    const n8nSettings = getN8nSettings(activity as RemoteArticleActivity);
    const remoteActivity = activity as RemoteArticleActivity;
    const articleId = isRecord(activity) && typeof activity.id === 'string' ? activity.id : '';
    const articlePath = articleId ? buildEditorArticlePath(articleId) : '';
    const absoluteArticleUrl = articlePath ? `${window.location.origin}${articlePath}` : '';
    const canClaimArticle = Boolean(
        onClaim &&
        !isTrashView &&
        remoteActivity.visibility === 'public' &&
        !remoteActivity.ownerId &&
        !remoteActivity.assignedTo &&
        !n8nSettings.visibleToEmailsCsv
    );
    const fieldsToShow = visibleSettingFields.length > 0
        ? visibleSettingFields
        : showAdminMetadata
          ? (['status', 'visibility', 'accessRole', 'articleLanguage'] as N8nSettingFieldKey[])
          : [];
    const shouldShowN8nSettings = fieldsToShow.length > 0 && (
        Boolean(n8nSettings.visibility) ||
        Boolean(n8nSettings.accessRole) ||
        Boolean(n8nSettings.visibleToEmailsCsv) ||
        Boolean(n8nSettings.articleLanguage) ||
        Boolean(n8nSettings.status)
    );
    const handleCopyArticleLink = async (event: React.MouseEvent) => {
        event.stopPropagation();
        if (!absoluteArticleUrl) return;
        await navigator.clipboard?.writeText(absoluteArticleUrl);
    };
    const handleOpenArticleTab = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (!absoluteArticleUrl) return;
        window.open(absoluteArticleUrl, '_blank', 'noopener,noreferrer');
    };

    return (
        <li
            className="group flex items-center gap-2 p-2 bg-white dark:bg-[#2A2A2A] rounded-md transition-all duration-200 hover:shadow-md hover:border-gray-300 dark:hover:border-[#4A4A4A] cursor-pointer border border-gray-200 dark:border-[#3C3C3C]"
            onClick={onLoad}
            role="button"
            tabIndex={0}
            onKeyPress={(e) => e.key === 'Enter' && onLoad()}
        >
            {isSelectable && (
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(event) => {
                        event.stopPropagation();
                        onToggleSelected?.();
                    }}
                    onClick={event => event.stopPropagation()}
                    className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
                    aria-label="تحديد المقالة"
                />
            )}
            <SeoScoreIndicator score={seoScore} />
            <div className="min-w-0 flex-grow space-y-0.5">
                <div className="flex items-start justify-between gap-2">
                    <h4 className="min-w-0 flex-1 truncate text-[13px] font-bold text-[#333333] dark:text-gray-200" title={untranslatedTitle}>
                        {untranslatedTitle}
                    </h4>
                    <div className="flex flex-shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {isTrashView && onRestore && (
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRestore();
                                }}
                                className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                                title="استعادة المقالة"
                            >
                                <RefreshCw size={13} />
                            </button>
                        )}
                        {onDetails && (
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDetails();
                                }}
                                className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                                title="تفاصيل المقالة"
                            >
                                <Eye size={13} />
                            </button>
                        )}
                        {articlePath && (
                            <>
                              <button
                                  onClick={handleCopyArticleLink}
                                  className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                                  title="نسخ رابط المقالة"
                              >
                                  <Copy size={13} />
                              </button>
                              <button
                                  onClick={handleOpenArticleTab}
                                  className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                                  title="فتح المقالة في تبويب جديد"
                              >
                                  <ExternalLink size={13} />
                              </button>
                            </>
                        )}
                        {!isTrashView ? (
                            <>
                              <button
                                  onClick={handleStartRename}
                                  className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                                  title={t.renameArticle}
                              >
                                  <Edit size={13} />
                              </button>
                              <button
                                  onClick={handleDelete}
                                  className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-red-600 dark:hover:bg-[#d4af37]/20 dark:hover:text-red-400"
                                  title="نقل إلى سلة المهملات"
                              >
                                  <Trash2 size={13} />
                              </button>
                            </>
                        ) : onPermanentDelete ? (
                            <button
                                onClick={handlePermanentDelete}
                                className="p-1 rounded-full text-gray-400 dark:text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                                title="حذف نهائي"
                            >
                                <Trash2 size={13} />
                            </button>
                        ) : null}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                    {activity.createdAt && (
                         <span className="flex items-center gap-1.5" title="تاريخ الإنشاء">
                            <Calendar size={12} />
                            {formatIstanbulDateTime(activity.createdAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                    )}
                    {activity.lastSaved && (
                         <span className="flex items-center gap-1.5" title={t.lastSaved}>
                            <RefreshCw size={12} />
                            {formatIstanbulDateTime(activity.lastSaved, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                    )}
                    <span className="flex items-center gap-1.5" title={t.timeSpent}><Clock size={12} /> {formatSeconds(activity.timeSpentSeconds, t)}</span>
                    {activity.stats && (
                        <span className="flex items-center gap-1.5" title={t.wordCount}><FileText size={12} /> {activity.stats.wordCount}</span>
                    )}
                     <span className="font-bold text-gray-600 dark:text-gray-300">{(activity.articleLanguage || 'ar').toUpperCase()}</span>
                    {ownerLabel && (
                        <span className="font-bold text-[#8a6f1d] dark:text-[#f2d675]">{ownerLabel}</span>
                    )}
                    <span className="flex items-center gap-1.5" title={t.keywordViolations}>
                        <Key size={12} className="text-yellow-500" />
                        <span>{activity.stats?.keywordViolations ?? 0}</span>
                    </span>
                    <span className="flex items-center gap-1.5" title={t.structureViolations}>
                        <AlertCircle size={12} className="text-red-500" />
                        <span>{activity.stats?.violatingCriteriaCount ?? 0}</span>
                    </span>
                    <span className="flex items-center gap-1.5" title={t.totalDuplicates}>
                        <Repeat size={12} className="text-[#d4af37]" />
                        <span>{activity.stats?.totalDuplicates ?? 0}</span>
                    </span>
                    {trashInfo?.deletedAt && (
                        <span className="flex items-center gap-1.5 font-bold text-red-500 dark:text-red-300" title="تاريخ الحذف ومن حذفه">
                            <Trash2 size={12} />
                            {formatIstanbulDateTime(trashInfo.deletedAt, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            {deletedByLabel ? ` - ${deletedByLabel}` : ''}
                        </span>
                    )}
                </div>
                {shouldShowN8nSettings && (
                    <div className="flex flex-nowrap items-center gap-1 overflow-x-auto border-t border-gray-100 pt-1 dark:border-[#3a3a3a]">
                        {fieldsToShow.map(field => {
                            const isEditable = Boolean(onUpdateSettings && editableSettingFields.includes(field));
                            if (field === 'visibleToEmailsCsv' && canClaimArticle) {
                                return (
                                    <button
                                        key={field}
                                        type="button"
                                        onClick={handleClaimArticle}
                                        disabled={savingSettingField !== null}
                                        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-green-100 px-2 py-0.5 text-[10px] font-black text-green-700 hover:bg-green-200 disabled:cursor-wait disabled:opacity-60 dark:bg-green-500/15 dark:text-green-300 dark:hover:bg-green-500/25"
                                        title="حجز المقالة وتحويلها إلى حسابك"
                                    >
                                        visibleToEmailsCsv: احجز
                                    </button>
                                );
                            }
                            if (isEditable && isEditableN8nSettingField(field)) {
                                return (
                                    <EditableN8nSettingField
                                        key={field}
                                        field={field}
                                        value={String(n8nSettings[field] || '')}
                                        disabled={savingSettingField !== null}
                                        onChange={handleSettingChange}
                                    />
                                );
                            }
                            if (isEditable && field === 'visibleToEmailsCsv') {
                                return (
                                    <EditableN8nTextField
                                        key={field}
                                        field={field}
                                        value={n8nSettings.visibleToEmailsCsv}
                                        disabled={savingSettingField !== null}
                                        onChange={handleSettingChange}
                                    />
                                );
                            }
                            return (
                                <N8nSettingChip
                                    key={field}
                                    label={field}
                                    value={isEditableN8nSettingField(field) ? getN8nOptionLabel(field, String(n8nSettings[field] || '')) : n8nSettings[field]}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        </li>
    );
};


const Dashboard: React.FC = () => {
  const {
    setCurrentView,
    currentUser,
    currentUserId,
    currentUserRole,
    handleLogout: onLogout,
    isDarkMode,
    highlightStyle: preferredHighlightStyle,
    handleHighlightStyleChange: onHighlightStyleChange,
    chatGptOpenMode,
    handleChatGptOpenModeChange: onChatGptOpenModeChange,
    keywordViewMode: preferredKeywordViewMode,
    handleKeywordViewModeChange: onKeywordViewModeChange,
    structureViewMode: preferredStructureViewMode,
    handleStructureViewModeChange: onStructureViewModeChange,
    preferredLanguage,
    handlePreferredLanguageChange: onPreferredLanguageChange,
    uiLanguage,
    handleUiLanguageChange: onUiLanguageChange,
    t,
  } = useUser();
  const { handleNewArticle: onNewArticle, handleLoadArticle: onLoadArticle } = useEditor();

  const onGoToEditor = () => setCurrentView('editor');
  
  const [activityData, setActivityData] = useState<ActivityData>(getActivityData());
  const [remoteArticles, setRemoteArticles] = useState<RemoteArticleActivity[]>([]);
  const [n8nLogs, setN8nLogs] = useState<RemoteN8nIngestLog[]>([]);
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [detailArticle, setDetailArticle] = useState<RemoteArticleActivity | null>(null);
  const [detailSnapshot, setDetailSnapshot] = useState<ArticleStorageSnapshot | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isArticlesLoading, setIsArticlesLoading] = useState(false);
  const [isN8nLogsLoading, setIsN8nLogsLoading] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [isNewArticleLanguageModalOpen, setIsNewArticleLanguageModalOpen] = useState(false);
  const [isFilterVisible, setIsFilterVisible] = useState(false);
  const [isTrashVisible, setIsTrashVisible] = useState(false);
  const [dashboardMode, setDashboardMode] = useState<'all' | 'n8n'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(() => new Set());
  const [bulkStatus, setBulkStatus] = useState<RemoteArticleSettingsPatch['status']>('draft');
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    createdFrom: '',
    createdTo: '',
    wordCountMin: '',
    wordCountMax: '',
    timeMin: '',
    timeMax: '',
    language: 'all',
    status: 'all',
    profileId: 'all',
    visibility: 'all',
    source: 'all',
    company: 'all',
    pageType: 'all',
    audienceScope: 'all',
  });

  const refreshLocalActivityData = () => {
    setActivityData(getActivityData());
  };

  const isAdmin = currentUserRole === 'admin';

  const refreshData = async () => {
    refreshLocalActivityData();
    if (!currentUser) return;
    setIsArticlesLoading(true);
    if (isAdmin) setIsN8nLogsLoading(true);
    try {
      await purgeExpiredRemoteArticleTrash(30).catch(error => {
        console.warn('Could not purge expired dashboard trash:', error);
      });
      const [articles, profileRows, logRows] = await Promise.all([
        listRemoteArticles(),
        isAdmin ? listRemoteProfiles() : Promise.resolve([]),
        isAdmin ? listRemoteN8nIngestLogs(40) : Promise.resolve([]),
      ]);
      setRemoteArticles(sortArticlesByLastChange(articles));
      setProfiles(profileRows);
      setN8nLogs(logRows);
    } catch (error) {
      console.error('Failed to load Supabase articles:', error);
    } finally {
      setIsArticlesLoading(false);
      setIsN8nLogsLoading(false);
    }
  };

  const getOwnerLabel = (article: RemoteArticleActivity): string => {
    const ownerId = getArticleOwnerId(article);
    const profile = ownerId ? profiles.find(item => item.id === ownerId) : undefined;
    return getProfileLabel(profile);
  };

  const handleShowArticleDetails = async (article: RemoteArticleActivity) => {
    setDetailArticle(article);
    setDetailSnapshot(null);
    setIsDetailLoading(true);
    try {
      setDetailSnapshot(await loadRemoteArticleSnapshot(article.id, currentUser || 'admin'));
    } catch (error) {
      console.error(`Failed to load article details "${article.id}":`, error);
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleCloseArticleDetails = () => {
    setDetailArticle(null);
    setDetailSnapshot(null);
    setIsDetailLoading(false);
  };
  
  const handleDeleteArticle = async (articleId: string) => {
    try {
      const trashedArticle = await moveRemoteArticleToTrash(articleId);
      setRemoteArticles(prev => sortArticlesByLastChange(prev.map(article => (
        article.id === articleId ? trashedArticle : article
      ))));
      setDetailArticle(prev => (prev?.id === articleId ? trashedArticle : prev));
    } catch (error) {
      console.error(`Failed to move article "${articleId}" to trash:`, error);
      alert('تعذر نقل المقالة إلى سلة المهملات. حاول مرة أخرى.');
    }
  };

  const handleRestoreArticle = async (articleId: string) => {
    try {
      const restoredArticle = await restoreRemoteArticleFromTrash(articleId);
      setRemoteArticles(prev => sortArticlesByLastChange(prev.map(article => (
        article.id === articleId ? restoredArticle : article
      ))));
      setDetailArticle(prev => (prev?.id === articleId ? restoredArticle : prev));
    } catch (error) {
      console.error(`Failed to restore article "${articleId}" from trash:`, error);
      alert('تعذر استعادة المقالة. حاول مرة أخرى.');
    }
  };

  const handlePermanentDeleteArticle = async (articleId: string) => {
    try {
      await deleteRemoteArticle(articleId);
      setRemoteArticles(prev => prev.filter(article => article.id !== articleId));
      if (detailArticle?.id === articleId) {
        setDetailArticle(null);
        setDetailSnapshot(null);
      }
    } catch (error) {
      console.error(`Failed to permanently delete article "${articleId}":`, error);
      alert('تعذر حذف المقالة نهائيا. الحذف النهائي متاح عادة للأدمن أو مالك المقالة فقط.');
    }
  };

  const clearSelectedArticles = () => setSelectedArticleIds(new Set());

  const toggleSelectedArticle = (articleId: string) => {
    setSelectedArticleIds(prev => {
      const next = new Set(prev);
      if (next.has(articleId)) {
        next.delete(articleId);
      } else {
        next.add(articleId);
      }
      return next;
    });
  };

  const handleBulkMoveToTrash = async () => {
    const ids = [...selectedArticleIds];
    if (ids.length === 0) return;
    if (!window.confirm(`سيتم نقل ${ids.length} مقالات إلى سلة المهملات. هل تريد المتابعة؟`)) return;
    await Promise.all(ids.map(id => moveRemoteArticleToTrash(id)));
    clearSelectedArticles();
    await refreshData();
  };

  const handleBulkRestore = async () => {
    const ids = [...selectedArticleIds];
    if (ids.length === 0) return;
    await Promise.all(ids.map(id => restoreRemoteArticleFromTrash(id)));
    clearSelectedArticles();
    await refreshData();
  };

  const handleBulkPermanentDelete = async () => {
    const ids = [...selectedArticleIds];
    if (ids.length === 0) return;
    if (!window.confirm(`سيتم حذف ${ids.length} مقالات نهائيا ولا يمكن استعادتها. هل أنت متأكد؟`)) return;
    await Promise.all(ids.map(id => deleteRemoteArticle(id)));
    clearSelectedArticles();
    await refreshData();
  };

  const handleBulkStatusChange = async () => {
    const ids = [...selectedArticleIds];
    if (ids.length === 0 || !bulkStatus) return;
    await Promise.all(ids.map(id => updateRemoteArticleSettings(id, { status: bulkStatus })));
    if (bulkStatus === 'in_review') {
      ids.forEach(articleId => {
        window.dispatchEvent(new CustomEvent('bazarvan:article-ai-clear-request', {
          detail: { articleId },
        }));
      });
    }
    clearSelectedArticles();
    await refreshData();
  };
  
  const handleRenameArticle = async (articleId: string, newTitle: string): Promise<boolean> => {
      const normalizedTitle = newTitle.trim();
      if (!normalizedTitle) return false;
      try {
        await renameRemoteArticle(articleId, normalizedTitle);
        await refreshData();
        return true;
      } catch (error) {
        console.error(`Failed to rename article "${articleId}":`, error);
        return false;
      }
  };

  const handleUpdateArticleSettings = async (
    articleId: string,
    patch: RemoteArticleSettingsPatch,
  ): Promise<boolean> => {
    try {
      const updatedArticle = await updateRemoteArticleSettings(articleId, patch);
      setRemoteArticles(prev => sortArticlesByLastChange(prev.map(article => (
        article.id === articleId ? updatedArticle : article
      ))));
      setDetailArticle(prev => (prev?.id === articleId ? updatedArticle : prev));
      if (patch.status === 'in_review') {
        window.dispatchEvent(new CustomEvent('bazarvan:article-ai-clear-request', {
          detail: { articleId },
        }));
      }
      if (patch.visibleToEmailsCsv !== undefined && patch.visibleToEmailsCsv.trim()) {
        void triggerAssignedArticleAutomation(articleId)
          .then(() => {
            window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
            return refreshData();
          })
          .catch(error => {
            console.error(`Assigned article automation failed for "${articleId}":`, error);
          });
      }
      return true;
    } catch (error) {
      console.error(`Failed to update article settings "${articleId}":`, error);
      return false;
    }
  };

  const handleClaimArticle = async (articleId: string): Promise<boolean> => {
    try {
      const claimedArticle = await claimRemoteArticle(articleId);
      setRemoteArticles(prev => sortArticlesByLastChange(prev.map(article => (
        article.id === articleId ? claimedArticle : article
      ))));
      setDetailArticle(prev => (prev?.id === articleId ? claimedArticle : prev));
      window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
      window.dispatchEvent(new CustomEvent('bazarvan:article-claimed', {
        detail: { articleId: claimedArticle.id, status: claimedArticle.status },
      }));
      void triggerAssignedArticleAutomation(claimedArticle.id)
        .then(() => {
          window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
          return refreshData();
        })
        .catch(error => {
          console.error(`Assigned article automation failed for claimed article "${claimedArticle.id}":`, error);
        });
      return true;
    } catch (error) {
      console.error(`Failed to claim article "${articleId}":`, error);
      await refreshData();
      return false;
    }
  };

  useEffect(() => {
    void refreshData();
    const intervalId = setInterval(() => {
      void refreshData();
    }, 10 * 60 * 1000);
    const handleActivityUpdated = () => {
      void refreshData();
    };
    window.addEventListener('smart-editor-activity-updated', handleActivityUpdated);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('smart-editor-activity-updated', handleActivityUpdated);
    };
  }, [currentUser, isAdmin]);

  useEffect(() => {
    if (!currentUser || !isSupabaseConfigured) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('dashboard-articles-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'articles' }, () => {
        void refreshData();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [currentUser, isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setSelectedProfileId(null);
      setProfiles([]);
      setDashboardMode('all');
      setN8nLogs([]);
    }
  }, [isAdmin]);

  useEffect(() => {
    clearSelectedArticles();
  }, [isTrashVisible, dashboardMode, selectedProfileId, searchQuery]);

  const handleExportHtml = () => {
    if (!currentUser) return;
    const exportArticles = selectedProfileId
      ? activeRemoteArticles.filter(article => articleBelongsToProfile(article, selectedProfileId))
      : activeRemoteArticles;

    const formatSecondsDetailed = (seconds: number): string => {
      if (!seconds || seconds < 60) return `${Math.floor(seconds || 0)} ${t.seconds}`;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return [
        h > 0 ? `${h} ${t.hours}` : '',
        m > 0 ? `${m} ${t.minutes}` : '',
        s > 0 ? `${s} ${t.seconds}` : '',
      ].filter(Boolean).join(' ').trim() || `0 ${t.seconds}`;
    };

    const totalArticles = exportArticles.length;
    const totalTimeSpent = exportArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);

    const articlesHtml = `
      <table class="articles-table">
          <thead>
              <tr>
                  <th>${t.articleTitle}</th>
                  <th>${t.timeSpent}</th>
                  <th>${t.words}</th>
                  <th>${t.keywordViolations}</th>
                  <th>${t.structureViolations}</th>
                  <th>${t.structureErrors}</th>
                  <th>${t.totalDuplicates}</th>
                  <th>${t.keywordDuplicates}</th>
                  <th>${t.commonDuplicates}</th>
              </tr>
          </thead>
          <tbody>
              ${[...exportArticles]
              .sort((a, b) => getArticleSortTime(b) - getArticleSortTime(a))
              .map((activity) => `
                  <tr>
                      <td>${activity.title || t.untitled}</td>
                      <td>${formatSeconds(activity.timeSpentSeconds, t)}</td>
                      <td>${activity.stats?.wordCount ?? 'N/A'}</td>
                      <td>${activity.stats?.keywordViolations ?? 'N/A'}</td>
                      <td>${activity.stats?.violatingCriteriaCount ?? 'N/A'}</td>
                      <td>${activity.stats?.totalErrorsCount ?? 'N/A'}</td>
                      <td>${activity.stats?.totalDuplicates ?? 'N/A'}</td>
                      <td>${activity.stats?.keywordDuplicatesCount ?? 'N/A'}</td>
                      <td>${activity.stats?.commonDuplicatesCount ?? 'N/A'}</td>
                  </tr>
              `).join('')}
          </tbody>
      </table>
    `;

    const htmlContent = `
        <!DOCTYPE html>
        <html lang="${uiLanguage}" dir="${uiLanguage === 'ar' ? 'rtl' : 'ltr'}">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${t.userActivityReport}: ${currentUser}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; margin: 0; padding: 20px; }
                .container { max-width: 1200px; margin: auto; background: #fff; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1, h2 { color: #b8922e; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
                h1 { font-size: 2em; }
                h2 { font-size: 1.5em; margin-top: 30px; }
                p { color: #666; }
                .summary-table, .articles-table { width: 100%; border-collapse: collapse; margin-top: 15px; text-align: ${uiLanguage === 'ar' ? 'right' : 'left'}; }
                .summary-table th, .summary-table td, .articles-table th, .articles-table td { padding: 12px; border: 1px solid #ddd; }
                .summary-table th { background-color: #f2f2f2; font-weight: bold; color: #b8922e; }
                .summary-table th { width: 30%; }
                .summary-table tr:nth-child(even), .articles-table tr:nth-child(even) { background-color: #f9f9f9; }
                .articles-table { font-size: 0.9em; table-layout: fixed; }
                .articles-table td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .articles-table tr:hover { background-color: #f1f1f1; }
                .articles-table td:first-child { width: 30%; white-space: normal; word-break: break-word; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>${t.userActivityReport}: ${currentUser}</h1>
                <p>${t.reportDate}: ${formatIstanbulDateTime(new Date(), t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                <h2>${t.activitySummary}</h2>
                <table class="summary-table">
                    <tr><th>${t.totalArticles}</th><td>${totalArticles}</td></tr>
                    <tr><th>${t.totalTimeSpent}</th><td>${formatSecondsDetailed(totalTimeSpent)}</td></tr>
                </table>
                <h2>${t.articlesDetails}</h2>
                ${articlesHtml}
            </div>
        </body>
        </html>
    `;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${currentUser}-${getIstanbulDateKey()}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleConfirmClearData = async () => {
    if (!currentUserId) return;
    const ownedArticles = remoteArticles.filter(article => article.ownerId === currentUserId || article.createdBy === currentUserId);
    await Promise.all(ownedArticles.map(article => moveRemoteArticleToTrash(article.id)));
    await refreshData();
    setIsConfirmModalOpen(false);
  };

  const handleChooseNewArticleLanguage = (lang: 'ar' | 'en') => {
    setIsNewArticleLanguageModalOpen(false);
    onNewArticle(lang);
  };

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const handleResetFilters = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      createdFrom: '',
      createdTo: '',
      wordCountMin: '',
      wordCountMax: '',
      timeMin: '',
      timeMax: '',
      language: 'all',
      status: 'all',
      profileId: 'all',
      visibility: 'all',
      source: 'all',
      company: 'all',
      pageType: 'all',
      audienceScope: 'all',
    });
  };

  const currentUserData = currentUser ? activityData[currentUser] : undefined;
  const geminiUsageRows = useMemo(() => {
    const usage = currentUserData?.geminiKeyUsage || {};
    const geminiKeys = [
      ...(currentUserData?.apiKeys?.gemini || []).filter(key => key.trim()).map(key => ({ key, provider: 'gemini' as const })),
      ...(currentUserData?.apiKeys?.geminiPaid || []).filter(key => key.trim()).map(key => ({ key, provider: 'geminiPaid' as const })),
    ];
    const currentRows = geminiKeys.map((item, index) => {
      const fingerprint = createApiKeyFingerprint(item.key);
      const record = usage[fingerprint];
      return {
        id: fingerprint,
        label: `${item.provider === 'geminiPaid' ? 'Gemini Pro' : 'Gemini'} #${index + 1}`,
        keyPreview: maskApiKey(item.key),
        provider: record?.provider || item.provider,
        model: record?.model || '',
        count: record?.count || 0,
        lastUsed: record?.lastUsed || '',
        isSavedKey: true,
      };
    });
    const currentFingerprints = new Set(currentRows.map(row => row.id));
    const archivedRows = Object.entries(usage)
      .filter(([fingerprint, record]) => !currentFingerprints.has(fingerprint) && (record?.count || 0) > 0)
      .map(([fingerprint, record], index) => ({
        id: fingerprint,
        label: `${t.unsavedGeminiKey} #${index + 1}`,
        keyPreview: fingerprint,
        provider: record.provider || 'gemini',
        model: record.model || '',
        count: record.count,
        lastUsed: record.lastUsed,
        isSavedKey: false,
      }));

    return [...currentRows, ...archivedRows];
  }, [currentUserData, t.unsavedGeminiKey]);
  const totalGeminiUses = geminiUsageRows.reduce((sum, row) => sum + row.count, 0);
  const selectedProfile = selectedProfileId ? profiles.find(profile => profile.id === selectedProfileId) : undefined;
  const activeRemoteArticles = useMemo(() => (
    remoteArticles.filter(article => {
      if (getArticleTrashInfo(article, currentUserId)) return false;
      return canProfileSeeArticle(article, currentUserId, isAdmin);
    })
  ), [remoteArticles, currentUserId, isAdmin]);
  const trashedRemoteArticles = useMemo(() => (
    remoteArticles.filter(article => {
      if (!getArticleTrashInfo(article, currentUserId)) return false;
      return canProfileSeeTrashedArticle(article, currentUserId, isAdmin);
    })
  ), [remoteArticles, currentUserId, isAdmin]);
  const displayedRemoteArticles = useMemo(() => {
    const baseArticles = isTrashVisible ? trashedRemoteArticles : activeRemoteArticles;
    return dashboardMode === 'n8n'
      ? baseArticles.filter(article => article.source === 'n8n')
      : baseArticles;
  }, [activeRemoteArticles, trashedRemoteArticles, isTrashVisible, dashboardMode]);
  const scopedArticles = useMemo(() => (
    selectedProfileId
      ? displayedRemoteArticles.filter(article => articleBelongsToProfile(article, selectedProfileId))
      : displayedRemoteArticles
  ), [displayedRemoteArticles, selectedProfileId]);
  const scopedLastSaved = getLatestSavedAt(scopedArticles);
  const scopedTotalTime = scopedArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);
  const filterOptions = useMemo(() => ({
    companies: getUniqueArticleValues(displayedRemoteArticles, article => article.keywords?.company),
    pageTypes: getUniqueArticleValues(displayedRemoteArticles, article => article.goalContext?.pageType),
    audienceScopes: getUniqueArticleValues(displayedRemoteArticles, article => article.goalContext?.audienceScope),
    sources: getUniqueArticleValues(displayedRemoteArticles, article => article.source),
    visibilities: getUniqueArticleValues(displayedRemoteArticles, article => article.visibility),
  }), [displayedRemoteArticles]);

  // Article filters stay derived from Supabase data so refreshData remains the only reload path.
  const filteredArticles = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    return scopedArticles.filter((activity) => {
      const ownerId = getArticleOwnerId(activity) || '';
      if (normalizedSearch) {
        const ownerLabel = getOwnerLabel(activity).toLowerCase();
        const searchText = getArticleSearchText(activity, ownerLabel, ownerId);
        if (!searchText.includes(normalizedSearch)) return false;
      }
      if (filters.dateFrom) {
          if (!activity.lastSaved || new Date(activity.lastSaved) < getIstanbulDayStart(filters.dateFrom)) {
              return false;
          }
      }
      if (filters.dateTo) {
          if (!activity.lastSaved) return false;
          const articleDate = new Date(activity.lastSaved);
          const filterDate = getIstanbulDayEnd(filters.dateTo);
          if (articleDate > filterDate) {
              return false;
          }
      }
      if (filters.createdFrom) {
          if (!activity.createdAt || getArticleCreatedTime(activity) < getIstanbulDayStart(filters.createdFrom).getTime()) {
              return false;
          }
      }
      if (filters.createdTo) {
          if (!activity.createdAt) return false;
          const createdDate = new Date(activity.createdAt);
          const filterDate = getIstanbulDayEnd(filters.createdTo);
          if (createdDate > filterDate) {
              return false;
          }
      }
      const wordCount = activity.stats?.wordCount ?? 0;
      const wordMin = parseInt(filters.wordCountMin, 10);
      const wordMax = parseInt(filters.wordCountMax, 10);
      if (!isNaN(wordMin) && wordCount < wordMin) return false;
      if (!isNaN(wordMax) && wordCount > wordMax) return false;
      
      const timeInMinutes = Math.floor(activity.timeSpentSeconds / 60);
      const timeMin = parseInt(filters.timeMin, 10);
      const timeMax = parseInt(filters.timeMax, 10);
      if (!isNaN(timeMin) && timeInMinutes < timeMin) return false;
      if (!isNaN(timeMax) && timeInMinutes > timeMax) return false;
      
      if (filters.language !== 'all' && (activity.articleLanguage || 'ar') !== filters.language) {
          return false;
      }
      if (filters.status !== 'all' && activity.status !== filters.status) {
          return false;
      }
      if (filters.profileId !== 'all' && !articleBelongsToProfile(activity, filters.profileId)) {
          return false;
      }
      if (filters.visibility !== 'all' && activity.visibility !== filters.visibility) {
          return false;
      }
      if (filters.source !== 'all' && activity.source !== filters.source) {
          return false;
      }
      if (filters.company !== 'all' && activity.keywords?.company !== filters.company) {
          return false;
      }
      if (filters.pageType !== 'all' && activity.goalContext?.pageType !== filters.pageType) {
          return false;
      }
      if (filters.audienceScope !== 'all' && activity.goalContext?.audienceScope !== filters.audienceScope) {
          return false;
      }

      return true;
    });
  }, [scopedArticles, filters, searchQuery, profiles]);

  const selectedFilteredArticles = useMemo(() => (
    filteredArticles.filter(article => selectedArticleIds.has(article.id))
  ), [filteredArticles, selectedArticleIds]);
  const areAllFilteredSelected = filteredArticles.length > 0 && filteredArticles.every(article => selectedArticleIds.has(article.id));
  const toggleSelectAllFilteredArticles = () => {
    setSelectedArticleIds(prev => {
      const next = new Set(prev);
      if (areAllFilteredSelected) {
        filteredArticles.forEach(article => next.delete(article.id));
      } else {
        filteredArticles.forEach(article => next.add(article.id));
      }
      return next;
    });
  };

  const getDeletedByLabel = (trashInfo?: RemoteArticleTrashInfo | null): string => {
    if (!trashInfo?.deletedBy) return '';
    if (trashInfo.deletedBy === currentUserId) return currentUser || 'أنت';
    const profile = profiles.find(item => item.id === trashInfo.deletedBy);
    return profile ? getProfileLabel(profile) : trashInfo.deletedBy;
  };
  
  const styleButtonClass = (isActive: boolean) =>
    `flex-1 flex items-center justify-center gap-2 p-2 rounded-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-100 dark:focus:ring-offset-[#1F1F1F] focus:ring-[#d4af37] ${
      isActive
        ? 'bg-[#d4af37] text-white shadow-sm'
        : 'bg-white hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 text-[#333333] dark:text-[#8d8d8d]'
    }`;

  const inputClass = "w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0]";

  if (!currentUser) {
    return null;
  }

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 dark:bg-[#181818]`}>
      <div className="max-w-screen-xl mx-auto p-4 sm:p-6 md:p-8">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[#333333] dark:text-gray-100">{t.dashboardTitle}</h1>
            <p className="mt-1 text-gray-500 dark:text-gray-400">{t.welcomeBack}, <span className="font-bold text-[#d4af37]">{currentUser}</span>!</p>
          </div>
           <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => navigateToAppPath('/admin')}
                className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
              >
                <Shield size={18} />
                <span>الأدمن</span>
              </button>
            )}
            <button
              onClick={() => navigateToAppPath('/settings')}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
            >
              <Settings size={18} />
              <span>{t.settings}</span>
            </button>
            <button
              onClick={() => setIsNewArticleLanguageModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
            >
              <PlusSquare size={18} />
              <span>{t.newArticle}</span>
            </button>
            <button
              onClick={onGoToEditor}
              className="flex items-center gap-2 px-4 py-2 font-bold text-white bg-[#d4af37] rounded-lg hover:bg-[#b8922e] transition-colors"
            >
              <Edit size={18} />
              <span>{t.goToEditor}</span>
            </button>
            <button
              onClick={handleExportHtml}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
            >
              <FileDown size={18} />
              <span>{t.exportHtml}</span>
            </button>
            <button
              onClick={() => setIsConfirmModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-red-600 dark:text-red-400 bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title={t.clearUserData}
            >
              <Trash2 size={18} />
              <span>{t.clearData}</span>
            </button>
            <button
              onClick={onLogout}
              className="p-2.5 border rounded-lg transition-colors text-gray-500 dark:text-[#8d8d8d] border-gray-300 dark:border-[#3C3C3C] bg-white hover:bg-[#d4af37]/10 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20"
              title={t.logout}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {isAdmin && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setDashboardMode('all')}
                className={`rounded-md px-3 py-1.5 text-xs font-bold ${dashboardMode === 'all' ? 'bg-[#d4af37] text-white' : 'bg-white text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:text-gray-300'}`}
              >
                كل المقالات
              </button>
              <button
                onClick={() => setDashboardMode('n8n')}
                className={`rounded-md px-3 py-1.5 text-xs font-bold ${dashboardMode === 'n8n' ? 'bg-[#d4af37] text-white' : 'bg-white text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:text-gray-300'}`}
              >
                مقالات n8n
              </button>
            </div>
            <AdminUsersTable
              profiles={profiles}
              articles={dashboardMode === 'n8n' ? activeRemoteArticles.filter(article => article.source === 'n8n') : activeRemoteArticles}
              selectedProfileId={selectedProfileId}
              onSelectProfile={setSelectedProfileId}
              t={t}
            />
            {dashboardMode === 'n8n' && (
              <N8nLogsPanel logs={n8nLogs} isLoading={isN8nLogsLoading} t={t} />
            )}
          </>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
                <div className="flex justify-between items-center mb-4">
                    <div>
                        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">
                            {isTrashVisible
                              ? `سلة المهملات ${selectedProfile ? `- ${getProfileLabel(selectedProfile)}` : ''}`
                              : dashboardMode === 'n8n'
                                ? `مقالات n8n ${selectedProfile ? `- ${getProfileLabel(selectedProfile)}` : ''}`
                              : isAdmin
                                ? `مقالات ${selectedProfile ? getProfileLabel(selectedProfile) : 'كل المستخدمين'}`
                                : t.yourRecentArticles}
                        </h2>
                        {isAdmin && (
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                {scopedArticles.length} مقال، آخر حفظ: {scopedLastSaved ? formatIstanbulDateTime(scopedLastSaved, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}، الوقت: {formatSeconds(scopedTotalTime, t)}
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setIsTrashVisible(prev => !prev)}
                            className={`flex items-center gap-2 text-sm ${isTrashVisible ? 'font-bold text-[#8a6f1d] dark:text-[#f2d675]' : 'text-gray-500 hover:text-[#d4af37] dark:text-gray-400 dark:hover:text-[#f2d675]'}`}
                            title={isTrashVisible ? 'عرض المقالات النشطة' : 'عرض سلة المهملات'}
                        >
                            <Trash2 size={14} />
                            <span>{isTrashVisible ? 'المقالات' : `السلة (${trashedRemoteArticles.length})`}</span>
                        </button>
                        <button
                            onClick={() => setIsFilterVisible(!isFilterVisible)}
                            className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#d4af37] dark:hover:text-[#f2d675]"
                            title={isFilterVisible ? t.hideFilters : t.showFilters}
                        >
                            <Filter size={14} />
                            <span>{t.filter}</span>
                        </button>
                        <button
                            onClick={refreshData}
                            className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#d4af37] dark:hover:text-[#f2d675]"
                            title={t.refreshData}
                        >
                            <RefreshCw size={14} />
                            <span>{t.refresh}</span>
                        </button>
                    </div>
                </div>

                <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={event => setSearchQuery(event.target.value)}
                            placeholder="بحث في العنوان، المستخدم، الكلمات، الشركة، LSI، ومحتوى المقالة"
                            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-[#333333] focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                        />
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <button
                                type="button"
                                onClick={toggleSelectAllFilteredArticles}
                                disabled={filteredArticles.length === 0}
                                className="rounded-md bg-gray-100 px-3 py-1.5 font-bold text-gray-600 hover:bg-[#d4af37]/15 disabled:opacity-50 dark:bg-[#1F1F1F] dark:text-gray-300"
                            >
                                {areAllFilteredSelected ? 'إلغاء تحديد الكل' : 'تحديد النتائج'}
                            </button>
                            <span className="font-bold text-gray-500 dark:text-gray-400">
                                المحدد: {selectedFilteredArticles.length}
                            </span>
                        </div>
                    </div>
                    {selectedFilteredArticles.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-[#3C3C3C]">
                            {!isTrashVisible ? (
                                <button
                                    type="button"
                                    onClick={handleBulkMoveToTrash}
                                    className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300"
                                >
                                    نقل المحدد للسلة
                                </button>
                            ) : (
                                <>
                                  <button
                                      type="button"
                                      onClick={handleBulkRestore}
                                      className="rounded-md bg-[#d4af37]/10 px-3 py-1.5 text-xs font-bold text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]"
                                  >
                                      استعادة المحدد
                                  </button>
                                  <button
                                      type="button"
                                      onClick={handleBulkPermanentDelete}
                                      className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300"
                                  >
                                      حذف نهائي للمحدد
                                  </button>
                                </>
                            )}
                            <div className="flex items-center gap-2">
                                <select
                                    value={bulkStatus}
                                    onChange={event => setBulkStatus(event.target.value as RemoteArticleSettingsPatch['status'])}
                                    className="rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200"
                                >
                                    {N8N_SETTING_OPTIONS.status.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    onClick={handleBulkStatusChange}
                                    className="rounded-md bg-[#d4af37] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#b8922e]"
                                >
                                    تغيير حالة المحدد
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {isFilterVisible && (
                    <div className="p-4 mb-6 bg-white/50 dark:bg-[#2A2A2A]/50 rounded-xl border border-gray-200 dark:border-[#3C3C3C] backdrop-blur-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-gray-700 dark:text-gray-200">{t.filterOptions}</h3>
                            <button onClick={handleResetFilters} className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-100/50 dark:bg-[#3C3C3C]/50 rounded-md hover:bg-[#d4af37]/20 dark:hover:bg-[#d4af37]/25 transition-colors">
                                <X size={14} />
                                <span>{t.reset}</span>
                            </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Calendar size={16} className="text-[#d4af37]" />
                                    <span>{t.saveDate}</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="date" name="dateFrom" value={filters.dateFrom} onChange={handleFilterChange} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="date" name="dateTo" value={filters.dateTo} onChange={handleFilterChange} className={inputClass} />
                                </div>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Calendar size={16} className="text-[#d4af37]" />
                                    <span>تاريخ الإنشاء</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="date" name="createdFrom" value={filters.createdFrom} onChange={handleFilterChange} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="date" name="createdTo" value={filters.createdTo} onChange={handleFilterChange} className={inputClass} />
                                </div>
                            </div>
                             <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <FileText size={16} className="text-[#d4af37]" />
                                    <span>{t.wordCount}</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="number" name="wordCountMin" value={filters.wordCountMin} onChange={handleFilterChange} placeholder={t.from} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="number" name="wordCountMax" value={filters.wordCountMax} onChange={handleFilterChange} placeholder={t.to} className={inputClass} />
                                </div>
                            </div>
                             <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Clock size={16} className="text-[#d4af37]" />
                                    <span>{t.timeSpent} ({t.minutes})</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="number" name="timeMin" value={filters.timeMin} onChange={handleFilterChange} placeholder={t.from} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="number" name="timeMax" value={filters.timeMax} onChange={handleFilterChange} placeholder={t.to} className={inputClass} />
                                </div>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Languages size={16} className="text-[#d4af37]" />
                                    <span>{t.language}</span>
                                </label>
                                <select name="language" value={filters.language} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    <option value="ar">{t.arabic}</option>
                                    <option value="en">{t.english}</option>
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Settings size={16} className="text-[#d4af37]" />
                                    <span>الحالة</span>
                                </label>
                                <select name="status" value={filters.status} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {N8N_SETTING_OPTIONS.status.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </div>
                            {isAdmin && (
                                <div>
                                    <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                        <Users size={16} className="text-[#d4af37]" />
                                        <span>المستخدم</span>
                                    </label>
                                    <select name="profileId" value={filters.profileId} onChange={handleFilterChange} className={inputClass}>
                                        <option value="all">{t.all}</option>
                                        {profiles.map(profile => (
                                            <option key={profile.id} value={profile.id}>{getProfileLabel(profile)}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Eye size={16} className="text-[#d4af37]" />
                                    <span>الظهور</span>
                                </label>
                                <select name="visibility" value={filters.visibility} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {filterOptions.visibilities.map(value => (
                                        <option key={value} value={value}>{value}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <ExternalLink size={16} className="text-[#d4af37]" />
                                    <span>المصدر</span>
                                </label>
                                <select name="source" value={filters.source} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {filterOptions.sources.map(value => (
                                        <option key={value} value={value}>{value}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Key size={16} className="text-[#d4af37]" />
                                    <span>الشركة</span>
                                </label>
                                <select name="company" value={filters.company} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {filterOptions.companies.map(value => (
                                        <option key={value} value={value}>{value}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <NotebookTabs size={16} className="text-[#d4af37]" />
                                    <span>نوع الصفحة</span>
                                </label>
                                <select name="pageType" value={filters.pageType} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {filterOptions.pageTypes.map(value => (
                                        <option key={value} value={value}>{value}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <AppWindow size={16} className="text-[#d4af37]" />
                                    <span>النطاق الجغرافي</span>
                                </label>
                                <select name="audienceScope" value={filters.audienceScope} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    {filterOptions.audienceScopes.map(value => (
                                        <option key={value} value={value}>{value}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                )}

                {filteredArticles.length > 0 ? (
                    <ul className="space-y-2">
                          {filteredArticles
                            .sort((a, b) => getArticleSortTime(b) - getArticleSortTime(a))
                            .map((activity) => {
                              const trashInfo = getArticleTrashInfo(activity, currentUserId);
                              return (
                                <ArticleListItem
                                    key={activity.id}
                                    title={activity.title}
                                    activity={activity}
                                    ownerLabel={isAdmin ? getOwnerLabel(activity) : undefined}
                                    trashInfo={trashInfo}
                                    deletedByLabel={getDeletedByLabel(trashInfo)}
                                    isSelectable
                                    isSelected={selectedArticleIds.has(activity.id)}
                                    onToggleSelected={() => toggleSelectedArticle(activity.id)}
                                    onLoad={() => onLoadArticle(activity.title, activity)}
                                    onDetails={() => { void handleShowArticleDetails(activity); }}
                                    onDelete={() => { void handleDeleteArticle(activity.id); }}
                                    onPermanentDelete={() => { void handlePermanentDeleteArticle(activity.id); }}
                                    onRestore={() => { void handleRestoreArticle(activity.id); }}
                                    onRename={(newTitle) => handleRenameArticle(activity.id, newTitle)}
                                    onUpdateSettings={handleUpdateArticleSettings}
                                    onClaim={handleClaimArticle}
                                    visibleSettingFields={isAdmin
                                      ? ['status', 'visibility', 'accessRole', 'visibleToEmailsCsv', 'articleLanguage']
                                      : ['status', 'accessRole', 'visibleToEmailsCsv']}
                                    editableSettingFields={isAdmin
                                      ? ['status', 'visibility', 'accessRole', 'visibleToEmailsCsv', 'articleLanguage']
                                      : ['status']}
                                    isTrashView={isTrashVisible}
                                    showAdminMetadata={isAdmin}
                                    t={t}
                                />
                              );
                            })}
                    </ul>
                ) : (
                    <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-gray-300 dark:border-[#3C3C3C] rounded-lg text-center">
                        <Book size={40} className="text-gray-400 dark:text-gray-500 mb-2"/>
                        <h3 className="text-lg font-semibold text-gray-600 dark:text-gray-300">
                            {scopedArticles.length > 0
                              ? t.noArticlesMatchFilter
                              : (isArticlesLoading ? 'جار تحميل المقالات...' : (isTrashVisible ? 'سلة المهملات فارغة' : t.noArticlesYet))}
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {scopedArticles.length > 0 ? t.tryAdjustingFilters : (isTrashVisible ? 'المقالات التي تنقلها للسلة ستظهر هنا.' : t.clickNewArticleToStart)}
                        </p>
                    </div>
                )}
            </div>

            <div className="space-y-8">
                <div>
                     <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4">{t.activitySummary}</h2>
                     <div className="space-y-3">
                        <SummaryStat icon={<Book size={20} />} label={t.totalArticles} value={scopedArticles.length} />
                        <SummaryStat icon={<Clock size={20} />} label={t.totalTime} value={formatSeconds(scopedTotalTime, t)} />
                    </div>
                </div>

                <div>
                    <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4 flex items-center gap-2">
                        <Key size={20} />
                        <span>{t.geminiKeyUsage}</span>
                    </h2>
                    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                        <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                            <span className="font-bold text-gray-600 dark:text-gray-300">{t.geminiTotalUses}</span>
                            <span className="rounded-full bg-[#d4af37]/10 px-2.5 py-1 text-xs font-black text-[#8a6f1d] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
                                {totalGeminiUses}
                            </span>
                        </div>
                        {geminiUsageRows.length > 0 ? (
                            <div className="space-y-2">
                                {geminiUsageRows.map(row => (
                                    <div key={row.id} className="rounded-md border border-gray-100 bg-gray-50 p-2.5 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-xs font-black text-gray-700 dark:text-gray-200">{row.label}</div>
                                                 <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400" title={row.keyPreview}>
                                                     {row.keyPreview}
                                                 </div>
                                                 <div className="mt-1 flex flex-wrap gap-1">
                                                     <span className="rounded-full bg-[#d4af37]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#8a6f1d] dark:text-[#f2d675]">
                                                         {row.provider === 'geminiPaid' ? 'Gemini Pro' : 'Gemini'}
                                                     </span>
                                                     {row.model && (
                                                         <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-300">
                                                             {row.model}
                                                         </span>
                                                     )}
                                                 </div>
                                             </div>
                                            <div className="text-end">
                                                <div className="text-lg font-black text-[#d4af37]">{row.count}</div>
                                                <div className="text-[10px] font-bold text-gray-400">{t.geminiUsageCount}</div>
                                            </div>
                                        </div>
                                        {row.lastUsed && (
                                            <div className="mt-2 border-t border-gray-100 pt-1.5 text-[10px] font-semibold text-gray-400 dark:border-[#333]">
                                                {t.geminiLastUsed}: {formatIstanbulDateTime(row.lastUsed, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t.noGeminiUsageYet}</p>
                        )}
                    </div>
                </div>

                <div>
                    <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4 flex items-center gap-2"><Settings size={20} /><span>{t.settings}</span></h2>
                    <div className="p-4 bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C] space-y-4">
                        <ClientGoalSettings />
                        <EngineeringPromptsSettings />
                        <div className="rounded-lg border border-[#d4af37]/20 bg-[#d4af37]/10 p-3 text-sm font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]">
                          <div className="flex items-center gap-2">
                            <Key size={18} />
                            <span>مفاتيح الذكاء الاصطناعي محفوظة على السيرفر فقط.</span>
                          </div>
                        </div>
                         <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.highlightStyle}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onHighlightStyleChange('background')} className={styleButtonClass(preferredHighlightStyle === 'background')} title={t.background}><PaintRoller size={16} /></button>
                                <button onClick={() => onHighlightStyleChange('underline')} className={styleButtonClass(preferredHighlightStyle === 'underline')} title={t.wavyUnderline}><Baseline size={16} /></button>
                            </div>
                            <div className="mt-3">
                                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-gray-500 dark:text-gray-400">
                                    <ExternalLink size={14} className="text-[#d4af37]" />
                                    <span>{t.chatGptOpenPreference}</span>
                                </div>
                                <div className="grid grid-cols-1 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-[#1F1F1F] sm:grid-cols-2">
                                    <button onClick={() => onChatGptOpenModeChange('window')} className={styleButtonClass(chatGptOpenMode === 'window')} title={t.chatGptOpenSeparateWindow}>
                                        <AppWindow size={16} />
                                        <span>{t.chatGptOpenSeparateWindow}</span>
                                    </button>
                                    <button onClick={() => onChatGptOpenModeChange('tab')} className={styleButtonClass(chatGptOpenMode === 'tab')} title={t.chatGptOpenNewTab}>
                                        <NotebookTabs size={16} />
                                        <span>{t.chatGptOpenNewTab}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.keywordView}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onKeywordViewModeChange('classic')} className={styleButtonClass(preferredKeywordViewMode === 'classic')} title={t.detailedCards}><LayoutGrid size={16} /></button>
                                <button onClick={() => onKeywordViewModeChange('modern')} className={styleButtonClass(preferredKeywordViewMode === 'modern')} title={t.modernList}><ListTree size={16} /></button>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.structureView}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onStructureViewModeChange('grid')} className={styleButtonClass(preferredStructureViewMode === 'grid')} title={t.grid}><LayoutGrid size={16} /></button>
                                <button onClick={() => onStructureViewModeChange('list')} className={styleButtonClass(preferredStructureViewMode === 'list')} title={t.list}><List size={16} /></button>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.defaultArticleLanguage}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onPreferredLanguageChange('ar')} className={styleButtonClass(preferredLanguage === 'ar')} title={t.arabic}>
                                    <Languages size={16} /> <span>{t.arabic}</span>
                                </button>
                                <button onClick={() => onPreferredLanguageChange('en')} className={styleButtonClass(preferredLanguage === 'en')} title={t.english}>
                                    <Languages size={16} /> <span>{t.english}</span>
                                </button>
                            </div>
                        </div>
                         <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.interfaceLanguage}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onUiLanguageChange('ar')} className={styleButtonClass(uiLanguage === 'ar')} title={t.arabic}>
                                    <Languages size={16} /> <span>{t.arabic}</span>
                                </button>
                                <button onClick={() => onUiLanguageChange('en')} className={styleButtonClass(uiLanguage === 'en')} title={t.english}>
                                    <Languages size={16} /> <span>{t.english}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <footer className="mt-10 border-t border-gray-200 pt-4 text-center text-xs font-semibold text-gray-500 dark:border-[#3C3C3C] dark:text-gray-400">
          جميع الحقوق محفوظة - 2026-05-07 01:54:51
        </footer>
      </div>
      {isConfirmModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" aria-labelledby="modal-title" role="dialog" aria-modal="true">
            <div className={`bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl w-full max-md p-6 border dark:border-[#3C3C3C] text-start`}>
                <div className="flex sm:items-start gap-4">
                    <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20 sm:mx-0 sm:h-10 sm:w-10">
                        <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" aria-hidden="true" />
                    </div>
                    <div className="flex-grow">
                        <h3 className="text-lg font-bold leading-6 text-[#333333] dark:text-gray-100" id="modal-title">
                            {t.clearAllData}
                        </h3>
                        <div className="mt-2">
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t.clearDataConfirmation}
                            </p>
                        </div>
                    </div>
                </div>
                <div className={`mt-5 sm:mt-4 flex ${uiLanguage === 'ar' ? 'flex-row-reverse' : 'flex-row'} gap-3`}>
                    <button
                        type="button"
                        className="inline-flex w-full justify-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 sm:w-auto"
                        onClick={handleConfirmClearData}
                    >
                        {t.yesClear}
                    </button>
                    <button
                        type="button"
                        className="mt-3 inline-flex w-full justify-center rounded-md bg-white dark:bg-[#3C3C3C] px-3 py-2 text-sm font-semibold text-gray-900 dark:text-gray-200 shadow-sm ring-1 ring-inset ring-gray-300 dark:ring-[#4A4A4A] hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/25 sm:mt-0 sm:w-auto"
                        onClick={() => setIsConfirmModalOpen(false)}
                    >
                        {t.cancel}
                    </button>
                </div>
            </div>
        </div>
      )}
      {isNewArticleLanguageModalOpen && (
        <NewArticleLanguageModal
          t={t}
          uiLanguage={uiLanguage}
          onChoose={handleChooseNewArticleLanguage}
        />
      )}
      {detailArticle && (
        <ArticleDetailsModal
          article={detailArticle}
          snapshot={detailSnapshot}
          ownerLabel={getOwnerLabel(detailArticle)}
          isLoading={isDetailLoading}
          t={t}
          onClose={handleCloseArticleDetails}
          onOpenArticle={() => {
            const articleToOpen = detailArticle;
            handleCloseArticleDetails();
            void onLoadArticle(articleToOpen.title, articleToOpen);
          }}
        />
      )}
    </div>
  );
};

export default Dashboard;
