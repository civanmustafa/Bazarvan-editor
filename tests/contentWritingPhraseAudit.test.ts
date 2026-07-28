import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createCompetitorPhraseIntelligence,
  type CompetitorPhraseIntelligenceResult,
} from '../utils/competitorPhraseAnalysis.ts';
import {
  buildContentWritingPhraseAudit,
  getContentWritingPhraseAuditOutput,
} from '../utils/contentWritingPhraseAudit.ts';

test('phrase audit proves attachment separately from visible output matches', () => {
  const intelligence = createCompetitorPhraseIntelligence({
    sources: [
      {
        competitorNumber: 1,
        text: 'content strategy improves organic search. content strategy improves organic search.',
      },
      {
        competitorNumber: 2,
        text: 'content strategy improves organic search for brands.',
      },
    ],
    keywords: {
      primary: 'content strategy',
      secondaries: ['organic search'],
      lsi: [],
    },
  });
  const target = intelligence.mustCover.find(
    item => item.text === 'content strategy improves organic search',
  );
  assert.ok(target?.id);

  const audit = buildContentWritingPhraseAudit({
    stepType: 'section',
    intelligence,
    outputText: [
      '## A useful heading',
      'A content strategy improves organic search when the plan matches user intent.',
      'The content strategy improves organic search over time.',
    ].join('\n'),
  });

  assert.equal(audit.enabled, true);
  assert.equal(audit.attachedToStage, true);
  assert.deepEqual(audit.attachmentModes, ['generation_request', 'compact_article_context']);
  const observed = audit.items.find(item => item.id === target.id);
  assert.equal(observed?.sentToStage, true);
  assert.equal(observed?.observedInOutput, true);
  assert.equal(observed?.outputOccurrenceCount, 2);
  assert.deepEqual(observed?.locations.map(location => location.lineNumber), [2, 3]);
});

test('excluded phrase decisions remain reviewable but are never reported as sent', () => {
  const intelligence: CompetitorPhraseIntelligenceResult = {
    enabled: true,
    analyzedCompetitorCount: 2,
    keywordTerms: ['content'],
    mustCover: [],
    supporting: [],
    review: [],
    lowPriority: [],
    ignored: [{
      id: 'CP001',
      text: 'irrelevant repeated slogan',
      normalizedText: 'irrelevant repeated slogan',
      size: 3,
      totalCount: 2,
      competitorCount: 1,
      competitors: [{ competitorNumber: 1, count: 2 }],
      matchedKeywordTerms: [],
      score: 10,
      decision: 'ignore',
      signalTypes: ['single_competitor_repetition', 'low_keyword_relevance'],
      rationale: 'Low relevance.',
    }],
    items: [],
  };
  intelligence.items = [...intelligence.ignored];

  const audit = buildContentWritingPhraseAudit({
    stepType: 'competitor_index',
    intelligence,
    outputText: 'irrelevant repeated slogan',
  });

  assert.deepEqual(
    audit.attachmentModes,
    ['generation_request', 'direct_stage_instructions'],
  );
  assert.equal(audit.items[0]?.sentToStage, false);
  assert.equal(audit.items[0]?.observedInOutput, true);
  assert.equal(audit.sentPhraseCount, 0);
});

test('accepted candidate article is audited instead of a structured revision response', () => {
  const output = getContentWritingPhraseAuditOutput({
    outputText: '{"operations":[]}',
    metadata: {
      acceptedDraft: '# Article\nA visible accepted draft.',
    },
  });

  assert.equal(output.subject, 'accepted_candidate_article');
  assert.equal(output.text, '# Article\nA visible accepted draft.');
});

test('every writing stage exposes the review panel and workflow persists its audit', async () => {
  const [panel, stagePanel, workflow] = await Promise.all([
    readFile(new URL('../components/ContentWritingPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/ContentWritingStageAuditPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../server/contentWritingWorkflow.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(panel, /<ContentWritingStageAuditPanel/);
  assert.match(stagePanel, /Complete phrase register/);
  assert.match(stagePanel, /Copy stage audit/);
  assert.match(stagePanel, /Where it appears in the stage output/);
  assert.match(workflow, /competitorPhraseAudit/);
  assert.match(workflow, /buildContentWritingPhraseAudit/);
});
