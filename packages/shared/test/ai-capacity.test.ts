// PR 1 (AI runtime): capacity, the operating budget, output contracts, the portable schema subset, and the
// recorded controls the gateway now reads.
//
// WHAT THESE PROVE
//
// ABSENT MEANS TODAY. With no recorded operating budget, the effective budget policy is the reviewed one
// (the same object), admission refuses nothing it did not refuse before, and only the always-on emergency
// ceiling is added -- which no realistic day approaches.
//
// A RECORDED BUDGET IS CHECKED TOTALLY. An unknown key, a figure above the code maximums, lanes that
// promise more than the organization's day, or an invented budget class is refused -- never ignored.
//
// BACKGROUND CANNOT STARVE LIVE WORK. It has its own lane, never borrows, and is deferred while the day or
// FORWARD's lane is too far along; FORWARD alone may use the unallocated reserve.
//
// AN ANSWER IS JUDGED BY ITS REGISTERED CONTRACT, AND TODAY'S CONTRACTS ARE TODAY'S RULES.
//
// THE GATEWAY READS ONLY THE KILLED SWITCHES. A missing ACTIVE grant row never switches the gateway off.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_BUDGET_CONTROL_VALUE,
  AI_DEFAULT_EMERGENCY_CEILING_MICROS,
  AI_LANES,
  AI_NO_COST,
  AI_NO_SPEND,
  AI_OPERATING_BUDGET_INITIAL,
  AI_OPERATING_BUDGET_MAXIMUMS,
  AI_OUTPUT_CONTRACTS,
  AI_PORTABLE_SCHEMA_EXEMPTIONS,
  AI_STORED_CONTROL_SCOPES,
  AI_TASKS,
  admitAiInvocation,
  aiCapacityRefusals,
  aiControlAppendDecision,
  aiControlRefusals,
  aiEffectiveBudgetPolicy,
  aiEffectiveControls,
  aiOperatingBudgetOf,
  aiOperatingBudgetRefusals,
  aiOutputContract,
  aiPortableSchemaViolationKey,
  aiPortableSchemaViolations,
  aiStoredKillSwitches,
  aiUnexemptedSchemaViolations,
  canonicalJson,
  isAiLane,
  parseAiTaskOutput,
  validateAiTaskOutput,
  type AiAdmissionRequest,
  type AiBudgetPolicy,
  type AiControlEntry,
  type AiCostSnapshot,
  type AiOperatingBudget,
  type AiRoutingPolicy,
} from '../src';

const ORG = 'org_a';
const CLASSES = ['telegram-content-triage', 'mail-reply-draft', 'case-explanation'];
const PRICED = { listVersion: 'list.test', inputMicrosPerToken: 5, outputMicrosPerToken: 25 };
const TARGET_A = { providerId: 'anthropic', modelId: 'model-a', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 2000, pricing: PRICED } as const;
const TARGET_B = { providerId: 'openai', modelId: 'model-b', reasoningEffort: 'low', timeoutMs: 15_000, maxOutputTokens: 2000, pricing: PRICED } as const;

function policy(patch: Partial<AiRoutingPolicy['tasks'][string]> = {}): AiRoutingPolicy {
  return {
    version: 'routing.test.1',
    tasks: {
      'telegram.content.triage': {
        taskId: 'telegram.content.triage',
        taskVersion: '3.0.0',
        primary: TARGET_A,
        fallback: TARGET_B,
        fallbackPermitted: true,
        budgetClass: 'telegram-content-triage',
        lane: 'FORWARD',
        ...patch,
      },
    },
  };
}

const BUDGET: AiBudgetPolicy = Object.freeze({
  version: 'budget.test.1',
  classes: {
    'telegram-content-triage': { maxInputTokensPerCall: 8000, maxOutputTokensPerCall: 2000, taskDaily: { maxInvocations: 50, maxInputTokens: 400_000, maxOutputTokens: 100_000 } },
    'mail-reply-draft': { maxInputTokensPerCall: 20_000, maxOutputTokensPerCall: 2000, taskDaily: { maxInvocations: 50, maxInputTokens: 800_000, maxOutputTokens: 120_000 } },
    'case-explanation': { maxInputTokensPerCall: 40_000, maxOutputTokensPerCall: 6000, taskDaily: { maxInvocations: 20, maxInputTokens: 800_000, maxOutputTokens: 120_000 } },
  },
  organizationDaily: { maxInvocations: 60, maxInputTokens: 2_000_000, maxOutputTokens: 300_000 },
  globalDaily: { maxInvocations: 70, maxInputTokens: 3_000_000, maxOutputTokens: 450_000 },
});

