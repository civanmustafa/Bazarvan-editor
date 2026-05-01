import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';

const Login: React.FC = () => {
  const { handleLogin, isDarkMode, uiLanguage } = useUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const t = translations[uiLanguage];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const success = handleLogin(username, password);
    if (!success) {
      setError(t.loginError);
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
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="username" className="sr-only">{t.username}</label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                className="relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-[#d4af37] focus:border-[#d4af37] focus:z-10 sm:text-sm dark:bg-[#2A2A2A] dark:border-[#3C3C3C] dark:placeholder-gray-400 dark:text-gray-100"
                placeholder={t.username}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
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
              className="group relative flex justify-center w-full px-4 py-2 text-sm font-medium text-white bg-[#d4af37] border border-transparent rounded-md hover:bg-[#b8922e] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d4af37] dark:focus:ring-offset-gray-800"
            >
              <span className="absolute inset-y-0 start-0 flex items-center ps-3">
                <LogIn className="w-5 h-5 text-[#f2d675] group-hover:text-white" aria-hidden="true" />
              </span>
              {t.loginButton}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;