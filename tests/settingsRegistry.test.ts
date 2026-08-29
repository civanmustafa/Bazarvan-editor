import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_VALUES,
  GEMINI_PAID_ANALYSIS_MODEL,
  GEMINI_PAID_MODEL_VALUES,
  MODEL_REGISTRY,
  normalizeGeminiFreeModelId,
  normalizeGeminiPaidModelId,
} from '../constants/modelRegistry.ts';
import {
  ARTICLE_STATUS_VALUES,
  DASHBOARD_ARTICLE_STATUS_TABS,
  DASHBOARD_PREFETCH_ARTICLE_STATUSES,
  isExternalAnalysisArticleStatus,
  normalizeArticleStatus,
} from '../constants/articleStatuses.ts';
import {
  hasPromptTemplateVariable,
  renderPromptTemplateVariables,
} from '../constants/promptTemplateRenderer.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSqlParentheses = (sql: string): void => {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (!quote && character === '-' && next === '-') {
      index = sql.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    assert.ok(depth >= 0, `Unexpected closing parenthesis at character ${index}.`);
  }
  assert.equal(quote, null, 'SQL contains an unterminated quoted value.');
  assert.equal(depth, 0, 'SQL contains mismatched parentheses.');
};

const importSettingsRegistry = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/settingsRegistry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const importAiProviderCapabilities = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/aiProviderCapabilities.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const importPromptRegistry = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/promptRegistry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const importSemanticKeywordPolicy = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/semanticKeywordPolicy.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

test('ModelRegistry owns a unique strongest-to-lightest Gemini order', () => {
  assert.deepEqual(GEMINI_FREE_MODEL_VALUES, [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
  ]);
  assert.equal(GEMINI_FREE_MODEL_VALUES.length, 4);
  assert.equal(GEMINI_ANALYSIS_MODEL, MODEL_REGISTRY.gemini.free[0].id);
  assert.deepEqual(
    GEMINI_FREE_MODEL_VALUES,
    MODEL_REGISTRY.gemini.free.map((model: { id: string }) => model.id),
  );
  assert.equal(new Set(GEMINI_FREE_MODEL_VALUES).size, GEMINI_FREE_MODEL_VALUES.length);
  assert.equal(normalizeGeminiFreeModelId('not-a-model'), GEMINI_ANALYSIS_MODEL);
  assert.equal(normalizeGeminiFreeModelId('gemini-2.5-flash'), GEMINI_ANALYSIS_MODEL);
  assert.deepEqual(
    new Set(GEMINI_PAID_MODEL_VALUES),
    new Set(MODEL_REGISTRY.gemini.paid.map(model => model.id)),
  );
  assert.equal(GEMINI_PAID_ANALYSIS_MODEL, 'gemini-3.1-pro-preview');
  assert.equal(
    GEMINI_PAID_MODEL_VALUES.some(model => new Set<string>(GEMINI_FREE_MODEL_VALUES).has(model)),
    false,
  );
  assert.equal(normalizeGeminiPaidModelId('not-a-model'), GEMINI_PAID_ANALYSIS_MODEL);
});

test('Gemini free model upgrade starts existing users on the new strongest model once', async () => {
  const registry = await importSettingsRegistry();
  const upgradedSystem = registry.normalizeSystemSettingsMap({
    ai: {
      settingsRegistryVersion: registry.SETTINGS_REGISTRY_VERSION - 1,
      defaultGeminiModel: 'gemini-3.5-flash',
    },
  });
  assert.equal(upgradedSystem.ai.defaultGeminiModel, 'gemini-3.6-flash');

  const currentSystem = registry.normalizeSystemSettingsMap({
    ai: {
      settingsRegistryVersion: registry.SETTINGS_REGISTRY_VERSION,
      defaultGeminiModel: 'gemini-2.5-pro',
    },
  });
  assert.equal(currentSystem.ai.defaultGeminiModel, 'gemini-2.5-pro');

  const upgradedUser = registry.normalizeUserPreferences({
    schemaVersion: registry.USER_PREFERENCES_SCHEMA_VERSION - 1,
    ai: { defaultGeminiModel: 'gemini-3.5-flash' },
  });
  assert.equal(upgradedUser.ai.defaultGeminiModel, 'gemini-3.6-flash');

  const currentUser = registry.normalizeUserPreferences({
    schemaVersion: registry.USER_PREFERENCES_SCHEMA_VERSION,
    ai: { defaultGeminiModel: 'gemini-2.5-pro' },
  });
  assert.equal(currentUser.ai.defaultGeminiModel, 'gemini-2.5-pro');
});