function admission(patch: Partial<AiAdmissionRequest> = {}): AiAdmissionRequest {
  return {
    taskId: 'telegram.content.triage',
    taskVersion: '3.0.0',
    organizationId: ORG,
    authorized: true,
    activation: { enabled: true, organizations: [ORG], tasks: ['telegram.content.triage'], providers: ['anthropic', 'openai'] },
    policy: policy(),
    killSwitches: [],
    budget: BUDGET,
    spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND },
    estimatedInputTokens: 3000,
    registeredProviders: ['anthropic', 'openai'],
    contextRefusals: [],
    tools: [],
    providerPolicies: [
      { providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 },
      { providerId: 'openai', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 },
    ],
    sensitivityCeiling: 'COMMUNICATION_CONTENT',
    ...patch,
  };
}

function cost(patch: Partial<AiCostSnapshot> = {}): AiCostSnapshot {
  return { ...AI_NO_COST, ...patch };
}

function lanes(patch: Partial<Record<(typeof AI_LANES)[number], number>> = {}) {
  return { FORWARD: 0, SYNTHESIS: 0, INTERACTIVE: 0, BACKGROUND: 0, ...patch };
}

const OPERATING = AI_OPERATING_BUDGET_INITIAL;
const $ = (dollars: number) => Math.round(dollars * 1_000_000);

// --- The operating budget ---------------------------------------------------------------------

test('the approved initial budget validates, and says exactly what was approved', () => {
  assert.deepEqual(aiOperatingBudgetRefusals(OPERATING, CLASSES), []);
  assert.equal(OPERATING.organizationDailyCostMicros, $(20));
  assert.equal(OPERATING.emergencyCostMicros, $(25));
  assert.equal(OPERATING.lanes.FORWARD.dailyCostMicros, $(8));
  assert.equal(OPERATING.lanes.SYNTHESIS.dailyCostMicros, $(6));
  assert.equal(OPERATING.lanes.INTERACTIVE.dailyCostMicros, $(2.5));
  assert.equal(OPERATING.lanes.BACKGROUND.dailyCostMicros, $(2));
  assert.equal(OPERATING.lanes.BACKGROUND.maxInvocations, 60);
  assert.equal(OPERATING.forwardReserveCostMicros, $(1.5));
  assert.equal(OPERATING.backgroundMaxOrganizationSpendMicros, $(12));
  assert.equal(OPERATING.backgroundMaxForwardUsedFraction, 0.75);
  assert.deepEqual(OPERATING.circuitBreaker, { failures: 10, windowMinutes: 60 });
  // The lanes and the reserve partition the $20 day exactly.
  const total = AI_LANES.reduce((n, l) => n + OPERATING.lanes[l].dailyCostMicros, 0) + OPERATING.forwardReserveCostMicros;
  assert.equal(total, OPERATING.organizationDailyCostMicros);
  assert.ok(Object.isFrozen(OPERATING) && Object.isFrozen(OPERATING.lanes));
});

