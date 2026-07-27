import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importWorkspaceModule = async (relativePath: string): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('n8n leaves the complete general context empty when no context fields are sent', async () => {
  const { getGoalContextPayload } = await importWorkspaceModule('../api/n8nArticles.ts');

  assert.deepEqual(getGoalContextPayload({
    title: 'Article without context',
    plainText: 'Body',
  }), {});
  assert.deepEqual(getGoalContextPayload({
    goalContext: {
      pageType: ' ',
      objective: '',
      targetWordRange: null,
    },
  }), {});
});

test('n8n accepts every general-context field in snake case including the word range', async () => {
  const { getGoalContextPayload } = await importWorkspaceModule('../api/n8nArticles.ts');
  const result = getGoalContextPayload({
    general_context: {
      target_word_range: '١٢٠٠/١٨٠٠',
      page_type: 'article',
      page_objective: 'educate',
      audience_scope: 'country',
      target_country: 'تركيا',
      target_audience: [
        'business-owners',
        { value: 'decision-makers' },
        'business-owners',
      ],
      audience_knowledge_level: ['beginner', 'non-technical'],
      audience_needs: 'clear-practical-answers',
      reader_outcome: 'make-informed-decision',
      desired_action: 'request-service-contact',
      marketing_stage: 'consideration',
      unique_angle: 'practical-actionable',
      evidence_requirements: 'official-primary-sources',
      freshness_requirements: 'recent-prices-dates',
      brand_voice: 'formal-professional',
      topic_sensitivity: 'standard',
      search_intent: 'informational',
      generated_brief: 'موجز قادم من n8n',
    },
  });

  assert.deepEqual(result, {
    targetWordRange: '1200-1800',
    pageType: 'article',
    objective: 'educate',
    audienceScope: 'country',
    targetCountry: 'تركيا',
    targetAudience: 'business-owners || decision-makers',
    audienceKnowledgeLevel: 'beginner || non-technical',
    audienceNeeds: 'clear-practical-answers',
    readerOutcome: 'make-informed-decision',
    desiredAction: 'request-service-contact',
    marketingStage: 'consideration',
    uniqueAngle: 'practical-actionable',
    evidenceRequirements: 'official-primary-sources',
    freshnessRequirements: 'recent-prices-dates',
    brandVoice: 'formal-professional',
    topicSensitivity: 'standard',
    searchIntent: 'informational',
    generatedBrief: 'موجز قادم من n8n',
  });
});

test('n8n accepts direct fields, nested aliases, and structured word ranges with direct precedence', async () => {
  const { getGoalContextPayload } = await importWorkspaceModule('../api/n8nArticles.ts');
  const result = getGoalContextPayload({
    page_type: 'service',
    tone_of_voice: 'clear-simple',
    goalContext: {
      pageType: 'article',
      targetWords: { min: 900, max: 1_300 },
      audienceDescription: 'potential-customers',
      knowledgeLevel: 'intermediate',
      readerNeeds: 'compare-alternatives',
      contentAngle: 'neutral-comparison',
      sourceRequirements: 'studies-statistics',
      informationFreshness: 'reliable-current-sources',
      sensitivity: 'financial',
      smartBrief: 'Nested brief',
    },
  });

  assert.equal(result.pageType, 'service');
  assert.equal(result.targetWordRange, '900-1300');
  assert.equal(result.targetAudience, 'potential-customers');
  assert.equal(result.audienceKnowledgeLevel, 'intermediate');
  assert.equal(result.audienceNeeds, 'compare-alternatives');
  assert.equal(result.uniqueAngle, 'neutral-comparison');
  assert.equal(result.evidenceRequirements, 'studies-statistics');
  assert.equal(result.freshnessRequirements, 'reliable-current-sources');
  assert.equal(result.brandVoice, 'clear-simple');
  assert.equal(result.topicSensitivity, 'financial');
  assert.equal(result.generatedBrief, 'Nested brief');
});

test('n8n accepts separate numeric minimum and maximum word fields', async () => {
  const { getGoalContextPayload } = await importWorkspaceModule('../api/n8nArticles.ts');

  assert.deepEqual(getGoalContextPayload({
    min_words: 1_100,
    max_words: 1_700,
  }), {
    targetWordRange: '1100-1700',
  });
});
