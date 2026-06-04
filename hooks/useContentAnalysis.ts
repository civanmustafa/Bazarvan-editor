import { useEffect, useRef, useState } from 'react';
import type { Keywords, FullAnalysis, GoalContext, StructureAnalysis } from '../types';
import { createAnalysisNodesFromEditorState, runContentAnalysis, type ContentAnalysisInput } from '../utils/analysis/runContentAnalysis';
import { countNodesByType } from '../utils/analysis/analysisUtils';
import { translations } from '../components/translations';

type ContentAnalysisWorkerResponse =
  | { requestId: number; result: FullAnalysis; error?: never }
  | { requestId: number; result?: never; error: string };

const STRUCTURE_ANALYSIS_KEYS: (keyof StructureAnalysis)[] = [
  'wordCount',
  'firstTitle',
  'secondTitle',
  'includesExcludes',
  'preTravelH2',
  'pricingH2',
  'whoIsItForH2',
  'summaryParagraph',
  'secondParagraph',
  'paragraphLength',
  'paragraphPair',
  'h2Structure',
  'h2Count',
  'h3Structure',
  'h4Structure',
  'betweenH2H3',
  'faqSection',
  'answerParagraph',
  'ambiguousHeadings',
  'ambiguousParagraphReferences',
  'punctuation',
  'paragraphEndings',
  'interrogativeH2',
  'differentTransitionalWords',
  'immediateDuplicateWords',
  'duplicateWordsInParagraph',
  'duplicateWordsInHeading',
  'sentenceLength',
  'stepsIntroduction',
  'automaticLists',
  'ctaWords',
  'interactiveLanguage',
  'arabicOnly',
  'lastH2IsConclusion',
  'conclusionParagraph',
  'conclusionWordCount',
  'conclusionHasList',
  'conclusionHasNumber',
  'sentenceBeginnings',
  'warningWords',
  'punctuationSpacing',
  'repeatedBigrams',
  'slowWords',
  'wordConsistency',
  'commonEnglishTerms',
  'wordsToDelete',
  'keywordStuffing',
  'productUsageHeading',
  'productTechnicalSpecsHeading',
  'productWarrantyContent',
  'tablesCount',
  'headingLength',
];

const STRUCTURE_ANALYSIS_TITLE_KEYS: Record<keyof StructureAnalysis, keyof typeof translations.ar.structureAnalysis> = {
  wordCount: 'عدد الكلمات',
  firstTitle: 'H2 الأول',
  secondTitle: 'H2 الثاني',
  includesExcludes: 'H2 التضمينات',
  preTravelH2: 'H2 قبل السفر',
  pricingH2: 'H2 الأسعار',
  whoIsItForH2: 'H2 المرشح',
  summaryParagraph: 'الفقرة التلخيصية',
  secondParagraph: 'الفقرة الثانية',
  paragraphLength: 'طول الفقرات',
  paragraphPair: 'زوج فقرات',
  h2Structure: 'قسم H2',
  h2Count: 'عدد H2',
  h3Structure: 'قسم H3',
  h4Structure: 'قسم H4',
  betweenH2H3: 'بين H2-H3',
  faqSection: 'الأسئلة والاجوبة',
  answerParagraph: 'فقرة الأجوبة',
  ambiguousHeadings: 'عناوين مبهمة',
  ambiguousParagraphReferences: 'إحالات غامضة',
  punctuation: 'علامات الترقيم',
  paragraphEndings: 'نهايات الفقرات',
  interrogativeH2: 'عناوين H2 استفهامية',
  differentTransitionalWords: 'كلمات إنتقالية',
  immediateDuplicateWords: 'تكرار مباشر',
  duplicateWordsInParagraph: 'تكرار بالفقرة',
  duplicateWordsInHeading: 'تكرار بالعنوان',
  sentenceLength: 'طول الجمل',
  stepsIntroduction: 'تمهيد خطوات',
  automaticLists: 'التعداد الآلي',
  ctaWords: 'كلمات الحث',
  interactiveLanguage: 'لغة تفاعلية',
  arabicOnly: 'الأحرف العربية',
  lastH2IsConclusion: 'عنوان الخاتمة',
  conclusionParagraph: 'فقرة الخاتمة',
  conclusionWordCount: 'طول الخاتمة',
  conclusionHasList: 'قائمة الخاتمة',
  conclusionHasNumber: 'أرقام بالخاتمة',
  sentenceBeginnings: 'بدايات الجمل',
  warningWords: 'كلمات تحذيرية',
  punctuationSpacing: 'فراغات الترقيم',
  repeatedBigrams: 'ثنائيات مكررة',
  slowWords: 'كلمات بطيئة',
  wordConsistency: 'تناسق الكلمات',
  commonEnglishTerms: 'مصطلحات إنجليزية شائعة',
  wordsToDelete: 'كلمات للحذف',
  keywordStuffing: 'حشو استهداف',
  productUsageHeading: 'H2 الاستخدام',
  productTechnicalSpecsHeading: 'H2 المواصفات',
  productWarrantyContent: 'الضمان',
  tablesCount: 'جداول',
  headingLength: 'طول العناوين',
};