test('a recorded budget is checked totally: nothing unknown, nothing above the code maximums, nothing incoherent', () => {
  const bad = (patch: Record<string, unknown>) => aiOperatingBudgetRefusals({ ...OPERATING, ...patch }, CLASSES);
  assert.deepEqual(aiOperatingBudgetRefusals(null, CLASSES), ['NOT_AN_OBJECT']);
  assert.ok(bad({ extra: 1 }).includes('UNKNOWN_KEY'), 'an unknown key is refused, never ignored');
  assert.ok(bad({ label: 'has space' }).includes('LABEL_INVALID'));
  assert.ok(bad({ organizationDailyCostMicros: AI_OPERATING_BUDGET_MAXIMUMS.organizationDailyCostMicros + 1 }).includes('AMOUNT_ABOVE_MAXIMUM'));
  assert.ok(bad({ emergencyCostMicros: AI_OPERATING_BUDGET_MAXIMUMS.emergencyCostMicros + 1 }).includes('AMOUNT_ABOVE_MAXIMUM'));
  assert.ok(bad({ organizationDailyCostMicros: 1.5 }).includes('AMOUNT_INVALID'));
  assert.ok(bad({ organizationDailyCostMicros: -1 }).includes('AMOUNT_INVALID'));
  assert.ok(bad({ emergencyCostMicros: $(19) }).includes('EMERGENCY_BELOW_ORGANIZATION'));
  assert.ok(bad({ lanes: { ...OPERATING.lanes, FORWARD: { dailyCostMicros: $(9) } } }).includes('LANES_EXCEED_ORGANIZATION'));
  assert.ok(bad({ lanes: { FORWARD: OPERATING.lanes.FORWARD } }).includes('LANE_MISSING'));
  assert.ok(bad({ lanes: { ...OPERATING.lanes, SIDEWAYS: { dailyCostMicros: 0 } } }).includes('LANE_UNKNOWN'));
  assert.ok(bad({ lanes: { ...OPERATING.lanes, BACKGROUND: { dailyCostMicros: $(2), maxInvocations: -1 } } }).includes('INVOCATIONS_INVALID'));
  assert.ok(bad({ backgroundMaxForwardUsedFraction: 1.2 }).includes('FRACTION_INVALID'));
  assert.ok(bad({ classInvocations: { 'made-up-class': 5 } }).includes('CLASS_UNKNOWN'), 'a budget may not invent a class');
  assert.ok(bad({ classInvocations: { 'mail-reply-draft': AI_OPERATING_BUDGET_MAXIMUMS.classInvocations + 1 } }).includes('INVOCATIONS_INVALID'));
  assert.ok(bad({ organizationDailyInvocations: AI_OPERATING_BUDGET_MAXIMUMS.organizationDailyInvocations + 1 }).includes('INVOCATIONS_INVALID'));
  assert.ok(bad({ circuitBreaker: { failures: 0, windowMinutes: 60 } }).includes('BREAKER_INVALID'));
  assert.ok(bad({ circuitBreaker: { failures: 5, windowMinutes: 60, extra: 1 } }).includes('BREAKER_INVALID'));
  assert.deepEqual(bad({ circuitBreaker: null }), [], 'no breaker is a valid choice');
  assert.equal(aiOperatingBudgetOf({ ...OPERATING, extra: 1 }, CLASSES), null);
  assert.ok(Object.isFrozen(aiOperatingBudgetOf(JSON.parse(JSON.stringify(OPERATING)), CLASSES)));
});

test('ABSENT MEANS TODAY: no recorded budget leaves the reviewed policy untouched -- the same object', () => {
  assert.equal(aiEffectiveBudgetPolicy(BUDGET, null), BUDGET);
});

test('a recorded budget replaces invocation caps only; token caps and per-call limits stay the reviewed ones', () => {
  const effective = aiEffectiveBudgetPolicy(BUDGET, OPERATING);
  assert.equal(effective.classes['telegram-content-triage']!.taskDaily.maxInvocations, 70);
  assert.equal(effective.classes['telegram-content-triage']!.taskDaily.maxInputTokens, 400_000);
  assert.equal(effective.classes['telegram-content-triage']!.maxOutputTokensPerCall, 2000);
  assert.equal(effective.classes['case-explanation']!.taskDaily.maxInvocations, 6);
  assert.equal(effective.organizationDaily.maxInvocations, 300);
  assert.equal(effective.organizationDaily.maxOutputTokens, 300_000);
  assert.equal(effective.globalDaily.maxInvocations, 360);
  assert.equal(effective.version, 'budget.test.1+operating.initial.1', 'the label says which budget applied');
  // A class the recorded budget does not name keeps its reviewed cap.
  const partial = aiEffectiveBudgetPolicy(BUDGET, { ...OPERATING, classInvocations: { 'mail-reply-draft': 3 } });
  assert.equal(partial.classes['telegram-content-triage']!.taskDaily.maxInvocations, 50);
});

// --- Capacity ------------------------------------------------------------------------------------

