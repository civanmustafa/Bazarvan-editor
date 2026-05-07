import type { Keywords, DuplicateAnalysis, DuplicateStats } from '../../types';
import { normalizeArabicText } from './analysisUtils';

/*
 * Duplicate analysis scans repeated 2-8 word phrases.
 * It also marks repeated phrases that overlap target keywords so the UI can
 * separate keyword repetition from general repetition.
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

      const containsTokenSequence = (tokens: string[], sequence: string[]): boolean => {
        if (sequence.length === 0 || sequence.length > tokens.length) return false;
        for (let index = 0; index <= tokens.length - sequence.length; index++) {
          if (sequence.every((token, offset) => tokens[index + offset] === token)) return true;
        }
        return false;
      };

      const targetKeywordTokens = [
          keywords.primary,
          ...keywords.secondaries,
          ...keywords.lsi,
      ]
        .filter(Boolean)
        .map(term => tokenizeForDuplicateComparison(term))
        .filter(tokens => tokens.length > 0);

      const containsTargetKeywordPhrase = (key: string): boolean => {
        const phraseTokens = tokenizeForDuplicateComparison(key);
        if (phraseTokens.length === 0) return false;
        return targetKeywordTokens.some(keywordTokens => (
          containsTokenSequence(phraseTokens, keywordTokens) ||
          containsTokenSequence(keywordTokens, phraseTokens)
        ));
      };

      const isProtectedBigram = (key: string): boolean => {
        const bigramTokens = tokenizeForDuplicateComparison(key);
        if (bigramTokens.length === 0) return false;
        return targetKeywordTokens.some(keywordTokens => (
          containsTokenSequence(bigramTokens, keywordTokens) ||
          containsTokenSequence(keywordTokens, bigramTokens)
        ));
      };

      for (let n = 2; n <= 8; n++) {
        nGrams[n].forEach((value, key) => {
          if (value.locations.length > 1) {
            const isKeywordPhrase = containsTargetKeywordPhrase(key);
            if (n === 2 && isProtectedBigram(key)) return;
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
