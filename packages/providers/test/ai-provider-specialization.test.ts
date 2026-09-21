// Provider specialization as governed policy (B2).
//
// WHAT THESE PROVE
//
// A TASK DECLARES A CAPABILITY; POLICY PICKS THE PROVIDER. The approved preferences
// (communication -> OpenAI, technical analysis -> Anthropic, general reasoning -> no
// default) are versioned data. The shipped routing policy follows them for every task,
// or the suite fails -- and a departure is only acceptable with a written reason.
//
// PREFERENCE IS NOT FALLBACK. A technical task whose fallback is another provider still
// conforms: the preference decides the primary only.
//
// NO UNIVERSAL FALLBACK ORDER. Neither policy has a platform-wide fallback. A task is
// served by another provider only when its own entry permits it AND names the target,
// in either direction; a task that permits nothing is served by its primary alone.
//
// NO PROVIDER NAME HIDES IN TASK OR RUNTIME CODE. A fence proves the provider ids appear
// only at the provider boundary, the settings catalog and the environment boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_CAPABILITY_ROUTES,
  AI_TASKS,
  AI_TASK_CASE_EXPLANATION,
  aiRoutingConformance,
  aiTaskContractViolations,
  type AiRoutingPolicy,
} from '@emgloop/shared';

import {
  AI_PROVIDER_SPECIALIZATION_POLICY,
  AI_PROVIDER_SPECIALIZATION_POLICY_VERSION,
  AI_ROUTING_POLICY,
  AI_ROUTING_POLICY_VERSION,
} from '../src';

const REPO = join(__dirname, '..', '..', '..');