test('the emergency ceiling is always on: $25 over the trailing 24 hours, including the call itself', () => {
  assert.equal(AI_DEFAULT_EMERGENCY_CEILING_MICROS, $(25));
  const at = (globalMicros: number, estimate: number | null) =>
    aiCapacityRefusals({ operating: null, lane: 'FORWARD', estimateMicros: estimate, cost: cost({ globalMicros }) });
  assert.deepEqual(at(0, $(0.09)), []);
  assert.deepEqual(at($(24.95), $(0.05)), [], 'exactly at the ceiling fits');
  assert.deepEqual(at($(24.95), $(0.06)), ['BUDGET_EMERGENCY_CEILING'], 'the call that crosses the line is refused');
  assert.deepEqual(at($(30), null), ['BUDGET_EMERGENCY_CEILING'], 'an unpriced call still cannot run past it');
  assert.deepEqual(at(0, null), [], 'without a recorded budget an unpriced call is not refused for being unpriced');
});

test('with a recorded budget: the organization day, the lane, and FORWARD alone may use the reserve', () => {
  const check = (lane: (typeof AI_LANES)[number], c: Partial<AiCostSnapshot>, estimate = $(0.1)) =>
    aiCapacityRefusals({ operating: OPERATING, lane, estimateMicros: estimate, cost: cost(c) });
  assert.deepEqual(check('FORWARD', {}), []);
  assert.deepEqual(check('FORWARD', { organizationMicros: $(19.95) }), ['BUDGET_ORGANIZATION_COST_EXHAUSTED']);
  assert.deepEqual(check('SYNTHESIS', { laneMicros: lanes({ SYNTHESIS: $(5.95) }) }), ['BUDGET_LANE_EXHAUSTED']);
  assert.deepEqual(check('INTERACTIVE', { laneMicros: lanes({ INTERACTIVE: $(2.45) }) }), ['BUDGET_LANE_EXHAUSTED']);
  assert.deepEqual(check('FORWARD', { laneMicros: lanes({ FORWARD: $(8.5) }) }), [], 'FORWARD continues into the $1.50 reserve');
  assert.deepEqual(check('FORWARD', { laneMicros: lanes({ FORWARD: $(9.45) }) }), ['BUDGET_LANE_EXHAUSTED'], '...and stops at lane + reserve');
  assert.deepEqual(check('SYNTHESIS', { laneMicros: lanes({ SYNTHESIS: $(6) }) }), ['BUDGET_LANE_EXHAUSTED'], 'no other lane touches the reserve');
  assert.deepEqual(check('FORWARD', {}, null), ['BUDGET_COST_UNPRICED'], 'a call that cannot be priced cannot be held to a cost cap');
  assert.deepEqual(
    check('FORWARD', { globalMicros: $(24.95) }),
    ['BUDGET_EMERGENCY_CEILING'],
    'the recorded emergency ceiling applies with the rest',
  );
});

test('BACKGROUND never starves live work: its own lane, its own call cap, and deferral while live work is busy', () => {
  const check = (c: Partial<AiCostSnapshot>) => aiCapacityRefusals({ operating: OPERATING, lane: 'BACKGROUND', estimateMicros: $(0.09), cost: cost(c) });
  assert.deepEqual(check({}), []);
  assert.deepEqual(check({ laneMicros: lanes({ BACKGROUND: $(1.95) }) }), ['BUDGET_LANE_EXHAUSTED'], '$2 and no more');
  assert.deepEqual(check({ laneInvocations: lanes({ BACKGROUND: 60 }) }), ['BUDGET_LANE_EXHAUSTED'], '60 calls and no more');
  assert.deepEqual(check({ organizationMicros: $(12) }), ['BUDGET_BACKGROUND_DEFERRED'], 'deferred once the org has spent $12');
  assert.deepEqual(check({ laneMicros: lanes({ FORWARD: $(6) }) }), ['BUDGET_BACKGROUND_DEFERRED'], 'deferred once FORWARD is 75% used');
  assert.deepEqual(check({ laneMicros: lanes({ FORWARD: $(5.99) }) }), [], 'just under 75% is fine');
  // FORWARD is never deferred for background's sake.
  assert.deepEqual(aiCapacityRefusals({ operating: OPERATING, lane: 'FORWARD', estimateMicros: $(0.09), cost: cost({ organizationMicros: $(12) }) }), []);
});

test('the circuit breaker opens at its failure count in the trailing window, and not before', () => {
  const check = (failures: number, breaker: AiOperatingBudget['circuitBreaker'] = OPERATING.circuitBreaker) =>
    aiCapacityRefusals({ operating: { ...OPERATING, circuitBreaker: breaker }, lane: 'FORWARD', estimateMicros: $(0.05), cost: cost({ taskRecentFailures: failures }) });
  assert.deepEqual(check(9), []);
  assert.deepEqual(check(10), ['TASK_CIRCUIT_OPEN']);
  assert.deepEqual(check(1000, null), [], 'no breaker configured: failures alone never stop a task');
});