test('SettingsRegistry validates system settings and discards unknown fields', async () => {
  const registry = await importSettingsRegistry();
  const normalized = registry.normalizeSystemSettingsMap({
    ai: {
      defaultGeminiModel: 'unknown-model',
      defaultGeminiPaidModel: 'unknown-paid-model',
      externalAnalysisRetryMinutes: 1,
      contentWritingInstructionsTemplate: 'تعليمات مخصصة',
      contentWritingMaxInputTokens: 1,
      contentWritingQualityPolicyVersion: 999,
      contentWritingMinimumQualityScore: 1,
      contentWritingMaxRepairPasses: 99,
      contentWritingQualityOverrideReasonRequired: false,
      contentWritingCompetitorPhraseIntelligenceEnabled: false,
      contentWritingDualKnowledgeExtractionEnabled: false,
      contentWritingMultiCandidateGenerationEnabled: false,
      contentWritingResumeModel: '  openai::gpt-4.1-mini  ',
      contentWritingAutomationEnabled: true,
      contentWritingAutomationIntervalMinutes: 99_999,
      contentWritingAutomationProvider: 'invalid-provider',
      contentWritingAutomationModel: '  gemini-custom-model  ',
      contentWritingAutomationMinimumCompetitors: 99,
      contentWritingAutomationRequireCompetitorTerminalState: false,
      contentWritingAutomationMaxAttempts: 99,
      contentWritingAutomationRetryMinutes: 0,
      unknownSecret: 'must-not-survive',
    },
    articles: {
      trashRetentionDays: 99_999,
      defaultLanguage: 'invalid',
      defaultStatus: 'content_preparation',
    },
    system: {
      autoGenerateAlternativeKeywords: false,
      autoGenerateLsiKeywords: false,
      autoDiscoverCompetitors: false,
      autoRunReadyEngineeringCommands: false,
      autoGenerateMetaDescription: false,
      unknownAutomationSwitch: true,
    },
  });

  assert.equal(normalized.ai.defaultGeminiModel, GEMINI_ANALYSIS_MODEL);
  assert.equal(normalized.ai.defaultGeminiPaidModel, GEMINI_PAID_ANALYSIS_MODEL);
  assert.equal(normalized.ai.externalAnalysisRetryMinutes, 5);
  assert.equal(normalized.ai.contentWritingInstructionsTemplate, 'تعليمات مخصصة');
  assert.equal(normalized.ai.contentWritingMaxInputTokens, 10_000);
  assert.equal(normalized.ai.contentWritingQualityPolicyVersion, 1);
  assert.equal(normalized.ai.contentWritingMinimumQualityScore, 50);
  assert.equal(normalized.ai.contentWritingMaxRepairPasses, 3);
  assert.equal(normalized.ai.contentWritingQualityOverrideReasonRequired, false);
  assert.equal(normalized.ai.contentWritingCompetitorPhraseIntelligenceEnabled, false);
  assert.equal(normalized.ai.contentWritingDualKnowledgeExtractionEnabled, false);
  assert.equal(normalized.ai.contentWritingMultiCandidateGenerationEnabled, false);
  assert.equal(normalized.ai.contentWritingResumeModel, 'openai::gpt-4.1-mini');
  assert.equal(normalized.ai.contentWritingAutomationEnabled, true);
  assert.equal(normalized.ai.contentWritingAutomationIntervalMinutes, 1_440);
  assert.equal(normalized.ai.contentWritingAutomationProvider, 'gemini');
  assert.equal(normalized.ai.contentWritingAutomationModel, 'gemini-custom-model');
  assert.equal(normalized.ai.contentWritingAutomationMinimumCompetitors, 5);
  assert.equal(normalized.ai.contentWritingAutomationRequireCompetitorTerminalState, false);
  assert.equal(normalized.ai.contentWritingAutomationMaxAttempts, 10);
  assert.equal(normalized.ai.contentWritingAutomationRetryMinutes, 1);
  assert.equal(normalized.ai.unknownSecret, undefined);
  assert.equal(normalized.articles.trashRetentionDays, 3_650);
  assert.equal(normalized.articles.defaultLanguage, 'ar');
  assert.equal(normalized.articles.defaultStatus, 'content_preparation');
  assert.equal(normalized.system.autoGenerateAlternativeKeywords, false);
  assert.equal(normalized.system.autoGenerateLsiKeywords, false);
  assert.equal(normalized.system.autoDiscoverCompetitors, false);
  assert.equal(normalized.system.autoRunReadyEngineeringCommands, false);
  assert.equal(normalized.system.autoGenerateMetaDescription, false);
  assert.equal(normalized.system.unknownAutomationSwitch, undefined);

  const defaults = registry.getDefaultSystemSettings();
  assert.equal(defaults.system.autoGenerateAlternativeKeywords, true);
  assert.equal(defaults.system.autoGenerateLsiKeywords, true);
  assert.equal(defaults.system.autoDiscoverCompetitors, true);
  assert.equal(defaults.system.autoRunReadyEngineeringCommands, true);
  assert.equal(defaults.system.autoGenerateMetaDescription, true);
  const invalidAutomation = registry.normalizeSystemSettingsMap({
    system: {
      autoGenerateAlternativeKeywords: 'yes',
      autoGenerateLsiKeywords: 1,
      autoDiscoverCompetitors: null,
      autoRunReadyEngineeringCommands: 'yes',
      autoGenerateMetaDescription: 'yes',
    },
  });
  assert.equal(invalidAutomation.system.autoGenerateAlternativeKeywords, true);
  assert.equal(invalidAutomation.system.autoGenerateLsiKeywords, true);
  assert.equal(invalidAutomation.system.autoDiscoverCompetitors, true);
  assert.equal(invalidAutomation.system.autoRunReadyEngineeringCommands, true);
  assert.equal(invalidAutomation.system.autoGenerateMetaDescription, true);
});

