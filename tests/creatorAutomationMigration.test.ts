import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../supabase/migrations/20260831000000_creator_article_automation.sql', import.meta.url), 'utf8');
const body = (name: string): string => {
  const result = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(result, `${name} must exist`);
  return result[0];
};

test('creator automation rollout cannot enroll saved old articles or follow reassignment', () => {
  const stamp = body('stamp_article_creator_automation_policy');
  assert.match(source, /automation_policy_version smallint not null default 0/);
  assert.match(stamp, /if tg_op = 'UPDATE' then[\s\S]*immutable[\s\S]*return new;[\s\S]*new\.automation_policy_version := case/);
  assert.match(stamp, /new\.created_by := auth\.uid\(\)/);
  assert.match(stamp, /new\.automation_creator_id := new\.created_by/);
  assert.match(stamp, /in \('manual', 'import'\) then 1/);
  const policy = body('article_automation_policy');
  assert.match(policy, /user_id = v_article\.automation_creator_id/);
  assert.doesNotMatch(policy, /assigned_to|owner_id|requested_by/);
  assert.match(policy, /'scope', 'legacy'/);
  assert.match(policy, /v_enabled[\s\S]*v_limits->>v_key[\s\S]*v_personal->>v_key/);
});

test('personal preferences are isolated from global defaults and use the canonical writing cap', () => {
  assert.match(source, /user_automation_settings enable row level security/);
  assert.match(source, /revoke all on public\.user_automation_settings from public, anon, authenticated/);
  assert.match(source, /revoke all on function %s from public, anon, authenticated/);
  assert.match(source, /grant execute on function %s to service_role/);
  assert.doesNotMatch(source, /grant .* to authenticated/);
  assert.match(body('article_automation_admin_limits'), /where key = 'ai'[\s\S]*v_ai->'contentWritingAutomationEnabled'/);
  assert.match(body('reconcile_creator_automation_from_settings'), /new\.key = 'ai'[\s\S]*contentWritingAutomationEnabled/);
  assert.match(body('user_article_automation_defaults'), /value->'userAutomationDefaults'/);
  assert.match(body('normalize_user_automation_preferences'), /Unknown automatic command id/);
  assert.match(body('normalize_user_automation_preferences'), /'\[\]'::jsonb/);
  assert.match(body('save_user_automation_settings'), /reconcile_creator_article_automation\(p_user_id\)/);
});

test('automatic claim guards stop disabled work without counting an unstarted paid attempt', () => {
  const guard = body('guard_creator_automatic_external_job');
  assert.match(guard, /new\.origin <> 'auto' or new\.pipeline_parent_job_id is not null then return new/);
  assert.match(guard, /new\.attempt_count := old\.attempt_count/);
  assert.match(guard, /new\.started_at := old\.started_at/);
  assert.match(guard, /new\.cancel_requested_at := coalesce/);
  assert.match(guard, /if tg_op <> 'UPDATE' or old\.status <> 'running'/);
  assert.doesNotMatch(guard, /new\.result :=/);
  const claim = body('claim_next_external_analysis_job');
  assert.match(claim, /article_automatic_job_allowed\(job\.article_id, job\.job_type, job\.command_id\)/);
  assert.match(claim, /if v_job\.status <> 'running' or v_job\.cancel_requested_at is not null then return; end if;[\s\S]*insert into public\.ai_external_analysis_runs/);
});

test('each semantic target is independent and scoped command selection preserves lifetime guards', () => {
  const semantic = body('enqueue_external_semantic_analysis_job_controlled');
  assert.match(semantic, /v_settings jsonb := public\.article_automation_policy\(p_article_id\)/);
  assert.match(semantic, /v_needs_google_metadata :=[\s\S]*v_settings->>'autoGenerateGoogleMetadata'/);
  assert.match(semantic, /semanticTargetAttempt,googleMetadata/);
  const commands = body('enqueue_external_engineering_jobs_sequential_base_before_google_metadata');
  assert.match(commands, /v_origin = 'auto' and \(v_policy->>'policyVersion'\)::integer = 1/);
  assert.match(commands, /jsonb_array_elements_text\(v_policy->'externalAnalysisCommandIds'\)/);
  assert.match(commands, /previous\.attempt_count > 0[\s\S]*previous\.started_at is not null[\s\S]*previous\.result is not null/);
  assert.match(body('enqueue_automatic_competitor_extraction_for_discovery'), /if not \(v_policy->>'autoExtractCompetitorContent'\)::boolean then return null/);
  assert.match(body('enqueue_automatic_competitor_extraction_for_discovery'), /set origin = case when \(v_policy->>'policyVersion'\)::integer = 1 or v_discovery\.origin = 'auto' then 'auto'/);
});

test('writing never falls back to an assignee or administrator for creator-scoped articles', () => {
  const claim = body('claim_next_content_writing_automation_item');
  assert.match(claim, /article_automatic_job_allowed\(article\.id, 'content_writing'\)/);
  assert.match(claim, /v_article\.automation_policy_version = 1 and profile\.id = v_article\.automation_creator_id/);
  assert.match(claim, /if v_requested_by is null and v_article\.automation_policy_version = 0 then/);
  const preparation = body('enqueue_next_automatic_writing_competitor_preparation');
  assert.match(preparation, /article_automatic_job_allowed\(article\.id, 'content_writing_preparation'\)/);
  assert.match(preparation, /article\.automation_policy_version = 1 and profile\.id = article\.automation_creator_id/);
  assert.match(body('article_automatic_job_allowed'), /when 'content_writing_preparation' then[\s\S]*autoDiscoverCompetitors[\s\S]*autoExtractCompetitorContent/);
  const sessions = body('reconcile_creator_article_automation');
  assert.match(sessions, /session\.context_snapshot->>'triggerSource' = 'automatic_ready'/);
  assert.match(sessions, /session\.status in \('queued', 'retry_scheduled'\)/);
});

test('migration exposes a readiness version without requeueing all articles during deployment', () => {
  assert.match(body('creator_article_automation_schema_version'), /select 1;/);
  assert.doesNotMatch(source, /^select public\.reconcile_/m);
  assert.doesNotMatch(source, /update public\.articles[\s\S]*set automation_policy_version/i);
  assert.match(source.trim(), /commit;$/);
});
