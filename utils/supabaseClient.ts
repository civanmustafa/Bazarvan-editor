import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as any).env || {};

export const supabaseUrl = String(env.VITE_SUPABASE_URL || '').trim();
export const supabaseAnonKey = String(env.VITE_SUPABASE_ANON_KEY || '').trim();

let supabaseClient: SupabaseClient | null = null;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const getSupabaseClient = (): SupabaseClient => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.');
  }

  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return supabaseClient;
};
