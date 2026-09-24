// Activation gate G2 as a recorded provider policy (2026-09-24). Pure: the admission decision and
// the control-log contract. The database test proves the same rules through the gateway, the
// stored controls and the Telegram triage service.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_CONTROL_SCOPES,
  AI_KILL_SWITCH_SCOPES,
  AI_NO_SPEND,
  AI_PROVIDER_POLICY_REFUSALS,
  AI_STORED_CONTROL_SCOPES,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  admitAiInvocation,
  aiControlAppendDecision,
  aiControlKey,
  aiControlRefusals,
  aiEffectiveControls,
  aiProviderPoliciesOf,
  aiProviderPolicyRefusal,
  type AiAdmissionRequest,
  type AiControlEntry,
  type AiProviderPolicy,
} from '../src/index';

const ORG = 'org_a';
const A = { providerId: 'anthropic', modelId: 'model-a', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 1000, pricing: null } as const;
const B = { providerId: 'openai', modelId: 'model-b', reasoningEffort: 'low', timeoutMs: 15_000, maxOutputTokens: 1000, pricing: null } as const;

const policy = (providerId: string, state: 'ACTIVE' | 'KILLED', ceiling: AiProviderPolicy['ceiling']): AiProviderPolicy => ({ providerId, state, ceiling, version: 1, recordedAtMs: 0 });

function triage(patch: Partial<AiAdmissionRequest> = {}): AiAdmissionRequest {
  return {
    taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
    taskVersion: AI_TASK_TELEGRAM_CONTENT_TRIAGE.version,
    organizationId: ORG,
    authorized: true,
    activation: { enabled: true, organizations: [ORG], tasks: [AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId], providers: ['anthropic', 'openai'] },
    policy: {
      version: 'routing.test',
      tasks: {
        [AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId]: {
          taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
          taskVersion: AI_TASK_TELEGRAM_CONTENT_TRIAGE.version,
          primary: A,
          fallback: B,
          fallbackPermitted: true,
          budgetClass: 'c',
        },
      },
    },
    killSwitches: [],
    budget: {
      version: 'b',
      classes: { c: { maxInputTokensPerCall: 20_000, maxOutputTokensPerCall: 4000, taskDaily: { maxInvocations: 5, maxInputTokens: 100_000, maxOutputTokens: 10_000 } } },
      organizationDaily: { maxInvocations: 5, maxInputTokens: 100_000, maxOutputTokens: 10_000 },
      globalDaily: { maxInvocations: 5, maxInputTokens: 100_000, maxOutputTokens: 10_000 },
    },
    spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND },
    estimatedInputTokens: 2000,
    registeredProviders: ['anthropic', 'openai'],
    contextRefusals: [],
    tools: [],
    providerPolicies: [policy('anthropic', 'ACTIVE', 'COMMUNICATION_CONTENT')],
    sensitivityCeiling: AI_TASK_TELEGRAM_CONTENT_TRIAGE.sensitivityCeiling,
    ...patch,
  };
}

const refusals = (r: ReturnType<typeof admitAiInvocation>) => (r.ok ? [] : [...r.refusals]);

test('Telegram triage needs COMMUNICATION_CONTENT, and a policy at exactly that ceiling admits it', () => {
  assert.equal(AI_TASK_TELEGRAM_CONTENT_TRIAGE.sensitivityCeiling, 'COMMUNICATION_CONTENT');
  const admitted = admitAiInvocation(triage());
  assert.equal(admitted.ok, true);
  assert.equal(admitted.ok && admitted.route.providerId, 'anthropic');
  // The fallback (openai) holds no policy: it is skipped and says why, and the primary still serves.
  assert.deepEqual(admitted.ok && admitted.skipped, [{ target: { providerId: 'openai', modelId: 'model-b' }, reason: 'PROVIDER_POLICY_MISSING' }]);
  // A wider ceiling admits too.
  assert.equal(admitAiInvocation(triage({ providerPolicies: [policy('anthropic', 'ACTIVE', 'WORKFORCE_PII')] })).ok, true);
});

test('no policy at all: POLICY_DENIED with PROVIDER_POLICY_MISSING, before anything is sent', () => {
  assert.deepEqual(refusals(admitAiInvocation(triage({ providerPolicies: [] }))), ['POLICY_DENIED', 'PROVIDER_POLICY_MISSING']);
});

