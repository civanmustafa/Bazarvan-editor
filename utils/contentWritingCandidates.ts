import {
  countContentWritingTargetWords,
  type ContentWritingWordRange,
} from './contentWritingTargets';
import {
  normalizeContentWritingSectionCoverage,
  type ContentWritingSectionCoverage,
} from './contentWritingKnowledge';

export const CONTENT_WRITING_CANDIDATE_ENGINE_VERSION = 3;
export const CONTENT_WRITING_DEFAULT_CANDIDATE_COUNT = 2;
export const CONTENT_WRITING_MAX_CANDIDATE_COUNT = 3;

export type ContentWritingCandidateStrategy = {
  key: 'balanced' | 'focused_comprehensive' | 'deep_investigative' | 'targeted_recovery';
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
};

export const getContentWritingCandidateStrategy = (
  candidateIndex: number,
): ContentWritingCandidateStrategy => {
  if (candidateIndex === 1) {
    return {
      key: 'focused_comprehensive',
      nameAr: 'الكتابة المركّزة الشاملة',
      nameEn: 'Focused comprehensive writing',
      descriptionAr: 'تغطي جميع الأفكار والأدلة المطلوبة مباشرة وبوضوح، مع تقليل الحشو والتكرار.',
      descriptionEn: 'Covers every required idea and source directly and clearly while minimizing padding and repetition.',
    };
  }
  if (candidateIndex === 2) {
    return {
      key: 'deep_investigative',
      nameAr: 'الكتابة العميقة الاستقصائية',
      nameEn: 'Deep investigative writing',
      descriptionAr: 'تستخدم بناءً مختلفًا وتبحث عن التفاصيل والثغرات والاستثناءات التي قد يغفلها الأسلوب المباشر.',
      descriptionEn: 'Uses a different structure and actively investigates details, gaps, and exceptions a direct draft may miss.',
    };
  }
  if (candidateIndex >= 3) {
    return {
      key: 'targeted_recovery',
      nameAr: 'الكتابة الإصلاحية الموجّهة',
      nameEn: 'Targeted recovery writing',
      descriptionAr: 'مرشح احتياطي يعالج الشروط القاطعة التي لم يجتزها المرشحان الأساسيان.',
      descriptionEn: 'A fallback candidate focused on hard gates missed by the two primary candidates.',
    };
  }
  return {
    key: 'balanced',
    nameAr: 'الكتابة المتوازنة',
    nameEn: 'Balanced writing',
    descriptionAr: 'مرشح واحد يجمع التغطية العميقة مع الوضوح والتركيز وتقليل الحشو.',
    descriptionEn: 'A single candidate combining deep coverage with clarity, focus, and minimal padding.',
  };
};

export type ContentWritingCandidateEvaluation = {
  version: number;
  candidateIndex: number;
  score: number;
  passedHardGates: boolean;
  hardFailures: string[];
  warnings: string[];
  metrics: {
    wordCount: number;
    targetWordRange: ContentWritingWordRange | null;
    requiredIdeaCount: number;
    coveredRequiredIdeaCount: number;
    ideaCoveragePercent: number;
    requiredClaimCount: number;
    usedRequiredClaimCount: number;
    claimCoveragePercent: number;
    blockedClaimCount: number;
    maximumPriorSimilarity: number;
    acceptedFaqCount: number | null;
    qualityScore: number | null;
  };
};

export type ContentWritingCandidateSelection = {
  version: number;
  enabled: true;
  parentStepKey: string;
  mode: 'best_candidate' | 'faq_union';
  selectedCandidateStepKey: string;
  selectedCandidateIndex: number;
  selectionReason: string;
  candidates: Array<ContentWritingCandidateEvaluation & {
    stepKey: string;
    title: string;
    selected: boolean;
  }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const toTextList = (value: unknown): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map(toText).filter(Boolean)))
  : [];

const clamp = (value: number, minimum = 0, maximum = 100): number => (
  Math.max(minimum, Math.min(maximum, value))
);