const createFallbackAnalysis = (textContent = '', uiLanguage: 'ar' | 'en' = 'ar'): FullAnalysis => {
  const t = translations[uiLanguage] || translations.ar;
  const wordCount = textContent.trim().split(/\s+/).filter(Boolean).length;
  const keywordStats = {
    count: 0,
    percentage: 0,
    requiredCount: [0, 0] as [number, number],
    requiredPercentage: [0, 0] as [number, number],
    status: 'info' as const,
  };
  const fallbackCheck = (title: string) => ({
    title,
    status: 'info' as const,
    current: 0,
    required: '-',
    progress: 0,
  });
  const structureAnalysis = Object.fromEntries(
    STRUCTURE_ANALYSIS_KEYS.map(key => {
      const titleKey = STRUCTURE_ANALYSIS_TITLE_KEYS[key];
      const translatedTitle = t.structureAnalysis[titleKey]?.title || titleKey || key;
      return [key, fallbackCheck(translatedTitle)];
    })
  ) as StructureAnalysis;

  return {
    keywordAnalysis: {
      primary: { ...keywordStats, checks: [] },
      secondaries: [],
      secondariesDistribution: keywordStats,
      company: keywordStats,
      lsi: {
        distribution: keywordStats,
        balance: fallbackCheck('lsi'),
        keywords: [],
      },
    },
    structureAnalysis,
    structureStats: {
      violatingCriteriaCount: 0,
      totalErrorsCount: 0,
      paragraphCount: 0,
      headingCount: 0,
    },
    duplicateAnalysis: {
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
      7: [],
      8: [],
    },
    duplicateStats: {
      totalWords: wordCount,
      uniqueWords: 0,
      keywordDuplicatesCount: 0,
      totalDuplicates: 0,
      commonDuplicatesCount: 0,
    },
    wordCount,
  };
};

const runContentAnalysisSafely = (input: ContentAnalysisInput, previousResult?: FullAnalysis | null): FullAnalysis => {
  try {
    return runContentAnalysis(input);
  } catch (error) {
    console.error('Content analysis failed:', error);
    if (previousResult) {
      const wordCount = input.textContent.trim().split(/\s+/).filter(Boolean).length;
      return {
        ...previousResult,
        duplicateStats: {
          ...previousResult.duplicateStats,
          totalWords: wordCount,
        },
        wordCount,
      };
    }
    return createFallbackAnalysis(input.textContent, input.uiLanguage);
  }
};

const createAnalysisInput = (
  editorState: any,
  textContent: string,
  keywords: Keywords,
  goalContext: GoalContext,
  articleLanguage: 'ar' | 'en',
  uiLanguage: 'ar' | 'en',
  updateDuplicateAnalysis: boolean,
): ContentAnalysisInput => ({
  analysisNodes: createAnalysisNodesFromEditorState(editorState),
  textContent: typeof textContent === 'string' ? textContent : '',
  keywords,
  goalContext,
  articleLanguage,
  uiLanguage,
  tableCount: countNodesByType(editorState, 'table'),
  updateDuplicateAnalysis,
});

