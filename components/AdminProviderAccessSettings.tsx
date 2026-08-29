import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react';
import {
  PROVIDER_ACCESS_LABELS,
  PROVIDER_ACCESS_PROVIDERS,
  PROVIDER_CREDENTIAL_MODES,
  type ProviderAccessProvider,
  type ProviderCredentialMode,
  type ProviderCredentialPurpose,
} from '../constants/providerAccessControl.ts';
import {
  deleteAdminCredentialGrant,
  deleteAdminSharedCredential,
  loadAdminProviderAccess,
  saveAdminCredentialGrant,
  saveAdminProviderPolicy,
  saveAdminSharedCredential,
  updateAdminUserAccess,
  type AdminProviderAccessResponse,
  type EffectiveProviderPolicy,
} from '../utils/providerAccessControl.ts';

type Props = {
  userId?: string;
  onProfileUpdated?: () => void | Promise<void>;
};

type PolicyDraft = {
  enabled: boolean;
  allowPersonalKeys: boolean;
  credentialMode: ProviderCredentialMode;
  allowSharedFallback: boolean;
  allowProviderFallback: boolean;
  defaultModel: string;
  allowedModels: string;
  dailyRequestLimit: string;
  monthlyRequestLimit: string;
};

const MODE_LABELS: Record<ProviderCredentialMode, string> = {
  personal_first: 'الشخصي أولًا ثم المعيّن والمشترك',
  assigned_first: 'المعيّن أولًا ثم الشخصي والمشترك',
  assigned_only: 'المفاتيح المعيّنة فقط',
  personal_only: 'المفاتيح الشخصية فقط',
  global_only: 'المفاتيح العامة فقط',
  disabled: 'معطّل بالكامل',
};

const PURPOSE_LABELS: Record<ProviderCredentialPurpose, string> = {
  default: 'الاستخدام العام للمزود',
  content_writing_resume: 'استئناف جلسات كتابة المحتوى',
};

const toDraft = (policy: EffectiveProviderPolicy): PolicyDraft => ({
  enabled: policy.enabled,
  allowPersonalKeys: policy.allowPersonalKeys,
  credentialMode: policy.credentialMode,
  allowSharedFallback: policy.allowSharedFallback,
  allowProviderFallback: policy.allowProviderFallback,
  defaultModel: policy.defaultModel || '',
  allowedModels: policy.allowedModels.join(', '),
  dailyRequestLimit: policy.dailyRequestLimit ? String(policy.dailyRequestLimit) : '',
  monthlyRequestLimit: policy.monthlyRequestLimit ? String(policy.monthlyRequestLimit) : '',
});

const buildDrafts = (
  policies: Record<ProviderAccessProvider, EffectiveProviderPolicy>,
): Record<ProviderAccessProvider, PolicyDraft> => Object.fromEntries(
  PROVIDER_ACCESS_PROVIDERS.map(provider => [provider, toDraft(policies[provider])]),
) as Record<ProviderAccessProvider, PolicyDraft>;

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const Toggle: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ label, checked, onChange, disabled }) => (
  <label className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
    <span>{label}</span>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
    />
  </label>
);