test('AI capabilities expose an optional normalized content-writing resume model', async () => {
  const capabilities = await importAiProviderCapabilities();
  const normalized = capabilities.normalizeAiProviderCapabilities({
    contentWriting: {
      resumeModel: { provider: 'openai', model: '  gpt-4.1-mini  ' },
    },
  });
  assert.deepEqual(normalized.contentWriting.resumeModel, {
    provider: 'openai',
    model: 'gpt-4.1-mini',
  });
  assert.equal(
    capabilities.normalizeAiProviderCapabilities({
      contentWriting: { resumeModel: { provider: 'invalid', model: 'x' } },
    }).contentWriting.resumeModel,
    null,
  );
});

test('PromptRegistry keeps Arabic defaults, required attachments, and valid administrator overrides', async () => {
  const registry = await importPromptRegistry();
  const definition = registry.PROMPT_REGISTRY_DEFINITIONS.find(
    (item: { id: string }) => item.id === registry.PROMPT_TEMPLATE_IDS.bodySection,
  );
  assert.ok(definition);
  assert.ok(definition.attachments.some(
    (attachment: { id: string }) => attachment.id === 'coverageLedger',
  ));
  assert.match(registry.DEFAULT_PROMPT_TEMPLATES[definition.id], /سجل التغطية بين الأقسام/);

  const customized = registry.DEFAULT_PROMPT_TEMPLATES[definition.id]
    .replace('نفّذ كتابة قسم المتن', 'اكتب القسم المطلوب بعناية');
  const normalized = registry.normalizePromptRegistrySettings({
    templates: {
      [definition.id]: customized,
      [registry.PROMPT_TEMPLATE_IDS.outline]: 'نص ناقص بلا المتغيرات المطلوبة',
      unknownPrompt: 'يجب تجاهله',
    },
  });
  assert.equal(normalized.templates[definition.id], customized);
  assert.equal(
    normalized.templates[registry.PROMPT_TEMPLATE_IDS.outline],
    registry.DEFAULT_PROMPT_TEMPLATES[registry.PROMPT_TEMPLATE_IDS.outline],
  );
  assert.equal(normalized.templates.unknownPrompt, undefined);

  const internalLinkDefinition = registry.PROMPT_REGISTRY_DEFINITIONS.find(
    (item: { id: string }) => item.id === registry.PROMPT_TEMPLATE_IDS.internalLinkReview,
  );
  assert.ok(internalLinkDefinition);
  assert.equal(internalLinkDefinition.group, registry.PROMPT_GROUP_IDS.internalLinking);
  assert.deepEqual(internalLinkDefinition.requiredVariables, [
    'article_title',
    'article_language',
    'candidate_suggestions_json',
    'quality_rules_json',
  ]);
  assert.deepEqual(
    internalLinkDefinition.attachments.map((attachment: { id: string }) => attachment.id),
    [
      'candidateParagraphs',
      'targetPages',
      'algorithmEvidence',
      'allowedAnchors',
      'qualityPolicy',
    ],
  );
  assert.match(
    registry.DEFAULT_PROMPT_TEMPLATES[registry.PROMPT_TEMPLATE_IDS.internalLinkReview],
    /لا تنشئ Anchor Text جديدًا/,
  );

  const semanticDefinition = registry.PROMPT_REGISTRY_DEFINITIONS.find(
    (item: { id: string }) => item.id === registry.PROMPT_TEMPLATE_IDS.semanticKeywordsGeneration,
  );
  assert.ok(semanticDefinition);
  assert.equal(semanticDefinition.group, registry.PROMPT_GROUP_IDS.semanticKeywords);
  assert.deepEqual(semanticDefinition.requiredVariables, [
    'primary_keyword',
    'article_language',
    'goal_context',
    'protected_constraints',
  ]);
  assert.match(
    registry.DEFAULT_PROMPT_TEMPLATES[semanticDefinition.id],
    /المفرد في بعض الصيغ والجمع في صيغ أخرى/,
  );
  assert.match(registry.DEFAULT_PROMPT_TEMPLATES[semanticDefinition.id], /«أفضل» و«أحسن»/);
});

