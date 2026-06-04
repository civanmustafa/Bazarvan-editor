export const COMPETITOR_URLS_STORAGE_KEY = 'bazarvan-competitor-links';
export const COMPETITOR_HTML_STORAGE_KEY = 'bazarvan-competitor-html-snippets';
export const COMPETITOR_TEXT_STORAGE_KEY = 'bazarvan-competitor-text-snippets';
export const COMPETITOR_RESET_EVENT = 'bazarvan:competitors-reset';

export type StoredCompetitorInputs = {
    urls: string[];
    htmls: string[];
    texts: string[];
};

const readStringArray = (key: string): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed)
            ? parsed.map(item => typeof item === 'string' ? item : '')
            : [];
    } catch {
        return [];
    }
};

const writeStringArray = (key: string, value: string[]) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error(`Could not save competitor field "${key}":`, error);
    }
};

export const readStoredCompetitorInputs = (): StoredCompetitorInputs => ({
    urls: readStringArray(COMPETITOR_URLS_STORAGE_KEY),
    htmls: readStringArray(COMPETITOR_HTML_STORAGE_KEY),
    texts: readStringArray(COMPETITOR_TEXT_STORAGE_KEY),
});

export const writeStoredCompetitorInputs = (inputs: StoredCompetitorInputs) => {
    writeStringArray(COMPETITOR_URLS_STORAGE_KEY, inputs.urls);
    writeStringArray(COMPETITOR_HTML_STORAGE_KEY, inputs.htmls);
    writeStringArray(COMPETITOR_TEXT_STORAGE_KEY, inputs.texts);
};

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