// --- Admission --------------------------------------------------------------------------------

test('ABSENT MEANS TODAY at admission: same route, same fallbacks, no new refusal, and the route lane is reported', () => {
  const admitted = admitAiInvocation(admission());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(admitted.route.providerId, 'anthropic');
  assert.deepEqual(admitted.fallbacks.map((f) => f.providerId), ['openai']);
  assert.equal(admitted.lane, 'FORWARD');
  // A route that names no lane is INTERACTIVE.
  const unnamed = admitAiInvocation(admission({ policy: policy({ lane: undefined }) }));
  assert.equal(unnamed.ok && unnamed.lane, 'INTERACTIVE');
});

test('a caller may move work DOWN to BACKGROUND, and claim no other lane', () => {
  const background = admitAiInvocation(admission({ lane: 'BACKGROUND' }));
  assert.equal(background.ok && background.lane, 'BACKGROUND');
  const claimed = admitAiInvocation(admission({ lane: 'SYNTHESIS' }));
  assert.equal(claimed.ok, false);
  assert.ok(!claimed.ok && claimed.refusals.includes('LANE_NOT_PERMITTED'));
  const own = admitAiInvocation(admission({ lane: 'FORWARD' }));
  assert.equal(own.ok, true, 'naming the route own lane is allowed');
});

test('admission applies capacity: the cost of the call is its input estimate and full output ceiling at the route price', () => {
  // 3000 in x 5 + 2000 out x 25 = 65,000 micros ($0.065).
  const nearly = { ...AI_NO_COST, globalMicros: $(25) - 65_000 };
  const fits = admitAiInvocation(admission({ spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND, cost: nearly } }));
  assert.equal(fits.ok, true);
  const over = admitAiInvocation(admission({ spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND, cost: { ...nearly, globalMicros: nearly.globalMicros + 1 } } }));
  assert.ok(!over.ok && over.refusals.includes('BUDGET_EMERGENCY_CEILING'));
  const background = admitAiInvocation(
    admission({ lane: 'BACKGROUND', operating: OPERATING, spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND, cost: { ...AI_NO_COST, organizationMicros: $(12) } } }),
  );
  assert.ok(!background.ok && background.refusals.includes('BUDGET_BACKGROUND_DEFERRED'));
});

test('OTHER_THAN_SUBJECT: a verification is served by a provider other than its subject, or not at all', () => {
  const route = policy({ strategy: 'OTHER_THAN_SUBJECT', fallbackPermitted: false, lane: 'SYNTHESIS' });
  const missing = admitAiInvocation(admission({ policy: route }));
  assert.ok(!missing.ok && missing.refusals.includes('NO_INDEPENDENT_PROVIDER'), 'no subject named: nothing to be independent of');
  const byOpenAi = admitAiInvocation(admission({ policy: route, subjectProvider: 'anthropic' }));
  assert.equal(byOpenAi.ok && byOpenAi.route.providerId, 'openai', 'the primary is skipped because it wrote the subject');
  assert.deepEqual(byOpenAi.ok && byOpenAi.fallbacks, [], 'and there is no availability fallback back to the subject');
  const byAnthropic = admitAiInvocation(admission({ policy: route, subjectProvider: 'openai' }));
  assert.equal(byAnthropic.ok && byAnthropic.route.providerId, 'anthropic');
  // The only independent provider is not enabled: refused, never quietly served by the subject's provider.
  const alone = admitAiInvocation(admission({ policy: route, subjectProvider: 'anthropic', activation: { ...admission().activation, providers: ['anthropic'] } }));
  assert.equal(alone.ok, false);
  assert.ok(!alone.ok && !alone.refusals.includes('NO_INDEPENDENT_PROVIDER') && alone.refusals.includes('PROVIDER_NOT_ENABLED'));
});

// --- Output contracts ---------------------------------------------------------------------------