test('one prompt renderer supports current and saved legacy placeholder syntax', async () => {
  const registry = await importPromptRegistry();
  const mixedTemplate = 'العنوان: {{ title }}\nالنص القديم: ${title}\nالقيمة: {{value}}';
  const variables = { title: 'اختبار', value: 0 };

  assert.equal(
    renderPromptTemplateVariables(mixedTemplate, variables),
    'العنوان: اختبار\nالنص القديم: اختبار\nالقيمة: 0',
  );
  assert.equal(registry.renderPromptTemplate(mixedTemplate, variables), (
    renderPromptTemplateVariables(mixedTemplate, variables)
  ));
  assert.equal(hasPromptTemplateVariable(mixedTemplate, 'title'), true);
  assert.equal(
    renderPromptTemplateVariables('{{article}} / {{keyword}}', {
      article: 'نص يتضمن {{keyword}} كما كتبه المستخدم',
      keyword: 'قيمة مستقلة',
    }),
    'نص يتضمن {{keyword}} كما كتبه المستخدم / قيمة مستقلة',
  );

  const outlineDefinition = registry.PROMPT_REGISTRY_DEFINITIONS.find(
    (item: { id: string }) => item.id === registry.PROMPT_TEMPLATE_IDS.outline,
  );
  assert.ok(outlineDefinition);
  const savedLegacyTemplate = outlineDefinition.requiredVariables
    .map((variable: string) => `\${${variable}}`)
    .join('\n');
  assert.equal(registry.inspectPromptTemplate(outlineDefinition, savedLegacyTemplate).valid, true);
  assert.equal(
    registry.normalizePromptRegistrySettings({
      templates: { [outlineDefinition.id]: savedLegacyTemplate },
    }).templates[outlineDefinition.id],
    savedLegacyTemplate,
  );
});

