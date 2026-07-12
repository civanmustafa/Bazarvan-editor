import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type GeminiKeyProvider = 'gemini' | 'geminiPaid';
export type GeminiKeyFailureReason = 'quota' | 'auth' | 'server' | 'blocked' | 'unknown';
export type GeminiKeyOutcome = 'success' | 'failed' | 'cancelled';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

export type GeminiApiKeyLease = {
  apiKey: string;
  fingerprint: string;
  suffix: string;
  source: 'supabase' | 'memory';
  complete: (options: {
    outcome: GeminiKeyOutcome;
    status?: number;
    reason?: GeminiKeyFailureReason | 'cancelled';
    cooldownSeconds?: number;
  }) => Promise<void>;
};

type KeyMetadata = {
  apiKey: string;
  fingerprint: string;
  suffix: string;
  position: number;
};

type LocalKeyState = {
  selectionCount: number;
  lastSelectedAt: number;
  leaseOwner: string;
  leaseExpiresAt: number;
  disabled: boolean;
};

const localKeyStates = new Map<string, LocalKeyState>();
const localModelCooldowns = new Map<string, number>();
const syncedProviderSignatures = new Map<GeminiKeyProvider, string>();
let supabaseAdmin: SupabaseAdmin | null | undefined;
let lastCoordinatorWarning = '';
let lastCoordinatorWarningAt = 0;

export const createGeminiApiKeyFingerprint = (key: string): string => (
  createHash('sha256').update(key.trim()).digest('hex')
);

export const getGeminiApiKeySuffix = (key: string): string => key.trim().slice(-4);

export const getGeminiKeyFailureCooldownSeconds = (
  reason: GeminiKeyFailureReason,
  status?: number,
): number => {
  if (reason === 'quota' || status === 429) return 30 * 60;
  if (reason === 'auth' || status === 401 || status === 403) return 24 * 60 * 60;
  if (reason === 'blocked') return 5 * 60;
  if (reason === 'server' || (status !== undefined && status >= 500)) return 60;
  return 30;
};

const warnCoordinator = (message: string, error?: unknown): void => {
  const detail = error instanceof Error ? error.message : error ? String(error) : '';
  const fullMessage = detail ? `${message}: ${detail}` : message;
  const now = Date.now();
  if (fullMessage === lastCoordinatorWarning && now - lastCoordinatorWarningAt < 60_000) return;
  lastCoordinatorWarning = fullMessage;
  lastCoordinatorWarningAt = now;
  console.warn(`[gemini-key-coordinator] ${fullMessage}`);
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin | null => {
  if (supabaseAdmin !== undefined) return supabaseAdmin;
  const url = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceRoleKey) {
    supabaseAdmin = null;
    return null;
  }
  supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
};

const toMetadata = (keys: string[]): KeyMetadata[] => Array.from(new Set(
  keys.map(key => key.trim()).filter(Boolean),
)).map((apiKey, position) => ({
  apiKey,
  fingerprint: createGeminiApiKeyFingerprint(apiKey),
  suffix: getGeminiApiKeySuffix(apiKey),
  position,
}));

const syncProviderKeys = async (
  supabase: SupabaseAdmin,
  provider: GeminiKeyProvider,
  keys: KeyMetadata[],
): Promise<void> => {
  const signature = keys.map(key => key.fingerprint).join('|');
  if (syncedProviderSignatures.get(provider) === signature) return;
  const { error } = await supabase.rpc('sync_gemini_api_key_pool', {
    p_provider: provider,
    p_keys: keys.map(key => ({
      fingerprint: key.fingerprint,
      suffix: key.suffix,
      position: key.position,
    })),
  });
  if (error) throw error;
  syncedProviderSignatures.set(provider, signature);
};

const localStateKey = (provider: GeminiKeyProvider, fingerprint: string): string => (
  `${provider}:${fingerprint}`
);

const localModelKey = (
  provider: GeminiKeyProvider,
  model: string,
  fingerprint: string,
): string => `${provider}:${model}:${fingerprint}`;

