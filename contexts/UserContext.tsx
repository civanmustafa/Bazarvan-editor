
import React, { useState, useCallback, useEffect, createContext, useContext, useMemo, useRef } from 'react';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { recordLogin, getActivityData, saveUserPreference, saveUserClientGoalContexts, saveUserEngineeringPrompts } from '../hooks/useUserActivity';
import { translations } from '../components/translations';
import { DEFAULT_ENGINEERING_PROMPTS, normalizeEngineeringPrompts } from '../constants/engineeringPrompts';
import type { ChatGptOpenMode, ClientGoalContexts, EngineeringPrompts, GoalContext } from '../types';
import { normalizeClientGoalContexts, normalizeGoalContext } from '../utils/goalContext';
import { getSupabaseClient, isSupabaseConfigured } from '../utils/supabaseClient';
import { updateCurrentProfileLastSeen } from '../utils/supabaseArticles';
import { APP_NAVIGATION_EVENT, getRouteView, navigateToAppPath, parseAppRoute } from '../utils/appRoutes';
import { endAppSession, ensureAppSession, recordAppActivity, recordPathActivityIfChanged } from '../utils/appActivity';
import { createLegacyUserPreferences, type UserPreferencesPatch } from '../constants/settingsRegistry';
import {
    clearLegacyGeminiModelPreferences,
    hydrateGeminiModelPreferences,
    readLegacyGeminiModelPreferences,
    resetGeminiModelPreferences,
} from '../utils/geminiModelPreference';
import {
    hydrateCurrentUserPreferences,
    resetUserPreferencesCache,
    saveCurrentUserPreferencesPatch,
} from '../utils/userPreferences';

/*
 * UserContext is the owner of session-level app state:
 * login/logout, selected screen, theme, UI language, article language preference,
 * server-only AI API mode, saved client goal contexts, and editable engineering prompts.
 *
 * Edit here when adding a user preference or anything that should survive per user.
 * Durable preferences use Supabase; hooks/useUserActivity.ts remains a local startup cache.
 */
type UserRole = 'admin' | 'user';
type AppView = 'login' | 'dashboard' | 'editor' | 'admin' | 'settings' | 'notFound';
type Profile = {
    id: string;
    email: string | null;
    full_name: string | null;
    role: UserRole;
};

interface UserContextType {
    currentUser: string | null;
    currentUserId: string | null;
    currentUserRole: UserRole;
    currentView: AppView;
    isAuthLoading: boolean;
    isDarkMode: boolean;
    setIsDarkMode: React.Dispatch<React.SetStateAction<boolean>>;
    highlightStyle: 'background' | 'underline';
    chatGptOpenMode: ChatGptOpenMode;
    keywordViewMode: 'classic' | 'modern';
    structureViewMode: 'grid' | 'list';
    preferredLanguage: 'ar' | 'en';
    uiLanguage: 'ar' | 'en';
    clientGoalContexts: ClientGoalContexts;
    engineeringPrompts: EngineeringPrompts;
    t: typeof translations.ar;
    isIdle: boolean;
    handleLogin: (username: string, password: string) => Promise<boolean>;
    handleLogout: () => Promise<void>;
    setCurrentView: React.Dispatch<React.SetStateAction<AppView>>;
    handleHighlightStyleChange: (style: 'background' | 'underline') => void;
    handleChatGptOpenModeChange: (mode: ChatGptOpenMode) => void;
    handleKeywordViewModeChange: (mode: 'classic' | 'modern') => void;
    handleStructureViewModeChange: (mode: 'grid' | 'list') => void;
    handlePreferredLanguageChange: (lang: 'ar' | 'en') => void;
    handleUiLanguageChange: (lang: 'ar' | 'en') => void;
    handleSaveClientGoalContext: (companyName: string, goalContext: GoalContext) => void;
    handleDeleteClientGoalContext: (companyName: string) => void;
    handleMergeClientGoalContexts: (contexts: ClientGoalContexts) => void;
    handleSaveEngineeringPrompts: (prompts: EngineeringPrompts) => void;
}