test('semantic keyword policy preserves numbers, places, and nationalities deterministically', async () => {
  const [policy, registry] = await Promise.all([
    importSemanticKeywordPolicy(),
    importPromptRegistry(),
  ]);
  const input = {
    title: 'أفضل المطاعم',
    plainText: '',
    articleLanguage: 'ar',
    primaryKeyword: 'أفضل ١٠ مطاعم في دبي',
    companyName: 'بازارفان',
    existingSecondaries: [] as string[],
    existingLsi: [] as string[],
    goalContext: {
      objective: 'compare',
      searchIntent: 'commercial',
      targetCountry: 'دبي',
    },
  };
  const response = JSON.stringify({
    protectedQualifiers: ['دبي'],
    secondaries: [
      'أحسن 10 مطعم في دبي',
      'دليل ١٠ مطاعم داخل دبي',
      'ما أحسن 10 مطعم في دبي',
      'قائمة 10 مطاعم مميزة في دبي',
      'أفضل مطاعم دبي',
      'أفضل 10 مطاعم في أبوظبي',
      'أفضل 10 مطاعم في دبي 2026',
    ],
    lsi: [
      'تقييمات الزوار',
      'جودة الطعام',
      'تنوع المأكولات',
      'أجواء المكان',
      'مواعيد العمل',
      'الحجز المسبق',
      'مواقف السيارات',
      'خيارات العائلات',
      'قوائم الطعام',
      'تجربة الضيوف',
    ],
  });

  const terms = policy.parseSemanticKeywordTerms(response, input);
  assert.deepEqual(terms.secondaries, [
    'أحسن 10 مطعم في دبي',
    'دليل ١٠ مطاعم داخل دبي',
    'ما أحسن 10 مطعم في دبي',
    'قائمة 10 مطاعم مميزة في دبي',
  ]);
  assert.equal(policy.hasUsableSemanticKeywordTerms(terms, true, true), true);

  const prompt = policy.renderSemanticKeywordPrompt(
    input,
    registry.DEFAULT_PROMPT_TEMPLATES[registry.PROMPT_TEMPLATE_IDS.semanticKeywordsGeneration],
  );
  assert.match(prompt, /قيد الرقم نشط لأن الكلمة الأساسية تحتوي: 10/);
  assert.match(prompt, /قيد الموقع نشط لأن الكلمة الأساسية تحتوي: دبي/);
  assert.match(prompt, /قيد القومية غير نشط/);
  assert.match(prompt, /لا يُشترط تكرار الرقم أو الموقع أو القومية داخل كلمات LSI/);

  const nationalityInput = {
    ...input,
    primaryKeyword: 'أفضل 5 أطباق للسعوديين',
    goalContext: {},
  };
  const nationalityTerms = policy.parseSemanticKeywordTerms(JSON.stringify({
    protectedQualifiers: ['السعوديين'],
    secondaries: [
      'أحسن 5 أطباق سعودية',
      'قائمة 5 أكلات للسعوديين',
      'ما أفضل 5 وجبات سعودية',
      'أشهر 5 أطباق سعودي',
      'أفضل 5 أطباق خليجية',
    ],
    lsi: Array.from({ length: 10 }, (_, index) => `مصطلح دلالي ${index + 1}`),
  }), nationalityInput);
  assert.equal(nationalityTerms.secondaries.length, 4);
  assert.ok(nationalityTerms.secondaries.every(
    (term: string) => /سعود/u.test(policy.normalizeSemanticKeywordText(term)),
  ));
});