const AdminProviderAccessSettings: React.FC<Props> = ({ userId, onProfileUpdated }) => {
  const isUserScope = Boolean(userId);
  const [overview, setOverview] = useState<AdminProviderAccessResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderAccessProvider, PolicyDraft> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [isActive, setIsActive] = useState(true);
  const [credentialProvider, setCredentialProvider] = useState<ProviderAccessProvider>('gemini_free');
  const [credentialPurpose, setCredentialPurpose] = useState<ProviderCredentialPurpose>('default');
  const [credentialLabel, setCredentialLabel] = useState('');
  const [credentialKeys, setCredentialKeys] = useState('');
  const [credentialScope, setCredentialScope] = useState<'unassigned' | 'all' | 'user'>(
    isUserScope ? 'user' : 'unassigned',
  );
  const [credentialExpiry, setCredentialExpiry] = useState('');
  const [showCredentialKeys, setShowCredentialKeys] = useState(false);

  const applyOverview = useCallback((next: AdminProviderAccessResponse) => {
    setOverview(next);
    setDrafts(buildDrafts(isUserScope ? next.effectivePolicies : next.globalPolicies));
    if (next.profile) {
      setRole(next.profile.role);
      setIsActive(next.profile.is_active !== false);
    }
  }, [isUserScope]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      applyOverview(await loadAdminProviderAccess(userId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل صلاحيات المزودات.');
    } finally {
      setIsLoading(false);
    }
  }, [applyOverview, userId]);

  useEffect(() => {
    setCredentialScope(isUserScope ? 'user' : 'unassigned');
    void load();
  }, [isUserScope, load]);

  const run = async (key: string, action: () => Promise<AdminProviderAccessResponse>, success: string) => {
    setBusyKey(key);
    setError('');
    setMessage('');
    try {
      applyOverview(await action());
      setMessage(success);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'تعذر حفظ التغيير.');
    } finally {
      setBusyKey('');
    }
  };

  const updateDraft = <K extends keyof PolicyDraft>(
    provider: ProviderAccessProvider,
    field: K,
    value: PolicyDraft[K],
  ) => {
    setDrafts(current => current ? {
      ...current,
      [provider]: { ...current[provider], [field]: value },
    } : current);
  };

  const savePolicy = (provider: ProviderAccessProvider) => {
    const draft = drafts?.[provider];
    if (!draft) return;
    const splitModels = draft.allowedModels
      .split(/[\n,;]+/)
      .map(value => value.trim())
      .filter(Boolean);
    void run(`policy:${provider}`, () => saveAdminProviderPolicy({
      scope: isUserScope ? 'user' : 'global',
      userId,
      provider,
      patch: {
        enabled: draft.enabled,
        allowPersonalKeys: draft.allowPersonalKeys,
        credentialMode: draft.credentialMode,
        allowSharedFallback: draft.allowSharedFallback,
        allowProviderFallback: draft.allowProviderFallback,
        defaultModel: draft.defaultModel.trim() || null,
        allowedModels: splitModels,
        dailyRequestLimit: draft.dailyRequestLimit ? Number(draft.dailyRequestLimit) : null,
        monthlyRequestLimit: draft.monthlyRequestLimit ? Number(draft.monthlyRequestLimit) : null,
      },
    }), `تم حفظ سياسة ${PROVIDER_ACCESS_LABELS[provider]}.`);
  };

  const saveProfile = () => {
    if (!userId) return;
    void run('profile', () => updateAdminUserAccess({ userId, role, isActive }), 'تم تحديث دور المستخدم وحالة الحساب.')
      .then(() => onProfileUpdated?.());
  };

  const createCredential = () => {
    if (!credentialLabel.trim() || !credentialKeys.trim()) {
      setError('أدخل اسمًا داخليًا ومفتاحًا واحدًا على الأقل.');
      return;
    }
    void run('credential:new', () => saveAdminSharedCredential({
      userId,
      provider: credentialProvider,
      purpose: credentialPurpose,
      label: credentialLabel.trim(),
      apiKeys: credentialKeys,
      ...(credentialScope === 'unassigned' ? {} : { scope: credentialScope }),
      expiresAt: credentialExpiry ? new Date(`${credentialExpiry}T23:59:59`).toISOString() : null,
    }), credentialScope === 'unassigned'
      ? 'تم تشفير مجموعة المفاتيح وحفظها دون تعيين. لن تستخدم حتى يعيّنها المسؤول.'
      : 'تم تشفير مجموعة المفاتيح وحفظها وتعيينها بنجاح.').then(() => {
      setCredentialLabel('');
      setCredentialKeys('');
      setCredentialExpiry('');
      setShowCredentialKeys(false);
    });
  };

  const relevantCredentials = useMemo(() => overview?.credentials || [], [overview]);

  if (isLoading) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 text-sm font-bold text-gray-500 dark:text-gray-300">
        <LoaderCircle size={18} className="animate-spin" />
        <span>جاري تحميل الصلاحيات والمفاتيح المعيّنة...</span>
      </div>
    );
  }

  if (!overview || !drafts) {
    return <div className="text-sm font-bold text-red-700 dark:text-red-300">{error || 'تعذر تحميل الصلاحيات.'}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[#d4af37]/40 bg-[#d4af37]/10 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck className="mt-0.5 shrink-0 text-[#a78318]" size={21} />
          <div>
            <div className="text-sm font-black text-gray-800 dark:text-gray-100">
              {isUserScope ? 'سياسة المستخدم الفعلية' : 'السياسة العامة لجميع المستخدمين'}
            </div>
            <p className="mt-1 text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
              هذه الشاشة هي المكان الإداري الوحيد لحفظ مفاتيح Gemini وOpenAI وFirecrawl وBrowserless وتعيينها. المنع العام يتغلّب دائمًا على تخصيص المستخدم، ولا تُعرض قيمة أي مفتاح بعد الحفظ.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={Boolean(busyKey)}
          className="inline-flex items-center gap-2 rounded-md border border-[#d4af37]/50 bg-white px-3 py-2 text-xs font-black text-[#8a6f1d] disabled:opacity-50 dark:bg-[#242424] dark:text-[#f2d675]"
        >
          <RefreshCw size={15} /> تحديث
        </button>
      </div>

      {!overview.schemaAvailable && (
        <div className="border-r-4 border-amber-500 bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          يجب تطبيق ترحيل صلاحيات المزودات على قاعدة البيانات قبل الحفظ.
        </div>
      )}
      {!overview.encryptionConfigured && (
        <div className="border-r-4 border-red-500 bg-red-50 p-3 text-sm font-bold text-red-800 dark:bg-red-950/30 dark:text-red-200">
          مفتاح تشفير البنية الخاص بخزنة المزودات غير مهيأ في بيئة الخادم.
        </div>
      )}
      {error && <div className="rounded-md bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {message && <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm font-bold text-green-700 dark:bg-green-950/30 dark:text-green-300"><CheckCircle2 size={17} />{message}</div>}

      {isUserScope && overview.profile && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
          <div className="mb-3 flex items-center gap-2 text-sm font-black text-gray-800 dark:text-gray-100">
            <UserCog size={18} className="text-[#b8922e]" /> الدور وحالة الدخول
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
              <span className="mb-2 block">الدور</span>
              <select value={role} onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'user')} className={inputClass}>
                <option value="user">مستخدم</option>
                <option value="admin">مسؤول شامل</option>
              </select>
            </label>
            <Toggle label="الحساب نشط ويسمح له بالدخول" checked={isActive} onChange={setIsActive} />
            <button
              type="button"
              onClick={saveProfile}
              disabled={busyKey === 'profile'}
              className="self-end rounded-md bg-[#d4af37] px-4 py-2 text-sm font-black text-white disabled:opacity-50"
            >
              {busyKey === 'profile' ? 'جار الحفظ...' : 'حفظ الحساب'}
            </button>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-base font-black text-gray-800 dark:text-gray-100">صلاحيات المزودات والحصص</h3>
        {PROVIDER_ACCESS_PROVIDERS.map(provider => {
          const draft = drafts[provider];
          const effective = overview.effectivePolicies[provider];
          const usage = overview.usage[provider];
          const busy = busyKey === `policy:${provider}`;
          return (
            <div key={provider} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-black text-gray-800 dark:text-gray-100">{PROVIDER_ACCESS_LABELS[provider]}</div>
                  <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                    الاستخدام: {usage.dailyUsed} اليوم / {usage.monthlyUsed} هذا الشهر
                    {isUserScope && effective.customizedForUser ? ' · سياسة مخصصة' : ''}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-black ${effective.enabled ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'}`}>
                  {effective.enabled ? 'مسموح' : 'ممنوع'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Toggle label="السماح بهذا المزود" checked={draft.enabled} onChange={value => updateDraft(provider, 'enabled', value)} disabled={busy} />
                <Toggle label="السماح بالمفاتيح الشخصية" checked={draft.allowPersonalKeys} onChange={value => updateDraft(provider, 'allowPersonalKeys', value)} disabled={busy} />
                <Toggle label="السماح بالمفاتيح المشتركة والاحتياطية" checked={draft.allowSharedFallback} onChange={value => updateDraft(provider, 'allowSharedFallback', value)} disabled={busy} />
                <Toggle label="السماح بالانتقال إلى مزود آخر عند الفشل" checked={draft.allowProviderFallback} onChange={value => updateDraft(provider, 'allowProviderFallback', value)} disabled={busy} />
                <label className="text-xs font-bold text-gray-600 dark:text-gray-300 md:col-span-2">
                  <span className="mb-2 block">ترتيب مصادر المفاتيح</span>
                  <select value={draft.credentialMode} onChange={event => updateDraft(provider, 'credentialMode', event.target.value as ProviderCredentialMode)} className={inputClass} disabled={busy}>
                    {PROVIDER_CREDENTIAL_MODES.map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
                  </select>
                </label>
                <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
                  <span className="mb-2 block">الحد اليومي للطلبات (فارغ = بلا حد إضافي)</span>
                  <input type="number" min="1" value={draft.dailyRequestLimit} onChange={event => updateDraft(provider, 'dailyRequestLimit', event.target.value)} className={inputClass} disabled={busy} />
                </label>
                <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
                  <span className="mb-2 block">الحد الشهري للطلبات</span>
                  <input type="number" min="1" value={draft.monthlyRequestLimit} onChange={event => updateDraft(provider, 'monthlyRequestLimit', event.target.value)} className={inputClass} disabled={busy} />
                </label>
                {(provider === 'gemini_free' || provider === 'gemini_paid' || provider === 'openai') && (
                  <>
                    <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
                      <span className="mb-2 block">الموديل الافتراضي (اختياري)</span>
                      <input dir="ltr" value={draft.defaultModel} onChange={event => updateDraft(provider, 'defaultModel', event.target.value)} className={inputClass} disabled={busy} />
                    </label>
                    <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
                      <span className="mb-2 block">الموديلات المسموحة، مفصولة بفاصلة</span>
                      <input dir="ltr" value={draft.allowedModels} onChange={event => updateDraft(provider, 'allowedModels', event.target.value)} className={inputClass} disabled={busy} />
                    </label>
                  </>
                )}
              </div>
              <div className="mt-3 flex justify-end">
                <button type="button" onClick={() => savePolicy(provider)} disabled={busy || !overview.schemaAvailable} className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-black text-white disabled:opacity-50">
                  {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
                  حفظ السياسة
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={19} className="text-[#b8922e]" />
          <div>
            <h3 className="text-base font-black text-gray-800 dark:text-gray-100">إضافة مجموعة مفاتيح مشفّرة</h3>
            <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">احفظ المفتاح أولًا ثم اختر من يمكنه استخدامه. الحفظ دون تعيين هو الخيار الآمن الافتراضي، ويمكن لاحقًا تعيينه لمستخدم محدد أو للجميع دون نسخ السر.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <select value={credentialProvider} onChange={event => {
            const provider = event.target.value as ProviderAccessProvider;
            setCredentialProvider(provider);
            if (provider === 'firecrawl' || provider === 'browserless') setCredentialPurpose('default');
          }} className={inputClass}>
            {PROVIDER_ACCESS_PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_ACCESS_LABELS[provider]}</option>)}
          </select>
          <input value={credentialLabel} onChange={event => setCredentialLabel(event.target.value)} placeholder="اسم داخلي، مثل: فريق المحتوى" className={inputClass} />
          <select value={credentialPurpose} onChange={event => setCredentialPurpose(event.target.value === 'content_writing_resume' ? 'content_writing_resume' : 'default')} className={inputClass}>
            <option value="default">{PURPOSE_LABELS.default}</option>
            {credentialProvider !== 'firecrawl' && credentialProvider !== 'browserless' && (
              <option value="content_writing_resume">{PURPOSE_LABELS.content_writing_resume}</option>
            )}
          </select>
          <select value={credentialScope} onChange={event => {
            const scope = event.target.value;
            setCredentialScope(scope === 'user' ? 'user' : scope === 'all' ? 'all' : 'unassigned');
          }} className={inputClass}>
            <option value="unassigned">حفظ دون تعيين — غير قابل للاستخدام</option>
            {isUserScope && <option value="user">تعيين لهذا المستخدم</option>}
            <option value="all">تعيين لجميع المستخدمين</option>
          </select>
          <label className="text-xs font-bold text-gray-600 dark:text-gray-300">
            <span className="mb-1 block">تاريخ الانتهاء (اختياري)</span>
            <input type="date" value={credentialExpiry} onChange={event => setCredentialExpiry(event.target.value)} className={inputClass} />
          </label>
          <div className="relative md:col-span-2">
            <textarea
              value={credentialKeys}
              onChange={event => setCredentialKeys(event.target.value)}
              placeholder="مفتاح واحد أو عدة مفاتيح، كل مفتاح في سطر"
              dir="ltr"
              rows={3}
              autoComplete="new-password"
              spellCheck={false}
              className={`${inputClass} pe-11 ${showCredentialKeys ? '' : 'text-security-disc'}`}
              style={showCredentialKeys ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)}
            />
            <button type="button" onClick={() => setShowCredentialKeys(value => !value)} className="absolute end-2 top-2 p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-100" title={showCredentialKeys ? 'إخفاء' : 'إظهار'}>
              {showCredentialKeys ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={createCredential} disabled={busyKey === 'credential:new' || !overview.encryptionConfigured || !overview.schemaAvailable} className="inline-flex items-center gap-2 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-black text-white disabled:opacity-50">
            {busyKey === 'credential:new' ? <LoaderCircle size={16} className="animate-spin" /> : <KeyRound size={16} />}
            {credentialScope === 'unassigned' ? 'تشفير وحفظ' : 'تشفير وحفظ وتعيين'}
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-base font-black text-gray-800 dark:text-gray-100">مجموعات المفاتيح والتعيينات الحالية</h3>
        {relevantCredentials.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm font-bold text-gray-500 dark:border-[#3C3C3C] dark:text-gray-400">لا توجد مجموعات مشتركة بعد.</div>
        ) : (
          <div className="space-y-3">
            {relevantCredentials.map(credential => {
              const grants = overview.grants.filter(grant => grant.credentialId === credential.id);
              const allGrant = grants.find(grant => grant.scope === 'all');
              const userGrant = userId ? grants.find(grant => grant.scope === 'user' && grant.userId === userId) : undefined;
              return (
                <div key={credential.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-black text-gray-800 dark:text-gray-100">{credential.label}</div>
                      <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                        {PROVIDER_ACCESS_LABELS[credential.provider]} · {PURPOSE_LABELS[credential.purpose]} · {credential.keyCount} مفاتيح · {credential.keySuffixes.map(value => `••••${value}`).join('، ')}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs font-black">
                        {allGrant && <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"><Users size={12} className="me-1 inline" />الجميع</span>}
                        {userGrant && <span className="rounded-full bg-purple-100 px-2 py-1 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300"><UserCog size={12} className="me-1 inline" />هذا المستخدم</span>}
                        {grants.length === 0 && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">غير معيّن — لن يُستخدم</span>}
                        <span className={`rounded-full px-2 py-1 ${credential.enabled ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>{credential.enabled ? 'مفعّل' : 'متوقف'}</span>
                        {credential.expiresAt && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">ينتهي {new Date(credential.expiresAt).toLocaleDateString('ar')}</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {isUserScope && !userGrant && (
                        <button type="button" onClick={() => void run(`grant:${credential.id}:user`, () => saveAdminCredentialGrant({ credentialId: credential.id, scope: 'user', userId }), 'تم تعيين المجموعة للمستخدم.')} className="rounded-md border border-purple-200 px-2 py-1.5 text-xs font-black text-purple-700 dark:border-purple-900 dark:text-purple-300">تعيين للمستخدم</button>
                      )}
                      {!allGrant && (
                        <button type="button" onClick={() => void run(`grant:${credential.id}:all`, () => saveAdminCredentialGrant({ credentialId: credential.id, scope: 'all', userId }), 'تم تعيين المجموعة للجميع.')} className="rounded-md border border-blue-200 px-2 py-1.5 text-xs font-black text-blue-700 dark:border-blue-900 dark:text-blue-300">تعيين للجميع</button>
                      )}
                      {userGrant && (
                        <button type="button" onClick={() => void run(`grant-delete:${userGrant.id}`, () => deleteAdminCredentialGrant(userGrant.id, userId), 'تم إلغاء تعيين المستخدم.')} className="rounded-md border border-gray-200 px-2 py-1.5 text-xs font-black text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">إلغاء تعيين المستخدم</button>
                      )}
                      {allGrant && (
                        <button type="button" onClick={() => void run(`grant-delete:${allGrant.id}`, () => deleteAdminCredentialGrant(allGrant.id, userId), 'تم إلغاء التعيين العام.')} className="rounded-md border border-gray-200 px-2 py-1.5 text-xs font-black text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">إلغاء الجميع</button>
                      )}
                      <button type="button" onClick={() => void run(`credential-toggle:${credential.id}`, () => saveAdminSharedCredential({ id: credential.id, userId, provider: credential.provider, purpose: credential.purpose, label: credential.label, enabled: !credential.enabled }), credential.enabled ? 'تم إيقاف المجموعة.' : 'تم تفعيل المجموعة.')} className="rounded-md border border-gray-200 px-2 py-1.5 text-xs font-black text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300">{credential.enabled ? 'إيقاف' : 'تفعيل'}</button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm('حذف هذه المجموعة يلغي تعيينها من جميع المستخدمين. هل تريد المتابعة؟')) return;
                          void run(`credential-delete:${credential.id}`, () => deleteAdminSharedCredential(credential.id, userId), 'تم حذف مجموعة المفاتيح وتعييناتها.');
                        }}
                        className="rounded-md border border-red-200 p-1.5 text-red-700 dark:border-red-900 dark:text-red-300"
                        title="حذف المجموعة"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminProviderAccessSettings;