const UserContext = createContext<UserContextType | null>(null);

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) throw new Error("useUser must be used within a UserProvider");
  return context;
};

const getStoredSessionUser = (): string | null => {
    try {
        return sessionStorage.getItem('currentUser');
    } catch (error) {
        console.error("Could not read current user from sessionStorage:", error);
        return null;
    }
};

const getStoredSessionView = (): Exclude<AppView, 'login'> => {
    try {
        const savedView = sessionStorage.getItem('currentView');
        return savedView === 'editor' ||
            savedView === 'dashboard' ||
            savedView === 'admin' ||
            savedView === 'settings' ||
            savedView === 'notFound'
            ? savedView
            : 'dashboard';
    } catch (error) {
        console.error("Could not read current view from sessionStorage:", error);
        return 'dashboard';
    }
};

const getViewPath = (view: AppView): string | null => {
    switch (view) {
        case 'dashboard':
            return '/dashboard';
        case 'editor':
            return '/editor';
        case 'admin':
            return '/admin';
        case 'settings':
            return '/settings';
        case 'notFound':
        case 'login':
        default:
            return null;
    }
};

const getInitialTheme = () => {
    try {
      const user = getStoredSessionUser();
      if (user) {
          const data = getActivityData();
          const userPrefs = data[user];
          if (userPrefs?.preferredTheme) {
              return userPrefs.preferredTheme === 'dark';
          }
      }
      const savedTheme = localStorage.getItem('editor-theme');
      return savedTheme ? savedTheme === 'dark' : true; // Default dark
    } catch (error) {
      console.error("Could not get initial theme:", error);
      return true;
    }
};

const getProfileLabel = (profile: Profile | null, user: SupabaseUser): string => (
    profile?.full_name?.trim() ||
    profile?.email?.trim() ||
    user.email?.trim() ||
    user.id
);

const ensureUserProfile = async (user: SupabaseUser): Promise<Profile | null> => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
        .from('profiles')
        .select('id,email,full_name,role')
        .eq('id', user.id)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (data) {
        return {
            id: data.id,
            email: data.email,
            full_name: data.full_name,
            role: data.role === 'admin' ? 'admin' : 'user',
        };
    }

    const { data: insertedProfile, error: insertError } = await supabase
        .from('profiles')
        .insert({
            id: user.id,
            email: user.email,
            full_name: user.user_metadata?.full_name || user.user_metadata?.name || null,
            role: 'user',
        })
        .select('id,email,full_name,role')
        .single();

    if (insertError) {
        throw insertError;
    }

    return insertedProfile
        ? {
            id: insertedProfile.id,
            email: insertedProfile.email,
            full_name: insertedProfile.full_name,
            role: insertedProfile.role === 'admin' ? 'admin' : 'user',
        }
        : null;
};