test('semantic keyword constraints activate independently from the primary keyword only', async () => {
  const policy = await importSemanticKeywordPolicy();
  const baseInput = {
    title: '',
    plainText: '',
    articleLanguage: 'ar',
    companyName: 'بازارفان',
    existingSecondaries: [] as string[],
    existingLsi: [] as string[],
    goalContext: {},
  };

  const noConstraintInput = {
    ...baseInput,
    primaryKeyword: 'أفضل أدوات التسويق الرقمي',
  };
  assert.deepEqual(policy.getSemanticKeywordConstraints(noConstraintInput), {
    numbers: [],
    locations: [],
    nationalities: [],
    qualifiers: [],
  });
  const unconstrainedTerms = policy.parseSemanticKeywordTerms(JSON.stringify({
    secondaries: [
      'أحسن أدوات التسويق الإلكتروني',
      'أدوات فعالة للتسويق الرقمي',
      'ما أفضل أدوات التسويق عبر الإنترنت',
      'حلول تسويق رقمي احترافية',
    ],
    lsi: [
      'تحليل الجمهور',
      'رحلة العميل',
      'قياس التحويل',
      'إدارة الحملات',
      'تحسين الإعلانات',
      'استراتيجية المحتوى',
      'تقسيم السوق',
      'مؤشرات الأداء',
      'أتمتة العمليات',
      'اتجاهات 2026',
    ],
  }), noConstraintInput);
  assert.equal(policy.hasUsableSemanticKeywordTerms(unconstrainedTerms, true, true), true);

  const partialTerms = {
    secondaries: [
      'أحسن أدوات التسويق الإلكتروني',
      'حلول تسويق رقمي احترافية',
    ],
    lsi: [
      'تحليل الجمهور',
      'رحلة العميل',
      'قياس التحويل',
      'إدارة الحملات',
      'تحسين الإعلانات',
      'استراتيجية المحتوى',
    ],
  };
  assert.equal(
    policy.hasUsableSemanticKeywordTerms(partialTerms, true, true),
    true,
    'valid partial results must be accepted below the 4/10 generation targets',
  );
  assert.equal(
    policy.hasUsableSemanticKeywordTerms({ secondaries: partialTerms.secondaries, lsi: [] }, true, true),
    true,
    'alternative forms must be accepted even when LSI is empty',
  );
  assert.equal(
    policy.hasUsableSemanticKeywordTerms({ secondaries: [], lsi: partialTerms.lsi }, true, true),
    true,
    'LSI terms must be accepted even when alternative forms are empty',
  );
  assert.equal(
    policy.hasUsableSemanticKeywordTerms({ secondaries: [], lsi: [] }, true, true),
    false,
    'a retry is still required when no requested list contains a valid item',
  );

  const numberOnly = policy.getSemanticKeywordConstraints({
    ...baseInput,
    primaryKeyword: 'أفضل 7 أدوات إدارة مشاريع',
  });
  assert.deepEqual(numberOnly.numbers, ['7']);
  assert.deepEqual(numberOnly.locations, []);
  assert.deepEqual(numberOnly.nationalities, []);

  const locationOnly = policy.getSemanticKeywordConstraints({
    ...baseInput,
    primaryKeyword: 'خدمات المحاسبة في دبي',
  });
  assert.deepEqual(locationOnly.numbers, []);
  assert.deepEqual(locationOnly.locations, ['دبي']);
  assert.deepEqual(locationOnly.nationalities, []);

  const nationalityOnly = policy.getSemanticKeywordConstraints({
    ...baseInput,
    primaryKeyword: 'أكلات مناسبة للعراقيين',
  });
  assert.deepEqual(nationalityOnly.numbers, []);
  assert.deepEqual(nationalityOnly.locations, []);
  assert.deepEqual(nationalityOnly.nationalities, ['عراقي']);

  const allConstraints = policy.getSemanticKeywordConstraints({
    ...baseInput,
    primaryKeyword: 'أفضل 5 مطاعم عراقية في دبي',
  });
  assert.deepEqual(allConstraints.numbers, ['5']);
  assert.deepEqual(allConstraints.locations, ['دبي']);
  assert.deepEqual(allConstraints.nationalities, ['عراقي']);

  const failureMessage = policy.describeSemanticKeywordValidationFailure(
    { secondaries: [], lsi: [] },
    { ...baseInput, primaryKeyword: 'أفضل 7 أدوات إدارة مشاريع' },
  );
  assert.match(failureMessage, /لم تُرجع أي صيغة بديلة صالحة/);
  assert.match(failureMessage, /لم تُرجع أي كلمة LSI صالحة/);
  assert.match(failureMessage, /الرقم \(7\)/);
  assert.doesNotMatch(failureMessage, /الموقع \(/);
  assert.doesNotMatch(failureMessage, /القومية \(/);
});

test('administrator prompt registry migration preserves saved templates when repeated', async () => {
  const [migration, conditionalConstraintsMigration, generatedBriefMigration] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260724000000_admin_prompt_registry.sql'),
    readWorkspaceFile('supabase/migrations/20260726050000_conditional_semantic_keyword_constraints.sql'),
    readWorkspaceFile('supabase/migrations/20260726060000_generated_content_brief_text_block.sql'),
  ]);
  assert.match(migration, /insert into public\.app_settings/);
  assert.match(migration, /'prompts'/);
  assert.match(migration, /on conflict \(key\) do update/);
  assert.match(migration, /public\.app_settings\.value -> 'templates'/);
  assertBalancedSqlParentheses(migration);
  assert.match(conditionalConstraintsMigration, /semanticKeywords\.generation/);
  assert.match(conditionalConstraintsMigration, /replace\(/);
  assert.match(conditionalConstraintsMigration, /'10'::jsonb/);
  assertBalancedSqlParentheses(conditionalConstraintsMigration);
  assert.match(generatedBriefMigration, /contentWriting\.contentBriefGeneration/);
  assert.match(generatedBriefMigration, /'11'::jsonb/);
  assert.match(generatedBriefMigration, /value -> 'templates'/);
  assertBalancedSqlParentheses(generatedBriefMigration);
});

test('ArticleStatusRegistry owns workflow states, dashboard priority, and analysis eligibility', () => {
  assert.deepEqual(ARTICLE_STATUS_VALUES, [
    'content_preparation',
    'draft',
    'in_review',
    'published',
    'archived',
  ]);
  assert.deepEqual(DASHBOARD_ARTICLE_STATUS_TABS.slice(0, 4), [
    'all',
    'in_review',
    'content_preparation',
    'draft',
  ]);
  assert.deepEqual(DASHBOARD_PREFETCH_ARTICLE_STATUSES, [
    'in_review',
    'content_preparation',
    'draft',
  ]);
  assert.equal(normalizeArticleStatus('تجهيز محتوى'), 'content_preparation');
  assert.equal(normalizeArticleStatus('ready'), 'in_review');
  assert.equal(isExternalAnalysisArticleStatus('content_preparation'), true);
  assert.equal(isExternalAnalysisArticleStatus('draft'), true);
  assert.equal(isExternalAnalysisArticleStatus('in_review'), false);
});

test('AiProviderCapabilities centrally gates OpenAI and resolves a safe default provider', async () => {
  const {
    getDefaultAiPatchProvider,
    isAiPatchProviderAvailable,
    isAiPatchProviderEnabled,
    normalizeAiProviderCapabilities,
  } = await importAiProviderCapabilities();
  const disabled = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: false, configured: true, model: 'gpt-enabled-but-blocked' },
    },
    defaultProvider: 'openai',
  });
  assert.equal(isAiPatchProviderEnabled(disabled, 'chatgpt'), false);
  assert.equal(isAiPatchProviderAvailable(disabled, 'chatgpt'), false);
  assert.equal(getDefaultAiPatchProvider(disabled), 'gemini');
  assert.equal(disabled.contentWriting.qualityOverrideReasonRequired, true);
  assert.equal(disabled.contentWriting.competitorPhraseIntelligenceEnabled, true);

  const enabled = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: true, configured: true, model: 'gpt-admin-default' },
    },
    defaultProvider: 'openai',
    contentWriting: {
      qualityOverrideReasonRequired: false,
      competitorPhraseIntelligenceEnabled: false,
    },
  });
  assert.equal(isAiPatchProviderEnabled(enabled, 'chatgpt'), true);
  assert.equal(isAiPatchProviderAvailable(enabled, 'chatgpt'), true);
  assert.equal(getDefaultAiPatchProvider(enabled), 'chatgpt');
  assert.equal(enabled.providers.openai.model, 'gpt-admin-default');
  assert.equal(enabled.contentWriting.qualityOverrideReasonRequired, false);
  assert.equal(enabled.contentWriting.competitorPhraseIntelligenceEnabled, false);

  const missingKey = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: true, configured: false, model: 'gpt-no-key' },
    },
    defaultProvider: 'openai',
  });
  assert.equal(isAiPatchProviderEnabled(missingKey, 'chatgpt'), true);
  assert.equal(isAiPatchProviderAvailable(missingKey, 'chatgpt'), false);
  assert.equal(getDefaultAiPatchProvider(missingKey), 'gemini');
});