test('KILLED: denied, whatever ceiling it carries', () => {
  for (const ceiling of ['COMMUNICATION_CONTENT', null] as const) {
    assert.deepEqual(refusals(admitAiInvocation(triage({ providerPolicies: [policy('anthropic', 'KILLED', ceiling)] }))), ['POLICY_DENIED', 'PROVIDER_POLICY_KILLED', 'PROVIDER_POLICY_MISSING']);
  }
});

test('a ceiling below the task: denied as BELOW_TASK', () => {
  for (const ceiling of ['OPERATIONAL', 'CONTACT_IDENTIFIER'] as const) {
    const r = refusals(admitAiInvocation(triage({ providerPolicies: [policy('anthropic', 'ACTIVE', ceiling), policy('openai', 'ACTIVE', ceiling)] })));
    assert.deepEqual(r, ['POLICY_DENIED', 'PROVIDER_POLICY_BELOW_TASK'], ceiling);
  }
});

test('an unreadable read, an unknown ceiling or a duplicate: UNREADABLE, never an approval', () => {
  assert.deepEqual(refusals(admitAiInvocation(triage({ providerPolicies: null }))), ['POLICY_DENIED', 'PROVIDER_POLICY_UNREADABLE']);
  assert.deepEqual(refusals(admitAiInvocation(triage({ providerPolicies: undefined as never }))), ['POLICY_DENIED', 'PROVIDER_POLICY_UNREADABLE'], 'a caller that forgot the field is refused');
  assert.equal(aiProviderPolicyRefusal([policy('anthropic', 'ACTIVE', 'SECRET' as never)], 'anthropic', 'OPERATIONAL'), 'PROVIDER_POLICY_UNREADABLE');
  assert.equal(aiProviderPolicyRefusal([policy('anthropic', 'ACTIVE', null)], 'anthropic', 'OPERATIONAL'), 'PROVIDER_POLICY_UNREADABLE');
  assert.equal(aiProviderPolicyRefusal([policy('anthropic', 'ACTIVE', 'WORKFORCE_PII'), policy('anthropic', 'ACTIVE', 'WORKFORCE_PII')], 'anthropic', 'OPERATIONAL'), 'PROVIDER_POLICY_UNREADABLE');
  // An unclassified TASK ceiling ranks above everything, so nothing admits it.
  assert.equal(aiProviderPolicyRefusal([policy('anthropic', 'ACTIVE', 'WORKFORCE_PII')], 'anthropic', 'SOMETHING_NEW'), 'PROVIDER_POLICY_BELOW_TASK');
  assert.deepEqual([...AI_PROVIDER_POLICY_REFUSALS].sort(), ['PROVIDER_POLICY_BELOW_TASK', 'PROVIDER_POLICY_KILLED', 'PROVIDER_POLICY_MISSING', 'PROVIDER_POLICY_UNREADABLE']);
});

