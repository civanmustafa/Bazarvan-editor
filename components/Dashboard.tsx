
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LogOut, Edit, RefreshCw, Clock, Key, Save, Book, Trash2, AlertCircle, Repeat, FileText, PlusSquare, PaintRoller, Baseline, LayoutGrid, ListTree, List, ChevronRight, FileDown, Filter, X, Calendar, Settings, Languages } from 'lucide-react';
import { getActivityData, UserActivity, ArticleActivity, deleteArticleActivity, renameArticleActivity, clearUserActivity } from '../hooks/useUserActivity';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useModal } from '../contexts/ModalContext';

type ActivityData = {
  [username: string]: UserActivity;
};

const formatSeconds = (seconds: number, t: typeof translations.ar): string => {
  if (!seconds || seconds < 60) return `${Math.floor(seconds || 0)} ${t.secondsAbbr}`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [
    h > 0 ? `${h} ${t.hoursAbbr}` : '',
    m > 0 ? `${m} ${t.minutesAbbr}` : '',
  ].filter(Boolean).join(' ').trim() || `0 ${t.secondsAbbr}`;
};

const SummaryStat: React.FC<{ icon: React.ReactNode; label: string; value: string | number }> = ({ icon, label, value }) => (
  <div className="flex items-center gap-4 p-4 bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C]">
    <div className="p-3 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-lg">
      {icon}
    </div>
    <div className="text-start">
      <div className="text-xl font-bold text-[#333333] dark:text-[#b7b7b7]">{value}</div>
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  </div>
);

const SeoScoreIndicator: React.FC<{ score: number }> = ({ score }) => {
  const getScoreColor = () => {
    if (score >= 85) return 'text-green-500 bg-green-500/10 border-green-500/20';
    if (score >= 60) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
    return 'text-red-500 bg-red-500/10 border-red-500/20';
  };

  return (
    <div className={`flex items-center justify-center flex-col w-16 h-16 rounded-full border-2 ${getScoreColor()}`}>
      <span className="text-xl font-bold">{Math.round(score)}</span>
      <span className="text-xs font-medium -mt-1 opacity-80">SEO</span>
    </div>
  );
};


interface ArticleItemProps {
    title: string;
    activity: ArticleActivity;
    onLoad: () => void;
    onDelete: () => void;
    onRename: (oldTitle: string, newTitle: string) => boolean;
    t: typeof translations.ar;
}

