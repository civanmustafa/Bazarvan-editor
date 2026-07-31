import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importWorkflow = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingWorkflow.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const outlineJson = JSON.stringify({
  sections: [
    { title: 'First topic', brief: 'First coverage brief' },
    { title: 'Second topic', brief: 'Second coverage brief' },
    { title: 'Third topic', brief: 'Third coverage brief' },
    { title: 'Fourth topic', brief: 'Fourth coverage brief' },
  ],
});

test('structured writing parses a bounded outline and creates deterministic sequential steps', async () => {
  const {
    parseContentWritingOutline,
    createContentWritingWorkflowSteps,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(`\`\`\`json\n${outlineJson}\n\`\`\``);
  const steps = createContentWritingWorkflowSteps(outline);

  assert.equal(outline.sections.length, 4);
  assert.deepEqual(steps.map((step: { key: string }) => step.key), [
    'competitor-index',
    'outline',
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'introduction',
    'faq',
    'conclusion',
    'coverage-audit',
    'final-review',
  ]);
  assert.deepEqual(steps.map((step: { ordinal: number }) => step.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('service writing replaces the conclusion stage with a goal-aware call-to-action stage', async () => {
  const {
    parseContentWritingOutline,
    createContentWritingWorkflowSteps,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const steps = createContentWritingWorkflowSteps(outline, {
    pageType: 'service',
    objective: 'convert',
    searchIntent: 'transactional',
  });

  assert.ok(steps.some((step: { key: string; type: string }) => (
    step.key === 'call-to-action' && step.type === 'call_to_action'
  )));
  assert.ok(!steps.some((step: { type: string }) => step.type === 'conclusion'));
});

test('every page type selects its required final section deterministically', async () => {
  const {
    parseContentWritingOutline,
    createContentWritingWorkflowSteps,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const expectedByPageType: Record<string, 'call_to_action' | 'conclusion'> = {
    service: 'call_to_action',
    category: 'call_to_action',
    product: 'call_to_action',
    landing: 'call_to_action',
    article: 'conclusion',
    news: 'conclusion',
    comparison: 'conclusion',
    guide: 'conclusion',
  };

  Object.entries(expectedByPageType).forEach(([pageType, expectedType]) => {
    const steps = createContentWritingWorkflowSteps(outline, { pageType });
    const finalSteps = steps.filter((step: { type: string }) => (
      step.type === 'call_to_action' || step.type === 'conclusion'
    ));
    assert.equal(finalSteps.length, 1, `${pageType} must have exactly one final-section stage`);
    assert.equal(finalSteps[0].type, expectedType);
  });
});

test('structured writing rejects incomplete or duplicate outlines', async () => {
  const { normalizeContentWritingOutline } = await importWorkflow();
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'Two', 'Three'] }), null);
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'One', 'Two', 'Three'] }), null);
});

test('outline fitting satisfies an exact 5-5 policy without discarding overflow evidence', async () => {
  const {
    fitContentWritingOutlineSectionRange,
    parseContentWritingOutline,
  } = await importWorkflow();
  const sixSectionOutline = parseContentWritingOutline(JSON.stringify({
    sections: [
      ...JSON.parse(outlineJson).sections,
      { title: 'Fifth topic', brief: 'Fifth coverage brief', sourceChunkIds: ['C5-S001'] },
      { title: 'Sixth topic', brief: 'Sixth coverage brief', sourceChunkIds: ['C6-S001'] },
    ],
  }));
  const fitted = fitContentWritingOutlineSectionRange(sixSectionOutline, { items: [] }, { min: 5, max: 5 });

  assert.equal(fitted.sections.length, 5);
  assert.match(fitted.sections[4].brief, /Sixth topic/);
  assert.deepEqual(fitted.sections[4].sourceChunkIds, ['C5-S001', 'C6-S001']);

  const expanded = fitContentWritingOutlineSectionRange(
    parseContentWritingOutline(outlineJson),
    {
      items: [{
        id: 'K005',
        topic: 'Fifth documented topic',
        detail: 'Evidence-backed fifth section.',
        priority: 'high',
        coverageCount: 2,
        sourceChunkIds: ['C1-S005'],
      }],
    },
    { min: 5, max: 5 },
  );
  assert.equal(expanded.sections.length, 5);
  assert.equal(expanded.sections[4].title, 'Fifth documented topic');
  assert.deepEqual(expanded.sections[4].sourceChunkIds, ['C1-S005']);
});

