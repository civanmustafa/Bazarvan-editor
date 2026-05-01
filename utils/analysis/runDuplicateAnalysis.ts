import type { Keywords, DuplicateAnalysis, DuplicateStats } from '../../types';
import { normalizeArabicText } from './analysisUtils';

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

      const allKeywordsForDupCheck = [
          keywords.primary,
          ...keywords.secondaries,
      ].filter(Boolean).map(kw => articleLanguage === 'ar' ? normalizeArabicText(kw.toLowerCase()) : kw.toLowerCase());

      for (let n = 2; n <= 8; n++) {
        nGrams[n].forEach((value, key) => {
          if (value.locations.length > 1) {
            const isKeywordPhrase = allKeywordsForDupCheck.some(kw => key.includes(kw) || kw.includes(key));
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