const claimLocalKey = (options: {
  provider: GeminiKeyProvider;
  model: string;
  keys: KeyMetadata[];
  excludedFingerprints: Set<string>;
  leaseOwner: string;
  leaseSeconds: number;
}): GeminiApiKeyLease | null => {
  const now = Date.now();
  const eligible = options.keys
    .filter(key => !options.excludedFingerprints.has(key.fingerprint))
    .filter(key => {
      const state = localKeyStates.get(localStateKey(options.provider, key.fingerprint));
      const cooldownUntil = localModelCooldowns.get(
        localModelKey(options.provider, options.model, key.fingerprint),
      ) || 0;
      return !state?.disabled
        && (!state?.leaseExpiresAt || state.leaseExpiresAt <= now)
        && cooldownUntil <= now;
    })
    .sort((left, right) => {
      const leftState = localKeyStates.get(localStateKey(options.provider, left.fingerprint));
      const rightState = localKeyStates.get(localStateKey(options.provider, right.fingerprint));
      return (leftState?.selectionCount || 0) - (rightState?.selectionCount || 0)
        || (leftState?.lastSelectedAt || 0) - (rightState?.lastSelectedAt || 0)
        || left.position - right.position;
    });
  const selected = eligible[0];
  if (!selected) return null;

  const stateKey = localStateKey(options.provider, selected.fingerprint);
  const previous = localKeyStates.get(stateKey);
  localKeyStates.set(stateKey, {
    selectionCount: (previous?.selectionCount || 0) + 1,
    lastSelectedAt: now,
    leaseOwner: options.leaseOwner,
    leaseExpiresAt: now + options.leaseSeconds * 1_000,
    disabled: previous?.disabled || false,
  });

  let completed = false;
  return {
    apiKey: selected.apiKey,
    fingerprint: selected.fingerprint,
    suffix: selected.suffix,
    source: 'memory',
    complete: async result => {
      if (completed) return;
      completed = true;
      const current = localKeyStates.get(stateKey);
      if (current?.leaseOwner === options.leaseOwner) {
        current.leaseOwner = '';
        current.leaseExpiresAt = 0;
        if (result.outcome === 'failed' && result.reason === 'auth') current.disabled = true;
        localKeyStates.set(stateKey, current);
      }
      if (result.outcome === 'failed' && (result.cooldownSeconds || 0) > 0) {
        localModelCooldowns.set(
          localModelKey(options.provider, options.model, selected.fingerprint),
          Date.now() + (result.cooldownSeconds || 0) * 1_000,
        );
      }
      if (result.outcome === 'success') {
        localModelCooldowns.delete(
          localModelKey(options.provider, options.model, selected.fingerprint),
        );
      }
    },
  };
};

export const claimGeminiApiKey = async (options: {
  provider: GeminiKeyProvider;
  model: string;
  keys: string[];
  excludedFingerprints?: Iterable<string>;
  leaseOwner?: string;
  leaseSeconds?: number;
}): Promise<GeminiApiKeyLease | null> => {
  const keys = toMetadata(options.keys);
  if (keys.length === 0) return null;
  const excludedFingerprints = new Set(options.excludedFingerprints || []);
  const leaseOwner = (options.leaseOwner || `gemini-${randomUUID()}`).slice(0, 200);
  const leaseSeconds = Math.max(30, Math.min(options.leaseSeconds || 180, 600));
  const supabase = getSupabaseAdmin();

  if (supabase) {
    try {
      await syncProviderKeys(supabase, options.provider, keys);
      const { data, error } = await supabase.rpc('claim_gemini_api_key', {
        p_provider: options.provider,
        p_model: options.model,
        p_candidate_fingerprints: keys.map(key => key.fingerprint),
        p_excluded_fingerprints: Array.from(excludedFingerprints),
        p_lease_owner: leaseOwner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.key_fingerprint || !row?.lease_token) return null;
      const selected = keys.find(key => key.fingerprint === String(row.key_fingerprint));
      if (!selected) return null;

      let completed = false;
      return {
        apiKey: selected.apiKey,
        fingerprint: selected.fingerprint,
        suffix: selected.suffix,
        source: 'supabase',
        complete: async result => {
          if (completed) return;
          completed = true;
          try {
            const { error: reportError } = await supabase.rpc('report_gemini_api_key_result', {
              p_provider: options.provider,
              p_model: options.model,
              p_key_fingerprint: selected.fingerprint,
              p_lease_owner: leaseOwner,
              p_lease_token: row.lease_token,
              p_outcome: result.outcome,
              p_status: result.status ?? null,
              p_reason: result.reason ?? null,
              p_cooldown_seconds: result.cooldownSeconds ?? 0,
            });
            if (reportError) throw reportError;
          } catch (error) {
            warnCoordinator('Could not report Gemini key result; the lease will expire automatically', error);
          }
        },
      };
    } catch (error) {
      warnCoordinator('Supabase key coordination is unavailable; using process-local fairness', error);
    }
  }

  return claimLocalKey({
    provider: options.provider,
    model: options.model,
    keys,
    excludedFingerprints,
    leaseOwner,
    leaseSeconds,
  });
};
