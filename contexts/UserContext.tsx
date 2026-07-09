
import React, { useState, useCallback, useEffect, createContext, useContext, useRef } from 'react';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { recordGeminiKeyUsage, recordLogin, getActivityData, saveUserPreference, saveUserApiKeys, saveUserClientGoalContexts, saveUserEngineeringPrompts } from '../hooks/useUserActivity';
import { translations } from '../components/translations';
import { DEFAULT_ENGINEERING_PROMPTS, normalizeEngineeringPrompts } from '../constants/engineeringPrompts';
import type { ChatGptOpenMode, ClientGoalContexts, EngineeringPrompts, GoalContext } from '../types';
import { normalizeClientGoalContexts, normalizeGoalContext } from '../utils/goalContext';
import { getSupabaseClient, isSupabaseConfigured } from '../utils/supabaseClient';
import { updateCurrentProfileLastSeen } from '../utils/supabaseArticles';
import { APP_NAVIGATION_EVENT, getRouteView, navigateToAppPath, parseAppRoute } from '../utils/appRoutes';
import { endAppSession, ensureAppSession, recordAppActivity, recordPathActivityIfChanged } from '../utils/appActivity';

/*
 * UserContext is the owner of session-level app state:
 * login/logout, selected screen, theme, UI language, article language preference,
 * server-only AI API mode, saved client goal contexts, and editable engineering prompts.
 *
 * Edit here when adding a user preference or anything that should survive per user.
 * Persistent writes are delegated to hooks/useUserActivity.ts.
 */
type ApiKeys = { gemini: string[]; geminiPaid: string[]; chatgpt: string[] };
type StoredApiKeys = { gemini?: string | string[]; geminiPaid?: string | string[]; chatgpt?: string | string[]; openai?: string | string[] };
type UserRole = 'admin' | 'user';
type AppView = 'login' | 'dashboard' | 'editor' | 'admin' | 'settings' | 'notFound';
type ApiKeyUsedDetail = {
    keyFingerprint?: unknown;
    keySuffix?: unknown;
    service?: unknown;
    provider?: unknown;
    model?: unknown;
    source?: unknown;
    articleId?: unknown;
    articleTitle?: unknown;
    articleKey?: unknown;
    commandId?: unknown;
    commandLabel?: unknown;
    action?: unknown;
    batchIndex?: unknown;
    batchTotal?: unknown;
    ruleTitle?: unknown;
    rules?: unknown;
    outcome?: unknown;
    status?: unknown;
    reason?: unknown;
    attemptNumber?: unknown;
    keyCount?: unknown;
    attemptedKeyCount?: unknown;
};
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
    apiKeys: ApiKeys;
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
    handleSaveApiKeys: (keys: ApiKeys) => void;
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

