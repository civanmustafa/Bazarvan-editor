import type { ExternalAnalysisJson } from './externalAnalysisQueue';

const ALLOWED_OPERATIONS = new Set([
  'replace_block',
  'replace_text',
  'delete_block',
  'insert_after_heading',
  'insert_before_heading',
  'append_to_section',
  'insert_before_faq',
  'insert_before_conclusion',
  'append_to_article',
]);

export type ExternalEngineeringResult = {
  parsedFromJson: boolean;
  analysisMarkdown: string;
  patches: ExternalAnalysisJson[];
  invalidPatchCount: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const parseJsonRecord = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const source = fenced || trimmed;
  try {
    const parsed = JSON.parse(source);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
};

const normalizeMarker = (value: string, fallback: string): string => {
  const normalized = value
    .normalize('NFKC')
    .replace(/^\[\[PATCH:/i, '')
    .replace(/\]\]$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
};

const normalizePatches = (
  value: unknown,
  commandId: string,
  sequence: number,
): {
  patches: ExternalAnalysisJson[];
  markerMap: Map<string, string>;
  invalidPatchCount: number;
} => {
  if (!Array.isArray(value)) {
    return { patches: [], markerMap: new Map(), invalidPatchCount: 0 };
  }
  const seen = new Set<string>();
  const markerMap = new Map<string, string>();
  let invalidPatchCount = 0;

  const patches = value.flatMap((item, index) => {
    if (!isRecord(item)) {
      invalidPatchCount += 1;
      return [];
    }
    const patch = item;
    const operation = toTrimmedString(patch.operation);
    if (!ALLOWED_OPERATIONS.has(operation)) {
      invalidPatchCount += 1;
      return [];
    }

    const contentMarkdown = toTrimmedString(patch.contentMarkdown ?? patch.content ?? patch.text);
    const targetText = toTrimmedString(patch.targetText);
    if (operation !== 'delete_block' && !contentMarkdown) {
      invalidPatchCount += 1;
      return [];
    }
    if ((operation === 'replace_block' || operation === 'replace_text' || operation === 'delete_block') && !targetText) {
      invalidPatchCount += 1;
      return [];
    }

    const sourceMarker = toTrimmedString(patch.marker) || `patch_${index + 1}`;
    const originalMarker = normalizeMarker(
      sourceMarker,
      `patch_${index + 1}`,
    );
    let marker = `external_${sequence}_${originalMarker}`;
    while (seen.has(marker)) marker = `${marker}_${index + 1}`;
    seen.add(marker);
    markerMap.set(sourceMarker, marker);
    markerMap.set(originalMarker, marker);
    const confidenceValue = typeof patch.confidence === 'number' ? patch.confidence : undefined;

    return [{
      marker,
      commandId,
      operation,
      title: toTrimmedString(patch.title) || `Suggestion ${index + 1}`,
      anchorText: toTrimmedString(patch.anchorText),
      targetText,
      placementLabel: toTrimmedString(patch.placementLabel),
      contentMarkdown,
      reason: toTrimmedString(patch.reason),
      confidence: confidenceValue === undefined
        ? undefined
        : Math.max(0, Math.min(confidenceValue, 1)),
      mergeDeleteTargetText: toTrimmedString(patch.mergeDeleteTargetText),
      mergeDeleteAnchorText: toTrimmedString(patch.mergeDeleteAnchorText),
      mergeDeletePlacementLabel: toTrimmedString(patch.mergeDeletePlacementLabel),
      status: 'pending',
    }];
  });

  return { patches, markerMap, invalidPatchCount };
};

export const parseExternalEngineeringResult = (
  responseText: string,
  commandId: string,
  sequence: number,
): ExternalEngineeringResult => {
  const parsed = parseJsonRecord(responseText);
  if (!parsed) {
    return {
      parsedFromJson: false,
      analysisMarkdown: '',
      patches: [],
      invalidPatchCount: 0,
    };
  }

  let analysisMarkdown = toTrimmedString(
    parsed.analysisMarkdown
    ?? parsed.analysis
    ?? parsed.reportMarkdown
    ?? parsed.report,
  );
  const normalizedPatches = normalizePatches(
    parsed.patches ?? parsed.insertions ?? parsed.contentPatches,
    commandId,
    sequence,
  );
  normalizedPatches.markerMap.forEach((nextMarker, sourceMarker) => {
    analysisMarkdown = analysisMarkdown
      .split(`[[PATCH:${sourceMarker}]]`)
      .join(`[[PATCH:${nextMarker}]]`);
  });

  return {
    parsedFromJson: true,
    analysisMarkdown,
    patches: normalizedPatches.patches,
    invalidPatchCount: normalizedPatches.invalidPatchCount,
  };
};

export const hasUsableExternalEngineeringResult = (
  result: ExternalEngineeringResult,
): boolean => (
  result.parsedFromJson
  && result.invalidPatchCount === 0
  && Boolean(result.analysisMarkdown || result.patches.length > 0)
);
