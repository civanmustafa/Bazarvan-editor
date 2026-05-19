import type { Keywords, DuplicateAnalysis, DuplicateStats } from '../../types';
import { CTA_WORDS, INTERACTIVE_WORDS, TRANSITIONAL_WORDS, WARNING_ADVICE_WORDS } from '../../constants';
import { normalizeArabicText } from './analysisUtils';

const ENGLISH_TARGET_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

const ENGLISH_TRANSITIONAL_WORDS = ['firstly', 'secondly', 'finally', 'in addition', 'furthermore', 'therefore', 'consequently', 'on the other hand', 'in contrast', 'also', 'as well as', 'moreover', 'in fact', 'actually', 'in other words', 'for example', 'specifically', 'in general', 'however', 'although', 'while', 'in summary', 'in conclusion'];
const ENGLISH_CTA_WORDS = ['start now', 'try now', 'sign up', 'book your spot', 'get', 'order now', 'contact us', 'join us', 'discover more', 'learn more', 'benefit now', 'subscribe', 'download', 'buy', 'shop', 'explore', 'request a quote', 'click here', 'submit', 'register', 'claim your', 'get started', 'find out more'];
const ENGLISH_INTERACTIVE_WORDS = ['you can', 'you will find', 'you need', 'you want', 'discover', 'learn', 'try', 'choose', 'use', 'start', 'get', 'benefit', 'enjoy', 'read', 'watch', 'compare', 'check', 'did you know', 'have you ever', 'imagine', 'think about', 'explore', 'see how', 'your', 'unlock', 'uncover', 'consider', 'you', "let's"];
const ENGLISH_WARNING_ADVICE_WORDS = ['warning', 'caution', 'be careful', 'note', 'important', 'recommendation', 'it is recommended', 'it is important', 'avoid', 'make sure', 'be aware', 'beware', 'take note', 'heads up', 'it is crucial', 'you should', 'remember to', 'pro tip', 'keep in mind'];

/*
 * Duplicate analysis scans repeated 2-8 word phrases.
 * It excludes repeated phrases that are already covered by target keywords,
 * alternate forms, LSI terms, the company name, and protected editorial signals.
 */
