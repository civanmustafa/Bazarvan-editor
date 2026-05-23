import { useEffect, useRef, useState } from 'react';
import type { Keywords, FullAnalysis, GoalContext, StructureAnalysis } from '../types';
import { runContentAnalysis, type ContentAnalysisInput } from '../utils/analysis/runContentAnalysis';

type ContentAnalysisWorkerResponse =
  | { requestId: number; result: FullAnalysis; error?: never }
  | { requestId: number; result?: never; error: string };

const createAnalysisInput = (
  editorState: any,
  textContent: string,
  keywords: Keywords,
  goalContext: GoalContext,
  articleLanguage: 'ar' | 'en',
  uiLanguage: 'ar' | 'en',
  updateDuplicateAnalysis: boolean,
): ContentAnalysisInput => ({
  editorState,
  textContent,
  keywords,
  goalContext,
  articleLanguage,
  uiLanguage,
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
): FullAnalysis => {
  const [analysisResults, setAnalysisResults] = useState<FullAnalysis>(() =>
    runContentAnalysis(createAnalysisInput(editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, true))
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
    const input = createAnalysisInput(editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, updateDuplicateAnalysis);
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;

    const runFallbackAnalysis = () => {
      const result = runContentAnalysis(input);
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
  }, [editorState, textContent, keywords, goalContext, articleLanguage, uiLanguage, updateDuplicateAnalysis, workerDisabled]);

  return analysisResults;
};
