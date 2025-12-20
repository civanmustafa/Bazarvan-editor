
import React, { useState, useCallback, useEffect, createContext, useContext, useRef } from 'react';
import { recordLogin, getActivityData, saveUserPreference, saveUserApiKeys } from '../hooks/useUserActivity';
import { translations } from '../components/translations';
import { USERS } from '../constants';

interface UserContextType {
    currentUser: string | null;
    currentView: 'login' | 'dashboard' | 'editor';
    isDarkMode: boolean;
    setIsDarkMode: React.Dispatch<React.SetStateAction<boolean>>;
    highlightStyle: 'background' | 'underline';
    keywordViewMode: 'classic' | 'modern';
    structureViewMode: 'grid' | 'list';
    preferredLanguage: 'ar' | 'en';
    uiLanguage: 'ar' | 'en';
    apiKeys: { gemini: string; perplexity: string[] };
    t: typeof translations.ar;
    isIdle: boolean;
    handleLogin: (username: string, password: string) => boolean;
    handleLogout: () => void;
    setCurrentView: React.Dispatch<React.SetStateAction<'login' | 'dashboard' | 'editor'>>;
    handleHighlightStyleChange: (style: 'background' | 'underline') => void;
    handleKeywordViewModeChange: (mode: 'classic' | 'modern') => void;
    handleStructureViewModeChange: (mode: 'grid' | 'list') => void;
    handlePreferredLanguageChange: (lang: 'ar' | 'en') => void;
    handleUiLanguageChange: (lang: 'ar' | 'en') => void;
    handleSaveApiKeys: (keys: { gemini: string; perplexity: string[] }) => void;
}

const UserContext = createContext<UserContextType | null>(null);

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) throw new Error("useUser must be used within a UserProvider");
  return context;
};

const getInitialTheme = () => {
    try {
      const user = sessionStorage.getItem('currentUser');
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

export const UserProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [currentUser, setCurrentUser] = useState<string | null>(() => sessionStorage.getItem('currentUser'));
    const [currentView, setCurrentView] = useState<'login' | 'dashboard' | 'editor'>(
      sessionStorage.getItem('currentUser') ? 'dashboard' : 'login'
    );
    const [isDarkMode, setIsDarkMode] = useState(getInitialTheme);
    const [highlightStyle, setHighlightStyle] = useState<'background' | 'underline'>('background');
    const [keywordViewMode, setKeywordViewMode] = useState<'classic' | 'modern'>('classic');
    const [structureViewMode, setStructureViewMode] = useState<'grid' | 'list'>('grid');
    const [preferredLanguage, setPreferredLanguage] = useState<'ar' | 'en'>('ar');
    const [uiLanguage, setUiLanguage] = useState<'ar' | 'en'>('ar');
    const [apiKeys, setApiKeys] = useState<{ gemini: string; perplexity: string[] }>({ gemini: '', perplexity: [''] });
    
    const [isIdle, setIsIdle] = useState(false);
    const idleTimerRef = useRef<number | null>(null);

    const t = translations[uiLanguage] || translations.ar;

    useEffect(() => {
        document.documentElement.lang = uiLanguage;
        document.documentElement.dir = uiLanguage === 'ar' ? 'rtl' : 'ltr';
        document.title = t.appTitle;
    }, [uiLanguage, t]);
    
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

     useEffect(() => {
        if (currentView !== 'editor') {
        if (!isIdle) setIsIdle(true);
        return;
        }
        
        const IDLE_TIMEOUT = 2 * 60 * 1000;

        const handleUserActivity = () => {
        setIsIdle(false); 
        
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
        }

        idleTimerRef.current = window.setTimeout(() => {
            setIsIdle(true);
        }, IDLE_TIMEOUT);
        };

        const handleVisibilityChange = () => {
        if (document.hidden) {
            if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
            }
            setIsIdle(true);
        } else {
            handleUserActivity();
        }
        };

        handleUserActivity();

        const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
        events.forEach(event => window.addEventListener(event, handleUserActivity, { passive: true }));
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
        }
        events.forEach(event => window.removeEventListener(event, handleUserActivity));
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [currentUser, currentView, isIdle]);

    useEffect(() => {
        if (currentUser) {
            const data = getActivityData();
            const userPrefs = data[currentUser];
            setHighlightStyle(userPrefs?.preferredHighlightStyle || 'background');
            setKeywordViewMode(userPrefs?.preferredKeywordViewMode || 'classic');
            setStructureViewMode(userPrefs?.preferredStructureViewMode || 'grid');
            setPreferredLanguage(userPrefs?.preferredLanguage || 'ar');
            setUiLanguage(userPrefs?.preferredUILanguage || 'ar');
            if (userPrefs?.apiKeys) setApiKeys(userPrefs.apiKeys);
            if (userPrefs?.preferredTheme) setIsDarkMode(userPrefs.preferredTheme === 'dark');
        }
    }, [currentUser]);

    const handleLogin = useCallback((username: string, password: string): boolean => {
        const trimmedUsername = username.trim();
        const trimmedPassword = password.trim();
        const user = USERS.find(u => u.username === trimmedUsername && u.password === trimmedPassword);
        if (user) {
            setCurrentUser(user.username);
            recordLogin(user.username);
            try {
                sessionStorage.setItem('currentUser', user.username);
            } catch (error) {
                console.error("Could not write to sessionStorage:", error);
            }
            setCurrentView('dashboard');
            return true;
        }
        return false;
    }, []);

    const handleLogout = useCallback(() => {
        setCurrentUser(null);
        try {
            sessionStorage.removeItem('currentUser');
        } catch (error) {
            console.error("Could not remove from sessionStorage:", error);
        }
        setCurrentView('login');
    }, []);
    
    const handleHighlightStyleChange = (style: 'background' | 'underline') => {
        setHighlightStyle(style);
        if (currentUser) saveUserPreference(currentUser, { preferredHighlightStyle: style });
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

    const handleSaveApiKeys = (keys: { gemini: string; perplexity: string[] }) => {
        setApiKeys(keys);
        if (currentUser) saveUserApiKeys(currentUser, keys);
    };

    const value = {
        currentUser,
        currentView,
        isDarkMode,
        setIsDarkMode,
        highlightStyle,
        keywordViewMode,
        structureViewMode,
        preferredLanguage,
        uiLanguage,
        apiKeys,
        t,
        isIdle,
        handleLogin,
        handleLogout,
        setCurrentView,
        handleHighlightStyleChange,
        handleKeywordViewModeChange,
        handleStructureViewModeChange,
        handlePreferredLanguageChange,
        handleUiLanguageChange,
        handleSaveApiKeys,
    };

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};
