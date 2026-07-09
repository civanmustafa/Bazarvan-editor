import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Baseline,
  BookOpen,
  CheckCircle2,
  Copy,
  Key,
  Languages,
  LayoutGrid,
  List,
  ListTree,
  NotebookTabs,
  PaintRoller,
  RefreshCw,
  Save,
  Shield,
  SlidersHorizontal,
  Users,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import EngineeringPromptsSettings from './EngineeringPromptsSettings';
import { navigateToAppPath } from '../utils/appRoutes';
import {
  loadSystemSettings,
  saveSystemSettings,
  type SecretStatus,
  type SystemSettingKey,
  type SystemSettingsMap,
} from '../utils/systemSettings';
import {
  buildGeminiFreeModelOptions,
  getSelectedGeminiFreeModel,
  normalizeGeminiFreeModel,
  setSelectedGeminiFreeModel,
} from '../utils/geminiModelPreference';

type SettingsPageProps = {
  section: string | null;
};

type SettingsTab = {
  key: SystemSettingKey;
  label: string;
  path: string;
  icon: React.ReactNode;
};

const DEFAULT_SETTINGS: SystemSettingsMap = {
  ai: {
    geminiFreeEnabled: true,
    geminiProEnabled: true,
    openAiEnabled: false,
    defaultProvider: 'gemini',
    defaultGeminiModel: 'gemini-2.5-flash',
    defaultGeminiPaidModel: 'gemini-2.5-pro',
    defaultOpenAiModel: 'gpt-4.1-mini',
  },
  n8n: {
    enabled: true,
    defaultVisibility: 'public',
    defaultAccessRole: 'editor',
    autoRunAssignedAutomation: true,
  },
  articles: {
    defaultStatus: 'draft',
    defaultVisibility: 'public',
    defaultLanguage: 'ar',
    trashRetentionDays: 30,
  },
  roles: {
    adminCanSeeAll: true,
    usersCanClaimPublicArticles: true,
    usersCanSeeOnlyAssignedAfterClaim: true,
  },
  system: {
    timezone: 'Europe/Istanbul',
    publicEditorUrl: '',
    dailyReportEnabled: true,
    activityTrackingEnabled: true,
  },
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

const FieldLabel: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">{label}</span>
    {children}
  </label>
);