const tokenize = (value: string): Set<string> => new Set(
  String(value || '')
    .toLocaleLowerCase()
    .replace(/[#*_>`~[\](){}|،؛؟!?.,:/"'«»]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .slice(0, 2_000),
);

const jaccardSimilarity = (left: string, right: string): number => {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) intersection += 1;
  });
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const getMaximumSimilarity = (
  outputText: string,
  comparisonTexts: readonly string[],
): number => comparisonTexts.reduce(
  (maximum, value) => Math.max(maximum, jaccardSimilarity(outputText, value)),
  0,
);

const normalizeWordRange = (
  value: ContentWritingWordRange | null | undefined,
): ContentWritingWordRange | null => {
  if (!value) return null;
  const minimum = Math.max(1, Math.round(Number(value.min) || 0));
  const maximum = Math.max(minimum, Math.round(Number(value.max) || 0));
  return { min: minimum, max: maximum };
};

const getWordRangePenalty = (
  wordCount: number,
  range: ContentWritingWordRange | null,
): { penalty: number; warning: string | null } => {
  if (!range || wordCount <= 0) return { penalty: 0, warning: null };
  if (wordCount >= range.min && wordCount <= range.max) {
    return { penalty: 0, warning: null };
  }
  const distance = wordCount < range.min
    ? range.min - wordCount
    : wordCount - range.max;
  const scale = Math.max(1, Math.round((range.min + range.max) / 2));
  return {
    penalty: clamp(Math.round((distance / scale) * 60), 4, 24),
    warning: 'candidate_word_range_mismatch',
  };
};

const readFaqAcceptedCount = (metadata: Record<string, unknown>): number | null => {
  if (Number.isFinite(Number(metadata.acceptedQuestionCount))) {
    return Math.max(0, Math.round(Number(metadata.acceptedQuestionCount)));
  }
  const audit = isRecord(metadata.faqIndependenceAudit)
    ? metadata.faqIndependenceAudit
    : {};
  return Number.isFinite(Number(audit.acceptedCount))
    ? Math.max(0, Math.round(Number(audit.acceptedCount)))
    : null;
};

const readQualityScore = (metadata: Record<string, unknown>): number | null => {
  const after = isRecord(metadata.qualityReportAfterRevision)
    ? metadata.qualityReportAfterRevision
    : {};
  return Number.isFinite(Number(after.score))
    ? clamp(Math.round(Number(after.score)))
    : null;
};

export const buildContentWritingCandidatePrompt = (options: {
  prompt: string;
  candidateIndex: number;
  stageLabel: string;
  remediationFailures?: readonly string[];
}): string => {
  const strategyDefinition = getContentWritingCandidateStrategy(options.candidateIndex);
  if (options.candidateIndex <= 0) {
    return `${options.prompt}

<protected_single_candidate_protocol>
- طبّق استراتيجية «${strategyDefinition.nameAr}» لمرحلة: ${options.stageLabel}.
- ابدأ بحصر جميع الأفكار والأدلة والشروط المطلوبة، ثم عالجها بعمق كافٍ، وبعد ذلك احذف الحشو والتكرار وحافظ على أوضح صياغة ممكنة.
- Apply the “${strategyDefinition.nameEn}” strategy: secure complete evidence-backed coverage first, then remove padding and repetition while preserving sufficient depth.
- لا تذكر اسم الاستراتيجية أو عملية التوليد داخل النص الناتج.
- التزم تمامًا بعقد الإخراج الأصلي للمرحلة؛ لا تغيّر JSON أو Markdown المطلوب.
</protected_single_candidate_protocol>`;
  }
  const strategy = options.candidateIndex === 1
    ? [
        `طبّق استراتيجية «${strategyDefinition.nameAr}» بمنهج تغطية مباشر: قدّم كل فكرة مطلوبة بوضوح، واربطها بأدلتها، واحترم البنية والميزانية دون حشو.`,
        'Build candidate one with a direct coverage-first approach: express every required idea clearly, preserve evidence, and respect structure and budget without padding.',
      ]
    : options.candidateIndex === 2
      ? [
          `طبّق استراتيجية «${strategyDefinition.nameAr}» وابنِ مرشحًا مستقلًا حقًا ببناء بلاغي وتنظيم مختلفين، وابحث خصوصًا عن التفاصيل التي قد يغفلها الحل المباشر. لا تعِد صياغة مرشح آخر ولا تفترض أنك رأيته.`,
          'Build a genuinely independent candidate with a different rhetorical structure, actively checking for details a direct draft may miss. Do not paraphrase or assume access to another candidate.',
        ]
      : [
          `طبّق استراتيجية «${strategyDefinition.nameAr}» وأنشئ مرشح إنقاذ يعالج البوابات التي لم يجتزها المرشحان السابقان فقط: ${(options.remediationFailures || []).join(', ') || 'متطلبات المرحلة'}.`,
          `Create a recovery candidate focused on the hard gates missed by the earlier candidates: ${(options.remediationFailures || []).join(', ') || 'stage requirements'}.`,
        ];
  return `${options.prompt}

<protected_multi_candidate_protocol>
- هذه محاولة مستقلة رقم ${options.candidateIndex} باسم «${strategyDefinition.nameAr}» لمرحلة: ${options.stageLabel}.
- ${strategy[0]}
- ${strategy[1]}
- لا تذكر وجود مرشحين ولا عملية الاختيار داخل النص الناتج.
- التزم تمامًا بعقد الإخراج الأصلي للمرحلة؛ لا تغيّر JSON أو Markdown المطلوب.
</protected_multi_candidate_protocol>`;
};