export const runDuplicateAnalysis = (textContent: string, keywords: Keywords, totalWordCount: number, articleLanguage: 'ar' | 'en'): { duplicateAnalysis: DuplicateAnalysis; duplicateStats: DuplicateStats } => {
    const duplicateAnalysis: DuplicateAnalysis = { 2:[], 3:[], 4:[], 5:[], 6:[], 7:[], 8:[] };
    const duplicateStats: DuplicateStats = {
      totalWords: totalWordCount,
      uniqueWords: 0,
      keywordDuplicatesCount: 0,
      totalDuplicates: 0,
      commonDuplicatesCount: 0,
    };

    if (textContent) {
      const normalizedContentForUniques = articleLanguage === 'ar' ? normalizeArabicText(textContent) : textContent.toLowerCase();
      const words = normalizedContentForUniques.split(/\s+/).filter(Boolean);
      duplicateStats.uniqueWords = new Set(words).size;

      const nGrams: { [key: number]: Map<string, { locations: number[]; text: string }> } = {
        2: new Map(), 3: new Map(), 4: new Map(), 5: new Map(), 6: new Map(), 7: new Map(), 8: new Map()
      };

      const originalWordsWithLocations = [...textContent.matchAll(/\S+/g)]
        .map(match => ({ text: match[0], index: match.index ?? 0 }));
      const originalWords = originalWordsWithLocations.map(word => word.text);
      for (let n = 2; n <= 8; n++) {
          if (originalWords.length < n) continue;

          for (let i = 0; i <= originalWords.length - n; i++) {
              const originalNgramArray = originalWords.slice(i, i + n);
              const originalNgramText = originalNgramArray.join(' ');

              const normalizedNgramArray = originalNgramArray.map(w => articleLanguage === 'ar' ? normalizeArabicText(w.toLowerCase()) : w.toLowerCase());
              const normalizedNgramKey = normalizedNgramArray.join(' ');
              
              if (!nGrams[n].has(normalizedNgramKey)) {
                  nGrams[n].set(normalizedNgramKey, { locations: [], text: originalNgramText });
              }
              const charIndex = originalWordsWithLocations[i]?.index ?? 0;
              nGrams[n].get(normalizedNgramKey)!.locations.push(charIndex);
          }
      }

      const tokenizeForDuplicateComparison = (value: string): string[] => {
        const normalized = articleLanguage === 'ar' ? normalizeArabicText(value.toLowerCase()) : value.toLowerCase();
        return normalized.match(/[\p{L}\p{N}]+/gu) || [];
      };

      const normalizeComparisonToken = (token: string): string => {
        if (articleLanguage === 'ar') return token;
        const normalized = token.replace(/'s$/i, '');
        if (normalized.length > 4 && normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`;
        if (normalized.length > 4 && /(ches|shes|xes|zes|ses)$/.test(normalized)) return normalized.replace(/es$/, '');
        if (normalized.length > 3 && normalized.endsWith('s') && !normalized.endsWith('ss')) return normalized.slice(0, -1);
        return normalized;
      };

      const getMeaningfulComparisonTokens = (value: string): string[] => (
        tokenizeForDuplicateComparison(value)
          .map(normalizeComparisonToken)
          .filter(token => token && (articleLanguage === 'ar' || !ENGLISH_TARGET_STOPWORDS.has(token)))
      );

      const containsTokenSequence = (tokens: string[], sequence: string[]): boolean => {
        if (sequence.length === 0 || sequence.length > tokens.length) return false;
        for (let index = 0; index <= tokens.length - sequence.length; index++) {
          if (sequence.every((token, offset) => tokens[index + offset] === token)) return true;
        }
        return false;
      };

      const editorialSignalTerms = articleLanguage === 'ar'
        ? [
          ...TRANSITIONAL_WORDS,
          ...WARNING_ADVICE_WORDS,
          ...CTA_WORDS,
          ...INTERACTIVE_WORDS,
        ]
        : [
          ...ENGLISH_TRANSITIONAL_WORDS,
          ...ENGLISH_WARNING_ADVICE_WORDS,
          ...ENGLISH_CTA_WORDS,
          ...ENGLISH_INTERACTIVE_WORDS,
        ];

      const protectedDuplicateTokens = [
          keywords.primary,
          ...keywords.secondaries,
          ...keywords.lsi,
          keywords.company,
          ...editorialSignalTerms,
      ]
        .filter(Boolean)
        .map(term => getMeaningfulComparisonTokens(term))
        .filter(tokens => tokens.length > 0);

      const getTokenSequenceKey = (tokens: string[]): string => tokens.join('\u0001');
      const protectedSubphraseKeys = new Set<string>();
      protectedDuplicateTokens.forEach(tokens => {
        const minLength = tokens.length === 1 ? 1 : 2;
        const maxLength = Math.min(tokens.length, 8);
        for (let length = minLength; length <= maxLength; length++) {
          for (let index = 0; index <= tokens.length - length; index++) {
            protectedSubphraseKeys.add(getTokenSequenceKey(tokens.slice(index, index + length)));
          }
        }
      });

      const containsProtectedSubphrase = (phraseTokens: string[]): boolean => {
        for (let length = phraseTokens.length; length >= 1; length--) {
          for (let index = 0; index <= phraseTokens.length - length; index++) {
            if (protectedSubphraseKeys.has(getTokenSequenceKey(phraseTokens.slice(index, index + length)))) {
              return true;
            }
          }
        }
        return false;
      };

      const isProtectedTargetPhrase = (key: string): boolean => {
        const phraseTokens = getMeaningfulComparisonTokens(key);
        if (phraseTokens.length === 0) return false;
        if (containsProtectedSubphrase(phraseTokens)) return true;
        return protectedDuplicateTokens.some(protectedTokens => (
          containsTokenSequence(phraseTokens, protectedTokens) ||
          containsTokenSequence(protectedTokens, phraseTokens)
        ));
      };

      for (let n = 2; n <= 8; n++) {
        nGrams[n].forEach((value, key) => {
          if (value.locations.length > 1) {
            const isKeywordPhrase = isProtectedTargetPhrase(key);
            if (isKeywordPhrase) return;
            duplicateAnalysis[n as keyof DuplicateAnalysis].push({
              text: value.text,
              count: value.locations.length,
              locations: value.locations,
              containsKeyword: isKeywordPhrase,
            });
            duplicateStats.totalDuplicates += value.locations.length - 1;
            if (isKeywordPhrase) {
                duplicateStats.keywordDuplicatesCount++;
            } else {
                duplicateStats.commonDuplicatesCount++;
            }
          }
        });
      }
    }
    return { duplicateAnalysis, duplicateStats };
};
