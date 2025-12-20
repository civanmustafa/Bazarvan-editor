import type { Keywords, CheckResult, AnalysisStatus, DuplicateAnalysis } from '../../types';
import { translations } from '../../components/translations';

// --- Types ---
export interface AnalysisContext {
    editorState: any;
    nodes: { type: string; level?: number; text: string; node: any; pos: number }[];
    headings: { type: string; level?: number; text: string; node: any; pos: number }[];
    paragraphs: { type: string; level?: number; text: string; node: any; pos: number }[];
    nonEmptyParagraphs: { type: string; level?: number; text: string; node: any; pos: number }[];
    textContent: string;
    totalWordCount: number;
    keywords: Keywords;
    aiGoal: string;
    articleLanguage: 'ar' | 'en';
    uiLanguage: 'ar' | 'en';
    t: typeof translations.ar;
    totalDocSize: number;
    faqSections: { startPos: number; endPos: number }[];
    isPosInFaqSection: (pos: number) => boolean;
    conclusionSection: { text: string; paragraphs: any[]; hasList: boolean; hasNumber: boolean; wordCount: number } | null;
    duplicateAnalysis: DuplicateAnalysis;
}

// --- Helper Functions ---

export const getNodeText = (node: any): string => {
  if (!node) {
    return '';
  }
  if (node.type === 'text' && node.text) {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    return node.content.map(getNodeText).join('');
  }
  return '';
};

export const getNodeContentAsText = (node: any): string => {
  if (!node) {
    return '';
  }
  if (node.type === 'text' && node.text) {
    return node.text;
  }
  if (node.type === 'hardBreak') {
    return '\n';
  }
  if (Array.isArray(node.content)) {
    return node.content.map(getNodeContentAsText).join('');
  }
  return '';
};

export const getWordCount = (text: string): number => {
  return text.trim().split(/\s+/).filter(Boolean).length;
};

export const getSentenceCount = (text: string): number => {
    return text.split(/[.!?؟]+/).filter(s => s.trim().length > 2).length || (text.trim() ? 1 : 0);
};

export const normalizeArabicText = (text: string): string => {
    if (!text) return text;
    return text
        .replace(/[\u064B-\u0652]/g, "") 
        .replace(/\u0640/g, "") 
        .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") 
        .replace(/[\u0624]/g, "\u0648") 
        .replace(/[\u0626\u0649]/g, "\u064A")
        .replace(/\u0629/g, "\u0647"); 
};

export const countOccurrences = (text: string, sub: string, lang: 'ar' | 'en'): number => {
    if (!sub || !text) return 0;

    if (lang === 'ar') {
        const normalizedText = normalizeArabicText(text.toLowerCase());
        const normalizedSub = normalizeArabicText(sub.toLowerCase());

        if (!normalizedSub) return 0;

        const prefixes = '(ال|و|ف|ب|ك|ل|وبال|وال|فال|فل|وب|فب|كال|لل)?';
        const suffixes = '(ه|ها|هم|هن|ك|كم|كن|ي|نا|ان|ون|ين|ات|تم|كما|هما)?';
        const escapedSub = normalizedSub.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`(?<!\\p{L})${prefixes}${escapedSub}${suffixes}(?!\\p{L})`, 'gu');
        
        const matches = normalizedText.match(regex);
        return matches ? matches.length : 0;
    } else { // lang === 'en' or default
        const normalizedText = text.toLowerCase();
        const normalizedSub = sub.toLowerCase();

        if (!normalizedSub) return 0;
        
        const escapedSub = normalizedSub.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedSub}\\b`, 'gi');
        return (normalizedText.match(regex) || []).length;
    }
};

export const countNodesByType = (node: any, type: string): number => {
    if (!node) return 0;
    let count = 0;
    if (node.type === type) {
        count++;
    }
    if (node.content && Array.isArray(node.content)) {
        for (const child of node.content) {
            count += countNodesByType(child, type);
        }
    }
    return count;
};

export const createCheckResult = (
    title: string,
    status: AnalysisStatus,
    current: string | number,
    required: string | number,
    progress: number,
    description?: string,
    details?: string
): CheckResult => ({
  title, status, current, required, progress, description, details
});

export const getStatus = (current: number, min: number, max: number, warnMin?: number, warnMax?: number): AnalysisStatus => {
  if (current >= min && current <= max) return 'pass';
  if ((warnMin !== undefined && current >= warnMin) && (warnMax !== undefined && current <= warnMax)) return 'warn';
  return 'fail';
};

export const getNodeSizeFromJSON = (nodeJSON: any): number => {
    if (!nodeJSON || typeof nodeJSON !== 'object') {
        return 0;
    }

    if (nodeJSON.type === 'text') {
        return nodeJSON.text?.length || 0;
    }
    
    if (['hardBreak', 'horizontalRule'].includes(nodeJSON.type)) {
        return 1;
    }
    
    let size = 2; 
    
    if (Array.isArray(nodeJSON.content)) {
        for (const child of nodeJSON.content) {
            size += getNodeSizeFromJSON(child);
        }
    }
    
    return size;
};

// --- Constants ---
export const DUPLICATE_WORDS_EXCLUSION_LIST_RAW = [
    'الذي', 'التي', 'اللذان', 'اللتان', 'الذين', 'اللاتي', 'اللواتي', 'ما', 'من', 'متى', 'أين', 'كيف', 'كم', 'أي', 'أيان', 'مهما', 'أينما', 'حيثما', 'كيفما', 'كان', 'أصبح', 'أضحى', 'ظل', 'أمسى', 'بات', 'صار', 'ليس', 'ما زال', 'ما دام', 'ما برح', 'ما انفك', 'ما فتئ', 'إن', 'أن', 'كأن', 'لكن', 'ليت', 'لعل', 'على', 'ظن', 'حسب', 'خال', 'زعم', 'رأى', 'علم', 'وجد', 'ثم', 'أو', 'أم', 'بل', 'لا', 'حتى', 'لن', 'كي', 'لم', 'لما', 'ها', 'ألا', 'أما', 'إلا', 'غير', 'سوى', 'عدا', 'خلا', 'حاشا', 'أنى', 'إذما', 'جعل', 'حجا', 'عد', 'هب', 'تعلم', 'درى', 'ألفى', 'وهب', 'إذن', 'لا يكون', 'أنا', 'نحن', 'أنت', 'أنتِ', 'أنتما', 'أنتن', 'هو', 'هي', 'هما', 'هم', 'هن', 'أب', 'أخ', 'حم', 'فو', 'ذو', 'يا', 'أيا', 'هيا', 'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء', 'أولئك', 'هنا', 'هناك', 'هنالك'
];
export const DUPLICATE_WORDS_EXCLUSION_LIST = new Set(DUPLICATE_WORDS_EXCLUSION_LIST_RAW.map(normalizeArabicText));