test('legacy browser preferences migrate without replacing existing online values', async () => {
  const registry = await importSettingsRegistry();
  const legacy = registry.createLegacyUserPreferences({
    preferredTheme: 'light',
    preferredHighlightStyle: 'underline',
    preferredLanguage: 'en',
    clientGoalContexts: { Acme: { objective: 'legacy objective' } },
    engineeringPrompts: { analyzeFull: 'legacy prompt' },
  }, {
    model: 'gemini-2.5-flash',
    allowModelFallback: false,
  });
  const migrated = registry.migrateLegacyUserPreferences({
    schemaVersion: 1,
    appearance: { theme: 'dark' },
    ai: { defaultGeminiModel: 'gemini-2.5-pro' },
  }, legacy);

  assert.equal(migrated.appearance.theme, 'dark');
  assert.equal(migrated.appearance.highlightStyle, 'underline');
  assert.equal(migrated.editor.preferredLanguage, 'en');
  assert.equal(migrated.ai.defaultGeminiModel, GEMINI_ANALYSIS_MODEL);
  assert.equal(migrated.ai.allowGeminiModelFallback, false);
  assert.equal(migrated.clientGoalContexts.Acme.objective, 'legacy objective');
  assert.equal(migrated.engineeringPrompts.analyzeFull, 'legacy prompt');
});

