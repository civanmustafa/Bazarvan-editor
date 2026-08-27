import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  PROVIDER_ACCESS_LABELS,
  PROVIDER_ACCESS_PROVIDERS,
  type ProviderCredentialMode,
} from '../constants/providerAccessControl.ts';
import {
  loadUserProviderAccess,
  type UserProviderAccessResponse,
} from '../utils/providerAccessControl.ts';

const MODE_LABELS: Record<ProviderCredentialMode, string> = {
  personal_first: 'مفتاحك أولًا ثم المفاتيح المعيّنة',
  assigned_first: 'المفتاح المعيّن أولًا ثم مفتاحك',
  assigned_only: 'المفاتيح التي عيّنها المسؤول فقط',
  personal_only: 'مفاتيحك الشخصية فقط',
  global_only: 'المفاتيح العامة فقط',
  disabled: 'متوقف',
};

const formatLimit = (used: number, limit: number | null): string => (
  limit ? `${used} من ${limit}` : `${used} (بلا حد مخصص)`
);

const UserProviderAccessSummary: React.FC = () => {
  const [overview, setOverview] = useState<UserProviderAccessResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setOverview(await loadUserProviderAccess());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل صلاحيات المزودات.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return <div className="flex min-h-20 items-center justify-center gap-2 text-sm font-bold text-gray-500"><LoaderCircle size={17} className="animate-spin" />جاري تحميل الصلاحيات...</div>;
  }
  if (!overview) {
    return <div className="text-sm font-bold text-red-700 dark:text-red-300">{error || 'تعذر تحميل الصلاحيات.'}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          هذه هي السياسة الفعلية التي يفرضها الخادم على حسابك، وتشمل مصدر المفتاح والحصص. لا يمكن لتفضيلات المتصفح تجاوز منع المسؤول.
        </p>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5 text-xs font-black text-gray-600 dark:border-[#3C3C3C] dark:text-gray-300"><RefreshCw size={14} />تحديث</button>
      </div>
      {error && <div className="text-sm font-bold text-red-700 dark:text-red-300">{error}</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {PROVIDER_ACCESS_PROVIDERS.map(provider => {
          const policy = overview.policies[provider];
          const usage = overview.usage[provider];
          const assignments = overview.assignedCredentials.filter(item => item.provider === provider && item.enabled);
          return (
            <div key={provider} className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-black text-gray-800 dark:text-gray-100">
                  {policy.enabled ? <ShieldCheck size={17} className="text-green-600" /> : <ShieldCheck size={17} className="text-red-500" />}
                  {PROVIDER_ACCESS_LABELS[provider]}
                </div>
                <span className={`rounded-full px-2 py-1 text-[11px] font-black ${policy.enabled ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'}`}>{policy.enabled ? 'مسموح' : 'ممنوع'}</span>
              </div>
              <div className="mt-3 space-y-1 text-xs font-bold text-gray-600 dark:text-gray-300">
                <div>المصادر: {MODE_LABELS[policy.credentialMode]}</div>
                <div>المفاتيح الشخصية: {policy.allowPersonalKeys ? 'مسموحة' : 'غير مسموحة'}</div>
                <div>اليوم: {formatLimit(usage.dailyUsed, policy.dailyRequestLimit)}</div>
                <div>الشهر: {formatLimit(usage.monthlyUsed, policy.monthlyRequestLimit)}</div>
                {policy.defaultModel && <div dir="ltr" className="text-start">Default: {policy.defaultModel}</div>}
              </div>
              {assignments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {assignments.map(assignment => (
                    <span key={`${assignment.id}:${assignment.scope}`} className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-[11px] font-black text-[#8a6f1d] shadow-sm dark:bg-[#2A2A2A] dark:text-[#f2d675]">
                      <KeyRound size={12} />
                      {assignment.label} · {assignment.keyCount} · {assignment.scope === 'all' ? 'للجميع' : 'لحسابك'}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default UserProviderAccessSummary;