export const evaluateContentWritingCandidate = (options: {
  candidateIndex: number;
  outputText: string;
  metadata?: Record<string, unknown>;
  requiredIdeaIds?: readonly string[];
  requiredClaimIds?: readonly string[];
  blockedClaimIds?: readonly string[];
  targetWordRange?: ContentWritingWordRange | null;
  comparisonTexts?: readonly string[];
  requireFaqCandidates?: boolean;
  requireAcceptedRevision?: boolean;
}): ContentWritingCandidateEvaluation => {
  const metadata = options.metadata || {};
  const coverage: ContentWritingSectionCoverage = normalizeContentWritingSectionCoverage(
    metadata.sectionCoverage,
  );
  const requiredIdeaIds = Array.from(new Set(options.requiredIdeaIds || []));
  const requiredClaimIds = Array.from(new Set(options.requiredClaimIds || []));
  const blockedClaimIds = new Set(options.blockedClaimIds || []);
  const coveredIdeaIds = new Set(coverage.coveredIdeaIds);
  const usedClaimIds = new Set(coverage.usedClaimIds);
  const coveredRequiredIdeaCount = requiredIdeaIds.filter(id => coveredIdeaIds.has(id)).length;
  const usedRequiredClaimCount = requiredClaimIds.filter(id => usedClaimIds.has(id)).length;
  const blockedClaimCount = coverage.usedClaimIds.filter(id => blockedClaimIds.has(id)).length;
  const ideaCoveragePercent = requiredIdeaIds.length > 0
    ? Math.round((coveredRequiredIdeaCount / requiredIdeaIds.length) * 100)
    : 100;
  const claimCoveragePercent = requiredClaimIds.length > 0
    ? Math.round((usedRequiredClaimCount / requiredClaimIds.length) * 100)
    : 100;
  const outputText = toText(options.outputText);
  const wordCount = countContentWritingTargetWords(outputText);
  const targetWordRange = normalizeWordRange(options.targetWordRange);
  const maximumPriorSimilarity = getMaximumSimilarity(
    outputText,
    options.comparisonTexts || [],
  );
  const acceptedFaqCount = readFaqAcceptedCount(metadata);
  const qualityScore = readQualityScore(metadata);
  const hardFailures: string[] = [];
  const warnings: string[] = [];

  if (!outputText) hardFailures.push('candidate_empty');
  if (requiredIdeaIds.length > 0 && coveredRequiredIdeaCount < requiredIdeaIds.length) {
    hardFailures.push('candidate_missing_required_ideas');
  }
  if (blockedClaimCount > 0) hardFailures.push('candidate_uses_blocked_claim');
  if (options.requireFaqCandidates && (!acceptedFaqCount || acceptedFaqCount < 1)) {
    hardFailures.push('candidate_has_no_independent_faq');
  }
  if (options.requireAcceptedRevision) {
    const decision = isRecord(metadata.revisionDecision) ? metadata.revisionDecision : {};
    if (decision.accepted !== true || !toText(metadata.acceptedDraft)) {
      hardFailures.push('candidate_revision_rejected');
    }
  }
  if (requiredClaimIds.length > 0 && usedRequiredClaimCount < requiredClaimIds.length) {
    warnings.push('candidate_missing_requested_claims');
  }
  if (maximumPriorSimilarity >= 0.72) {
    warnings.push('candidate_repeats_prior_content');
  }
  const wordRangeResult = getWordRangePenalty(wordCount, targetWordRange);
  if (wordRangeResult.warning) warnings.push(wordRangeResult.warning);

  let score = 100;
  score -= hardFailures.length * 35;
  score -= Math.round((100 - ideaCoveragePercent) * 0.35);
  score -= Math.round((100 - claimCoveragePercent) * 0.08);
  score -= wordRangeResult.penalty;
  score -= maximumPriorSimilarity >= 0.72
    ? Math.round((maximumPriorSimilarity - 0.7) * 55)
    : 0;
  if (acceptedFaqCount !== null) {
    score += acceptedFaqCount >= 4 && acceptedFaqCount <= 6
      ? 5
      : acceptedFaqCount >= 1
        ? 1
        : 0;
  }
  if (qualityScore !== null) {
    score = Math.round((score * 0.45) + (qualityScore * 0.55));
  }

  return {
    version: CONTENT_WRITING_CANDIDATE_ENGINE_VERSION,
    candidateIndex: Math.max(1, Math.round(options.candidateIndex)),
    score: clamp(Math.round(score)),
    passedHardGates: hardFailures.length === 0,
    hardFailures: Array.from(new Set(hardFailures)),
    warnings: Array.from(new Set(warnings)),
    metrics: {
      wordCount,
      targetWordRange,
      requiredIdeaCount: requiredIdeaIds.length,
      coveredRequiredIdeaCount,
      ideaCoveragePercent,
      requiredClaimCount: requiredClaimIds.length,
      usedRequiredClaimCount,
      claimCoveragePercent,
      blockedClaimCount,
      maximumPriorSimilarity: Number(maximumPriorSimilarity.toFixed(3)),
      acceptedFaqCount,
      qualityScore,
    },
  };
};