test('outline coverage assigns usable claims and excludes blocked claims', async () => {
  const {
    ensureContentWritingOutlineKnowledgeCoverage,
    parseContentWritingOutline,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const covered = ensureContentWritingOutlineKnowledgeCoverage(outline, {
    items: [{
      id: 'K001',
      topic: 'First topic',
      detail: 'A useful fact.',
      sourceChunkIds: ['C1-S001'],
    }],
    claimLedger: {
      claims: [
        {
          id: 'CL001',
          statement: 'A usable fact.',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
          usagePolicy: 'allowed',
        },
        {
          id: 'CL002',
          statement: 'A blocked statistic.',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
          usagePolicy: 'blocked',
        },
      ],
    },
  });

  assert.deepEqual(
    covered.sections.flatMap((section: { requiredClaimIds?: string[] }) => section.requiredClaimIds || []),
    ['CL001'],
  );
  assert.equal(
    covered.sections.some(
      (section: { requiredClaimIds?: string[] }) => section.requiredClaimIds?.includes('CL002'),
    ),
    false,
  );
});

test('competitor analysis prompt appends the editable source and claim ledger command', async () => {
  const { buildContentWritingCompetitorIndexPrompt } = await importWorkflow();
  const prompt = buildContentWritingCompetitorIndexPrompt({
    language: 'ar',
    chunks: [{
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'Source',
      url: 'https://example.com',
      text: 'Source text.',
    }],
  });

  assert.match(prompt, /sourceAssessments/);
  assert.match(prompt, /claims/);
  assert.match(prompt, /محرك المصادر وسجل الادعاءات/);
  assert.match(prompt, /لا تعتبر تكرار الادعاء تحققًا نهائيًا/);
});

test('knowledge reconciliation prompt preserves supported union from two independent readings', async () => {
  const { buildContentWritingKnowledgeReconciliationPrompt } = await importWorkflow();
  const baseKnowledge: any = {
    version: 4,
    competitorCoverageMatrix: {},
    sourceRegistry: { sources: [] },
    claimLedger: {
      claims: [],
      allowedClaimIds: [],
      qualifiedClaimIds: [],
      blockedClaimIds: [],
    },
    processedChunkIds: ['C1-S001'],
    fallbackChunkIds: [],
  };
  const prompt = buildContentWritingKnowledgeReconciliationPrompt({
    language: 'ar',
    chunks: [{
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'Source',
      url: 'https://example.com',
      text: 'Source text.',
    }],
    firstPass: {
      ...baseKnowledge,
      items: [{
        id: 'K001',
        topic: 'الفكرة الأولى',
        detail: 'تفصيل أول',
        sourceChunkIds: ['C1-S001'],
      }],
    },
    secondPass: {
      ...baseKnowledge,
      items: [{
        id: 'K002',
        topic: 'فكرة فريدة',
        detail: 'تفصيل اكتشفته القراءة الثانية',
        sourceChunkIds: ['C1-S001'],
      }],
    },
  });

  assert.match(prompt, /الفكرة الأولى/);
  assert.match(prompt, /فكرة فريدة/);
  assert.match(prompt, /اتحادًا موثقًا لا تصويتًا ولا تقاطعًا/);
  assert.match(prompt, /C1-S001/);
});

test('structured writing assembles one markdown draft without duplicate section headings', async () => {
  const {
    parseContentWritingOutline,
    assembleContentWritingDraft,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const draft = assembleContentWritingDraft({
    articleTitle: 'A useful guide',
    language: 'en',
    outline,
    outputs: {
      introduction: '# Introduction\n\nOpening text.',
      'section-01': '## First topic\n\nFirst body.',
      'section-02': 'Second body.',
      'section-03': 'Third body.',
      'section-04': 'Fourth body.',
      conclusion: 'Closing text.',
      faq: '### What matters?\n\nA clear answer.',
      'call-to-action': '## Contact us now\n\nA stale CTA from another page goal.',
    },
  });

  assert.match(draft, /^# A useful guide/);
  assert.equal((draft.match(/## First topic/g) || []).length, 1);
  assert.match(draft, /## Conclusion/);
  assert.match(draft, /## Frequently asked questions/);
  assert.match(draft, /### What matters\?/);
  assert.doesNotMatch(draft, /stale CTA/);
  assert.ok(
    draft.indexOf('## Frequently asked questions') < draft.indexOf('## Conclusion'),
    'FAQ must appear before the conclusion so the conclusion remains the final H2.',
  );
});

test('draft assembly strips nested final sections and keeps FAQ immediately before one conclusion', async () => {
  const {
    parseContentWritingOutline,
    assembleContentWritingDraft,
    auditContentWritingFinalSectionStructure,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const draft = assembleContentWritingDraft({
    articleTitle: 'Safe article',
    language: 'en',
    outline,
    outputs: {
      introduction: 'Opening.\n\n## Conclusion\n\nLeaked introduction conclusion.',
      'section-01': 'Useful body.\n\n## Conclusion\n\nLeaked body conclusion.',
      'section-02': 'Second body.',
      'section-03': 'Third body.',
      'section-04': 'Fourth body.',
      faq: '## Frequently asked questions\n\n### What is new?\n\nA new answer.\n\n## Conclusion\n\nLeaked FAQ conclusion.',
      conclusion: [
        '## Conclusion',
        '',
        'First generated closing.',
        '',
        '## Conclusion',
        '',
        'The single selected closing.',
      ].join('\n'),
    },
  });
  const audit = auditContentWritingFinalSectionStructure({
    markdown: draft,
    goalContext: { pageType: 'article' },
  });

  assert.equal((draft.match(/^## Conclusion$/gm) || []).length, 1);
  assert.doesNotMatch(draft, /Leaked .* conclusion/);
  assert.match(draft, /The single selected closing/);
  assert.ok(
    draft.indexOf('## Frequently asked questions') < draft.indexOf('## Conclusion'),
  );
  assert.equal(audit.accepted, true);
  assert.deepEqual(audit.reasons, []);
});

test('final structure audit rejects duplicated final sections and FAQ in the wrong position', async () => {
  const { auditContentWritingFinalSectionStructure } = await importWorkflow();
  const duplicate = auditContentWritingFinalSectionStructure({
    markdown: [
      '# Page',
      '## Contact us now',
      'First CTA.',
      '## Frequently asked questions',
      '### Question?',
      'Answer.',
      '## Contact us now',
      'Second CTA.',
    ].join('\n\n'),
    goalContext: { pageType: 'service' },
  });
  const misplaced = auditContentWritingFinalSectionStructure({
    markdown: [
      '# Article',
      '## Frequently asked questions',
      '### Question?',
      'Answer.',
      '## Extra body section',
      'Body.',
      '## Conclusion',
      'Closing.',
    ].join('\n\n'),
    goalContext: { pageType: 'article' },
  });

  assert.equal(duplicate.accepted, false);
  assert.ok(duplicate.reasons.includes('final_structure_duplicate_final_heading'));
  assert.equal(misplaced.accepted, false);
  assert.ok(misplaced.reasons.includes('final_structure_faq_not_penultimate'));
});

test('service writing assembles the generated CTA as the final H2 without adding a conclusion', async () => {
  const {
    parseContentWritingOutline,
    assembleContentWritingDraft,
    auditContentWritingFinalSectionStructure,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const draft = assembleContentWritingDraft({
    articleTitle: 'خدمات التحول الرقمي',
    language: 'ar',
    outline,
    goalContext: { pageType: 'service' },
    primaryKeyword: 'التحول الرقمي',
    outputs: {
      introduction: 'مقدمة الصفحة.',
      'section-01': 'المتن الأول.',
      'section-02': 'المتن الثاني.',
      'section-03': 'المتن الثالث.',
      'section-04': 'المتن الرابع.',
      faq: '### ما الخدمة المناسبة؟\n\nإجابة واضحة.',
      'call-to-action': [
        '## اطلب خدمات التحول الرقمي المناسبة لأعمالك',
        '',
        'نص دعوة الإجراء.',
      ].join('\n'),
    },
  });

  assert.match(draft, /## اطلب خدمات التحول الرقمي المناسبة لأعمالك/);
  assert.doesNotMatch(draft, /## الخاتمة/);
  assert.ok(
    draft.indexOf('## الأسئلة الشائعة') < draft.indexOf('## اطلب خدمات التحول الرقمي'),
    'CTA must be the final H2 after FAQ for service pages.',
  );
  assert.equal(auditContentWritingFinalSectionStructure({
    markdown: draft,
    goalContext: { pageType: 'service' },
  }).accepted, true);
});

test('product writing never restores a conclusion as a fallback final section', async () => {
  const {
    parseContentWritingOutline,
    assembleContentWritingDraft,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const shared = {
    articleTitle: 'Professional camera',
    language: 'en',
    outline,
    goalContext: { pageType: 'product' },
    primaryKeyword: 'professional camera',
  };
  const withCta = assembleContentWritingDraft({
    ...shared,
    outputs: {
      conclusion: 'A legacy conclusion that must never be restored.',
      'call-to-action': '## Order your professional camera today\n\nChoose the suitable model.',
    },
  });
  const withoutCta = assembleContentWritingDraft({
    ...shared,
    outputs: {
      conclusion: 'A legacy conclusion that must never be restored.',
    },
  });

  assert.match(withCta, /## Order your professional camera today/);
  assert.doesNotMatch(withCta, /legacy conclusion/i);
  assert.doesNotMatch(withoutCta, /legacy conclusion/i);
  assert.doesNotMatch(withoutCta, /## Conclusion/);
});

test('call-to-action prompt receives the page goal and enforces CTA criteria instead of conclusion rules', async () => {
  const {
    parseContentWritingOutline,
    buildContentWritingCallToActionPrompt,
  } = await importWorkflow();
  const prompt = buildContentWritingCallToActionPrompt({
    outline: parseContentWritingOutline(outlineJson),
    draft: 'مسودة الصفحة.',
    goalContext: {
      pageType: 'service',
      objective: 'convert',
      searchIntent: 'transactional',
      readerOutcome: 'طلب استشارة',
    },
    primaryKeyword: 'خدمات التحول الرقمي',
    companyName: 'بازارفان',
  });

  assert.match(prompt, /قسم دعوة اتخاذ الإجراء/);
  assert.match(prompt, /خدمات التحول الرقمي/);
  assert.match(prompt, /طلب استشارة/);
  assert.match(prompt, /70-125/);
  assert.match(prompt, /لا تستخدم مؤشرًا ختاميًا/);
});

test('FAQ prompt receives page-specific intents, discovered questions, evidence, and a protected independence protocol', async () => {
  const {
    parseContentWritingOutline,
    buildContentWritingFaqPrompt,
  } = await importWorkflow();
  const prompt = buildContentWritingFaqPrompt({
    outline: parseContentWritingOutline(outlineJson),
    draft: '## المواصفات\n\nيعرض هذا القسم المواصفات المتاحة في جدول واضح.',
    goalContext: {
      pageType: 'product',
      objective: 'convert',
      searchIntent: 'transactional',
    },
    knowledge: {
      version: 3,
      items: [{
        id: 'K001',
        topic: 'اختيار المقاس',
        detail: 'يعتمد الاختيار على عدد المستخدمين.',
        sourceChunkIds: ['C1-S001'],
      }],
      competitorCoverageMatrix: {},
      sourceRegistry: {
        sources: [{ id: 'SRC1' }],
      },
      claimLedger: {
        allowedClaimIds: ['CL001'],
        qualifiedClaimIds: [],
        blockedClaimIds: [],
        claims: [{
          id: 'CL001',
          statement: 'اختيار المقاس يعتمد على عدد المستخدمين.',
        }],
      },
      processedChunkIds: ['C1-S001'],
      fallbackChunkIds: [],
    },
    questionSeeds: [{
      id: 'FQS001',
      question: 'كيف أختار المقاس المناسب؟',
      sourceType: 'people_also_ask',
      sourceChunkIds: ['C1-S001'],
      knowledgeItemIds: ['K001'],
    }],
  });

  assert.match(prompt, /"pageType": "product"/);
  assert.match(prompt, /"intent": "payment"/);
  assert.match(prompt, /كيف أختار المقاس المناسب/);
  assert.match(prompt, /complete_registry_attached_in_session_context/);
  assert.match(prompt, /"allowedClaimIds": \[\s*"CL001"/);
  assert.match(prompt, /mandatory_faq_independence_protocol/);
  assert.match(prompt, /اختلاف الكلمات لا يعني اختلاف الفكرة/);
  assert.match(prompt, /needs_information/);
});

test('generated writing removes bold formatting and normalizes Arabic list markers', async () => {
  const { normalizeFinalContentWritingResult } = await importWorkflow();
  const normalized = normalizeFinalContentWritingResult([
    '**مصطلح أساسي** و__جملة مهمة__ مع <strong>نص ظاهر</strong>.',
    '',
    '١. **العنصر الأول**',
    '۲) العنصر الثاني',
    '• العنصر الثالث',
  ].join('\n'));

  assert.doesNotMatch(normalized, /\*\*|__|<\/?(?:strong|b)\b/i);
  assert.match(normalized, /مصطلح أساسي وجملة مهمة مع نص ظاهر/);
  assert.match(normalized, /^1\. العنصر الأول$/m);
  assert.match(normalized, /^2\. العنصر الثاني$/m);
  assert.match(normalized, /^- العنصر الثالث$/m);
});

test('stopped writing recovers only completed prose stages as an importable partial draft', async () => {
  const { recoverContentWritingDraft } = await importWorkflow();
  const recovered = recoverContentWritingDraft({
    articleTitle: 'A useful guide',
    language: 'en',
    steps: [
      {
        stepKey: 'competitor-index',
        stepType: 'competitor_index',
        ordinal: 1,
        status: 'completed',
        outputText: 'RAW COMPETITOR ANALYSIS',
      },
      {
        stepKey: 'outline',
        stepType: 'outline',
        ordinal: 2,
        status: 'completed',
        outputText: outlineJson,
        metadata: { outline: JSON.parse(outlineJson) },
      },
      {
        stepKey: 'section-01',
        stepType: 'section',
        ordinal: 3,
        status: 'completed',
        outputText: 'Original first section.',
      },
      {
        stepKey: 'section-02',
        stepType: 'section',
        ordinal: 4,
        status: 'completed',
        outputText: 'Completed second section.',
      },
      {
        stepKey: 'section-03',
        stepType: 'section',
        ordinal: 5,
        status: 'failed',
        outputText: 'INVALID FAILED OUTPUT',
      },
      {
        stepKey: 'section-repair-01',
        stepType: 'section_repair',
        ordinal: 12,
        status: 'completed',
        outputText: 'Repaired first section.',
        metadata: { repairedSectionKey: 'section-01' },
      },
    ],
  });

  assert.ok(recovered);
  assert.equal(recovered.source, 'assembled_steps');
  assert.equal(recovered.includedStepCount, 3);
  assert.match(recovered.markdown, /^# A useful guide/);
  assert.match(recovered.markdown, /## First topic[\s\S]*Repaired first section\./);
  assert.match(recovered.markdown, /## Second topic[\s\S]*Completed second section\./);
  assert.doesNotMatch(recovered.markdown, /Original first section|RAW COMPETITOR|INVALID FAILED/);
  assert.doesNotMatch(recovered.markdown, /## Third topic|## Fourth topic/);
});

test('stopped writing prefers the latest completed full-draft review over assembled stages', async () => {
  const { recoverContentWritingDraft } = await importWorkflow();
  const recovered = recoverContentWritingDraft({
    articleTitle: 'Saved title',
    language: 'en',
    steps: [
      {
        stepKey: 'outline',
        stepType: 'outline',
        ordinal: 2,
        status: 'completed',
        outputText: outlineJson,
      },
      {
        stepKey: 'final-review',
        stepType: 'final_review',
        ordinal: 11,
        status: 'completed',
        outputText: '# Saved title\n\nFinal reviewed body.',
      },
      {
        stepKey: 'quality-repair-01',
        stepType: 'quality_repair',
        ordinal: 12,
        status: 'failed',
        outputText: '# Saved title\n\nInvalid failed repair.',
      },
    ],
  });

  assert.ok(recovered);
  assert.equal(recovered.source, 'review_step');
  assert.equal(recovered.markdown, '# Saved title\n\nFinal reviewed body.');
});

test('stopped writing recovers only an accepted targeted revision candidate and ignores plan JSON', async () => {
  const { recoverContentWritingDraft } = await importWorkflow();
  const acceptedDraft = '# Saved title\n\nAccepted targeted revision.';
  const recovered = recoverContentWritingDraft({
    articleTitle: 'Saved title',
    language: 'en',
    steps: [
      {
        stepKey: 'outline',
        stepType: 'outline',
        ordinal: 2,
        status: 'completed',
        outputText: outlineJson,
      },
      {
        stepKey: 'final-review',
        stepType: 'final_review',
        ordinal: 11,
        status: 'completed',
        outputText: '{"operations":[{"id":"R001"}]}',
        metadata: {
          revisionPhase: 'plan',
          revisionPlan: { operations: [{ id: 'R001' }] },
        },
      },
      {
        stepKey: 'final-review-apply',
        stepType: 'final_review',
        ordinal: 12,
        status: 'completed',
        outputText: '{"edits":[{"operationId":"R001"}]}',
        metadata: {
          revisionPhase: 'apply',
          revisionDecision: { accepted: true },
          acceptedDraft,
        },
      },
    ],
  });

  assert.ok(recovered);
  assert.equal(recovered.source, 'review_step');
  assert.equal(recovered.markdown, acceptedDraft);
  assert.doesNotMatch(recovered.markdown, /operations|operationId/);
});

test('final review prompts receive the complete assembled draft', async () => {
  const { buildContentWritingFinalReviewPrompt } = await importWorkflow();
  const marker = `START-${'complete body '.repeat(1_000)}-END`;
  const prompt = buildContentWritingFinalReviewPrompt({
    articleTitle: 'Article title',
    draft: marker,
  });

  assert.match(prompt, /START-/);
  assert.match(prompt, /-END/);
  assert.equal(prompt.includes(marker), true);
});

test('editor preparation removes only the generated leading H1 from the article body', async () => {
  const {
    prepareContentWritingResultForEditor,
    contentWritingMarkdownToPlainText,
  } = await importWorkflow();
  const prepared = prepareContentWritingResultForEditor(
    '```markdown\n# A useful guide\n\nOpening **text**.\n\n## First topic\n\nBody.\n```',
    'A useful guide',
  );

  assert.equal(prepared.leadingTitle, 'A useful guide');
  assert.equal(prepared.titleMatchesArticle, true);
  assert.doesNotMatch(prepared.markdown, /^#\s/m);
  assert.match(prepared.markdown, /^## First topic/m);
  assert.equal(contentWritingMarkdownToPlainText(prepared.markdown), 'Opening text. First topic Body.');
});

test('editor preparation flags a generated title that differs from the saved article title', async () => {
  const { prepareContentWritingResultForEditor } = await importWorkflow();
  const prepared = prepareContentWritingResultForEditor('# Different title\n\nBody.', 'Saved title');

  assert.equal(prepared.leadingTitle, 'Different title');
  assert.equal(prepared.titleMatchesArticle, false);
  assert.equal(prepared.markdown, 'Body.');
});
