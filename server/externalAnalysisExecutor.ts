import type {
  ExternalAnalysisJob,
  ExternalAnalysisJobType,
  ExternalAnalysisJson,
} from './externalAnalysisQueue';

export interface ExternalAnalysisExecutionContext {
  job: ExternalAnalysisJob;
  workerId: string;
  signal: AbortSignal;
  renewLease: () => Promise<boolean>;
  reportProgress: (update: ExternalAnalysisProgressUpdate) => Promise<boolean>;
}

export interface ExternalAnalysisProgressUpdate {
  progress: ExternalAnalysisJson;
  provider?: string;
  model?: string;
  keyAttempts?: ExternalAnalysisJson[];
}

export interface ExternalAnalysisExecutionResult {
  result: ExternalAnalysisJson;
  progress?: ExternalAnalysisJson;
}

export type ExternalAnalysisJobExecutor = (
  context: ExternalAnalysisExecutionContext,
) => Promise<ExternalAnalysisExecutionResult>;

export class ExternalAnalysisRetryError extends Error {
  readonly code: string;
  readonly retryDelayMinutes?: number;
  readonly progress?: ExternalAnalysisJson;

  constructor(options: {
    message: string;
    code?: string;
    retryDelayMinutes?: number;
    progress?: ExternalAnalysisJson;
  }) {
    super(options.message);
    this.name = 'ExternalAnalysisRetryError';
    this.code = options.code ?? 'external_analysis_retry';
    this.retryDelayMinutes = options.retryDelayMinutes;
    this.progress = options.progress;
  }
}

const executors = new Map<ExternalAnalysisJobType, ExternalAnalysisJobExecutor>();

export const registerExternalAnalysisJobExecutor = (
  jobType: ExternalAnalysisJobType,
  executor: ExternalAnalysisJobExecutor,
): void => {
  if (executors.has(jobType)) {
    throw new Error(`An external analysis executor is already registered for ${jobType}.`);
  }
  executors.set(jobType, executor);
};

export const getExternalAnalysisJobExecutor = (
  jobType: ExternalAnalysisJobType,
): ExternalAnalysisJobExecutor | null => executors.get(jobType) ?? null;

export const getSupportedExternalAnalysisJobTypes = (): ExternalAnalysisJobType[] => (
  Array.from(executors.keys())
);