export const selectBestContentWritingCandidate = <
  T extends { evaluation: ContentWritingCandidateEvaluation },
>(
  candidates: readonly T[],
): T | null => [...candidates].sort((left, right) => (
  Number(right.evaluation.passedHardGates) - Number(left.evaluation.passedHardGates)
  || right.evaluation.score - left.evaluation.score
  || right.evaluation.metrics.ideaCoveragePercent - left.evaluation.metrics.ideaCoveragePercent
  || right.evaluation.metrics.claimCoveragePercent - left.evaluation.metrics.claimCoveragePercent
  || left.evaluation.hardFailures.length - right.evaluation.hardFailures.length
  || left.evaluation.warnings.length - right.evaluation.warnings.length
  || left.evaluation.candidateIndex - right.evaluation.candidateIndex
))[0] || null;

export const getContentWritingCandidateMetadata = (
  value: unknown,
): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  const {
    execution: _execution,
    competitorPhraseAudit: _competitorPhraseAudit,
    candidatePhase: _candidatePhase,
    parentStepKey: _parentStepKey,
    candidateIndex: _candidateIndex,
    candidateLabel: _candidateLabel,
    ...metadata
  } = value;
  return metadata;
};

export const mergeContentWritingCandidateFailureCodes = (
  evaluations: readonly ContentWritingCandidateEvaluation[],
): string[] => Array.from(new Set(
  evaluations.flatMap(evaluation => [
    ...evaluation.hardFailures,
    ...evaluation.warnings,
  ]),
));