test('the approved preferences, as recorded on 2026-09-16, versioned and frozen', () => {
  assert.equal(AI_PROVIDER_SPECIALIZATION_POLICY.version, AI_PROVIDER_SPECIALIZATION_POLICY_VERSION);
  assert.match(AI_PROVIDER_SPECIALIZATION_POLICY_VERSION, /^specialization\.\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.deepEqual(Object.keys(AI_PROVIDER_SPECIALIZATION_POLICY.routes).sort(), [...AI_CAPABILITY_ROUTES].sort());
  assert.equal(AI_PROVIDER_SPECIALIZATION_POLICY.routes.COMMUNICATION.preferredProviderId, 'openai');
  assert.equal(AI_PROVIDER_SPECIALIZATION_POLICY.routes.TECHNICAL_ANALYSIS.preferredProviderId, 'anthropic');
  assert.equal(AI_PROVIDER_SPECIALIZATION_POLICY.routes.GENERAL_REASONING.preferredProviderId, null, 'no global default');
  for (const route of AI_CAPABILITY_ROUTES) {
    assert.ok(AI_PROVIDER_SPECIALIZATION_POLICY.routes[route].rationale.trim().length > 20, `${route} says why`);
  }
  assert.ok(Object.isFrozen(AI_PROVIDER_SPECIALIZATION_POLICY));
  assert.ok(Object.isFrozen(AI_PROVIDER_SPECIALIZATION_POLICY.routes));
  assert.ok(Object.isFrozen(AI_PROVIDER_SPECIALIZATION_POLICY.routes.COMMUNICATION));
});

test('the shipped routing policy conforms for every task, and Case Explanation needed no change', () => {
  const report = aiRoutingConformance(AI_TASKS, AI_ROUTING_POLICY, AI_PROVIDER_SPECIALIZATION_POLICY);
  assert.equal(report.length, AI_TASKS.length);
  for (const row of report) assert.deepEqual(row.findings, [], `${row.taskId} conforms`);
  for (const task of AI_TASKS) assert.deepEqual(aiTaskContractViolations(task), [], `${task.taskId} is a coherent task`);

  const caseExplanation = report.find((r) => r.taskId === AI_TASK_CASE_EXPLANATION.taskId)!;
  assert.equal(caseExplanation.capabilityRoute, 'TECHNICAL_ANALYSIS');
  assert.equal(caseExplanation.preferredProviderId, 'anthropic');
  assert.equal(caseExplanation.primaryProviderId, 'anthropic');
  assert.equal(caseExplanation.departure, 'NONE');
  // The version moves when a ROUTE is added, and only then. GM-3 added Mail Reply Draft and the
  // content-triage slice added Telegram Content Triage; Case Explanation's own entry is untouched,
  // which is what the assertions around this one check.
  assert.equal(AI_ROUTING_POLICY_VERSION, 'routing.2026-09-21.4');
  assert.equal(AI_ROUTING_POLICY.tasks['case.explanation']!.providerChoiceReason, undefined);
  // The fallback is another provider, and that is not a departure.
  assert.equal(AI_ROUTING_POLICY.tasks['case.explanation']!.fallback!.providerId, 'openai');
});

function withEntry(taskId: string, over: Record<string, unknown>): AiRoutingPolicy {
  const base = AI_ROUTING_POLICY.tasks['case.explanation']!;
  return { version: 'routing.test', tasks: { [taskId]: { ...base, taskId, ...over } as never } };
}

const target = (providerId: string, modelId: string) => ({ ...AI_ROUTING_POLICY.tasks['case.explanation']!.primary, providerId, modelId });

test('a departure from the preference needs a written reason; a route with no default always does', () => {
  const comms = { taskId: 'message.draft', version: '2.0.0', capabilityRoute: 'COMMUNICATION' };
  const anthropicPrimary = withEntry('message.draft', {});
  assert.deepEqual(aiRoutingConformance([comms], anthropicPrimary, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.findings, [
    'PREFERENCE_DEPARTED_WITHOUT_REASON',
  ]);
  const justified = withEntry('message.draft', { providerChoiceReason: 'Evaluated 2026-10-01: tone fidelity held on the eval set.' });
  const row = aiRoutingConformance([comms], justified, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!;
  assert.deepEqual(row.findings, []);
  assert.equal(row.departure, 'JUSTIFIED');
  const blankReason = withEntry('message.draft', { providerChoiceReason: '   ' });
  assert.deepEqual(aiRoutingConformance([comms], blankReason, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.findings, [
    'PREFERENCE_DEPARTED_WITHOUT_REASON',
  ]);
  const openaiPrimary = withEntry('message.draft', { primary: target('openai', 'model-x'), fallback: target('anthropic', 'model-y') });
  assert.equal(aiRoutingConformance([comms], openaiPrimary, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.departure, 'NONE');

  const general = { taskId: 'misc.reason', version: '2.0.0', capabilityRoute: 'GENERAL_REASONING' };
  assert.deepEqual(aiRoutingConformance([general], withEntry('misc.reason', {}), AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.findings, [
    'NO_DEFAULT_AND_NO_REASON',
  ]);
  const chosen = withEntry('misc.reason', { providerChoiceReason: 'Chosen on the reviewed eval run of 2026-10-02.' });
  assert.equal(aiRoutingConformance([general], chosen, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.departure, 'JUSTIFIED');
});

test('an unknown route, a missing entry, a version the policy was not reviewed against, and a fallback that is the primary', () => {
  const unknown = aiRoutingConformance(
    [{ taskId: 'case.explanation', version: '2.0.0', capabilityRoute: 'EXPLANATION' }],
    AI_ROUTING_POLICY,
    AI_PROVIDER_SPECIALIZATION_POLICY,
  )[0]!;
  assert.ok(unknown.findings.includes('UNKNOWN_CAPABILITY_ROUTE'), 'the retired vocabulary is not a route');
  const missing = aiRoutingConformance(
    [{ taskId: 'nothing.here', version: '1', capabilityRoute: 'TECHNICAL_ANALYSIS' }],
    AI_ROUTING_POLICY,
    AI_PROVIDER_SPECIALIZATION_POLICY,
  )[0]!;
  assert.deepEqual(missing.findings, ['NO_ROUTE_FOR_TASK']);
  const stale = aiRoutingConformance(
    [{ taskId: 'case.explanation', version: '3.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS' }],
    AI_ROUTING_POLICY,
    AI_PROVIDER_SPECIALIZATION_POLICY,
  )[0]!;
  assert.deepEqual(stale.findings, ['ROUTE_TASK_VERSION_MISMATCH']);
  const primary = AI_ROUTING_POLICY.tasks['case.explanation']!.primary;
  const doubled = withEntry('case.explanation', { fallback: primary });
  assert.deepEqual(
    aiRoutingConformance([{ taskId: 'case.explanation', version: '2.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS' }], doubled, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!
      .findings,
    ['FALLBACK_DUPLICATES_PRIMARY'],
  );
});

test('there is no universal fallback order: each task permits, and names, its own', () => {
  assert.deepEqual(Object.keys(AI_ROUTING_POLICY).sort(), ['tasks', 'version'], 'no policy-wide primary or fallback');
  for (const route of AI_CAPABILITY_ROUTES) {
    assert.deepEqual(Object.keys(AI_PROVIDER_SPECIALIZATION_POLICY.routes[route]).sort(), ['preferredProviderId', 'rationale'], `${route} names no fallback`);
  }
  const comms = { taskId: 'message.draft', version: '2.0.0', capabilityRoute: 'COMMUNICATION' };
  const technical = { taskId: 'case.explanation', version: '2.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS' };
  const conforms = (t: typeof comms, policy: AiRoutingPolicy) => aiRoutingConformance([t], policy, AI_PROVIDER_SPECIALIZATION_POLICY)[0]!.findings;

  // Either direction is fine when the task's own entry says so...
  const commsToAnthropic = withEntry('message.draft', { primary: target('openai', 'model-x'), fallback: target('anthropic', 'model-y'), fallbackPermitted: true });
  assert.deepEqual(conforms(comms, commsToAnthropic), []);
  const technicalToOpenai = withEntry('case.explanation', { primary: target('anthropic', 'model-a'), fallback: target('openai', 'model-b'), fallbackPermitted: true });
  assert.deepEqual(conforms(technical, technicalToOpenai), []);
  // ...and a task that permits no fallback conforms and is simply served by its primary.
  const primaryOnly = withEntry('message.draft', { primary: target('openai', 'model-x'), fallback: null, fallbackPermitted: false });
  assert.deepEqual(conforms(comms, primaryOnly), []);
  // A permission that names nobody is not an explicit permission.
  const unnamed = withEntry('message.draft', { primary: target('openai', 'model-x'), fallback: null, fallbackPermitted: true });
  assert.deepEqual(conforms(comms, unnamed), ['FALLBACK_PERMITTED_WITHOUT_TARGET']);
  // A named target the entry does not permit is a switched-off fallback, not a finding.
  const disabled = withEntry('message.draft', { primary: target('openai', 'model-x'), fallback: target('anthropic', 'model-y'), fallbackPermitted: false });
  assert.deepEqual(conforms(comms, disabled), []);
  // The shipped entry permits, and names, its fallback.
  const shipped = AI_ROUTING_POLICY.tasks['case.explanation']!;
  assert.equal(shipped.fallbackPermitted, true);
  assert.ok(shipped.fallback);
});

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist'].includes(f)) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) out.push(p);
    }
  };
  walk(join(REPO, root));
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}

test('fence: a provider id appears only at the provider boundary, the settings catalog and the environment boundary', () => {
  const allowed = [
    /^packages\/providers\/src\/ai\//,
    /^packages\/shared\/src\/ai\/provider\.ts$/,
    /^packages\/shared\/src\/index\.ts$/,
    /^packages\/database\/src\/integration-catalog\.ts$/,
    /^apps\/web\/src\/ai\/ai-environment\.ts$/,
    /^apps\/web\/src\/app\/crm\/integrations\/page\.tsx$/,
  ];
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      scanned += 1;
      const rel = file.slice(REPO.length + 1);
      if (allowed.some((re) => re.test(rel))) continue;
      if (/['"`](anthropic|openai)['"`]/i.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'task, runtime and Brain code never name a provider');
  assert.ok(scanned > 200, `the fence scanned the repository (${scanned} files)`);
});

test('fence: no task definition carries a provider or model, only a capability', () => {
  for (const task of AI_TASKS) {
    const flat = JSON.stringify(task);
    assert.doesNotMatch(flat, /anthropic|openai|claude|gpt/i, `${task.taskId} names no provider or model`);
    assert.equal('providerId' in task, false);
    assert.equal('modelId' in task, false);
    assert.equal('profile' in task, false, 'the retired field is gone, not kept beside the route');
  }
});