test('every task has a registered output contract, and today three contracts use exactly the rules the gateway used before', () => {
  for (const task of AI_TASKS) assert.ok(aiOutputContract(task.outputSchemaId), `${task.taskId} has a contract`);
  assert.deepEqual(Object.keys(AI_OUTPUT_CONTRACTS).sort(), ['case-explanation.v2', 'mail-reply-draft.v2', 'telegram-content-triage.v4']);
  for (const contract of Object.values(AI_OUTPUT_CONTRACTS)) {
    assert.equal(contract.parse, parseAiTaskOutput, `${contract.schemaId} parses with the existing parser`);
    assert.equal(contract.validate, validateAiTaskOutput, `${contract.schemaId} validates with the existing rules`);
  }
  assert.equal(aiOutputContract('mail-reply-draft.v1'), null, 'the retired schema has no contract');
  assert.equal(aiOutputContract('toString'), null, 'an inherited property is not a contract');
});

// --- The portable schema subset ---------------------------------------------------------------

test('the portable subset: forbidden keywords, open objects and optional properties are each reported with a path', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a', 'format'],
    properties: {
      a: { type: 'string', maxLength: 5, pattern: 'x' },
      format: { type: 'string' },
      b: { const: 'x' },
      c: { type: 'object', properties: { d: { type: 'array', maxItems: 2, items: { type: 'number', minimum: 0 } } } },
    },
  };
  const found = aiPortableSchemaViolations(schema).map(aiPortableSchemaViolationKey).sort();
  assert.deepEqual(found, [
    '$.properties.a:maxLength',
    '$.properties.a:pattern',
    '$.properties.b:PROPERTY_NOT_REQUIRED',
    '$.properties.b:const',
    '$.properties.c.properties.d.items:minimum',
    '$.properties.c.properties.d:PROPERTY_NOT_REQUIRED',
    '$.properties.c.properties.d:maxItems',
    '$.properties.c:OBJECT_NOT_CLOSED',
    '$.properties.c:PROPERTY_NOT_REQUIRED',
  ]);
  // A property NAMED `format` is a name, not the keyword.
  assert.ok(!found.some((k) => k.endsWith(':format')));
});

test('an exemption is named, narrow and listed: only triage v4 schemaId const, until triage v5', () => {
  assert.deepEqual(Object.keys(AI_PORTABLE_SCHEMA_EXEMPTIONS), ['telegram-content-triage.v4']);
  assert.deepEqual([...AI_PORTABLE_SCHEMA_EXEMPTIONS['telegram-content-triage.v4']!], ['$.properties.schemaId:const']);
  const schema = { type: 'object', additionalProperties: false, required: ['schemaId', 'x'], properties: { schemaId: { const: 'v' }, x: { type: 'string', maxLength: 3 } } };
  const left = aiUnexemptedSchemaViolations('telegram-content-triage.v4', schema).map(aiPortableSchemaViolationKey);
  assert.deepEqual(left, ['$.properties.x:maxLength'], 'the exemption covers the named violation and nothing else');
  assert.equal(aiUnexemptedSchemaViolations('another.v1', schema).length, 2, 'no other schema is exempt');
});

// --- Recorded controls ------------------------------------------------------------------------

const OPS = { kind: 'OPERATIONS', reference: 'github:record-ai-budget:run-1' } as const;
const BUDGET_TARGET = { scope: 'BUDGET', organizationId: null, value: AI_BUDGET_CONTROL_VALUE } as const;

test('the operating budget is one platform-wide BUDGET control: ACTIVE only, with settings, and nothing else carries settings', () => {
  assert.ok(AI_STORED_CONTROL_SCOPES.includes('BUDGET'));
  assert.deepEqual(aiControlRefusals({ target: BUDGET_TARGET, state: 'ACTIVE', reason: 'Initial budget.', actor: OPS, settings: OPERATING }), []);
  assert.ok(aiControlRefusals({ target: BUDGET_TARGET, state: 'KILLED', reason: 'x', actor: OPS, settings: OPERATING }).includes('BUDGET_MUST_BE_ACTIVE'));
  assert.ok(aiControlRefusals({ target: BUDGET_TARGET, state: 'ACTIVE', reason: 'x', actor: OPS, settings: null }).includes('SETTINGS_REQUIRED'));
  assert.ok(aiControlRefusals({ target: { ...BUDGET_TARGET, value: 'other' }, state: 'ACTIVE', reason: 'x', actor: OPS, settings: OPERATING }).includes('VALUE_REQUIRED'));
  assert.ok(aiControlRefusals({ target: { ...BUDGET_TARGET, organizationId: ORG }, state: 'ACTIVE', reason: 'x', actor: OPS, settings: OPERATING }).includes('ORGANIZATION_NOT_ALLOWED_FOR_SCOPE'));
  assert.deepEqual(
    aiControlRefusals({ target: { scope: 'GLOBAL', organizationId: null, value: null }, state: 'KILLED', reason: 'x', actor: OPS, settings: { a: 1 } }),
    ['SETTINGS_NOT_ALLOWED_FOR_SCOPE'],
  );
});

