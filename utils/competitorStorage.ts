export const COMPETITOR_URLS_STORAGE_KEY = 'bazarvan-competitor-links';
export const COMPETITOR_HTML_STORAGE_KEY = 'bazarvan-competitor-html-snippets';
export const COMPETITOR_TEXT_STORAGE_KEY = 'bazarvan-competitor-text-snippets';
export const COMPETITOR_RESET_EVENT = 'bazarvan:competitors-reset';

export const clearStoredCompetitorInputs = () => {
    [
        COMPETITOR_URLS_STORAGE_KEY,
        COMPETITOR_HTML_STORAGE_KEY,
        COMPETITOR_TEXT_STORAGE_KEY,
    ].forEach(key => {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.error(`Could not remove competitor field "${key}":`, error);
        }
    });
};
