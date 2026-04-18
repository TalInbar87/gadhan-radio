import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from './database.types';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  profileError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  async function loadProfile(userId: string) {
    console.log('[auth] loadProfile start', userId);
    setProfileLoading(true);
    setProfileError(null);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (error) {
        console.error('[auth] failed to load profile', error);
        setProfile(null);
        setProfileError(error.message);
      } else {
        console.log('[auth] loadProfile success', { active: data?.active, role: data?.role });
        setProfile(data);
      }
    } catch (e) {
      console.error('[auth] loadProfile threw', e);
      setProfile(null);
      setProfileError((e as Error).message);
    } finally {
      setProfileLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    console.log('[auth] AuthProvider mount — calling getSession');

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        console.log('[auth] getSession resolved, has session:', !!data.session);
        if (cancelled) return;
        setSession(data.session);
        if (data.session) await loadProfile(data.session.user.id);
      } catch (e) {
        console.error('[auth] getSession failed', e);
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      if (newSession) await loadProfile(newSession.user.id);
      else { setProfile(null); setProfileError(null); }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // "loading" = either initial session resolution OR a profile load is in-flight for an active session.
  const loading = sessionLoading || (!!session && profileLoading);

  const value: AuthContextValue = {
    session,
    profile,
    loading,
    profileError,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
    refreshProfile: async () => {
      if (session?.user.id) await loadProfile(session.user.id);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
