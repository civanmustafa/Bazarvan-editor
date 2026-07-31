import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  BookOpenCheck,
  CheckCircle2,
  ChevronLeft,
  CircleHelp,
  FilePenLine,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Link2,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  USER_GUIDE_ARTICLE_COUNT,
  USER_GUIDE_CATEGORIES,
  USER_GUIDE_LAST_UPDATED,
  USER_GUIDE_VERSION,
  type UserGuideArticle,
  type UserGuideCategory,
} from '../constants/userGuide';
import { navigateToAppPath } from '../utils/appRoutes';
import { searchUserGuide } from '../utils/userGuideSearch';

const categoryIcons: Record<string, React.ReactNode> = {
  'getting-started': <LayoutDashboard size={16} />,
  editor: <FilePenLine size={16} />,
  'keywords-goals': <Gauge size={16} />,
  competitors: <Users size={16} />,
  'content-writing': <Sparkles size={16} />,
  quality: <CheckCircle2 size={16} />,
  'ai-tools': <Bot size={16} />,
  'internal-links': <Link2 size={16} />,
  automation: <Workflow size={16} />,
  settings: <Settings size={16} />,
  administration: <ShieldCheck size={16} />,
  troubleshooting: <CircleHelp size={16} />,
};

const formatGuideDate = (value: string): string => {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ar', { dateStyle: 'long' }).format(date);
};