test('the policy is per target: a primary without one is skipped and the approved fallback serves', () => {
  const r = admitAiInvocation(triage({ providerPolicies: [policy('openai', 'ACTIVE', 'COMMUNICATION_CONTENT')] }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.route.providerId, 'openai');
  assert.deepEqual(r.ok && r.skipped.map((s) => s.reason), ['PROVIDER_POLICY_MISSING']);
  // Without fallback permission the primary's refusal stands.
  const noFallback = triage({ providerPolicies: [policy('openai', 'ACTIVE', 'COMMUNICATION_CONTENT')] });
  const route = noFallback.policy.tasks[AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId]!;
  const denied = admitAiInvocation({ ...noFallback, policy: { ...noFallback.policy, tasks: { [route.taskId]: { ...route, fallbackPermitted: false } } } });
  assert.deepEqual(refusals(denied), ['POLICY_DENIED', 'PROVIDER_POLICY_MISSING']);
});

test('an unauthorized caller still learns only that it is unauthorized', () => {
  assert.deepEqual(refusals(admitAiInvocation(triage({ authorized: false, providerPolicies: [] }))), ['NOT_AUTHORIZED']);
});

// --- The control-log contract --------------------------------------------------------------

const OPS = { kind: 'OPERATIONS', reference: 'github-run:1' } as const;
const target = (value: string) => ({ scope: 'PROVIDER_POLICY', organizationId: null, value }) as const;

test('a provider policy is its own key namespace, never an activation switch', () => {
  assert.deepEqual([...AI_CONTROL_SCOPES], [...AI_KILL_SWITCH_SCOPES], 'the switch scopes are unchanged');
  assert.deepEqual([...AI_STORED_CONTROL_SCOPES], [...AI_KILL_SWITCH_SCOPES, 'PROVIDER_POLICY']);
  assert.equal(aiControlKey(target('anthropic')), 'PROVIDER_POLICY|-|anthropic');
  assert.notEqual(aiControlKey(target('anthropic')), aiControlKey({ scope: 'PROVIDER', organizationId: null, value: 'anthropic' }));
});

test('recording a policy: platform-wide, a provider, a reason, an actor, and a ceiling when ACTIVE', () => {
  assert.deepEqual(aiControlRefusals({ target: target('anthropic'), state: 'ACTIVE', reason: 'Terms reviewed.', actor: OPS, ceiling: 'COMMUNICATION_CONTENT' }), []);
  assert.deepEqual(aiControlRefusals({ target: target('anthropic'), state: 'ACTIVE', reason: 'x', actor: OPS, ceiling: null }), ['CEILING_REQUIRED']);
  assert.deepEqual(aiControlRefusals({ target: target('anthropic'), state: 'KILLED', reason: 'Incident.', actor: OPS, ceiling: null }), [], 'a kill need not name a ceiling');
  assert.deepEqual(aiControlRefusals({ target: target('anthropic'), state: 'ACTIVE', reason: '  ', actor: OPS, ceiling: 'OPERATIONAL' }), ['REASON_REQUIRED']);
  assert.deepEqual(aiControlRefusals({ target: target('anthropic'), state: 'ACTIVE', reason: 'x', actor: OPS, ceiling: 'EVERYTHING' as never }), ['UNKNOWN_CEILING']);
  assert.ok(aiControlRefusals({ target: { ...target('anthropic'), organizationId: ORG }, state: 'ACTIVE', reason: 'x', actor: OPS, ceiling: 'OPERATIONAL' }).includes('ORGANIZATION_NOT_ALLOWED_FOR_SCOPE'));
  assert.ok(aiControlRefusals({ target: { scope: 'PROVIDER_POLICY', organizationId: null, value: null }, state: 'ACTIVE', reason: 'x', actor: OPS, ceiling: 'OPERATIONAL' }).includes('VALUE_REQUIRED'));
  assert.deepEqual(aiControlRefusals({ target: { scope: 'PROVIDER', organizationId: null, value: 'anthropic' }, state: 'ACTIVE', reason: 'x', actor: OPS, ceiling: 'OPERATIONAL' }), ['CEILING_NOT_ALLOWED_FOR_SCOPE'], 'only a policy carries a ceiling');
});

test('moving the ceiling is a change; recording the same state and ceiling is not', () => {
  const current = { version: 1, state: 'ACTIVE' as const, ceiling: 'OPERATIONAL' };
  assert.deepEqual(aiControlAppendDecision(current, { expectedVersion: 1, state: 'ACTIVE', ceiling: 'OPERATIONAL' }), { action: 'UNCHANGED' });
  assert.deepEqual(aiControlAppendDecision(current, { expectedVersion: 1, state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT' }), { action: 'APPEND', version: 2 });
  assert.deepEqual(aiControlAppendDecision(current, { expectedVersion: 0, state: 'KILLED', ceiling: null }), { action: 'STALE', currentVersion: 1 });
  // Controls without a ceiling behave exactly as before.
  assert.deepEqual(aiControlAppendDecision({ version: 2, state: 'KILLED' }, { expectedVersion: 2, state: 'KILLED' }), { action: 'UNCHANGED' });
});

test('the effective-controls reader ignores provider policies entirely; admission reads them', () => {
  const entry = (state: 'ACTIVE' | 'KILLED'): AiControlEntry => ({ target: target('anthropic'), state, version: 1, reason: 'r', actor: OPS, recordedAtMs: 5, ceiling: 'COMMUNICATION_CONTENT' });
  const floor = { activation: { enabled: true, organizations: [ORG], tasks: ['t'], providers: ['anthropic'] }, killSwitches: [] };
  const effective = aiEffectiveControls(floor, [entry('KILLED')], ORG);
  assert.deepEqual(effective.killSwitches, [], 'a KILLED policy is not a provider kill switch');
  assert.deepEqual(effective.activation.providers, [], 'and an ACTIVE one is not a PROVIDER activation');
  assert.deepEqual(aiEffectiveControls(floor, [entry('ACTIVE')], ORG).activation.providers, []);
  assert.deepEqual(aiProviderPoliciesOf([entry('ACTIVE')]), [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 5 }]);
  assert.deepEqual(aiProviderPoliciesOf([{ ...entry('ACTIVE'), target: { scope: 'PROVIDER', organizationId: null, value: 'anthropic' } }]), [], 'an activation switch is not a policy');
});