test('browser, API, and worker consume the shared registries', async () => {
  const [geminiApi, aiEngine, settingsApi, assignedAutomation, externalSettings, settingsPage] = await Promise.all([
    readWorkspaceFile('api/gemini.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('api/systemSettings.ts'),
    readWorkspaceFile('api/assignedArticleAutomation.ts'),
    readWorkspaceFile('server/externalAnalysisSettings.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(geminiApi, /server\/aiExecutionEngine/);
  assert.match(aiEngine, /constants\/modelRegistry/);
  assert.match(settingsApi, /constants\/settingsRegistry/);
  assert.match(assignedAutomation, /constants\/modelRegistry/);
  assert.match(externalSettings, /constants\/settingsRegistry/);
  assert.match(externalSettings, /readContentResearchAutomationSettings/);
  assert.match(settingsPage, /constants\/settingsRegistry/);
  assert.match(settingsPage, /جلب الصيغ البديلة تلقائيًا/);
  assert.match(settingsPage, /جلب كلمات LSI تلقائيًا/);
  assert.match(settingsPage, /جلب المنافسين تلقائيًا/);
  assert.match(settingsPage, /updateSetting\('system', 'autoGenerateAlternativeKeywords'/);
  assert.match(settingsPage, /updateSetting\('system', 'autoGenerateLsiKeywords'/);
  assert.match(settingsPage, /updateSetting\('system', 'autoDiscoverCompetitors'/);
  assert.match(settingsPage, /updateSetting\('system', 'autoRunReadyEngineeringCommands'/);
  assert.match(settingsPage, /options=\{GEMINI_PAID_MODEL_OPTIONS\}/);
  assert.doesNotMatch(
    settingsPage,
    /label="موديل Gemini Pro الافتراضي">\s*<TextInput/,
  );
  [geminiApi, aiEngine, settingsApi, assignedAutomation, externalSettings, settingsPage].forEach(source => {
    assert.doesNotMatch(source, /\['gemini-3\.5-flash'/);
  });
});

test('user settings do not duplicate centralized Gemini controls', async () => {
  const settingsPage = await readWorkspaceFile('components/SettingsPage.tsx');
  const personalPreferences = settingsPage.slice(
    settingsPage.indexOf('const renderPersonalPreferences'),
    settingsPage.indexOf('const renderAiSettings'),
  );

  assert.doesNotMatch(personalPreferences, /موديل Gemini الافتراضي/);
  assert.doesNotMatch(personalPreferences, /التبديل بين نماذج جيميني المجانية/);
  assert.match(settingsPage, /موديل Gemini المجاني الافتراضي/);
  assert.match(settingsPage, /التبديل بين موديلات Gemini المجانية/);
});

test('phase 4 migration creates protected durable user preferences', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260713020000_phase_4_settings_and_model_registry.sql',
  );
  assert.match(migration, /create table if not exists public\.user_preferences/);
  assert.match(migration, /alter table public\.user_preferences enable row level security/);
  assert.match(migration, /using \(user_id = auth\.uid\(\)\)/);
  assert.match(migration, /function public\.merge_current_user_preferences\(p_patch jsonb\)/);
  assert.match(migration, /coalesce\(public\.user_preferences\.preferences, '\{\}'::jsonb\)\s*\|\| excluded\.preferences/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});

test('content preparation migration expands status and external-analysis eligibility safely', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260721000000_content_preparation_status.sql',
  );

  assert.match(migration, /articles_status_check/);
  assert.match(migration, /'content_preparation', 'draft', 'in_review', 'published', 'archived'/);
  assert.match(migration, /article_status_supports_external_analysis/);
  assert.match(migration, /in \('content_preparation', 'draft'\)/);
  assert.match(migration, /create or replace function public\.evaluate_external_analysis_readiness/);
  assert.match(migration, /create or replace function public\.evaluate_competitor_discovery_readiness/);
  assert.match(migration, /public\.can_write_article\(target_article_id\)/);
  assertBalancedSqlParentheses(migration);
});

test('administrator AI secret migration keeps encrypted values server-only', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722050000_admin_ai_provider_secrets.sql',
  );

  assert.match(migration, /create table if not exists public\.ai_provider_secrets/);
  assert.match(migration, /provider in \('openai_latest', 'gemini_latest'\)/);
  assert.match(migration, /revoke all on table public\.ai_provider_secrets from anon/);
  assert.match(migration, /revoke all on table public\.ai_provider_secrets from authenticated/);
  assert.match(migration, /to service_role/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});