const GuideArticleContent: React.FC<{
  article: UserGuideArticle;
  category: UserGuideCategory;
}> = ({ article, category }) => (
  <article className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-[#3C3C3C] dark:bg-[#242424]">
    <header className="border-b border-gray-100 p-5 dark:border-[#353535] sm:p-6">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-black text-[#9a7b20] dark:text-[#e0bd47]">
        <span>{category.title}</span>
        {article.audience === 'admin' && (
          <span className="rounded-full bg-violet-100 px-2 py-1 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200">
            للمسؤول
          </span>
        )}
      </div>
      <h1 className="mt-2 text-2xl font-black leading-10 text-gray-900 dark:text-gray-100 sm:text-3xl">
        {article.title}
      </h1>
      <p className="mt-2 max-w-3xl text-sm font-semibold leading-7 text-gray-500 dark:text-gray-300">
        {article.summary}
      </p>
    </header>

    <div className="space-y-7 p-5 sm:p-6">
      {article.sections.map((section, sectionIndex) => (
        <section key={`${article.id}-${section.title}-${sectionIndex}`} className="scroll-mt-28">
          <h2 className="text-lg font-black leading-8 text-gray-900 dark:text-gray-100">
            {section.title}
          </h2>
          {section.paragraphs?.map((paragraph, paragraphIndex) => (
            <p
              key={`${section.title}-paragraph-${paragraphIndex}`}
              className="mt-2 text-sm font-semibold leading-8 text-gray-600 dark:text-gray-300"
            >
              {paragraph}
            </p>
          ))}
          {section.bullets && section.bullets.length > 0 && (
            <ul className="mt-3 space-y-2.5">
              {section.bullets.map((bullet, bulletIndex) => (
                <li key={`${section.title}-bullet-${bulletIndex}`} className="flex items-start gap-2.5 text-sm font-semibold leading-7 text-gray-600 dark:text-gray-300">
                  <CheckCircle2 size={16} className="mt-1.5 shrink-0 text-emerald-500" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          )}
          {section.table && (
            <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 dark:border-[#3C3C3C]">
              <table className="min-w-[720px] w-full border-collapse text-start text-xs">
                <thead className="bg-gray-50 dark:bg-[#1D1D1D]">
                  <tr>
                    {section.table.headers.map(header => (
                      <th key={header} className="border-b border-gray-200 px-3 py-3 text-start font-black text-gray-700 dark:border-[#3C3C3C] dark:text-gray-200">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.table.rows.map((row, rowIndex) => (
                    <tr key={`${section.title}-row-${rowIndex}`} className="border-b border-gray-100 last:border-0 dark:border-[#343434]">
                      {row.map((cell, cellIndex) => (
                        <td key={`${rowIndex}-${cellIndex}`} className="px-3 py-3 align-top font-semibold leading-6 text-gray-600 dark:text-gray-300">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {section.note && (
            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold leading-7 text-blue-800 dark:border-blue-900/50 dark:bg-blue-900/15 dark:text-blue-200">
              <span className="font-black">ملاحظة: </span>{section.note}
            </div>
          )}
          {section.warning && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-7 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/15 dark:text-amber-100">
              <span className="font-black">تنبيه: </span>{section.warning}
            </div>
          )}
        </section>
      ))}
    </div>

    {article.links && article.links.length > 0 && (
      <footer className="flex flex-wrap gap-2 border-t border-gray-100 p-5 dark:border-[#353535] sm:p-6">
        {article.links.map(link => (
          <button
            key={`${article.id}-${link.path}`}
            type="button"
            onClick={() => navigateToAppPath(link.path)}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#d4af37] px-3 py-2 text-xs font-black text-[#171717] hover:bg-[#e0bd47]"
          >
            {link.label}
            <ChevronLeft size={14} />
          </button>
        ))}
      </footer>
    )}
  </article>
);

const UserGuidePage: React.FC = () => {
  const { isDarkMode } = useUser();
  const [activeCategoryId, setActiveCategoryId] = useState(USER_GUIDE_CATEGORIES[0].id);
  const [activeArticleId, setActiveArticleId] = useState(USER_GUIDE_CATEGORIES[0].articles[0].id);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentTopRef = useRef<HTMLDivElement>(null);

  const activeCategory = USER_GUIDE_CATEGORIES.find(category => category.id === activeCategoryId)
    || USER_GUIDE_CATEGORIES[0];
  const activeArticle = activeCategory.articles.find(article => article.id === activeArticleId)
    || activeCategory.articles[0];
  const searchResults = useMemo(() => searchUserGuide(query), [query]);
  const normalizedQuery = query.trim();

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setQuery('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    const originalTitle = document.title;
    return () => {
      document.title = originalTitle;
    };
  }, []);

  useEffect(() => {
    document.title = `دليل الاستخدام — ${activeArticle.title}`;
  }, [activeArticle.title]);

  const selectCategory = (category: UserGuideCategory) => {
    setActiveCategoryId(category.id);
    setActiveArticleId(category.articles[0].id);
    setQuery('');
    window.requestAnimationFrame(() => contentTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const selectArticle = (category: UserGuideCategory, article: UserGuideArticle) => {
    setActiveCategoryId(category.id);
    setActiveArticleId(article.id);
    setQuery('');
    window.requestAnimationFrame(() => contentTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className={`${isDarkMode ? 'dark' : ''} min-h-screen bg-[#F7F7F5] text-right dark:bg-[#181818]`} dir="rtl">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 shadow-sm backdrop-blur dark:border-[#353535] dark:bg-[#202020]/95">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => navigateToAppPath('/dashboard')}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-black text-gray-700 hover:border-[#d4af37] hover:text-[#9a7b20] dark:border-[#3C3C3C] dark:text-gray-200"
          >
            <ArrowRight size={15} />
            لوحة التحكم
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BookOpenCheck size={24} className="shrink-0 text-[#d4af37]" />
            <div className="min-w-0">
              <div className="truncate text-base font-black text-gray-900 dark:text-gray-100">دليل استخدام محرر بازارفان</div>
              <div className="text-[10px] font-bold text-gray-400">{USER_GUIDE_ARTICLE_COUNT.toLocaleString('ar')} موضوعًا منظمًا وقابلًا للبحث</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigateToAppPath('/settings')}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-black text-gray-700 hover:border-[#d4af37] hover:text-[#9a7b20] dark:border-[#3C3C3C] dark:text-gray-200"
          >
            <Settings size={15} />
            الإعدادات
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
        <section className="overflow-hidden rounded-2xl bg-gradient-to-l from-[#171717] via-[#292516] to-[#66551e] p-5 text-white shadow-lg sm:p-7">
          <div className="grid gap-5 lg:grid-cols-[1fr,minmax(320px,620px)] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-black text-[#f1d77d]">
                <BookOpenCheck size={14} />
                من إنشاء المقالة حتى المراجعة والإدارة
              </div>
              <h1 className="mt-3 text-2xl font-black leading-10 sm:text-3xl">كيف يمكننا مساعدتك؟</h1>
              <p className="mt-2 max-w-2xl text-sm font-semibold leading-7 text-white/75">
                ابحث باسم الزر أو المرحلة أو المشكلة، مثل: قراءتان مستقلتان، عدد الكلمات، إصلاح الجودة أو n8n.
              </p>
            </div>
            <label className="relative block">
              <Search size={20} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="ابحث في دليل الاستخدام..."
                aria-label="البحث في دليل الاستخدام"
                className="h-14 w-full rounded-xl border border-white/15 bg-white pr-12 pl-20 text-sm font-bold text-gray-900 outline-none placeholder:text-gray-400 focus:border-[#e0bd47] focus:ring-4 focus:ring-[#d4af37]/15"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  aria-label="مسح البحث"
                >
                  <X size={16} />
                </button>
              ) : (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 rounded bg-gray-100 px-2 py-1 text-[10px] font-black text-gray-400">/</span>
              )}
            </label>
          </div>
        </section>

        <nav aria-label="أقسام دليل الاستخدام" className="mt-5 flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
          {USER_GUIDE_CATEGORIES.map(category => (
            <button
              key={category.id}
              type="button"
              onClick={() => selectCategory(category)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-black transition-colors ${activeCategory.id === category.id && !normalizedQuery
                ? 'border-[#d4af37] bg-[#d4af37] text-[#171717]'
                : 'border-gray-200 bg-white text-gray-600 hover:border-[#d4af37] hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-200'}`}
            >
              {categoryIcons[category.id] || <BookOpenCheck size={16} />}
              {category.shortTitle}
              <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[9px]">{category.articles.length.toLocaleString('ar')}</span>
            </button>
          ))}
        </nav>

        <div ref={contentTopRef} className="scroll-mt-24" />

        {normalizedQuery ? (
          <section className="mt-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-black text-gray-900 dark:text-gray-100">نتائج البحث عن «{normalizedQuery}»</h2>
                <p className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                  {searchResults.length.toLocaleString('ar')} نتيجة مرتبة حسب الصلة
                </p>
              </div>
            </div>
            {searchResults.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {searchResults.map(result => (
                  <button
                    key={`${result.category.id}-${result.article.id}`}
                    type="button"
                    onClick={() => selectArticle(result.category, result.article)}
                    className="group rounded-xl border border-gray-200 bg-white p-4 text-start shadow-sm transition hover:-translate-y-0.5 hover:border-[#d4af37] hover:shadow-md dark:border-[#3C3C3C] dark:bg-[#242424]"
                  >
                    <div className="flex items-center gap-2 text-[10px] font-black text-[#9a7b20] dark:text-[#e0bd47]">
                      {categoryIcons[result.category.id]}
                      {result.category.title}
                    </div>
                    <h3 className="mt-2 text-base font-black leading-7 text-gray-900 group-hover:text-[#8a6f1d] dark:text-gray-100">
                      {result.article.title}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-300">
                      {result.snippet}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center dark:border-[#444] dark:bg-[#242424]">
                <Search size={32} className="mx-auto text-gray-300" />
                <div className="mt-3 font-black text-gray-700 dark:text-gray-200">لا توجد نتيجة مطابقة</div>
                <p className="mt-1 text-xs font-semibold text-gray-400">جرّب اسم التبويب أو الزر أو المرحلة بكلمات أقل.</p>
              </div>
            )}
          </section>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[280px,minmax(0,1fr)]">
            <aside className="self-start rounded-2xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#242424] lg:sticky lg:top-24">
              <div className="px-2 pb-3">
                <div className="flex items-center gap-2 text-sm font-black text-gray-900 dark:text-gray-100">
                  {categoryIcons[activeCategory.id]}
                  {activeCategory.title}
                </div>
                <p className="mt-1 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">{activeCategory.description}</p>
              </div>
              <div className="space-y-1">
                {activeCategory.articles.map(article => (
                  <button
                    key={article.id}
                    type="button"
                    onClick={() => selectArticle(activeCategory, article)}
                    className={`flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2.5 text-start text-xs font-black leading-5 ${activeArticle.id === article.id
                      ? 'bg-[#d4af37]/15 text-[#806616] dark:bg-[#d4af37]/20 dark:text-[#f1d77d]'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-[#303030]'}`}
                  >
                    <span>{article.title}</span>
                    <ChevronLeft size={14} className="mt-0.5 shrink-0" />
                  </button>
                ))}
              </div>
            </aside>

            <GuideArticleContent article={activeArticle} category={activeCategory} />
          </div>
        )}

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[11px] font-bold text-gray-500 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-400">
          <span>إصدار الدليل {USER_GUIDE_VERSION.toLocaleString('ar')} — آخر تحديث {formatGuideDate(USER_GUIDE_LAST_UPDATED)}</span>
          <span className="inline-flex items-center gap-1.5"><KeyRound size={13} /> تظهر مزايا المسؤول بوسم خاص</span>
          <span className="inline-flex items-center gap-1.5"><Activity size={13} /> استخدم سجل الجلسات للتشخيص التفصيلي</span>
        </footer>
      </main>
    </div>
  );
};

export default UserGuidePage;