const normalizeApiKeys = (_keys?: StoredApiKeys): ApiKeys => ({
    gemini: [],
    geminiPaid: [],
    chatgpt: [],
});

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
    const [apiKeys, setApiKeys] = useState<ApiKeys>(() => normalizeApiKeys());
    const [clientGoalContexts, setClientGoalContexts] = useState<ClientGoalContexts>({});
    const [engineeringPrompts, setEngineeringPrompts] = useState<EngineeringPrompts>(() => normalizeEngineeringPrompts(DEFAULT_ENGINEERING_PROMPTS));
    
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
            setCurrentUser(null);
            setCurrentUserId(null);
            setCurrentUserRole('user');
            setApiKeys(normalizeApiKeys());
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
        const toOptionalString = (value: unknown): string | undefined => (
            typeof value === 'string' && value.trim() ? value.trim() : undefined
        );
        const toOptionalNumber = (value: unknown): number | undefined => (
            typeof value === 'number' && Number.isFinite(value) ? value : undefined
        );

        const handleApiKeyUsed = (event: Event) => {
            if (!currentUser) return;
            const detail = (event as CustomEvent<ApiKeyUsedDetail>).detail || {};
            const keyFingerprint = detail?.keyFingerprint;
            if (typeof keyFingerprint !== 'string' || !keyFingerprint.trim()) return;
            const provider = detail?.provider === 'geminiPaid'
                ? 'geminiPaid'
                : detail?.provider === 'gemini'
                  ? 'gemini'
                  : detail?.provider === 'openai'
                    ? 'openai'
                    : undefined;
            const service = toOptionalString(detail.service) || (provider === 'openai' ? 'openai' : 'gemini');
            const model = toOptionalString(detail.model);

            if (provider === 'gemini' || provider === 'geminiPaid') {
                recordGeminiKeyUsage(currentUser, keyFingerprint, {
                    provider,
                    model,
                });
            }

            if (currentUserId) {
                void recordAppActivity(currentUserId, {
                    eventType: 'api_key_used',
                    entityType: 'api_key',
                    entityId: `${service}:${provider || 'unknown'}:${keyFingerprint.trim()}`,
                    metadata: {
                        service,
                        provider: provider || toOptionalString(detail.provider) || service,
                        model,
                        keyFingerprint: keyFingerprint.trim(),
                        keySuffix: toOptionalString(detail.keySuffix),
                        source: toOptionalString(detail.source) || 'unknown',
                        articleId: toOptionalString(detail.articleId),
                        articleTitle: toOptionalString(detail.articleTitle),
                        articleKey: toOptionalString(detail.articleKey),
                        commandId: toOptionalString(detail.commandId),
                        commandLabel: toOptionalString(detail.commandLabel),
                        action: toOptionalString(detail.action),
                        batchIndex: toOptionalNumber(detail.batchIndex),
                        batchTotal: toOptionalNumber(detail.batchTotal),
                        ruleTitle: toOptionalString(detail.ruleTitle),
                        rules: Array.isArray(detail.rules)
                            ? detail.rules.filter((item): item is string => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, 12)
                            : undefined,
                        outcome: toOptionalString(detail.outcome),
                        status: toOptionalNumber(detail.status),
                        reason: toOptionalString(detail.reason),
                        attemptNumber: toOptionalNumber(detail.attemptNumber),
                        keyCount: toOptionalNumber(detail.keyCount),
                        attemptedKeyCount: toOptionalNumber(detail.attemptedKeyCount),
                    },
                }).catch(error => {
                    console.error('Failed to record API key usage activity:', error);
                });
            }
            window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
        };

        window.addEventListener('api-key-used', handleApiKeyUsed);
        window.addEventListener('gemini-key-used', handleApiKeyUsed);
        return () => {
            window.removeEventListener('api-key-used', handleApiKeyUsed);
            window.removeEventListener('gemini-key-used', handleApiKeyUsed);
        };
    }, [currentUser, currentUserId]);

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
        try {
            localStorage.setItem('editor-theme', theme);
        } catch (error) {
            console.error("Could not save theme to localStorage:", error);
        }
    }, [isDarkMode, currentUser]);

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

    // Load all saved preferences whenever a user logs in or changes.
    useEffect(() => {
        if (currentUser) {
            const data = getActivityData();
            const userPrefs = data[currentUser];
            setHighlightStyle(userPrefs?.preferredHighlightStyle || 'background');
            setChatGptOpenMode(userPrefs?.preferredChatGptOpenMode === 'tab' ? 'tab' : 'window');
            setKeywordViewMode(userPrefs?.preferredKeywordViewMode || 'classic');
            setStructureViewMode(userPrefs?.preferredStructureViewMode || 'grid');
            setPreferredLanguage(userPrefs?.preferredLanguage || 'ar');
            setUiLanguage(userPrefs?.preferredUILanguage || 'ar');
            const serverOnlyApiKeys = normalizeApiKeys(userPrefs?.apiKeys as StoredApiKeys | undefined);
            setApiKeys(serverOnlyApiKeys);
            if (userPrefs?.apiKeys) saveUserApiKeys(currentUser, serverOnlyApiKeys);
            setClientGoalContexts(normalizeClientGoalContexts(userPrefs?.clientGoalContexts));
            const normalizedPrompts = normalizeEngineeringPrompts(userPrefs?.engineeringPrompts);
            setEngineeringPrompts(normalizedPrompts);
            saveUserEngineeringPrompts(currentUser, normalizedPrompts);
            if (userPrefs?.preferredTheme) setIsDarkMode(userPrefs.preferredTheme === 'dark');
        }
    }, [currentUser]);

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
    
    const handleHighlightStyleChange = (style: 'background' | 'underline') => {
        setHighlightStyle(style);
        if (currentUser) saveUserPreference(currentUser, { preferredHighlightStyle: style });
    };

    const handleChatGptOpenModeChange = (mode: ChatGptOpenMode) => {
        setChatGptOpenMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredChatGptOpenMode: mode });
    };

    const handleKeywordViewModeChange = (mode: 'classic' | 'modern') => {
        setKeywordViewMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredKeywordViewMode: mode });
    };

    const handleStructureViewModeChange = (mode: 'grid' | 'list') => {
        setStructureViewMode(mode);
        if (currentUser) saveUserPreference(currentUser, { preferredStructureViewMode: mode });
    };

    const handlePreferredLanguageChange = (lang: 'ar' | 'en') => {
        setPreferredLanguage(lang);
        if (currentUser) saveUserPreference(currentUser, { preferredLanguage: lang });
    };

    const handleUiLanguageChange = (lang: 'ar' | 'en') => {
        setUiLanguage(lang);
        if (currentUser) saveUserPreference(currentUser, { preferredUILanguage: lang });
    };

    const handleSaveApiKeys = (keys: ApiKeys) => {
        const normalizedKeys = normalizeApiKeys(keys);
        setApiKeys(normalizedKeys);
        if (currentUser) saveUserApiKeys(currentUser, normalizedKeys);
    };

    const persistClientGoalContexts = useCallback((nextContexts: ClientGoalContexts) => {
        const normalizedContexts = normalizeClientGoalContexts(nextContexts);
        setClientGoalContexts(normalizedContexts);
        if (currentUser) saveUserClientGoalContexts(currentUser, normalizedContexts);
    }, [currentUser]);

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
    }, [currentUser]);

    const value = {
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
        apiKeys,
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
        handleSaveApiKeys,
        handleSaveClientGoalContext,
        handleDeleteClientGoalContext,
        handleMergeClientGoalContexts,
        handleSaveEngineeringPrompts,
    };

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};