const ArticleListItem: React.FC<ArticleItemProps> = ({ title, activity, onLoad, onDelete, onRename, t }) => {
    const [isRenaming, setIsRenaming] = useState(false);
    const [newTitle, setNewTitle] = useState(title);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(t.confirmDeleteArticle.replace('{title}', title))) {
            onDelete();
        }
    };

    const handleStartRename = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsRenaming(true);
    };

    const handleCancelRename = () => {
        setIsRenaming(false);
        setNewTitle(title);
    };

    const handleRenameSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (onRename(title, newTitle)) {
            setIsRenaming(false);
        } else {
            alert(t.renameArticleError.replace('{title}', newTitle));
            inputRef.current?.focus();
        }
    };
    
    const calculateSeoScore = () => {
        if (!activity.stats) return 0;
        const { violatingCriteriaCount = 0, totalErrorsCount = 0, keywordViolations = 0 } = activity.stats;
        const deductions = (violatingCriteriaCount * 3) + (totalErrorsCount * 0.5) + (keywordViolations * 2);
        const score = Math.max(0, 100 - deductions);
        return score;
    };
    const seoScore = calculateSeoScore();

    if (isRenaming) {
      return (
          <li className="p-3 bg-gray-100 dark:bg-[#3C3C3C] rounded-lg ring-2 ring-[#d4af37]">
              <form onSubmit={handleRenameSubmit}>
                  <input
                      ref={inputRef}
                      type="text"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full p-2 text-sm font-bold bg-white dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#4A4A4A] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-[#333333] dark:text-gray-200"
                      aria-label="New article title"
                  />
                  <div className="flex justify-end gap-2 mt-2">
                      <button type="button" onClick={(e)=>{e.stopPropagation(); handleCancelRename();}} className="px-3 py-1 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-[#d4af37]/20 dark:bg-[#4A4A4A] dark:text-gray-200 dark:hover:bg-[#d4af37]/25">
                          {t.cancel}
                      </button>
                      <button type="submit" className="px-3 py-1 text-xs font-semibold text-white bg-[#d4af37] rounded-md hover:bg-[#b8922e]">
                          {t.save}
                      </button>
                  </div>
              </form>
          </li>
      );
    }
    
    const untranslatedTitle = title || t.untitled;

    return (
        <li 
            className="group flex items-center gap-4 p-4 bg-white dark:bg-[#2A2A2A] rounded-lg transition-all duration-200 hover:shadow-md hover:border-gray-300 dark:hover:border-[#4A4A4A] cursor-pointer border border-gray-200 dark:border-[#3C3C3C]"
            onClick={onLoad}
            role="button"
            tabIndex={0}
            onKeyPress={(e) => e.key === 'Enter' && onLoad()}
        >
            <SeoScoreIndicator score={seoScore} />
            <div className="flex-grow space-y-2">
                <h4 className="font-bold text-md text-[#333333] dark:text-gray-200 truncate" title={untranslatedTitle}>
                    {untranslatedTitle}
                </h4>
                <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                    {activity.lastSaved && (
                         <span className="flex items-center gap-1.5" title={t.lastSaved}>
                            <RefreshCw size={12} />
                            {new Date(activity.lastSaved).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' })}
                        </span>
                    )}
                    <span className="flex items-center gap-1.5" title={t.timeSpent}><Clock size={12} /> {formatSeconds(activity.timeSpentSeconds, t)}</span>
                    {activity.stats && (
                        <span className="flex items-center gap-1.5" title={t.wordCount}><FileText size={12} /> {activity.stats.wordCount}</span>
                    )}
                     <span className="font-bold text-gray-600 dark:text-gray-300">{(activity.articleLanguage || 'ar').toUpperCase()}</span>
                </div>
                <div className="pt-2 border-t border-gray-100 dark:border-[#3a3a3a] flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1.5" title={t.keywordViolations}>
                        <Key size={12} className="text-yellow-500" />
                        <span>{activity.stats?.keywordViolations ?? 0}</span>
                    </span>
                    <span className="flex items-center gap-1.5" title={t.structureViolations}>
                        <AlertCircle size={12} className="text-red-500" />
                        <span>{activity.stats?.violatingCriteriaCount ?? 0}</span>
                    </span>
                    <span className="flex items-center gap-1.5" title={t.totalDuplicates}>
                        <Repeat size={12} className="text-[#d4af37]" />
                        <span>{activity.stats?.totalDuplicates ?? 0}</span>
                    </span>
                </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
                 <button
                    onClick={handleStartRename}
                    className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
                    title={t.renameArticle}
                >
                    <Edit size={16} />
                </button>
                <button
                    onClick={handleDelete}
                    className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-[#d4af37]/10 hover:text-red-600 dark:hover:bg-[#d4af37]/20 dark:hover:text-red-400"
                    title={t.deleteArticle}
                >
                    <Trash2 size={16} />
                </button>
            </div>
             <ChevronRight size={20} className="text-gray-300 dark:text-gray-600 flex-shrink-0" />
        </li>
    );
};


const Dashboard: React.FC = () => {
  const {
    setCurrentView,
    currentUser,
    handleLogout: onLogout,
    isDarkMode,
    highlightStyle: preferredHighlightStyle,
    handleHighlightStyleChange: onHighlightStyleChange,
    keywordViewMode: preferredKeywordViewMode,
    handleKeywordViewModeChange: onKeywordViewModeChange,
    structureViewMode: preferredStructureViewMode,
    handleStructureViewModeChange: onStructureViewModeChange,
    preferredLanguage,
    handlePreferredLanguageChange: onPreferredLanguageChange,
    uiLanguage,
    handleUiLanguageChange: onUiLanguageChange,
    t,
  } = useUser();
  const { handleNewArticle: onNewArticle, handleLoadArticle: onLoadArticle } = useEditor();
  const { openModal } = useModal();

  const onGoToEditor = () => setCurrentView('editor');
  
  const [activityData, setActivityData] = useState<ActivityData>(getActivityData());
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [isFilterVisible, setIsFilterVisible] = useState(false);
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    wordCountMin: '',
    wordCountMax: '',
    timeMin: '',
    timeMax: '',
    language: 'all',
  });

  if (!currentUser) {
    return null;
  }

  const refreshData = () => {
    setActivityData(getActivityData());
  };

  const handleDeleteArticle = (articleTitle: string) => {
    deleteArticleActivity(currentUser, articleTitle);
    refreshData();
  };
  
  const handleRenameArticle = (oldTitle: string, newTitle: string): boolean => {
      const success = renameArticleActivity(currentUser, oldTitle, newTitle);
      if (success) {
          refreshData();
      }
      return success;
  };

  useEffect(() => {
    const intervalId = setInterval(refreshData, 10000);
    return () => clearInterval(intervalId);
  }, []);

  const handleExportHtml = () => {
    const currentUserData = activityData[currentUser];
    if (!currentUserData) return;

    const formatSecondsDetailed = (seconds: number): string => {
      if (!seconds || seconds < 60) return `${Math.floor(seconds || 0)} ${t.seconds}`;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return [
        h > 0 ? `${h} ${t.hours}` : '',
        m > 0 ? `${m} ${t.minutes}` : '',
        s > 0 ? `${s} ${t.seconds}` : '',
      ].filter(Boolean).join(' ').trim() || `0 ${t.seconds}`;
    };

    const totalArticles = Object.keys(currentUserData.articles).length;
    const totalTimeSpent = (Object.values(currentUserData.articles) as ArticleActivity[]).reduce((sum, article) => sum + article.timeSpentSeconds, 0);

    const articlesHtml = `
      <table class="articles-table">
          <thead>
              <tr>
                  <th>${t.articleTitle}</th>
                  <th>${t.timeSpent}</th>
                  <th>${t.words}</th>
                  <th>${t.keywordViolations}</th>
                  <th>${t.structureViolations}</th>
                  <th>${t.structureErrors}</th>
                  <th>${t.totalDuplicates}</th>
                  <th>${t.keywordDuplicates}</th>
                  <th>${t.commonDuplicates}</th>
              </tr>
          </thead>
          <tbody>
              ${(Object.entries(currentUserData.articles) as [string, ArticleActivity][])
              .sort(([, a], [, b]) => new Date(b.lastSaved || 0).getTime() - new Date(a.lastSaved || 0).getTime())
              .map(([title, activity]) => `
                  <tr>
                      <td>${title || t.untitled}</td>
                      <td>${formatSeconds(activity.timeSpentSeconds, t)}</td>
                      <td>${activity.stats?.wordCount ?? 'N/A'}</td>
                      <td>${activity.stats?.keywordViolations ?? 'N/A'}</td>
                      <td>${activity.stats?.violatingCriteriaCount ?? 'N/A'}</td>
                      <td>${activity.stats?.totalErrorsCount ?? 'N/A'}</td>
                      <td>${activity.stats?.totalDuplicates ?? 'N/A'}</td>
                      <td>${activity.stats?.keywordDuplicatesCount ?? 'N/A'}</td>
                      <td>${activity.stats?.commonDuplicatesCount ?? 'N/A'}</td>
                  </tr>
              `).join('')}
          </tbody>
      </table>
    `;

    const htmlContent = `
        <!DOCTYPE html>
        <html lang="${uiLanguage}" dir="${uiLanguage === 'ar' ? 'rtl' : 'ltr'}">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${t.userActivityReport}: ${currentUser}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; margin: 0; padding: 20px; }
                .container { max-width: 1200px; margin: auto; background: #fff; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1, h2 { color: #b8922e; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
                h1 { font-size: 2em; }
                h2 { font-size: 1.5em; margin-top: 30px; }
                p { color: #666; }
                .summary-table, .articles-table { width: 100%; border-collapse: collapse; margin-top: 15px; text-align: ${uiLanguage === 'ar' ? 'right' : 'left'}; }
                .summary-table th, .summary-table td, .articles-table th, .articles-table td { padding: 12px; border: 1px solid #ddd; }
                .summary-table th { background-color: #f2f2f2; font-weight: bold; color: #b8922e; }
                .summary-table th { width: 30%; }
                .summary-table tr:nth-child(even), .articles-table tr:nth-child(even) { background-color: #f9f9f9; }
                .articles-table { font-size: 0.9em; table-layout: fixed; }
                .articles-table td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .articles-table tr:hover { background-color: #f1f1f1; }
                .articles-table td:first-child { width: 30%; white-space: normal; word-break: break-word; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>${t.userActivityReport}: ${currentUser}</h1>
                <p>${t.reportDate}: ${new Date().toLocaleString(t.locale)}</p>
                <h2>${t.activitySummary}</h2>
                <table class="summary-table">
                    <tr><th>${t.totalArticles}</th><td>${totalArticles}</td></tr>
                    <tr><th>${t.totalTimeSpent}</th><td>${formatSecondsDetailed(totalTimeSpent)}</td></tr>
                </table>
                <h2>${t.articlesDetails}</h2>
                ${articlesHtml}
            </div>
        </body>
        </html>
    `;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${currentUser}-${new Date().toISOString().split('T')[0]}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleConfirmClearData = () => {
    clearUserActivity(currentUser);
    refreshData();
    setIsConfirmModalOpen(false);
  };

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const handleResetFilters = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      wordCountMin: '',
      wordCountMax: '',
      timeMin: '',
      timeMax: '',
      language: 'all',
    });
  };

  const currentUserData = activityData[currentUser];

  const filteredArticles = useMemo(() => {
    if (!currentUserData) return [];

    return (Object.entries(currentUserData.articles) as [string, ArticleActivity][]).filter(([, activity]) => {
      if (filters.dateFrom) {
          if (!activity.lastSaved || new Date(activity.lastSaved) < new Date(filters.dateFrom)) {
              return false;
          }
      }
      if (filters.dateTo) {
          if (!activity.lastSaved) return false;
          const articleDate = new Date(activity.lastSaved);
          const filterDate = new Date(filters.dateTo);
          filterDate.setHours(23, 59, 59, 999);
          if (articleDate > filterDate) {
              return false;
          }
      }
      const wordCount = activity.stats?.wordCount ?? 0;
      const wordMin = parseInt(filters.wordCountMin, 10);
      const wordMax = parseInt(filters.wordCountMax, 10);
      if (!isNaN(wordMin) && wordCount < wordMin) return false;
      if (!isNaN(wordMax) && wordCount > wordMax) return false;
      
      const timeInMinutes = Math.floor(activity.timeSpentSeconds / 60);
      const timeMin = parseInt(filters.timeMin, 10);
      const timeMax = parseInt(filters.timeMax, 10);
      if (!isNaN(timeMin) && timeInMinutes < timeMin) return false;
      if (!isNaN(timeMax) && timeInMinutes > timeMax) return false;
      
      if (filters.language !== 'all' && (activity.articleLanguage || 'ar') !== filters.language) {
          return false;
      }

      return true;
    });
  }, [currentUserData, filters]);
  
  const styleButtonClass = (isActive: boolean) =>
    `flex-1 flex items-center justify-center gap-2 p-2 rounded-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-100 dark:focus:ring-offset-[#1F1F1F] focus:ring-[#d4af37] ${
      isActive
        ? 'bg-[#d4af37] text-white shadow-sm'
        : 'bg-white hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 text-[#333333] dark:text-[#8d8d8d]'
    }`;

  const inputClass = "w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0]";

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} bg-gray-50 dark:bg-[#181818]`}>
      <div className="max-w-screen-xl mx-auto p-4 sm:p-6 md:p-8">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[#333333] dark:text-gray-100">{t.dashboardTitle}</h1>
            <p className="mt-1 text-gray-500 dark:text-gray-400">{t.welcomeBack}, <span className="font-bold text-[#d4af37]">{currentUser}</span>!</p>
          </div>
           <div className="flex items-center gap-2">
            <button
              onClick={onNewArticle}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
            >
              <PlusSquare size={18} />
              <span>{t.newArticle}</span>
            </button>
            <button
              onClick={onGoToEditor}
              className="flex items-center gap-2 px-4 py-2 font-bold text-white bg-[#d4af37] rounded-lg hover:bg-[#b8922e] transition-colors"
            >
              <Edit size={18} />
              <span>{t.goToEditor}</span>
            </button>
            <button
              onClick={handleExportHtml}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-[#333333] dark:text-[#C7C7C7] bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors"
            >
              <FileDown size={18} />
              <span>{t.exportHtml}</span>
            </button>
            <button
              onClick={() => setIsConfirmModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 font-semibold text-red-600 dark:text-red-400 bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title={t.clearUserData}
            >
              <Trash2 size={18} />
              <span>{t.clearData}</span>
            </button>
            <button
              onClick={onLogout}
              className="p-2.5 border rounded-lg transition-colors text-gray-500 dark:text-[#8d8d8d] border-gray-300 dark:border-[#3C3C3C] bg-white hover:bg-[#d4af37]/10 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20"
              title={t.logout}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t.yourRecentArticles}</h2>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setIsFilterVisible(!isFilterVisible)}
                            className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#d4af37] dark:hover:text-[#f2d675]"
                            title={isFilterVisible ? t.hideFilters : t.showFilters}
                        >
                            <Filter size={14} />
                            <span>{t.filter}</span>
                        </button>
                        <button
                            onClick={refreshData}
                            className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#d4af37] dark:hover:text-[#f2d675]"
                            title={t.refreshData}
                        >
                            <RefreshCw size={14} />
                            <span>{t.refresh}</span>
                        </button>
                    </div>
                </div>

                {isFilterVisible && (
                    <div className="p-4 mb-6 bg-white/50 dark:bg-[#2A2A2A]/50 rounded-xl border border-gray-200 dark:border-[#3C3C3C] backdrop-blur-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-gray-700 dark:text-gray-200">{t.filterOptions}</h3>
                            <button onClick={handleResetFilters} className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-100/50 dark:bg-[#3C3C3C]/50 rounded-md hover:bg-[#d4af37]/20 dark:hover:bg-[#d4af37]/25 transition-colors">
                                <X size={14} />
                                <span>{t.reset}</span>
                            </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Calendar size={16} className="text-[#d4af37]" />
                                    <span>{t.saveDate}</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="date" name="dateFrom" value={filters.dateFrom} onChange={handleFilterChange} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="date" name="dateTo" value={filters.dateTo} onChange={handleFilterChange} className={inputClass} />
                                </div>
                            </div>
                             <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <FileText size={16} className="text-[#d4af37]" />
                                    <span>{t.wordCount}</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="number" name="wordCountMin" value={filters.wordCountMin} onChange={handleFilterChange} placeholder={t.from} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="number" name="wordCountMax" value={filters.wordCountMax} onChange={handleFilterChange} placeholder={t.to} className={inputClass} />
                                </div>
                            </div>
                             <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Clock size={16} className="text-[#d4af37]" />
                                    <span>{t.timeSpent} ({t.minutes})</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input type="number" name="timeMin" value={filters.timeMin} onChange={handleFilterChange} placeholder={t.from} className={inputClass} />
                                    <span className="text-gray-400 dark:text-gray-500">-</span>
                                    <input type="number" name="timeMax" value={filters.timeMax} onChange={handleFilterChange} placeholder={t.to} className={inputClass} />
                                </div>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <Languages size={16} className="text-[#d4af37]" />
                                    <span>{t.language}</span>
                                </label>
                                <select name="language" value={filters.language} onChange={handleFilterChange} className={inputClass}>
                                    <option value="all">{t.all}</option>
                                    <option value="ar">{t.arabic}</option>
                                    <option value="en">{t.english}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                )}

                {currentUserData && filteredArticles.length > 0 ? (
                    <ul className="space-y-3">
                         {filteredArticles
                            .sort(([, a], [, b]) => new Date(b.lastSaved || 0).getTime() - new Date(a.lastSaved || 0).getTime())
                            .map(([title, activity]) => (
                                <ArticleListItem
                                    key={title}
                                    title={title}
                                    activity={activity}
                                    onLoad={() => onLoadArticle(title, activity)}
                                    onDelete={() => handleDeleteArticle(title)}
                                    onRename={handleRenameArticle}
                                    t={t}
                                />
                            ))}
                    </ul>
                ) : (
                    <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-gray-300 dark:border-[#3C3C3C] rounded-lg text-center">
                        <Book size={40} className="text-gray-400 dark:text-gray-500 mb-2"/>
                        <h3 className="text-lg font-semibold text-gray-600 dark:text-gray-300">
                            {currentUserData && Object.keys(currentUserData.articles).length > 0 ? t.noArticlesMatchFilter : t.noArticlesYet}
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {currentUserData && Object.keys(currentUserData.articles).length > 0 ? t.tryAdjustingFilters : t.clickNewArticleToStart}
                        </p>
                    </div>
                )}
            </div>

            <div className="space-y-8">
                <div>
                     <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4">{t.activitySummary}</h2>
                     <div className="space-y-3">
                        <SummaryStat icon={<Book size={20} />} label={t.totalArticles} value={currentUserData ? Object.keys(currentUserData.articles).length : 0} />
                        <SummaryStat icon={<Clock size={20} />} label={t.totalTime} value={formatSeconds(currentUserData ? (Object.values(currentUserData.articles) as ArticleActivity[]).reduce((sum, article) => sum + article.timeSpentSeconds, 0) : 0, t)} />
                    </div>
                </div>

                <div>
                    <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4 flex items-center gap-2"><Settings size={20} /><span>{t.settings}</span></h2>
                    <div className="p-4 bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C] space-y-4">
                         <button
                            onClick={() => openModal('apiKeys')}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-[#d4af37]/10 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675] font-bold rounded-lg hover:bg-[#d4af37]/20 transition-colors"
                        >
                            <Key size={18} />
                            <span>{t.manageApiKeys}</span>
                        </button>
                         <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.highlightStyle}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onHighlightStyleChange('background')} className={styleButtonClass(preferredHighlightStyle === 'background')} title={t.background}><PaintRoller size={16} /></button>
                                <button onClick={() => onHighlightStyleChange('underline')} className={styleButtonClass(preferredHighlightStyle === 'underline')} title={t.wavyUnderline}><Baseline size={16} /></button>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.keywordView}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onKeywordViewModeChange('classic')} className={styleButtonClass(preferredKeywordViewMode === 'classic')} title={t.detailedCards}><LayoutGrid size={16} /></button>
                                <button onClick={() => onKeywordViewModeChange('modern')} className={styleButtonClass(preferredKeywordViewMode === 'modern')} title={t.modernList}><ListTree size={16} /></button>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.structureView}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onStructureViewModeChange('grid')} className={styleButtonClass(preferredStructureViewMode === 'grid')} title={t.grid}><LayoutGrid size={16} /></button>
                                <button onClick={() => onStructureViewModeChange('list')} className={styleButtonClass(preferredStructureViewMode === 'list')} title={t.list}><List size={16} /></button>
                            </div>
                        </div>
                        <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.defaultArticleLanguage}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onPreferredLanguageChange('ar')} className={styleButtonClass(preferredLanguage === 'ar')} title={t.arabic}>
                                    <Languages size={16} /> <span>{t.arabic}</span>
                                </button>
                                <button onClick={() => onPreferredLanguageChange('en')} className={styleButtonClass(preferredLanguage === 'en')} title={t.english}>
                                    <Languages size={16} /> <span>{t.english}</span>
                                </button>
                            </div>
                        </div>
                         <div>
                            <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300 mb-2">{t.interfaceLanguage}</h4>
                            <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-[#1F1F1F] p-1">
                                <button onClick={() => onUiLanguageChange('ar')} className={styleButtonClass(uiLanguage === 'ar')} title={t.arabic}>
                                    <Languages size={16} /> <span>{t.arabic}</span>
                                </button>
                                <button onClick={() => onUiLanguageChange('en')} className={styleButtonClass(uiLanguage === 'en')} title={t.english}>
                                    <Languages size={16} /> <span>{t.english}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
      </div>
      {isConfirmModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" aria-labelledby="modal-title" role="dialog" aria-modal="true">
            <div className={`bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl w-full max-md p-6 border dark:border-[#3C3C3C] text-start`}>
                <div className="flex sm:items-start gap-4">
                    <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20 sm:mx-0 sm:h-10 sm:w-10">
                        <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" aria-hidden="true" />
                    </div>
                    <div className="flex-grow">
                        <h3 className="text-lg font-bold leading-6 text-[#333333] dark:text-gray-100" id="modal-title">
                            {t.clearAllData}
                        </h3>
                        <div className="mt-2">
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t.clearDataConfirmation}
                            </p>
                        </div>
                    </div>
                </div>
                <div className={`mt-5 sm:mt-4 flex ${uiLanguage === 'ar' ? 'flex-row-reverse' : 'flex-row'} gap-3`}>
                    <button
                        type="button"
                        className="inline-flex w-full justify-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 sm:w-auto"
                        onClick={handleConfirmClearData}
                    >
                        {t.yesClear}
                    </button>
                    <button
                        type="button"
                        className="mt-3 inline-flex w-full justify-center rounded-md bg-white dark:bg-[#3C3C3C] px-3 py-2 text-sm font-semibold text-gray-900 dark:text-gray-200 shadow-sm ring-1 ring-inset ring-gray-300 dark:ring-[#4A4A4A] hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/25 sm:mt-0 sm:w-auto"
                        onClick={() => setIsConfirmModalOpen(false)}
                    >
                        {t.cancel}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