const getStructureStats = (structureAnalysis: StructureAnalysis, paragraphCount: number, headingCount: number) => ({
  violatingCriteriaCount: Object.values(structureAnalysis).filter(c => c.status === 'fail').length,
  totalErrorsCount: Object.values(structureAnalysis).reduce((sum, c) => sum + (c.violationCount ?? c.violatingItems?.length ?? 0), 0),
  paragraphCount,
  headingCount,
});

const mergePreviousDuplicateResults = (nextResult: FullAnalysis, previousResult: FullAnalysis | null, updateDuplicateAnalysis: boolean): FullAnalysis => {
  if (updateDuplicateAnalysis || !previousResult) return nextResult;

  const structureAnalysis = {
    ...nextResult.structureAnalysis,
    repeatedBigrams: previousResult.structureAnalysis.repeatedBigrams,
  };

  return {
    ...nextResult,
    structureAnalysis,
    structureStats: getStructureStats(
      structureAnalysis,
      nextResult.structureStats.paragraphCount,
      nextResult.structureStats.headingCount,
    ),
    duplicateAnalysis: previousResult.duplicateAnalysis,
    duplicateStats: previousResult.duplicateStats,
  };
};

export const useContentAnalysis = (
  editorState: any,
  textContent: string,
  keywords: Keywords,
  goalContext: GoalContext,
  articleLanguage: 'ar' | 'en',
  uiLanguage: 'ar' | 'en',
  updateDuplicateAnalysis = true,
  enabled = true,
): FullAnalysis => {
  const [analysisResults, setAnalysisResults] = useState<FullAnalysis>(() =>
    runContentAnalysisSafely(createAnalysisInput(editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, true))
  );
  const [workerDisabled, setWorkerDisabled] = useState(false);
  const activeWorkerRef = useRef<Worker | null>(null);
  const latestRequestIdRef = useRef(0);
  const latestAnalysisRef = useRef<FullAnalysis>(analysisResults);

  const setLatestAnalysisResults = (nextResult: FullAnalysis) => {
    latestAnalysisRef.current = nextResult;
    setAnalysisResults(nextResult);
  };

  useEffect(() => {
    return () => {
      activeWorkerRef.current?.terminate();
      activeWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      activeWorkerRef.current?.terminate();
      activeWorkerRef.current = null;
      return;
    }

    const input = createAnalysisInput(editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, updateDuplicateAnalysis);
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;

    const runFallbackAnalysis = () => {
      const result = runContentAnalysisSafely(input, latestAnalysisRef.current);
      setLatestAnalysisResults(mergePreviousDuplicateResults(result, latestAnalysisRef.current, updateDuplicateAnalysis));
    };

    if (workerDisabled || typeof Worker === 'undefined') {
      runFallbackAnalysis();
      return;
    }

    activeWorkerRef.current?.terminate();

    let disposed = false;
    const worker = new Worker(new URL('../workers/contentAnalysis.worker.ts', import.meta.url), { type: 'module' });
    activeWorkerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ContentAnalysisWorkerResponse>) => {
      if (disposed || event.data.requestId !== latestRequestIdRef.current) return;
      worker.terminate();
      if (activeWorkerRef.current === worker) {
        activeWorkerRef.current = null;
      }

      if (event.data.result) {
        setLatestAnalysisResults(mergePreviousDuplicateResults(event.data.result, latestAnalysisRef.current, updateDuplicateAnalysis));
        return;
      }

      console.error('Content analysis worker failed:', event.data.error);
      setWorkerDisabled(true);
      runFallbackAnalysis();
    };

    worker.onerror = (event) => {
      if (disposed) return;
      worker.terminate();
      if (activeWorkerRef.current === worker) {
        activeWorkerRef.current = null;
      }
      console.error('Content analysis worker error:', event.message || event);
      setWorkerDisabled(true);
      runFallbackAnalysis();
    };

    worker.postMessage({ requestId, input });

    return () => {
      disposed = true;
      worker.terminate();
      if (activeWorkerRef.current === worker) {
        activeWorkerRef.current = null;
      }
    };
  }, [editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, updateDuplicateAnalysis, enabled, workerDisabled]);

  return analysisResults;
};