const StatusPill: React.FC<{ active: boolean; label: string; count?: number }> = ({ active, label, count }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-black ${
    active
      ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
      : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  }`}>
    {active ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
    <span>{label}</span>
    {typeof count === 'number' && <span>({count})</span>}
  </span>
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
  onChange: (value: number) => void;
}> = ({ value, min = 0, onChange }) => (
  <input
    type="number"
    min={min}
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
  <select
    value={value}
    onChange={event => onChange(event.target.value)}
    className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
  >
    {options.map(option => (
      <option key={option.value} value={option.value}>{option.label}</option>
    ))}
  </select>
);

const ToggleField: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
    <span className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}</span>
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

const mergeSettings = (settings?: Partial<SystemSettingsMap>): SystemSettingsMap => ({
  ai: { ...DEFAULT_SETTINGS.ai, ...(settings?.ai || {}) },
  n8n: { ...DEFAULT_SETTINGS.n8n, ...(settings?.n8n || {}) },
  articles: { ...DEFAULT_SETTINGS.articles, ...(settings?.articles || {}) },
  roles: { ...DEFAULT_SETTINGS.roles, ...(settings?.roles || {}) },
  system: { ...DEFAULT_SETTINGS.system, ...(settings?.system || {}) },
});

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
  const selectedSection = (section || 'system') as SystemSettingKey;
  const [settings, setSettings] = useState<SystemSettingsMap>(() => mergeSettings());
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(EMPTY_SECRET_STATUS);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [selectedGeminiFreeModel, setSelectedGeminiFreeModelState] = useState(() => getSelectedGeminiFreeModel());

  const tabs: SettingsTab[] = useMemo(() => [
    { key: 'system', label: 'النظام', path: '/settings/system', icon: <Shield size={16} /> },
    { key: 'ai', label: 'الذكاء الاصطناعي', path: '/settings/ai', icon: <Key size={16} /> },
    { key: 'n8n', label: 'n8n', path: '/settings/n8n', icon: <Workflow size={16} /> },
    { key: 'users', label: 'المستخدمون', path: '/settings/users', icon: <Users size={16} /> },
    { key: 'roles', label: 'الصلاحيات', path: '/settings/roles', icon: <SlidersHorizontal size={16} /> },
  ], []);
  const selectedTabLabel = tabs.find(item => item.key === selectedSection)?.label || 'النظام';
  const geminiFreeModelOptions = useMemo(() => (
    buildGeminiFreeModelOptions()
  ), []);
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
      setSettings(mergeSettings(response.settings));
      setSecretStatus(response.secretStatus || EMPTY_SECRET_STATUS);
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

  useEffect(() => {
    const normalizedModel = normalizeGeminiFreeModel(selectedGeminiFreeModel, geminiFreeModelValues);
    if (normalizedModel === selectedGeminiFreeModel) return;
    setSelectedGeminiFreeModelState(normalizedModel);
    setSelectedGeminiFreeModel(normalizedModel, geminiFreeModelValues);
  }, [geminiFreeModelValues, selectedGeminiFreeModel]);

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

  const handleGeminiFreeModelPreferenceChange = (value: string, shouldShowMessage = true) => {
    const selectedModel = setSelectedGeminiFreeModel(value, geminiFreeModelValues);
    setSelectedGeminiFreeModelState(selectedModel);
    if (shouldShowMessage) {
      setError('');
      setSavedMessage('تم حفظ موديل Gemini الافتراضي لهذا المتصفح.');
    }
    return selectedModel;
  };

  const handleSave = async () => {
    if (!isAdmin) return;
    setIsSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const response = await saveSystemSettings(settings);
      setSettings(mergeSettings(response.settings));
      setSecretStatus(response.secretStatus || EMPTY_SECRET_STATUS);
      setSavedMessage('تم حفظ الإعدادات.');
    } catch (saveError) {
      console.error('Failed to save system settings:', saveError);
      setError('تعذر حفظ الإعدادات.');
    } finally {
      setIsSaving(false);
    }
  };

  const renderPersonalPreferences = () => (
    <SettingsSection title="تفضيلات المستخدم">
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

        <FieldLabel label="موديل Gemini الافتراضي">
          <SelectInput
            value={selectedGeminiFreeModel}
            onChange={value => handleGeminiFreeModelPreferenceChange(value)}
            options={geminiFreeModelOptions}
          />
        </FieldLabel>
      </div>
    </SettingsSection>
  );

  const renderAiSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="حالة مفاتيح السيرفر">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">Gemini المجاني</div>
            <StatusPill active={secretStatus.ai.gemini.configured} label={secretStatus.ai.gemini.configured ? 'مفعل' : 'غير مفعل'} count={secretStatus.ai.gemini.keyCount} />
            <div className="mt-2 text-xs font-semibold text-gray-500">{secretStatus.ai.gemini.model || '-'}</div>
          </div>
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">Gemini Pro</div>
            <StatusPill active={secretStatus.ai.geminiPaid.configured} label={secretStatus.ai.geminiPaid.configured ? 'مفعل' : 'غير مفعل'} count={secretStatus.ai.geminiPaid.keyCount} />
            <div className="mt-2 text-xs font-semibold text-gray-500">{secretStatus.ai.geminiPaid.model || '-'}</div>
          </div>
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">OpenAI</div>
            <StatusPill active={secretStatus.ai.openAi.configured} label={secretStatus.ai.openAi.configured ? 'مفعل' : 'غير مفعل'} count={secretStatus.ai.openAi.keyCount} />
            <div className="mt-2 text-xs font-semibold text-gray-500">{secretStatus.ai.openAi.model || '-'}</div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="إعدادات الذكاء الاصطناعي">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ToggleField label="Gemini المجاني" checked={Boolean(settings.ai.geminiFreeEnabled)} onChange={value => updateSetting('ai', 'geminiFreeEnabled', value)} />
          <ToggleField label="Gemini Pro" checked={Boolean(settings.ai.geminiProEnabled)} onChange={value => updateSetting('ai', 'geminiProEnabled', value)} />
          <ToggleField label="OpenAI" checked={Boolean(settings.ai.openAiEnabled)} onChange={value => updateSetting('ai', 'openAiEnabled', value)} />
          <FieldLabel label="المزود الافتراضي">
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
          <FieldLabel label="موديل Gemini الافتراضي">
            <SelectInput
              value={normalizeGeminiFreeModel(String(settings.ai.defaultGeminiModel || selectedGeminiFreeModel), geminiFreeModelValues)}
              onChange={value => {
                updateSetting('ai', 'defaultGeminiModel', value);
                handleGeminiFreeModelPreferenceChange(value, false);
              }}
              options={geminiFreeModelOptions}
            />
          </FieldLabel>
          <FieldLabel label="موديل Gemini Pro الافتراضي">
            <TextInput value={String(settings.ai.defaultGeminiPaidModel || '')} onChange={value => updateSetting('ai', 'defaultGeminiPaidModel', value)} dir="ltr" />
          </FieldLabel>
          <FieldLabel label="موديل OpenAI الافتراضي">
            <TextInput value={String(settings.ai.defaultOpenAiModel || '')} onChange={value => updateSetting('ai', 'defaultOpenAiModel', value)} dir="ltr" />
          </FieldLabel>
        </div>
      </SettingsSection>

      <SettingsSection title="قوالب التحرير والتحليل">
        <EngineeringPromptsSettings />
      </SettingsSection>
    </div>
  );

  const renderN8nSettings = () => (
    <div className="space-y-6">
      <SettingsSection title="n8n">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">N8N_INGEST_TOKEN</div>
            <StatusPill active={secretStatus.n8n.tokenConfigured} label={secretStatus.n8n.tokenConfigured ? 'مفعل' : 'غير مفعل'} />
          </div>
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">SUPABASE_SERVICE_ROLE_KEY</div>
            <StatusPill active={secretStatus.n8n.serviceRoleConfigured} label={secretStatus.n8n.serviceRoleConfigured ? 'مفعل' : 'غير مفعل'} />
          </div>
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
          <ToggleField label="تشغيل أتمتة المقالات المسندة" checked={Boolean(settings.n8n.autoRunAssignedAutomation)} onChange={value => updateSetting('n8n', 'autoRunAssignedAutomation', value)} />
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

      <SettingsSection title="القيم الافتراضية للمقالات">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldLabel label="الحالة الافتراضية">
            <SelectInput
              value={String(settings.articles.defaultStatus || 'draft')}
              onChange={value => updateSetting('articles', 'defaultStatus', value)}
              options={[
                { value: 'draft', label: 'مسودة' },
                { value: 'in_review', label: 'جاهز' },
                { value: 'published', label: 'منشور' },
                { value: 'archived', label: 'أرشيف' },
              ]}
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
    </div>
  );

  const renderRoleSettings = () => (
    <SettingsSection title="الصلاحيات">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ToggleField label="الأدمن يرى كل السجلات" checked={Boolean(settings.roles.adminCanSeeAll)} onChange={value => updateSetting('roles', 'adminCanSeeAll', value)} />
        <ToggleField label="المستخدم يستطيع حجز المقالات العامة" checked={Boolean(settings.roles.usersCanClaimPublicArticles)} onChange={value => updateSetting('roles', 'usersCanClaimPublicArticles', value)} />
        <ToggleField label="المقالات المحجوزة تختفي من باقي المستخدمين" checked={Boolean(settings.roles.usersCanSeeOnlyAssignedAfterClaim)} onChange={value => updateSetting('roles', 'usersCanSeeOnlyAssignedAfterClaim', value)} />
      </div>
    </SettingsSection>
  );

  const renderUsersSettings = () => (
    <div className="space-y-6">
      {renderPersonalPreferences()}
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
    if (!isAdmin && selectedSection !== 'users') {
      return renderPersonalPreferences();
    }

    if (selectedSection === 'ai') return renderAiSettings();
    if (selectedSection === 'n8n') return renderN8nSettings();
    if (selectedSection === 'roles') return renderRoleSettings();
    if (selectedSection === 'users') return renderUsersSettings();
    return renderSystemSettings();
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 dark:bg-[#181818]`}>
      <div className="mx-auto max-w-screen-lg p-4 sm:p-6 md:p-8">
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
                  <span>الأدمن</span>
                </button>
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

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
        {savedMessage && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm font-bold text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
            {savedMessage}
          </div>
        )}
        {isLoading && (
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
