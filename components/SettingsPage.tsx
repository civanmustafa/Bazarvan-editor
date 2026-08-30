import AppSelect from './AppSelect';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Baseline,
  BookOpen,
  Copy,
  Database,
  Key,
  Languages,
  LayoutGrid,
  List,
  ListTree,
  NotebookTabs,
  PaintRoller,
  Radar,
  RefreshCw,
  Save,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  Users,
  Workflow,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import ExternalAnalysisDefaultCommandsSettings from './ExternalAnalysisDefaultCommandsSettings';
import ContentWritingPromptSettings from './ContentWritingPromptSettings';
import UserAiProviderSecretsSettings from './UserAiProviderSecretsSettings';
import AdminProviderAccessSettings from './AdminProviderAccessSettings';
import AdminCrawlerUsagePolicySettings from './AdminCrawlerUsagePolicySettings';
import UserProviderAccessSummary from './UserProviderAccessSummary';
import AdminArticleQuotaSettings from './AdminArticleQuotaSettings';
import UserArticleQuotaSummary from './UserArticleQuotaSummary';
import DashboardDataTools from './DashboardDataTools';
import AdminPromptRegistrySettings from './AdminPromptRegistrySettings';
import ClientCenterSettings from './ClientCenterSettings';
import UserAutomationSettings, { UserAutomationPreferenceFields } from './UserAutomationSettings';
import { normalizeUserAutomationPreferences } from '../constants/userAutomation';
import { navigateToAppPath } from '../utils/appRoutes';
import {
  loadSystemSettings,
  saveSystemSettings,
  type SecretStatus,
  type SystemSettingKey,
  type SystemSettingsMap,
  type SystemSettingsUser,
} from '../utils/systemSettings';
import {
  buildGeminiFreeModelOptions,
  normalizeGeminiFreeModel,
} from '../utils/geminiModelPreference';
import {
  getDefaultSystemSettings,
  normalizeSystemSettingsMap,
} from '../constants/settingsRegistry';
import {
  GEMINI_PAID_MODEL_OPTIONS,
  normalizeGeminiPaidModelId,
} from '../constants/modelRegistry';
import { ARTICLE_STATUS_OPTIONS } from '../constants/articleStatuses';
import { notifyAiProviderCapabilitiesChanged } from '../utils/aiProviderCapabilities';
import { notifyPromptRegistryChanged } from '../utils/promptRegistry';
import { notifyInternalLinkAutomationSettingsChanged } from '../utils/internalLinkAutomationSettings';

type SettingsPageProps = {
  section: string | null;
};

type SettingsSectionKey = SystemSettingKey
  | 'clients'
  | 'users'
  | 'crawler'
  | 'preferences'
  | 'automation'
  | 'account'
  | 'data';

type SettingsTab = {
  key: SettingsSectionKey;
  label: string;
  path: string;
  icon: React.ReactNode;
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

const SettingsSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
    <h2 className="mb-4 text-lg font-black text-gray-800 dark:text-gray-100">{title}</h2>
    {children}
  </section>
);

const FieldLabel: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <label className="block">
    <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">{label}</span>
    {description && (
      <span className="mb-2 block text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
        {description}
      </span>
    )}
    {children}
  </label>
);

const SettingsBreadcrumbs: React.FC<{ currentLabel: string }> = ({ currentLabel }) => (
  <nav className="mt-4 flex flex-wrap items-center gap-2 text-xs font-black text-gray-400" aria-label="Breadcrumb">
    <button
      type="button"
      onClick={() => navigateToAppPath('/dashboard')}
      className="text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
    >
      لوحة التحكم
    </button>
    <span>/</span>
    <button
      type="button"
      onClick={() => navigateToAppPath('/settings')}
      className="text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
    >
      الإعدادات
    </button>
    <span>/</span>
    <span className="text-gray-600 dark:text-gray-300">{currentLabel}</span>
  </nav>
);

const TextInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dir?: 'rtl' | 'ltr';
}> = ({ value, onChange, placeholder, dir }) => (
  <input
    type="text"
    value={value}
    onChange={event => onChange(event.target.value)}
    placeholder={placeholder}
    dir={dir}
    className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
  />
);

const NumberInput: React.FC<{
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}> = ({ value, min = 0, max, step = 1, onChange }) => (
  <input
    type="number"
    min={min}
    max={max}
    step={step}
    value={Number.isFinite(value) ? value : 0}
    onChange={event => onChange(Number(event.target.value))}
    className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
  />
);

const SelectInput: React.FC<{
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ value, options, onChange }) => (
  <AppSelect
    value={value}
    onChange={event => onChange(event.target.value)}
    className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
  >
    {options.map(option => (
      <option key={option.value} value={option.value}>{option.label}</option>
    ))}
  </AppSelect>
);

