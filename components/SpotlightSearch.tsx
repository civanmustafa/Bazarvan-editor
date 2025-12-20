
import React, { useState, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useInteraction } from '../contexts/InteractionContext';
import { useAI } from '../contexts/AIContext';
import { useUser } from '../contexts/UserContext';

const SpotlightSearch: React.FC = () => {
    const { isSpotlightVisible, setIsSpotlightVisible } = useInteraction();
    const { openGoogleSearch } = useAI();
    const { t, uiLanguage } = useUser();
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isSpotlightVisible) {
            setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                    inputRef.current.select();
                }
            }, 50);
        }
    }, [isSpotlightVisible]);

    const handleClose = () => {
        setIsSpotlightVisible(false);
        setQuery('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (query.trim()) {
                openGoogleSearch(query);
                handleClose();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleClose();
        }
    };

    if (!isSpotlightVisible) return null;

    return (
        <div 
            className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh] bg-black/40 backdrop-blur-sm transition-opacity duration-200"
            onClick={handleClose}
        >
            <div 
                className="w-full max-w-2xl mx-4 bg-white dark:bg-[#2A2A2A] rounded-xl shadow-2xl border border-gray-200 dark:border-[#3C3C3C] overflow-hidden transform transition-all duration-200 scale-100 opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="relative flex items-center px-4 py-3">
                    <Search className="w-6 h-6 text-gray-400 dark:text-gray-500 me-3" />
                    <input
                        ref={inputRef}
                        type="text"
                        className="flex-grow w-full text-lg bg-transparent border-none outline-none text-gray-800 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                        placeholder={t.spotlight.placeholder}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoComplete="off"
                    />
                    {query && (
                        <button 
                            onClick={() => setQuery('')}
                            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#3C3C3C] text-gray-400 transition-colors"
                        >
                            <X size={18} />
                        </button>
                    )}
                    <div className="absolute end-4 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none opacity-60">
                        <kbd className="hidden sm:inline-flex items-center h-6 px-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#1F1F1F] border border-gray-200 dark:border-[#3C3C3C] rounded">
                            Esc
                        </kbd>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SpotlightSearch;
