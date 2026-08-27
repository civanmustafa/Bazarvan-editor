import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';

const Login: React.FC = () => {
  const { handleLogin, handleGoogleLogin, isDarkMode, uiLanguage } = useUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const t = translations[uiLanguage];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    const success = await handleLogin(username, password);
    setIsSubmitting(false);
    if (!success) {
      setError(t.loginError);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setIsSubmitting(true);
    const success = await handleGoogleLogin();
    if (!success) {
      setIsSubmitting(false);
      setError(uiLanguage === 'ar'
        ? 'تعذر بدء تسجيل الدخول عبر Google. تحقق من إعداد موفر Google في Supabase.'
        : 'Could not start Google sign-in. Verify the Google provider in Supabase.');
    }
  };

  return (
    <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'dark' : ''} bg-[#FAFAFA] dark:bg-[#181818]`}>
      <div className="w-full max-w-md p-8 space-y-8 bg-white rounded-xl shadow-lg dark:bg-[#1F1F1F] border border-gray-200 dark:border-[#3C3C3C]">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-[#333333] dark:text-gray-100">{t.loginTitle}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t.loginSubtitle}</p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <button
            type="button"
            onClick={() => void handleGoogle()}
            disabled={isSubmitting}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-100 dark:hover:bg-[#333]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
              <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
              <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.39 3.13 1.04 4.55l3.35-2.62Z" />
              <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5L18.7 4.56A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z" />
            </svg>
            <span>{uiLanguage === 'ar' ? 'الدخول أو إنشاء حساب بواسطة Google' : 'Continue with Google'}</span>
          </button>

          <div className="flex items-center gap-3 text-xs font-bold text-gray-400">
            <span className="h-px flex-1 bg-gray-200 dark:bg-[#3C3C3C]" />
            <span>{uiLanguage === 'ar' ? 'أو بالبريد وكلمة المرور' : 'or email and password'}</span>
            <span className="h-px flex-1 bg-gray-200 dark:bg-[#3C3C3C]" />
          </div>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="username" className="sr-only">{t.username}</label>
              <input
                id="username"
                name="username"
                type="email"
                autoComplete="username"
                required
                className="relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-[#d4af37] focus:border-[#d4af37] focus:z-10 sm:text-sm dark:bg-[#2A2A2A] dark:border-[#3C3C3C] dark:placeholder-gray-400 dark:text-gray-100"
                placeholder="email@example.com"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">{t.password}</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-[#d4af37] focus:border-[#d4af37] focus:z-10 sm:text-sm dark:bg-[#2A2A2A] dark:border-[#3C3C3C] dark:placeholder-gray-400 dark:text-gray-100"
                placeholder={t.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          </div>

          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-100 rounded-md dark:bg-red-900/20 dark:text-red-300" role="alert">
              {error}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="group relative flex justify-center w-full px-4 py-2 text-sm font-medium text-white bg-[#d4af37] border border-transparent rounded-md hover:bg-[#b8922e] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d4af37] dark:focus:ring-offset-gray-800"
            >
              <span className="absolute inset-y-0 start-0 flex items-center ps-3">
                <LogIn className="w-5 h-5 text-[#f2d675] group-hover:text-white" aria-hidden="true" />
              </span>
              {isSubmitting ? '...' : t.loginButton}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
