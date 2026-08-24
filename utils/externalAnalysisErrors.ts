const SCHEMA_ERROR_CODES = new Set([
  '42P01',
  '42703',
  '42883',
  'PGRST200',
  'PGRST202',
  'PGRST204',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export type NormalizedExternalAnalysisFailure = {
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export const normalizeExternalAnalysisFailure = (
  error: unknown,
  requestId: string,
  phase = 'request',
): NormalizedExternalAnalysisFailure => {
  const record = isRecord(error) ? error : {};
  const explicitStatus = Number(record.status);
  const rawMessage = error instanceof Error
    ? error.message.trim()
    : toTrimmedString(record.message);
  if (Number.isFinite(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
    const explicitDetails = isRecord(record.details) ? record.details : {};
    return {
      status: explicitStatus,
      code: toTrimmedString(record.code) || 'article_access_policy_failed',
      message: rawMessage || 'External analysis request failed.',
      details: { requestId, phase, ...explicitDetails },
    };
  }

  const databaseCode = toTrimmedString(record.code);
  const schemaUnavailable = SCHEMA_ERROR_CODES.has(databaseCode)
    || /schema cache|column .* does not exist|function .* does not exist|relation .* does not exist/i.test(rawMessage);
  return {
    status: schemaUnavailable ? 503 : 500,
    code: schemaUnavailable ? 'full_pipeline_schema_unavailable' : 'external_analysis_request_failed',
    message: schemaUnavailable
      ? 'The full article workflow database schema is not compatible with this release. Apply the required pipeline migrations.'
      : rawMessage || 'External analysis failed before the request could be completed.',
    details: {
      requestId,
      phase,
      ...(databaseCode ? { databaseCode } : {}),
    },
  };
};
