import type { KeywordAnalysis, PrimaryKeywordAnalysis, SecondaryKeywordAnalysis, CompanyNameAnalysis, LsiKeywordAnalysis, KeywordStats } from '../../types';
import { countOccurrences, getStatus, createCheckResult } from './analysisUtils';
import type { AnalysisContext } from './analysisUtils';

export const runKeywordAnalysis = (context: AnalysisContext): KeywordAnalysis => {
    const { keywords, totalWordCount, aiGoal, textContent, headings, paragraphs, articleLanguage, t } = context;
    const tKwChecks = t.keywordChecks;
    const getRequiredCount = (requiredPercentage: [number, number], isActive: boolean): [number, number] => {
      if (!isActive || totalWordCount === 0) return [0, 0];
      const min = Math.max(1, Math.floor(totalWordCount * requiredPercentage[0]));
      const max = Math.max(min, Math.ceil(totalWordCount * requiredPercentage[1]));
      return [min, max];
    };

    const primaryAnalysis: PrimaryKeywordAnalysis = (() => {
      const p = keywords.primary;
      const count = p ? countOccurrences(textContent, p, articleLanguage) : 0;
      const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
      
      let requiredPercentage: [number, number];
      if (aiGoal === 'اكاديمية') {
          requiredPercentage = [0.008, 0.009];
      } else if (aiGoal === 'البيع' || aiGoal === 'بيع جهاز') {
          requiredPercentage = [0.005, 0.008];
      } else if (aiGoal === 'مدونة' || aiGoal === 'برنامج سياحي') {
          requiredPercentage = [0.009, 0.011];
      } else {
          requiredPercentage = [0.005, 0.01];
      }
      
      const requiredCount = getRequiredCount(requiredPercentage, Boolean(p && p.trim()));

      const firstH2 = headings.find(h => h.level === 2);
      const h2Headings = headings.filter(h => h.level === 2);
      const lastH2 = h2Headings.length > 0 ? h2Headings[h2Headings.length - 1] : null;

      const checks = p ? [
        { text: tKwChecks.inFirstParagraph, isMet: paragraphs.length > 0 && countOccurrences(paragraphs[0].text, p, articleLanguage) > 0 },
        { text: tKwChecks.inFirstH2, isMet: firstH2 ? countOccurrences(firstH2.text, p, articleLanguage) > 0 : false },
        { text: tKwChecks.inLastH2, isMet: lastH2 ? countOccurrences(lastH2.text, p, articleLanguage) > 0 : false },
        { 
          text: tKwChecks.inLastTwoParagraphs, 
          isMet: (paragraphs.length > 0 && countOccurrences(paragraphs[paragraphs.length - 1].text, p, articleLanguage) > 0) || 
                 (paragraphs.length > 1 && countOccurrences(paragraphs[paragraphs.length - 2].text, p, articleLanguage) > 0) 
        }
      ] : [];

      if (p) {
        const h2Count = h2Headings.length;
        const h2sText = h2Headings.map(h => h.text).join(' ');
        const countInH2 = countOccurrences(h2sText, p, articleLanguage);

        let h2CheckIsMet = true;
        if (h2Count >= 5 && h2Count <= 8) {
            h2CheckIsMet = countInH2 >= 1 && countInH2 <= 2;
        }
        
        checks.push({
          text: tKwChecks.inH2WithCount(countInH2),
          isMet: h2CheckIsMet
        });
      }

      return {
        count,
        percentage,
        requiredPercentage: p && p.trim() ? requiredPercentage : [0, 0] as [number, number],
        requiredCount: requiredCount,
        status: p && p.trim() ? getStatus(count, requiredCount[0], requiredCount[1]) : 'info',
        checks: checks
      };
    })();

    let totalSecondariesRequiredPercentage: [number, number];
    if (aiGoal === 'البيع' || aiGoal === 'بيع جهاز') {
        totalSecondariesRequiredPercentage = [0.003, 0.005];
    } else {
        totalSecondariesRequiredPercentage = [0.005, 0.01];
    }

    const activeSecondariesCount = keywords.secondaries.filter(s => s.trim()).length;
    
    const individualSecondaryRequiredPercentage: [number, number] = activeSecondariesCount > 0
        ? [totalSecondariesRequiredPercentage[0] / activeSecondariesCount, totalSecondariesRequiredPercentage[1] / activeSecondariesCount]
        : [0, 0];
        
    const secondariesAnalysis: SecondaryKeywordAnalysis[] = keywords.secondaries.map((s): SecondaryKeywordAnalysis => {
      if (!s.trim()) {
        return { count: 0, percentage: 0, requiredPercentage: [0, 0], requiredCount: [0, 0], status: 'info', checks: [] };
      }
      const count = countOccurrences(textContent, s, articleLanguage);
      const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
      
      const requiredPercentage = individualSecondaryRequiredPercentage;
      const requiredCount = getRequiredCount(requiredPercentage, true);
      
      const h2s = headings.filter(h => h.level === 2);
      const h2sWithSynonym = h2s.filter(h => countOccurrences(h.text, s, articleLanguage) > 0);
      const isInH2 = h2sWithSynonym.length > 0;

      let allH2sWithSynonymAreValid = true;
      if (isInH2) {
          for (const h2 of h2sWithSynonym) {
              const h2IndexInNodes = context.nodes.findIndex(node => node.pos === h2.pos);
              if (h2IndexInNodes === -1) continue;

              let nextHeadingIndex = -1;
              for (let i = h2IndexInNodes + 1; i < context.nodes.length; i++) {
                  if (context.nodes[i].type === 'heading') {
                      nextHeadingIndex = i;
                      break;
                  }
              }
              
              const endOfSectionIndex = nextHeadingIndex === -1 ? context.nodes.length : nextHeadingIndex;
              const sectionParagraphs = context.nodes.slice(h2IndexInNodes + 1, endOfSectionIndex).filter(node => node.type === 'paragraph');
              const sectionText = sectionParagraphs.map(p => p.text).join(' ');
              
              if (countOccurrences(sectionText, s, articleLanguage) === 0) {
                  allH2sWithSynonymAreValid = false;
                  break;
              }
          }
      }

      return {
        count, percentage, requiredPercentage, requiredCount,
        status: getStatus(count, requiredCount[0], requiredCount[1]),
        checks: [
          { text: tKwChecks.inH2Simple, isMet: isInH2 },
          { text: tKwChecks.inH2Section, isMet: isInH2 && allH2sWithSynonymAreValid }
        ],
      };
    });

    const secondariesDistribution: KeywordStats = (() => {
        if (activeSecondariesCount === 0) {
            return { count: 0, percentage: 0, requiredPercentage: [0, 0] as [number, number], requiredCount: [0, 0] as [number, number], status: 'info' };
        }
        const totalCount = secondariesAnalysis.reduce((sum, s) => sum + s.count, 0);
        const percentage = totalWordCount > 0 ? totalCount / totalWordCount : 0;
        const requiredPercentage = totalSecondariesRequiredPercentage;
        const requiredCount = getRequiredCount(requiredPercentage, true);
        return { count: totalCount, percentage, requiredPercentage, requiredCount, status: getStatus(totalCount, requiredCount[0], requiredCount[1]) };
    })();

    const companyAnalysis: CompanyNameAnalysis = (() => {
        const c = keywords.company;
        const count = c ? countOccurrences(textContent, c, articleLanguage) : 0;
        const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
        const requiredPercentage: [number, number] = [0.001, 0.002];
        const requiredCount = getRequiredCount(requiredPercentage, Boolean(c && c.trim()));
        return { count, percentage, requiredPercentage: c && c.trim() ? requiredPercentage : [0, 0] as [number, number], requiredCount, status: c && c.trim() ? getStatus(count, requiredCount[0], requiredCount[1]) : 'info' };
    })();

    const lsiAnalysis = ((): LsiKeywordAnalysis => {
        const lsiKeywords = keywords.lsi.filter(k => k.trim());
        const result: LsiKeywordAnalysis = {
            distribution: { count: 0, percentage: 0, requiredCount: [0, 0], requiredPercentage: [0, 0], status: 'info' },
            balance: createCheckResult('توازن LSI', 'pass', 'لا توجد كلمات', 'الفرق <= 2', 1, 'يعتبر التوازن جيداً عندما يكون الفرق في عدد مرات التكرار بين أكثر كلمة وأقل كلمة استخداماً (من الكلمات المذكورة) لا يزيد عن 2.'),
            keywords: []
        };
        
        let requiredPercentage: [number, number];
        switch(aiGoal) {
            case 'مدونة': requiredPercentage = [0.02, 0.03]; break;
            default: requiredPercentage = [0.015, 0.025];
        }
        const requiredCount = getRequiredCount(requiredPercentage, lsiKeywords.length > 0);

        if (lsiKeywords.length === 0) {
            result.distribution.requiredCount = requiredCount;
            result.distribution.status = 'info';
            return result;
        }

        result.keywords = lsiKeywords.map(k => {
            const count = countOccurrences(textContent, k, articleLanguage);
            const percentage = totalWordCount > 0 ? count / totalWordCount : 0;
            return { text: k, count, percentage };
        });
        
        const totalCount = result.keywords.reduce((sum, kw) => sum + kw.count, 0);
        const totalPercentage = totalWordCount > 0 ? totalCount / totalWordCount : 0;
        const warnMin = Math.max(0, requiredCount[0] - 5);
        const warnMax = requiredCount[1] + 5;
        result.distribution = {
            count: totalCount, percentage: totalPercentage, requiredPercentage, requiredCount,
            status: getStatus(totalCount, requiredCount[0], requiredCount[1], warnMin, warnMax)
        };

        const missingKeywords = result.keywords.filter(kw => kw.count === 0).map(kw => kw.text);
        if (missingKeywords.length > 0) {
             result.balance = createCheckResult('توازن LSI', 'fail', `${missingKeywords.length} كلمات مفقودة`, 'استخدام كل الكلمات', 0, `الكلمات التالية لم تستخدم: ${missingKeywords.join(', ')}`);
            return result;
        }
        
        const usedKeywords = result.keywords.filter(kw => kw.count > 0);
        if (usedKeywords.length < 2) {
            result.balance = createCheckResult('توازن LSI', 'pass', 'جيد', 'الفرق <= 2', 1, 'يعتبر التوازن جيداً عندما يكون الفرق في عدد مرات التكرار بين أكثر كلمة وأقل كلمة استخداماً (من الكلمات المذكورة) لا يزيد عن 2.');
            return result;
        }

        const counts = usedKeywords.map(kw => kw.count);
        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);
        const difference = maxCount - minCount;

        if (difference > 2) {
            const mostUsedKeyword = usedKeywords.find(kw => kw.count === maxCount)!.text;
            const leastUsedKeyword = usedKeywords.find(kw => kw.count === minCount)!.text;
            const description = `الفرق في التكرار بين الكلمات المستخدمة كبير. الأكثر تكراراً هي "${mostUsedKeyword}" (${maxCount} مرة) والأقل هي "${leastUsedKeyword}" (${minCount} مرة). الفرق هو ${difference} (المطلوب <= 2).`;
            result.balance = createCheckResult('توازن LSI', 'fail', `الفرق: ${difference}`, 'الفرق <= 2', 0, description);
        } else {
             const description = `توزيع الكلمات متوازن. الفرق بين الأكثر والأقل استخدامًا هو ${difference} (المطلوب <= 2).`;
             result.balance = createCheckResult('توازن LSI', 'pass', `الفرق: ${difference}`, 'الفرق <= 2', 1, description);
        }
        return result;
    })();

    return {
        primary: primaryAnalysis,
        secondaries: secondariesAnalysis,
        secondariesDistribution: secondariesDistribution,
        company: companyAnalysis,
        lsi: lsiAnalysis,
    };
};