test('moving any figure of a budget is a change; recording the same figures in another key order is not', () => {
  const current = { version: 3, state: 'ACTIVE' as const, settings: { b: 2, a: { y: 1, x: 0 } } };
  assert.deepEqual(aiControlAppendDecision(current, { expectedVersion: 3, state: 'ACTIVE', settings: { a: { x: 0, y: 1 }, b: 2 } }), { action: 'UNCHANGED' });
  assert.deepEqual(aiControlAppendDecision(current, { expectedVersion: 3, state: 'ACTIVE', settings: { a: { x: 0, y: 1 }, b: 3 } }), { action: 'APPEND', version: 4 });
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

function entry(scope: AiControlEntry['target']['scope'], state: 'ACTIVE' | 'KILLED', value: string | null, organizationId: string | null = null): AiControlEntry {
  return { target: { scope, organizationId, value }, state, version: 1, reason: 'r', actor: OPS, recordedAtMs: 0 };
}

test('the gateway reads only KILLED switches: grants are ignored, and another organization is never read', () => {
  const stored = [
    entry('GLOBAL', 'ACTIVE', null),
    entry('PROVIDER', 'KILLED', 'openai'),
    entry('MODEL', 'KILLED', 'model-a'),
    entry('TASK', 'KILLED', 'mail.reply.draft'),
    entry('TASK', 'KILLED', 'telegram.content.triage', ORG),
    entry('TASK', 'KILLED', 'case.explanation', 'org_other'),
    entry('ORGANIZATION', 'KILLED', 'org_other', 'org_other'),
    entry('ORGANIZATION', 'ACTIVE', ORG, ORG),
    entry('PROVIDER_POLICY', 'KILLED', 'anthropic'),
    { ...entry('BUDGET', 'ACTIVE', AI_BUDGET_CONTROL_VALUE), settings: OPERATING },
  ];
  assert.deepEqual(aiStoredKillSwitches(stored, ORG), [
    { scope: 'PROVIDER', value: 'openai' },
    { scope: 'MODEL', value: 'model-a' },
    { scope: 'TASK', value: 'mail.reply.draft' },
    { scope: 'TASK', value: 'telegram.content.triage' },
  ]);
  assert.deepEqual(aiStoredKillSwitches([entry('GLOBAL', 'KILLED', null)], ORG), [{ scope: 'GLOBAL' }]);
  // NO ACTIVE ROW IS REQUIRED: an empty control log stops nothing at the gateway.
  assert.deepEqual(aiStoredKillSwitches([], ORG), []);
  // The Brain's effective-controls reader ignores the budget as it ignores provider policies.
  const effective = aiEffectiveControls({ activation: { enabled: true, organizations: [ORG], tasks: [], providers: [] }, killSwitches: [] }, stored, ORG);
  assert.equal(effective.killSwitches.some((k) => 'value' in k && k.value === AI_BUDGET_CONTROL_VALUE), false);
});

test('a KILLED stored switch stops admission exactly as an environment one does', () => {
  const killed = aiStoredKillSwitches([entry('TASK', 'KILLED', 'telegram.content.triage')], ORG);
  const refused = admitAiInvocation(admission({ killSwitches: killed }));
  assert.ok(!refused.ok && refused.refusals.includes('KILL_SWITCH'));
  const provider = admitAiInvocation(admission({ killSwitches: aiStoredKillSwitches([entry('PROVIDER', 'KILLED', 'anthropic')], ORG) }));
  assert.equal(provider.ok && provider.route.providerId, 'openai', 'a killed provider is skipped, and the permitted fallback serves');
});

test('lanes are a closed vocabulary', () => {
  assert.deepEqual([...AI_LANES], ['FORWARD', 'SYNTHESIS', 'INTERACTIVE', 'BACKGROUND']);
  assert.equal(isAiLane('FORWARD'), true);
  assert.equal(isAiLane('forward'), false);
});