export const UserProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Screen-level state. AppContent in App.tsx reads currentView to choose the visible page.
    const [currentUser, setCurrentUser] = useState<string | null>(null);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    const [currentUserRole, setCurrentUserRole] = useState<UserRole>('user');
    const [currentView, setCurrentViewState] = useState<AppView>('login');
    const [isAuthLoading, setIsAuthLoading] = useState(true);
    const [isDarkMode, setIsDarkMode] = useState(getInitialTheme);
    const [highlightStyle, setHighlightStyle] = useState<'background' | 'underline'>('background');
    const [chatGptOpenMode, setChatGptOpenMode] = useState<ChatGptOpenMode>('window');
    const [keywordViewMode, setKeywordViewMode] = useState<'classic' | 'modern'>('classic');
    const [structureViewMode, setStructureViewMode] = useState<'grid' | 'list'>('grid');
    const [preferredLanguage, setPreferredLanguage] = useState<'ar' | 'en'>('ar');
    const [uiLanguage, setUiLanguage] = useState<'ar' | 'en'>('ar');
    const [clientGoalContexts, setClientGoalContexts] = useState<ClientGoalContexts>({});
    const [engineeringPrompts, setEngineeringPrompts] = useState<EngineeringPrompts>(() => normalizeEngineeringPrompts(DEFAULT_ENGINEERING_PROMPTS));
    const [preferencesReadyUserId, setPreferencesReadyUserId] = useState<string | null>(null);
    
    const [isIdle, setIsIdle] = useState(false);
    const idleTimerRef = useRef<number | null>(null);
    const hiddenTimerRef = useRef<number | null>(null);
    const isIdleRef = useRef(false);
    const currentViewRef = useRef<AppView>('login');
    const sessionUserIdRef = useRef<string | null>(null);

    const t = translations[uiLanguage] || translations.ar;

    const applyAuthenticatedUser = useCallback(async (
        user: SupabaseUser | null,
        options: { recordLoginActivity?: boolean } = {},
    ): Promise<string | null> => {
        if (!user) {
            setPreferencesReadyUserId(null);
            resetUserPreferencesCache();
            resetGeminiModelPreferences();
            setCurrentUser(null);
            setCurrentUserId(null);
            setCurrentUserRole('user');
            setClientGoalContexts({});
            setEngineeringPrompts(normalizeEngineeringPrompts(DEFAULT_ENGINEERING_PROMPTS));
            try {
                sessionStorage.removeItem('currentUser');
                sessionStorage.removeItem('currentUserId');
                sessionStorage.removeItem('currentView');
            } catch (error) {
                console.error("Could not clear Supabase session mirror:", error);
            }
            setCurrentViewState('login');
            return null;
        }

        const profile = await ensureUserProfile(user);
        const label = getProfileLabel(profile, user);
        setCurrentUser(label);
        setCurrentUserId(user.id);
        setCurrentUserRole(profile?.role === 'admin' ? 'admin' : 'user');
        try {
            sessionStorage.setItem('currentUser', label);
            sessionStorage.setItem('currentUserId', user.id);
            sessionStorage.setItem('currentView', getRouteView(parseAppRoute()));
        } catch (error) {
            console.error("Could not mirror Supabase session to sessionStorage:", error);
        }
        if (options.recordLoginActivity) {
            recordLogin(label);
        }
        setCurrentViewState(getRouteView(parseAppRoute()));
        return label;
    }, []);

    useEffect(() => {
        currentViewRef.current = currentView;
    }, [currentView]);

    const setCurrentView = useCallback<React.Dispatch<React.SetStateAction<AppView>>>((value) => {
        const nextView = typeof value === 'function'
            ? value(currentViewRef.current)
            : value;
        const nextPath = getViewPath(nextView);
        if (nextPath) {
            navigateToAppPath(nextPath);
        }
        setCurrentViewState(nextView);
    }, []);

    useEffect(() => {
        const syncViewFromRoute = () => {
            setCurrentViewState(currentUser ? getRouteView(parseAppRoute()) : 'login');
        };

        window.addEventListener('popstate', syncViewFromRoute);
        window.addEventListener(APP_NAVIGATION_EVENT, syncViewFromRoute);
        return () => {
            window.removeEventListener('popstate', syncViewFromRoute);
            window.removeEventListener(APP_NAVIGATION_EVENT, syncViewFromRoute);
        };
    }, [currentUser]);

    useEffect(() => {
        if (!isSupabaseConfigured) {
            setIsAuthLoading(false);
            return;
        }

        let cancelled = false;
        const supabase = getSupabaseClient();

        supabase.auth.getSession()
            .then(async ({ data }) => {
                if (cancelled) return;
                await applyAuthenticatedUser(data.session?.user ?? null);
            })
            .catch(error => {
                console.error('Failed to restore Supabase session:', error);
                if (!cancelled) {
                    void applyAuthenticatedUser(null);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsAuthLoading(false);
                }
            });

        const { data: subscriptionData } = supabase.auth.onAuthStateChange((_event, session) => {
            void applyAuthenticatedUser(session?.user ?? null).catch(error => {
                console.error('Failed to apply Supabase auth change:', error);
            });
        });

        return () => {
            cancelled = true;
            subscriptionData.subscription.unsubscribe();
        };
    }, [applyAuthenticatedUser]);

    useEffect(() => {
        document.documentElement.lang = uiLanguage;
        document.documentElement.dir = uiLanguage === 'ar' ? 'rtl' : 'ltr';
        document.title = t.appTitle;
    }, [uiLanguage, t]);

    useEffect(() => {
        try {
            if (currentUser && currentView !== 'login') {
                sessionStorage.setItem('currentView', currentView);
                if (currentUserId) {
                    sessionStorage.setItem('currentUserId', currentUserId);
                }
            } else {
                sessionStorage.removeItem('currentView');
                sessionStorage.removeItem('currentUserId');
            }
        } catch (error) {
            console.error("Could not persist current view to sessionStorage:", error);
        }
    }, [currentUser, currentUserId, currentView]);
    
    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        const theme = isDarkMode ? 'dark' : 'light';
        if (currentUser) {
            saveUserPreference(currentUser, { preferredTheme: theme });
        }
        if (currentUserId && preferencesReadyUserId === currentUserId) {
            void saveCurrentUserPreferencesPatch({
                appearance: { theme },
            }).catch(error => {
                console.error('Failed to save theme preference to Supabase:', error);
            });
        }
        try {
            localStorage.setItem('editor-theme', theme);
        } catch (error) {
            console.error("Could not save theme to localStorage:", error);
        }
    }, [isDarkMode, currentUser, currentUserId, preferencesReadyUserId]);

     // Idle tracking feeds EditorContext time tracking so inactive tabs do not inflate article time.
     useEffect(() => {
        if (currentView !== 'editor') {
            isIdleRef.current = true;
            setIsIdle(true);
            if (idleTimerRef.current) {
                clearTimeout(idleTimerRef.current);
                idleTimerRef.current = null;
            }
            if (hiddenTimerRef.current) {
                clearTimeout(hiddenTimerRef.current);
                hiddenTimerRef.current = null;
            }
            return;
        }
        
        const IDLE_TIMEOUT = 2 * 60 * 1000;
        const HIDDEN_IDLE_GRACE_MS = 5 * 1000;

        const setIdleState = (nextIsIdle: boolean) => {
            if (isIdleRef.current === nextIsIdle) return;
            isIdleRef.current = nextIsIdle;
            setIsIdle(nextIsIdle);
        };

        const clearIdleTimer = () => {
            if (idleTimerRef.current) {
                clearTimeout(idleTimerRef.current);
                idleTimerRef.current = null;
            }
        };

        const clearHiddenTimer = () => {
            if (hiddenTimerRef.current) {
                clearTimeout(hiddenTimerRef.current);
                hiddenTimerRef.current = null;
            }
        };

        const handleUserActivity = () => {
            if (document.hidden) return;

            clearHiddenTimer();
            setIdleState(false);
            clearIdleTimer();

            idleTimerRef.current = window.setTimeout(() => {
                setIdleState(true);
            }, IDLE_TIMEOUT);
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                clearIdleTimer();
                clearHiddenTimer();
                hiddenTimerRef.current = window.setTimeout(() => {
                    if (document.hidden) {
                        setIdleState(true);
                    }
                }, HIDDEN_IDLE_GRACE_MS);
            } else {
                handleUserActivity();
            }
        };

        const handleWindowFocus = () => {
            handleUserActivity();
        };

        const handleWindowBlur = () => {
            if (!document.hidden) return;
            handleVisibilityChange();
        };

        handleUserActivity();

        const events: (keyof WindowEventMap)[] = ['mousemove', 'pointermove', 'keydown', 'mousedown', 'pointerdown', 'click', 'scroll', 'wheel', 'touchstart'];
        events.forEach(event => window.addEventListener(event, handleUserActivity, { passive: true }));
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('blur', handleWindowBlur);
        document.addEventListener('selectionchange', handleUserActivity);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            clearIdleTimer();
            clearHiddenTimer();
            events.forEach(event => window.removeEventListener(event, handleUserActivity));
            window.removeEventListener('focus', handleWindowFocus);
            window.removeEventListener('blur', handleWindowBlur);
            document.removeEventListener('selectionchange', handleUserActivity);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [currentUser, currentView]);

    useEffect(() => {
        if (!currentUserId || !isSupabaseConfigured) return;

        const recordLastSeen = () => {
            void updateCurrentProfileLastSeen(currentUserId).catch(error => {
                console.error('Failed to update profile last_seen_at:', error);
            });
        };

        recordLastSeen();
        const intervalId = window.setInterval(recordLastSeen, 10 * 60 * 1000);
        return () => window.clearInterval(intervalId);
    }, [currentUserId]);

    useEffect(() => {
        if (!currentUserId || !isSupabaseConfigured) {
            sessionUserIdRef.current = null;
            return;
        }

        if (sessionUserIdRef.current === currentUserId) return;
        sessionUserIdRef.current = currentUserId;

        void ensureAppSession(currentUserId)
            .then(() => recordAppActivity(currentUserId, {
                eventType: 'session_start',
                path: window.location.pathname,
            }))
            .catch(error => {
                console.error('Failed to start tracked app session:', error);
            });
    }, [currentUserId]);

    useEffect(() => {
        if (!currentUserId || !isSupabaseConfigured) return;

        const recordRoute = () => {
            void ensureAppSession(currentUserId)
                .then(() => recordPathActivityIfChanged(currentUserId, window.location.pathname))
                .catch(error => {
                    console.error('Failed to record route activity:', error);
                });
        };

        recordRoute();
        window.addEventListener('popstate', recordRoute);
        window.addEventListener(APP_NAVIGATION_EVENT, recordRoute);
        return () => {
            window.removeEventListener('popstate', recordRoute);
            window.removeEventListener(APP_NAVIGATION_EVENT, recordRoute);
        };
    }, [currentUserId]);

    // Supabase is authoritative. Existing browser values are imported once, then kept as a startup cache.
    useEffect(() => {
        if (!currentUser || !currentUserId) return;
        let cancelled = false;
        setPreferencesReadyUserId(null);

        const activity = getActivityData()[currentUser];
        const legacyPreferences = createLegacyUserPreferences(
            activity,
            readLegacyGeminiModelPreferences(),
        );

        const applyPreferences = (preferences: typeof legacyPreferences) => {
            if (cancelled) return;
            setHighlightStyle(preferences.appearance.highlightStyle);
            setChatGptOpenMode(preferences.editor.chatGptOpenMode);
            setKeywordViewMode(preferences.appearance.keywordViewMode);
            setStructureViewMode(preferences.appearance.structureViewMode);
            setPreferredLanguage(preferences.editor.preferredLanguage);
            setUiLanguage(preferences.editor.uiLanguage);
            setIsDarkMode(preferences.appearance.theme === 'dark');
            hydrateGeminiModelPreferences(preferences.ai);

            const normalizedContexts = normalizeClientGoalContexts(preferences.clientGoalContexts);
            const normalizedPrompts = normalizeEngineeringPrompts(
                preferences.engineeringPrompts as unknown as Partial<EngineeringPrompts>,
            );
            setClientGoalContexts(normalizedContexts);
            setEngineeringPrompts(normalizedPrompts);

            // Temporary local mirror keeps first paint and offline startup fast.
            saveUserPreference(currentUser, {
                preferredHighlightStyle: preferences.appearance.highlightStyle,
                preferredKeywordViewMode: preferences.appearance.keywordViewMode,
                preferredStructureViewMode: preferences.appearance.structureViewMode,
                preferredChatGptOpenMode: preferences.editor.chatGptOpenMode,
                preferredTheme: preferences.appearance.theme,
                preferredLanguage: preferences.editor.preferredLanguage,
                preferredUILanguage: preferences.editor.uiLanguage,
            });
            saveUserClientGoalContexts(currentUser, normalizedContexts);
            saveUserEngineeringPrompts(currentUser, normalizedPrompts);
            setPreferencesReadyUserId(currentUserId);
        };

        void hydrateCurrentUserPreferences(currentUserId, legacyPreferences)
            .then(result => {
                applyPreferences(result.preferences);
                if (result.persistedOnline) clearLegacyGeminiModelPreferences();
            })
            .catch(error => {
                console.error('Failed to load user preferences from Supabase:', error);
                applyPreferences(legacyPreferences);
            });

        return () => {
            cancelled = true;
        };
    }, [currentUser, currentUserId]);

    const handleLogin = useCallback(async (username: string, password: string): Promise<boolean> => {
        if (!isSupabaseConfigured) {
            console.error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.');
            return false;
        }

        const trimmedEmail = username.trim();
        const trimmedPassword = password.trim();
        if (!trimmedEmail || !trimmedPassword) return false;

        const supabase = getSupabaseClient();
        const { data, error } = await supabase.auth.signInWithPassword({
            email: trimmedEmail,
            password: trimmedPassword,
        });

        if (error || !data.user) {
            if (error) console.error('Supabase login failed:', error);
            return false;
        }

        await applyAuthenticatedUser(data.user, { recordLoginActivity: true });
        return true;
    }, [applyAuthenticatedUser]);

    const handleLogout = useCallback(async () => {
        const userIdForActivity = currentUserId;
        if (userIdForActivity) {
            await recordAppActivity(userIdForActivity, {
                eventType: 'logout',
                path: window.location.pathname,
            }).catch(error => {
                console.error('Failed to record logout activity:', error);
            });
        }
        await endAppSession();
        if (isSupabaseConfigured) {
            const { error } = await getSupabaseClient().auth.signOut();
            if (error) {
                console.error('Supabase logout failed:', error);
            }
        }
        await applyAuthenticatedUser(null);
    }, [applyAuthenticatedUser, currentUserId]);

    const persistUserPreferencePatch = useCallback((patch: UserPreferencesPatch) => {
        if (!currentUserId || preferencesReadyUserId !== currentUserId) return;
        void saveCurrentUserPreferencesPatch(patch).catch(error => {
            console.error('Failed to save user preferences to Supabase:', error);
        });
    }, [currentUserId, preferencesReadyUserId]);
    
    const handleHighlightStyleChange = useCallback((style: 'background' | 'underline') => {
        setHighlightStyle(style);
        if (currentUser) saveUserPreference(currentUser, { preferredHighlightStyle: style });
        persistUserPreferencePatch({ appearance: { highlightStyle: style } });
    }, [currentUser, persistUserPreferencePatch]);

    const handleChatGptOpenModeChange = useCallback((mode: ChatGptOpenMode) => {
        setChatGptOpenMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredChatGptOpenMode: mode });
        persistUserPreferencePatch({ editor: { chatGptOpenMode: mode } });
    }, [currentUser, persistUserPreferencePatch]);

    const handleKeywordViewModeChange = useCallback((mode: 'classic' | 'modern') => {
        setKeywordViewMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredKeywordViewMode: mode });
        persistUserPreferencePatch({ appearance: { keywordViewMode: mode } });
    }, [currentUser, persistUserPreferencePatch]);

    const handleStructureViewModeChange = useCallback((mode: 'grid' | 'list') => {
        setStructureViewMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredStructureViewMode: mode });
        persistUserPreferencePatch({ appearance: { structureViewMode: mode } });
    }, [currentUser, persistUserPreferencePatch]);

    const handlePreferredLanguageChange = useCallback((lang: 'ar' | 'en') => {
        setPreferredLanguage(lang);
        if (currentUser) saveUserPreference(currentUser, { preferredLanguage: lang });
        persistUserPreferencePatch({ editor: { preferredLanguage: lang } });
    }, [currentUser, persistUserPreferencePatch]);

    const handleUiLanguageChange = useCallback((lang: 'ar' | 'en') => {
        setUiLanguage(lang);
        if (currentUser) saveUserPreference(currentUser, { preferredUILanguage: lang });
        persistUserPreferencePatch({ editor: { uiLanguage: lang } });
    }, [currentUser, persistUserPreferencePatch]);

    const persistClientGoalContexts = useCallback((nextContexts: ClientGoalContexts) => {
        const normalizedContexts = normalizeClientGoalContexts(nextContexts);
        setClientGoalContexts(normalizedContexts);
        if (currentUser) saveUserClientGoalContexts(currentUser, normalizedContexts);
        persistUserPreferencePatch({
            clientGoalContexts: normalizedContexts as unknown as Record<string, unknown>,
        });
    }, [currentUser, persistUserPreferencePatch]);

    const handleSaveClientGoalContext = useCallback((companyName: string, context: GoalContext) => {
        const normalizedCompanyName = companyName.trim();
        if (!normalizedCompanyName) return;
        persistClientGoalContexts({
            ...clientGoalContexts,
            [normalizedCompanyName]: normalizeGoalContext(context),
        });
    }, [clientGoalContexts, persistClientGoalContexts]);

    const handleDeleteClientGoalContext = useCallback((companyName: string) => {
        const normalizedCompanyName = companyName.trim();
        if (!normalizedCompanyName || !clientGoalContexts[normalizedCompanyName]) return;
        const nextContexts = { ...clientGoalContexts };
        delete nextContexts[normalizedCompanyName];
        persistClientGoalContexts(nextContexts);
    }, [clientGoalContexts, persistClientGoalContexts]);

    const handleMergeClientGoalContexts = useCallback((contexts: ClientGoalContexts) => {
        persistClientGoalContexts({
            ...clientGoalContexts,
            ...normalizeClientGoalContexts(contexts),
        });
    }, [clientGoalContexts, persistClientGoalContexts]);

    const handleSaveEngineeringPrompts = useCallback((prompts: EngineeringPrompts) => {
        const normalizedPrompts = normalizeEngineeringPrompts(prompts);
        setEngineeringPrompts(normalizedPrompts);
        if (currentUser) saveUserEngineeringPrompts(currentUser, normalizedPrompts);
        persistUserPreferencePatch({
            engineeringPrompts: normalizedPrompts as unknown as Record<string, unknown>,
        });
    }, [currentUser, persistUserPreferencePatch]);

    const value = useMemo<UserContextType>(() => ({
        currentUser,
        currentUserId,
        currentUserRole,
        currentView,
        isAuthLoading,
        isDarkMode,
        setIsDarkMode,
        highlightStyle,
        chatGptOpenMode,
        keywordViewMode,
        structureViewMode,
        preferredLanguage,
        uiLanguage,
        clientGoalContexts,
        engineeringPrompts,
        t,
        isIdle,
        handleLogin,
        handleLogout,
        setCurrentView,
        handleHighlightStyleChange,
        handleChatGptOpenModeChange,
        handleKeywordViewModeChange,
        handleStructureViewModeChange,
        handlePreferredLanguageChange,
        handleUiLanguageChange,
        handleSaveClientGoalContext,
        handleDeleteClientGoalContext,
        handleMergeClientGoalContexts,
        handleSaveEngineeringPrompts,
    }), [
        currentUser,
        currentUserId,
        currentUserRole,
        currentView,
        isAuthLoading,
        isDarkMode,
        highlightStyle,
        chatGptOpenMode,
        keywordViewMode,
        structureViewMode,
        preferredLanguage,
        uiLanguage,
        clientGoalContexts,
        engineeringPrompts,
        t,
        isIdle,
        handleLogin,
        handleLogout,
        setCurrentView,
        handleHighlightStyleChange,
        handleChatGptOpenModeChange,
        handleKeywordViewModeChange,
        handleStructureViewModeChange,
        handlePreferredLanguageChange,
        handleUiLanguageChange,
        handleSaveClientGoalContext,
        handleDeleteClientGoalContext,
        handleMergeClientGoalContexts,
        handleSaveEngineeringPrompts,
    ]);

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};
