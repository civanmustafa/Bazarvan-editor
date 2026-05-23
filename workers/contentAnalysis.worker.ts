import type { FullAnalysis } from '../types';
import { runContentAnalysis, type ContentAnalysisInput } from '../utils/analysis/runContentAnalysis';

type ContentAnalysisWorkerRequest = {
  requestId: number;
  input: ContentAnalysisInput;
};

type ContentAnalysisWorkerResponse =
  | { requestId: number; result: FullAnalysis; error?: never }
  | { requestId: number; result?: never; error: string };

self.onmessage = (event: MessageEvent<ContentAnalysisWorkerRequest>) => {
  const { requestId, input } = event.data;

  try {
    const result = runContentAnalysis(input);
    self.postMessage({ requestId, result } satisfies ContentAnalysisWorkerResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ requestId, error: message } satisfies ContentAnalysisWorkerResponse);
  }
};

export {};