const ToggleField: React.FC<{
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ label, description, checked, onChange }) => (
  <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
    <span className="min-w-0">
      <span className="block text-sm font-bold text-gray-700 dark:text-gray-200">{label}</span>
      {description && (
        <span className="mt-1 block text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
          {description}
        </span>
      )}
    </span>
    <input
      type="checkbox"
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
    />
  </label>
);

const copyText = async (value: string) => {
  if (!value) return;
  await navigator.clipboard?.writeText(value);
};

const mergeSettings = (
  settings?: Partial<SystemSettingsMap>,
  allowedGeminiModels?: string[],
): SystemSettingsMap => (
  settings
    ? normalizeSystemSettingsMap(settings, { allowedGeminiModels })
    : getDefaultSystemSettings()
);

const SettingsPage: React.FC<SettingsPageProps> = ({ section }) => {
  const {
    currentUser,
    currentUserRole,
    isDarkMode,
    highlightStyle,
    handleHighlightStyleChange,
    chatGptOpenMode,
    handleChatGptOpenModeChange,
    keywordViewMode,
    handleKeywordViewModeChange,
    structureViewMode,
    handleStructureViewModeChange,
    preferredLanguage,
    handlePreferredLanguageChange,
    uiLanguage,
    handleUiLanguageChange,
    t,
  } = useUser();

  const isAdmin = currentUserRole === 'admin';
  const [settings, setSettings] = useState<SystemSettingsMap>(() => mergeSettings());
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(EMPTY_SECRET_STATUS);
  const [systemUsers, setSystemUsers] = useState<SystemSettingsUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  const tabs: SettingsTab[] = useMemo(() => (isAdmin ? [
    { key: 'system', label: 'النظام', path: '/settings/system', icon: <Shield size={16} /> },
    { key: 'automation', label: 'أتمتة مقالاتي', path: '/settings/automation', icon: <Workflow size={16} /> },
    { key: 'ai', label: 'الذكاء الاصطناعي', path: '/settings/ai', icon: <Key size={16} /> },
    { key: 'crawler', label: 'خدمات الزحف', path: '/settings/crawler', icon: <Radar size={16} /> },
    { key: 'prompts', label: 'الأوامر الهندسية', path: '/settings/prompts', icon: <TerminalSquare size={16} /> },
    { key: 'n8n', label: 'n8n', path: '/settings/n8n', icon: <Workflow size={16} /> },
    { key: 'clients', label: 'العملاء', path: '/settings/clients', icon: <Users size={16} /> },
    { key: 'users', label: 'المستخدمون', path: '/settings/users', icon: <Users size={16} /> },
    { key: 'roles', label: 'الصلاحيات', path: '/settings/roles', icon: <SlidersHorizontal size={16} /> },
  ] : [
    { key: 'preferences', label: 'التفضيلات', path: '/settings/preferences', icon: <SlidersHorizontal size={16} /> },
    { key: 'automation', label: 'أتمتة مقالاتي', path: '/settings/automation', icon: <Workflow size={16} /> },
    { key: 'account', label: 'مفاتيحي وحدودي', path: '/settings/account', icon: <Key size={16} /> },
    { key: 'clients', label: 'عملائي', path: '/settings/clients', icon: <Users size={16} /> },
    { key: 'data', label: 'بياناتي', path: '/settings/data', icon: <Database size={16} /> },
  ]), [isAdmin]);
  const requestedSection = (section || '') as SettingsSectionKey | '';
  const selectedSection = useMemo<SettingsSectionKey>(() => {
    if (isAdmin) {
      return tabs.some(item => item.key === requestedSection)
        ? requestedSection as SettingsSectionKey
        : 'system';
    }
    if (requestedSection === 'ai') return 'account';
    if (requestedSection === 'system') return 'preferences';
    return tabs.some(item => item.key === requestedSection)
      ? requestedSection as SettingsSectionKey
      : 'preferences';
  }, [isAdmin, requestedSection, tabs]);
  const selectedTab = tabs.find(item => item.key === selectedSection) || tabs[0];
  const selectedTabLabel = selectedTab?.label || (isAdmin ? 'النظام' : 'التفضيلات');

  useEffect(() => {
    if (!selectedTab || section === selectedTab.key) return;
    navigateToAppPath(selectedTab.path, { replace: true });
  }, [section, selectedTab]);
  const geminiFreeModelOptions = useMemo(() => (
    buildGeminiFreeModelOptions(secretStatus.ai.gemini.allowedModels || [])
  ), [secretStatus.ai.gemini.allowedModels]);
  const geminiFreeModelValues = useMemo(() => (
    geminiFreeModelOptions.map(option => option.value)
  ), [geminiFreeModelOptions]);

  const buttonClass = (isActive: boolean) =>
    `flex min-h-10 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-[#d4af37] ${
      isActive
        ? 'bg-[#d4af37] text-white'
        : 'bg-gray-100 text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-200 dark:hover:bg-[#d4af37]/20'
    }`;

  const loadSettings = useCallback(async () => {
    if (!isAdmin) return;
    setIsLoading(true);
    setError('');
    try {
      const response = await loadSystemSettings();
      const mergedSettings = mergeSettings(
        response.settings,
        response.secretStatus?.ai?.gemini?.allowedModels,
      );
      setSettings(mergedSettings);
      setSecretStatus(response.secretStatus || EMPTY_SECRET_STATUS);
      setSystemUsers(response.users || []);
    } catch (loadError) {
      console.error('Failed to load system settings:', loadError);
      setError('تعذر تحميل إعدادات النظام من السيرفر.');
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateSetting = <K extends SystemSettingKey>(key: K, field: string, value: unknown) => {
    setSettings(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: value,
      },
    }));
    setSavedMessage('');
  };

  const handleSave = async () => {
    if (!isAdmin) return;
    setIsSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const response = await saveSystemSettings(settings);
      setSettings(mergeSettings(
        response.settings,
        response.secretStatus?.ai?.gemini?.allowedModels,
      ));
      setSecretStatus(response.secretStatus || EMPTY_SECRET_STATUS);
      setSystemUsers(response.users || []);
      notifyAiProviderCapabilitiesChanged();
      notifyPromptRegistryChanged();
      notifyInternalLinkAutomationSettingsChanged();
      setSavedMessage('تم حفظ الإعدادات.');
    } catch (saveError) {
      console.error('Failed to save system settings:', saveError);
      setError('تعذر حفظ الإعدادات.');
    } finally {
      setIsSaving(false);
    }
  };

  const renderPersonalPreferences = () => (
    <div className="space-y-6">
      <SettingsSection title="المظهر وطريقة العمل">
        <p className="mb-4 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
          هذه الخيارات خاصة بحسابك وطريقة عرض المحرر، ولا تغيّر إعدادات بقية المستخدمين.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.highlightStyle}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handleHighlightStyleChange('background')} className={buttonClass(highlightStyle === 'background')} title={t.background}>
              <PaintRoller size={16} />
              <span>{t.background}</span>
            </button>
            <button type="button" onClick={() => handleHighlightStyleChange('underline')} className={buttonClass(highlightStyle === 'underline')} title={t.wavyUnderline}>
              <Baseline size={16} />
              <span>{t.wavyUnderline}</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.chatGptOpenPreference}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handleChatGptOpenModeChange('window')} className={buttonClass(chatGptOpenMode === 'window')} title={t.chatGptOpenSeparateWindow}>
              <AppWindow size={16} />
              <span>{t.chatGptOpenSeparateWindow}</span>
            </button>
            <button type="button" onClick={() => handleChatGptOpenModeChange('tab')} className={buttonClass(chatGptOpenMode === 'tab')} title={t.chatGptOpenNewTab}>
              <NotebookTabs size={16} />
              <span>{t.chatGptOpenNewTab}</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.keywordView}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handleKeywordViewModeChange('classic')} className={buttonClass(keywordViewMode === 'classic')} title={t.detailedCards}>
              <LayoutGrid size={16} />
              <span>{t.detailedCards}</span>
            </button>
            <button type="button" onClick={() => handleKeywordViewModeChange('modern')} className={buttonClass(keywordViewMode === 'modern')} title={t.modernList}>
              <ListTree size={16} />
              <span>{t.modernList}</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.structureView}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handleStructureViewModeChange('grid')} className={buttonClass(structureViewMode === 'grid')} title={t.grid}>
              <LayoutGrid size={16} />
              <span>{t.grid}</span>
            </button>
            <button type="button" onClick={() => handleStructureViewModeChange('list')} className={buttonClass(structureViewMode === 'list')} title={t.list}>
              <List size={16} />
              <span>{t.list}</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.defaultArticleLanguage}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handlePreferredLanguageChange('ar')} className={buttonClass(preferredLanguage === 'ar')} title={t.arabic}>
              <Languages size={16} />
              <span>{t.arabic}</span>
            </button>
            <button type="button" onClick={() => handlePreferredLanguageChange('en')} className={buttonClass(preferredLanguage === 'en')} title={t.english}>
              <Languages size={16} />
              <span>{t.english}</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-bold text-gray-600 dark:text-gray-300">{t.interfaceLanguage}</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => handleUiLanguageChange('ar')} className={buttonClass(uiLanguage === 'ar')} title={t.arabic}>
              <Languages size={16} />
              <span>{t.arabic}</span>
            </button>
            <button type="button" onClick={() => handleUiLanguageChange('en')} className={buttonClass(uiLanguage === 'en')} title={t.english}>
              <Languages size={16} />
              <span>{t.english}</span>
            </button>
          </div>
        </div>

        </div>
      </SettingsSection>
    </div>
  );

  const renderUserAccountSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="مفاتيح الذكاء الاصطناعي الخاصة بحسابي">
        <UserAiProviderSecretsSettings />
      </SettingsSection>
      <SettingsSection title="صلاحيات المزودات والحصص لحسابي">
        <UserProviderAccessSummary />
      </SettingsSection>
      <SettingsSection title="حصة المقالات الشهرية لحسابي">
        <UserArticleQuotaSummary />
      </SettingsSection>
    </div>
  );

  const renderUserDataSettings = () => (
    <div className="space-y-6">
      <DashboardDataTools />
    </div>
  );

  const renderAiSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="إعدادات الذكاء الاصطناعي">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-md border-r-4 border-[#d4af37] bg-[#d4af37]/10 px-3 py-3 text-xs font-semibold leading-6 text-gray-700 dark:text-gray-200 md:col-span-2">
            <div className="font-black">الرجوع التلقائي للمفاتيح والمزودات مفعّل في جميع أوامر الذكاء الاصطناعي</div>
            <div>OpenAI: مفتاح المستخدم الخاص ← المفاتيح المشتركة المعيّنة له ← المفاتيح المشتركة المعيّنة للجميع ← Gemini Pro ← Gemini المجاني.</div>
            <div>Gemini Pro: مفتاح المستخدم الخاص ← المفاتيح المشتركة المعيّنة له ← المفاتيح المشتركة المعيّنة للجميع ← Gemini المجاني.</div>
            <div>Gemini المجاني: مفتاح المستخدم الخاص ← المفاتيح المشتركة المسموح بها من المسؤول.</div>
            <div>لا تُقرأ مفاتيح API من بيئة الاستضافة؛ مصدرها الوحيد خزنة اللوحة المشفّرة.</div>
            <div className="text-gray-500 dark:text-gray-400">يحدث الرجوع عند فشل المفتاح أو الحصة أو الفوترة أو 429 أو انتهاء المهلة أو خطأ المزود، ولا يحدث عند إلغاء المستخدم أو نقص المدخلات أو حظر السلامة.</div>
          </div>
          <ToggleField
            label="السماح للمستخدمين باستخدام Gemini المجاني"
            description="يُستخدم مباشرة عند اختياره، وهو المرحلة الأخيرة في الرجوع التلقائي بعد فشل OpenAI أو Gemini Pro. تعطيله يمنع استخدامه كبديل."
            checked={Boolean(settings.ai.geminiFreeEnabled)}
            onChange={value => updateSetting('ai', 'geminiFreeEnabled', value)}
          />
          <ToggleField
            label="التبديل بين موديلات Gemini المجانية"
            description="عند تفعيله يجرب الخادم موديلات Gemini المجانية بالترتيب إذا فشل الموديل الأول، سواء كان Gemini مختارًا مباشرة أو تم الوصول إليه بالرجوع التلقائي."
            checked={Boolean(settings.ai.geminiFreeModelFallbackEnabled)}
            onChange={value => updateSetting('ai', 'geminiFreeModelFallbackEnabled', value)}
          />
          <ToggleField
            label="السماح للمستخدمين باستخدام Gemini Pro"
            description="يسمح باستخدام Gemini Pro مباشرة، ويسمح لـ OpenAI بالانتقال إليه كأول مزود بديل. عند فشل مفاتيحه ينتقل إلى Gemini المجاني إذا كان مسموحًا."
            checked={Boolean(settings.ai.geminiProEnabled)}
            onChange={value => updateSetting('ai', 'geminiProEnabled', value)}
          />
          <ToggleField
            label="السماح للمستخدمين باستخدام OpenAI"
            description="يسمح ببدء الطلب عبر OpenAI. عند فشل مفاتيحه ينتقل تلقائيًا إلى Gemini Pro ثم Gemini المجاني بحسب السماح والتوفر."
            checked={Boolean(settings.ai.openAiEnabled)}
            onChange={value => updateSetting('ai', 'openAiEnabled', value)}
          />
          <ToggleField
            label="توليد عبارات الربط الذكي أثناء الزحف"
            description="يحلل مقتطفًا منظفًا من محتوى كل صفحة بعد الزحف، ويبدأ بالمزود الافتراضي وموديله اللذين يحددهما المسؤول أدناه، ثم يطبق سياسة البدائل المفعلة. لا يُخزن النص الكامل."
            checked={settings.ai.clientLinkAiEnrichmentEnabled !== false}
            onChange={value => updateSetting('ai', 'clientLinkAiEnrichmentEnabled', value)}
          />
          <FieldLabel
            label="المزود الافتراضي"
            description="هذا هو مزود البداية فقط؛ قد يتغير المزود أثناء التنفيذ إذا حدث فشل قابل للرجوع."
          >
            <SelectInput
              value={String(settings.ai.defaultProvider || 'gemini')}
              onChange={value => updateSetting('ai', 'defaultProvider', value)}
              options={[
                { value: 'gemini', label: 'Gemini' },
                { value: 'geminiPaid', label: 'Gemini Pro' },
                { value: 'openai', label: 'OpenAI' },
              ]}
            />
          </FieldLabel>
          <FieldLabel
            label="موديل Gemini المجاني الافتراضي"
            description="يختاره المسؤول ليكون أول موديل Gemini في توليد عبارات الربط الذكي وبقية الطلبات. تُجرّب البدائل فقط عند تفعيل التبديل بين موديلات Gemini المجانية."
          >
            <SelectInput
              value={normalizeGeminiFreeModel(String(settings.ai.defaultGeminiModel || ''), geminiFreeModelValues)}
              onChange={value => updateSetting('ai', 'defaultGeminiModel', value)}
              options={geminiFreeModelOptions}
            />
          </FieldLabel>
          <FieldLabel label="مهلة التشغيل الدوري الخارجي للذكاء الاصطناعي (بالدقائق)">
            <NumberInput
              value={Number(settings.ai.externalAnalysisRetryMinutes || 30)}
              min={5}
              max={1440}
              step={5}
              onChange={value => updateSetting('ai', 'externalAnalysisRetryMinutes', value)}
            />
          </FieldLabel>
          <FieldLabel
            label="موديل Gemini Pro الافتراضي"
            description="يُستخدم عند اختيار Gemini Pro مباشرة، أو عند انتقال طلب OpenAI إليه تلقائيًا."
          >
            <SelectInput
              value={normalizeGeminiPaidModelId(settings.ai.defaultGeminiPaidModel)}
              onChange={value => updateSetting('ai', 'defaultGeminiPaidModel', value)}
              options={GEMINI_PAID_MODEL_OPTIONS}
            />
          </FieldLabel>
          <FieldLabel
            label="موديل OpenAI الافتراضي"
            description="يُستخدم في مرحلة OpenAI الأولى، قبل الانتقال إلى المزودات البديلة عند الفشل."
          >
            <TextInput value={String(settings.ai.defaultOpenAiModel || '')} onChange={value => updateSetting('ai', 'defaultOpenAiModel', value)} dir="ltr" />
          </FieldLabel>
        </div>
      </SettingsSection>

      {isAdmin && (
        <SettingsSection title="مركز المزودات والمفاتيح والصلاحيات">
          <AdminProviderAccessSettings />
        </SettingsSection>
      )}

      <SettingsSection title="إعدادات كتابة المحتوى">
        <ContentWritingPromptSettings
          values={settings.ai}
          onChange={(field, value) => updateSetting('ai', field, value)}
        />
      </SettingsSection>

      <SettingsSection title="الأوامر الافتراضية للتحليل الخارجي للمقالات السابقة ومقالات النظام">
        <p className="mb-4 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          للمقالات الجديدة التي ينشئها المستخدم بنفسه، يعتمد التشغيل التلقائي أوامر منشئها المحددة في «أتمتة مقالاتي». تبقى هذه القائمة الافتراضية للمقالات غير المشمولة بالإعدادات الشخصية.
        </p>
        <ExternalAnalysisDefaultCommandsSettings />
      </SettingsSection>
    </div>
  );

  const renderN8nSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="n8n">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <FieldLabel label="رابط API">
              <div className="flex gap-2">
                <TextInput value={secretStatus.n8n.ingestUrl || '/api/n8n/articles'} onChange={() => undefined} dir="ltr" />
                <button
                  type="button"
                  onClick={() => copyText(secretStatus.n8n.ingestUrl)}
                  className="rounded-md border border-gray-200 bg-white p-2 text-gray-500 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
                  title="نسخ"
                >
                  <Copy size={16} />
                </button>
              </div>
            </FieldLabel>
          </div>
          <ToggleField label="n8n مفعل" checked={Boolean(settings.n8n.enabled)} onChange={value => updateSetting('n8n', 'enabled', value)} />
          <ToggleField label="تشغيل أتمتة المقالات المسندة" description="سياسة خاصة بمقالات n8n والنظام؛ إسنادها إلى مستخدم لا يجعلها مقالات أنشأها بنفسه ولا يغيّر منشئها الأصلي." checked={Boolean(settings.n8n.autoRunAssignedAutomation)} onChange={value => updateSetting('n8n', 'autoRunAssignedAutomation', value)} />
          <FieldLabel label="الظهور الافتراضي">
            <SelectInput
              value={String(settings.n8n.defaultVisibility || 'public')}
              onChange={value => updateSetting('n8n', 'defaultVisibility', value)}
              options={[
                { value: 'public', label: 'عام' },
                { value: 'private', label: 'خاص' },
              ]}
            />
          </FieldLabel>
          <FieldLabel label="صلاحية الوصول الافتراضية">
            <SelectInput
              value={String(settings.n8n.defaultAccessRole || 'editor')}
              onChange={value => updateSetting('n8n', 'defaultAccessRole', value)}
              options={[
                { value: 'viewer', label: 'عرض' },
                { value: 'editor', label: 'تعديل' },
              ]}
            />
          </FieldLabel>
        </div>
      </SettingsSection>
    </div>
  );

  const renderCrawlerSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="خدمات الزحف الخارجية">
        <div className="rounded-md border-r-4 border-[#d4af37] bg-[#d4af37]/10 p-4 text-sm font-semibold leading-7 text-gray-700 dark:text-gray-200">
          <div className="font-black">إدارة موحدة لمفاتيح Firecrawl وBrowserless</div>
          <p className="mt-1 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
            تُحفظ مفاتيح الزحف وتُعيّن صلاحياتها من مركز المزودات نفسه المستخدم لـ Gemini وOpenAI. لا توجد شاشة ثانية أو خزنة منفصلة لخدمات الزحف.
          </p>
          <button
            type="button"
            onClick={() => navigateToAppPath('/settings/ai')}
            className="mt-3 inline-flex min-h-10 items-center justify-center rounded-md bg-[#d4af37] px-4 py-2 text-xs font-black text-white"
          >
            فتح مركز المزودات والمفاتيح
          </button>
        </div>
      </SettingsSection>
      <SettingsSection title="سياسة استخدام خدمات الزحف">
        <AdminCrawlerUsagePolicySettings />
      </SettingsSection>
    </div>
  );

  const renderSystemSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="النظام">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldLabel label="الدومين العام">
            <TextInput value={String(settings.system.publicEditorUrl || '')} onChange={value => updateSetting('system', 'publicEditorUrl', value)} placeholder="https://editor.example.com" dir="ltr" />
          </FieldLabel>
          <FieldLabel label="المنطقة الزمنية">
            <TextInput value={String(settings.system.timezone || 'Europe/Istanbul')} onChange={value => updateSetting('system', 'timezone', value)} dir="ltr" />
          </FieldLabel>
          <ToggleField label="التقارير اليومية" checked={Boolean(settings.system.dailyReportEnabled)} onChange={value => updateSetting('system', 'dailyReportEnabled', value)} />
          <ToggleField label="تسجيل النشاط" checked={Boolean(settings.system.activityTrackingEnabled)} onChange={value => updateSetting('system', 'activityTrackingEnabled', value)} />
        </div>
      </SettingsSection>

      <SettingsSection title="ضابط عام لأتمتة الربط الداخلي">
        <div className="grid grid-cols-1 gap-4">
          <ToggleField
            label="السماح بإدراج روابط الربط الداخلي المؤكدة تلقائيًا"
            description="تعطيله يمنع الإدراج التلقائي للجميع. السماح وحده لا يتجاوز رغبة منشئ المقالة. يطبق الرابط فقط عند صلة 90 من 100 وتطابق صريح وفريد وفارق 12 نقطة عن أي صفحة منافسة، مع منع الربط بالصفحة نفسها."
            checked={settings.system.autoApplyStrongInternalLinkSuggestions !== false}
            onChange={value => updateSetting('system', 'autoApplyStrongInternalLinkSuggestions', value)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="ضوابط السماح العامة للأتمتة">
        <p className="mb-4 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          هذه مفاتيح منع عامة للمسؤول: تعطيل أي مرحلة يمنع تشغيلها تلقائيًا للجميع، والسماح بها لا يفعّلها لمن عطّلها في تفضيلاته. لا تتغير اختيارات المستخدمين المحفوظة ولا صلاحيات التشغيل اليدوي.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ToggleField
            label="السماح بتوليد الصيغ البديلة تلقائيًا"
            description="يشترط تفعيلها في إعدادات منشئ المقالة المشمولة بالأتمتة الشخصية. عند تعطيله يبقى التوليد اليدوي متاحًا."
            checked={settings.system.autoGenerateAlternativeKeywords !== false}
            onChange={value => updateSetting('system', 'autoGenerateAlternativeKeywords', value)}
          />
          <ToggleField
            label="السماح بتوليد كلمات LSI تلقائيًا"
            description="يشترط تفعيلها في إعدادات منشئ المقالة المشمولة بالأتمتة الشخصية. عند تعطيله يبقى التوليد اليدوي متاحًا."
            checked={settings.system.autoGenerateLsiKeywords !== false}
            onChange={value => updateSetting('system', 'autoGenerateLsiKeywords', value)}
          />
          <ToggleField
            label="السماح باقتراح عناوين وأوصاف Google تلقائيًا"
            description="يخضع التشغيل التلقائي لتفضيلات منشئ المقالة وصلاحيات مزود الذكاء الاصطناعي."
            checked={settings.system.autoGenerateGoogleMetadata !== false}
            onChange={value => updateSetting('system', 'autoGenerateGoogleMetadata', value)}
          />
          <ToggleField
            label="السماح بجلب المنافسين تلقائيًا"
            description="يبدأ بعد توفر شروط البحث؛ لا تُشغّل مرحلة عطّلها المستخدم لتوفير متطلبات مرحلة أخرى. لا يتأثر البحث اليدوي."
            checked={settings.system.autoDiscoverCompetitors !== false}
            onChange={value => updateSetting('system', 'autoDiscoverCompetitors', value)}
          />
          <ToggleField
            label="السماح بسحب محتوى المنافسين تلقائيًا"
            description="يسمح بالسحب عند تفعيله في تفضيلات المنشئ وتوفر المنافسين، مع بقاء صلاحيات الزحف والحصص نافذة."
            checked={settings.system.autoExtractCompetitorContent !== false}
            onChange={value => updateSetting('system', 'autoExtractCompetitorContent', value)}
          />
          <ToggleField
            label="السماح بتشغيل الأوامر الجاهزة تلقائيًا"
            description="يجدول الخادم الأوامر التي اختارها منشئ المقالة بعد تحقق شروطها. تعطيله يوقف التشغيل التلقائي فقط."
            checked={settings.system.autoRunReadyEngineeringCommands !== false}
            onChange={value => updateSetting('system', 'autoRunReadyEngineeringCommands', value)}
          />
        </div>
        <p className="mt-4 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          ضابط الكتابة التلقائية والموديل والفواصل وشروط الجودة موجودة في تبويب الذكاء الاصطناعي ضمن إعدادات كتابة المحتوى.
        </p>
      </SettingsSection>

      <SettingsSection title="أتمتة المستخدمين الجدد: القيم الافتراضية">
        <p className="mb-4 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          تُنسخ هذه الاختيارات إلى إعدادات المستخدم الجديد مرة واحدة. تعديلها لا يغيّر رغبات المستخدمين الحاليين ولا يعيد تشغيل المقالات السابقة. هذه القيم مستقلة عن ضوابط السماح العامة أعلاه، ويمكن للمستخدم تغيير اختياراته من «أتمتة مقالاتي».
        </p>
        <UserAutomationPreferenceFields
          value={normalizeUserAutomationPreferences(settings.system.userAutomationDefaults)}
          onChange={value => updateSetting('system', 'userAutomationDefaults', value)}
          disabled={isLoading || isSaving}
          defaultsMode
        />
      </SettingsSection>

      <SettingsSection title="القيم الافتراضية للمقالات">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldLabel label="الحالة الافتراضية">
            <SelectInput
              value={String(settings.articles.defaultStatus || 'draft')}
              onChange={value => updateSetting('articles', 'defaultStatus', value)}
              options={ARTICLE_STATUS_OPTIONS}
            />
          </FieldLabel>
          <FieldLabel label="الظهور الافتراضي">
            <SelectInput
              value={String(settings.articles.defaultVisibility || 'public')}
              onChange={value => updateSetting('articles', 'defaultVisibility', value)}
              options={[
                { value: 'public', label: 'عام' },
                { value: 'private', label: 'خاص' },
              ]}
            />
          </FieldLabel>
          <FieldLabel label="لغة المقال الافتراضية">
            <SelectInput
              value={String(settings.articles.defaultLanguage || 'ar')}
              onChange={value => updateSetting('articles', 'defaultLanguage', value)}
              options={[
                { value: 'ar', label: 'عربي' },
                { value: 'en', label: 'English' },
              ]}
            />
          </FieldLabel>
          <FieldLabel label="مدة السلة بالأيام">
            <NumberInput value={Number(settings.articles.trashRetentionDays || 30)} min={1} onChange={value => updateSetting('articles', 'trashRetentionDays', value)} />
          </FieldLabel>
        </div>
      </SettingsSection>
      <DashboardDataTools />
    </div>
  );

  const renderRoleSettings = () => (
    <SettingsSection title="الصلاحيات">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <FieldLabel
            label="المستخدم الناشر"
            description="يرى تلقائيًا مقالات بقية المستخدمين التي حالتها «جاهز» أو «تجهيز محتوى»، إضافة إلى المقالات التي يعيّنها له المسؤول يدويًا وفق صلاحيتها الحالية."
          >
            <SelectInput
              value={String(settings.roles.publisherUserId || '')}
              onChange={value => updateSetting('roles', 'publisherUserId', value)}
              options={[
                { value: '', label: 'بدون مستخدم ناشر' },
                ...systemUsers
                  .slice()
                  .sort((left, right) => (
                    (left.fullName || left.email || left.id).localeCompare(
                      right.fullName || right.email || right.id,
                      'ar',
                    )
                  ))
                  .map(user => ({
                    value: user.id,
                    label: `${user.fullName?.trim() || user.email?.trim() || user.id}${user.role === 'admin' ? ' (مسؤول)' : ''}${user.isActive ? '' : ' (غير فعال)'}`,
                  })),
              ]}
            />
          </FieldLabel>
        </div>
        <ToggleField label="الأدمن يرى كل السجلات" checked={Boolean(settings.roles.adminCanSeeAll)} onChange={value => updateSetting('roles', 'adminCanSeeAll', value)} />
        <ToggleField label="المستخدم يستطيع حجز المقالات العامة" checked={Boolean(settings.roles.usersCanClaimPublicArticles)} onChange={value => updateSetting('roles', 'usersCanClaimPublicArticles', value)} />
        <ToggleField label="المقالات المحجوزة تختفي من باقي المستخدمين" checked={Boolean(settings.roles.usersCanSeeOnlyAssignedAfterClaim)} onChange={value => updateSetting('roles', 'usersCanSeeOnlyAssignedAfterClaim', value)} />
      </div>
    </SettingsSection>
  );

  const renderClientSettings = () => <ClientCenterSettings />;

  const renderPromptSettings = () => (
    <SettingsSection title="الأوامر الهندسية">
      <AdminPromptRegistrySettings
        values={settings.prompts}
        onChange={(field, value) => updateSetting('prompts', field, value)}
      />
    </SettingsSection>
  );

  const renderUsersSettings = () => (
    <div className="space-y-6">
      {renderPersonalPreferences()}
      {isAdmin && (
        <SettingsSection title="الحصة الشهرية الافتراضية للمستخدمين">
          <AdminArticleQuotaSettings />
        </SettingsSection>
      )}
      <SettingsSection title="إدارة المستخدمين">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigateToAppPath('/admin/users')}
            className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
          >
            <Users size={16} />
            <span>فتح المستخدمين</span>
          </button>
          <button
            type="button"
            onClick={() => navigateToAppPath('/admin/activity')}
            className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
          >
            <SlidersHorizontal size={16} />
            <span>فتح النشاط</span>
          </button>
        </div>
      </SettingsSection>
    </div>
  );

  const renderSelectedSection = () => {
    if (selectedSection === 'automation') return <UserAutomationSettings />;
    if (!isAdmin) {
      if (selectedSection === 'account') return renderUserAccountSettings();
      if (selectedSection === 'clients') return renderClientSettings();
      if (selectedSection === 'data') return renderUserDataSettings();
      return renderPersonalPreferences();
    }

    if (selectedSection === 'ai') return renderAiSettings();
    if (selectedSection === 'crawler') return renderCrawlerSettings();
    if (selectedSection === 'prompts') return renderPromptSettings();
    if (selectedSection === 'n8n') return renderN8nSettings();
    if (selectedSection === 'clients') return renderClientSettings();
    if (selectedSection === 'roles') return renderRoleSettings();
    if (selectedSection === 'users') return renderUsersSettings();
    return renderSystemSettings();
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 dark:bg-[#181818]`}>
      <div className={`mx-auto p-4 sm:p-6 md:p-8 ${selectedSection === 'clients' ? 'max-w-screen-2xl' : 'max-w-screen-lg'}`}>
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-xs font-black text-[#d4af37]">Bazarvan Settings</div>
            <h1 className="mt-1 text-3xl font-black text-gray-900 dark:text-gray-100">الإعدادات</h1>
            <p className="mt-1 text-sm font-semibold text-gray-500 dark:text-gray-400">{currentUser}</p>
            <SettingsBreadcrumbs currentLabel={selectedTabLabel} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigateToAppPath('/dashboard')}
              className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
            >
              <BookOpen size={16} />
              <span>لوحة التحكم</span>
            </button>
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => navigateToAppPath('/admin')}
                  className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
                >
                  <Shield size={16} />
                  <span>مركز المتابعة</span>
                </button>
                {selectedSection !== 'clients' && selectedSection !== 'automation' && (
                  <>
                    <button
                      type="button"
                      onClick={loadSettings}
                      disabled={isLoading}
                      className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-[#d4af37]/10 disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-200"
                    >
                      <RefreshCw size={16} />
                      <span>تحديث</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={isSaving}
                      className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-60"
                    >
                      <Save size={16} />
                      <span>حفظ</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </header>

        <nav className="mb-6 flex flex-wrap gap-2">
          {tabs.map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigateToAppPath(item.path)}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-bold ${
                selectedSection === item.key
                  ? 'bg-[#d4af37] text-white'
                  : 'bg-white text-gray-600 hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:text-gray-300'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {selectedSection !== 'automation' && error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
        {selectedSection !== 'automation' && savedMessage && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm font-bold text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
            {savedMessage}
          </div>
        )}
        {selectedSection !== 'automation' && isLoading && (
          <div className="mb-4 rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-sm font-bold text-[#8a6f1d] dark:text-[#f2d675]">
            جار تحميل الإعدادات...
          </div>
        )}

        <div className="space-y-6">
          {renderSelectedSection()}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
