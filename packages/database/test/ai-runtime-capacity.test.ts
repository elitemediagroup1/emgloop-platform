// PR 1 (AI runtime): the gateway beneath production Telegram triage, and the capacity it now enforces.
//
// WHAT THESE PROVE
//
// PRODUCTION TRIAGE IS EXACTLY THE REVIEWED v5 CONTRACT. PR 1 pinned triage v4 to main 97816a5 and held
// it byte for byte; Chats v5 (Loop Intelligence Phase B, 2026-09-26) is the DELIBERATE change that pin was
// waiting for. The task definition, output schema, template and every request a provider receives are now
// pinned to the v5 production contract (CHATS_V5). What v5 did NOT change is still pinned to main 97816a5:
// the route's targets, efforts, deadlines, ceilings and fallback (with only its taskVersion moved), the
// budget class and the daily windows. If any of them moves, this file fails -- a change to what
// production triage sends is a task change, reviewed as one, never a side effect.
//
// EVERY TASK SCHEMA IS ONE BOTH PROVIDERS ACCEPT. Since v5 there is no exemption at all.
//
// THE NEW GATES FAIL CLOSED AND CHANGE NOTHING WHEN ABSENT. An unregistered output contract, an
// unreadable control or budget, a stored KILLED switch, a lane the route does not name, a lane or cost
// cap, the emergency ceiling, and an independent-provider route each decide exactly what they name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  AI_BUDGET_POLICY,
  AI_MAX_ATTEMPTS_PER_TARGET,
  AI_ROUTING_POLICY,
} from '@emgloop/providers';
import {
  AI_OPERATING_BUDGET_INITIAL,
  AI_TASK_CASE_EXPLANATION,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TASKS,
  aiUnexemptedSchemaViolations,
  aiPortableSchemaViolationKey,
  aiPortableSchemaViolations,
  DOMAIN_READING_SCHEMA,
  type AiBudgetPolicy,
  type AiContextPackage,
  type AiModelRequest,
  type AiModelResult,
  type AiProviderPolicy,
  type AiRoutingPolicy,
} from '@emgloop/shared';

import {
  AiRuntimeGateway,
  InMemoryAiUsageLedger,
  type AiOperatingBudgetReading,
  type AiPrincipal,
  type AiProviderPort,
  type AiRunRequest,
  type AiRuntimeDeps,
} from '../src/services/ai-runtime/gateway';
import { TelegramContentTriageService } from '../src/services/ai-runtime/telegram-content-triage.service';
import {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from '../src/services/ai-runtime/templates/case-explanation';
import { MAIL_REPLY_DRAFT_SCHEMA, MAIL_REPLY_DRAFT_SCHEMA_ID } from '../src/services/ai-runtime/templates/mail-reply-draft';
import { MAIL_CONTENT_TRIAGE_SCHEMA, MAIL_CONTENT_TRIAGE_SCHEMA_ID } from '../src/services/ai-runtime/templates/mail-content-triage';
import { INTELLIGENCE_TASK_SCHEMAS as EXTRA_TASK_SCHEMAS } from '../src/services/ai-runtime/templates/intelligence-schemas';
import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA,
  TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
} from '../src/services/ai-runtime/templates/telegram-content-triage';

const fp = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

// --- 1. Production Telegram triage, pinned to main 97816a5 ----------------------------------------

const FP_ORG = 'org_fp';
const FP_CONV = 'k'.repeat(64);
const fpMessage = (n: number, text: string, direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND', senderLabel: string | null = null) => ({
  providerEventId: `${FP_CONV}:${n}`,
  direction,
  occurredAt: new Date(Date.UTC(2026, 8, 21, 9, n)),
  text,
  senderLabel,
});
const FP_CASES = [
  { conversationKey: FP_CONV, messages: [fpMessage(1, 'Can you send the signed roofing contract by Thursday?'), fpMessage(2, 'Let me check', 'OUTBOUND')], truncated: true, evaluatedFloorProviderEventId: `${FP_CONV}:1`, conversation: { label: 'Dana Reyes', kind: 'PRIVATE' as const } },
  { conversationKey: FP_CONV, messages: [fpMessage(1, 'Can we get the invoice?', 'INBOUND', 'Bob Chen'), fpMessage(2, 'Sending now', 'OUTBOUND')], truncated: false, evaluatedFloorProviderEventId: `${FP_CONV}:1`, conversation: { label: 'Acme Roofing Crew', kind: 'GROUP' as const } },
  { conversationKey: FP_CONV, messages: [fpMessage(1, 'hi')], truncated: false, evaluatedFloorProviderEventId: `${FP_CONV}:1`, conversation: null },
];

/** The production triage path through the real gateway and the real reviewed policies, capturing what a provider receives. */
async function triageFingerprint(extra: Partial<AiRuntimeDeps> = {}, lane?: 'BACKGROUND') {
  const requests: AiModelRequest[] = [];
  const reservations: Record<string, unknown>[] = [];
  const ledger = new InMemoryAiUsageLedger();
  const reserve = ledger.reserve.bind(ledger);
  ledger.reserve = async (r, ...rest) => {
    const { lane: _l, specializationPolicyVersion: _s, routingPolicyVersion: _v, requestedAt: _t, ...stable } = r;
    reservations.push(stable);
    return reserve(r, ...rest);
  };
  const port: AiProviderPort = {
    providerId: 'anthropic',
    async invoke(request) {
      requests.push(request);
      throw Object.assign(new Error('fingerprint stops here'), { failure: 'UNAVAILABLE' });
    },
  };
  let n = 0;
  const gateway = new AiRuntimeGateway(
    {
      activation: { enabled: true, organizations: [FP_ORG], tasks: ['telegram.content.triage'], providers: ['anthropic'] },
      policy: AI_ROUTING_POLICY,
      budget: AI_BUDGET_POLICY,
      killSwitches: [],
      maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET,
    },
    {
      providers: [port],
      ledger,
      authorize: async () => true,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newInvocationId: () => `inv_${++n}`,
      providerPolicies: async () => [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }],
      ...extra,
    },
  );
  const service = new TelegramContentTriageService({ runtime: gateway });
  const outcomes: string[] = [];
  for (const input of FP_CASES) {
    outcomes.push((await service.triage({ organizationId: FP_ORG, userId: 'user_fp' }, lane ? { ...input, lane } : input)).outcome);
  }
  return { requests, reservations, outcomes, ledger };
}

/** Computed with this file's own functions on main 97816a5, before PR 1. Still pins what v5 did not change. */
const MAIN_97816A5 = Object.freeze({
  task: 'c382e51d0e3578d3',
  schema: 'add54bb68235a134',
  route: 'a31456e036285087',
  budgetClass: 'b1aee07a7506996c',
  budgetWindows: '917ea7fb8ee74be1',
  requests: ['b206fe58e86a894e', 'c739a88472647f47', '2f5d1a5851a614c9'],
  reservations: '2d5d6149d8c45145',
});

/**
 * THE v5 PRODUCTION CONTRACT (Chats v5, 2026-09-26), computed with this file's own functions. A change to
 * any of these is a change to what production triage sends: make it deliberately, with a new fixture.
 */
const CHATS_V5 = Object.freeze({
  task: 'a2ea66fbc8963bd1',
  schema: '60389015902de68b',
  requests: ['ccf11dcfa2e1c458', 'a83e8c7e0c28d589', '4958fa7a9d13e2bc'],
  reservations: '3cb4f0819ef438eb',
});

test('PRODUCTION TRIAGE IS THE REVIEWED v5 CONTRACT: definition, schema, template and every provider request are pinned', async () => {
  assert.equal(fp(AI_TASK_TELEGRAM_CONTENT_TRIAGE), CHATS_V5.task, 'the task definition');
  assert.equal(TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID, 'telegram-content-triage.v5');
  assert.equal(fp(TELEGRAM_CONTENT_TRIAGE_SCHEMA), CHATS_V5.schema, 'the output schema sent to the provider');
  assert.equal(`${TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID}@${TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION}`, 'telegram-content-triage@6');
  const { requests, reservations, outcomes } = await triageFingerprint();
  assert.deepEqual(requests.map(fp), CHATS_V5.requests, 'instructions, input, schema, limits and effort, byte for byte');
  assert.equal(fp(reservations), CHATS_V5.reservations, 'the budget class, estimate, target and refs reserved');
  assert.deepEqual(outcomes, ['FAILED', 'FAILED', 'FAILED']);
});

test('WHAT v5 DID NOT CHANGE is still main 97816a5: route targets, efforts, deadlines, ceilings, fallback, budget class and windows', () => {
  const route = AI_ROUTING_POLICY.tasks['telegram.content.triage']!;
  const { lane, ...targets } = route;
  assert.equal(lane, 'FORWARD');
  assert.equal(targets.taskVersion, '4.0.0', 'the route moved to the v5 task in lockstep');
  assert.equal(fp({ ...targets, taskVersion: '3.0.0' }), MAIN_97816A5.route, 'and nothing else about the route moved');
  assert.equal(fp(AI_BUDGET_POLICY.classes[route.budgetClass]), MAIN_97816A5.budgetClass);
  assert.equal(fp([AI_BUDGET_POLICY.organizationDaily, AI_BUDGET_POLICY.globalDaily]), MAIN_97816A5.budgetWindows);
  assert.equal(route.primary.providerId, 'anthropic', 'production stays primary-Anthropic');
});

test('the recorded controls and the BACKGROUND lane change what is RECORDED, never what a provider receives', async () => {
  const withControls = await triageFingerprint({ storedKillSwitches: async () => [], operatingBudget: async () => ({ state: 'NONE' }) });
  assert.deepEqual(withControls.requests.map(fp), CHATS_V5.requests);
  const recorded = await triageFingerprint(
    { storedKillSwitches: async () => [], operatingBudget: async () => ({ state: 'RECORDED', budget: AI_OPERATING_BUDGET_INITIAL }) },
    'BACKGROUND',
  );
  assert.deepEqual(recorded.requests.map(fp), CHATS_V5.requests, 'a recorded budget and the BACKGROUND lane leave the request untouched');
  assert.deepEqual(recorded.ledger.calls.map((c) => c.lane), ['BACKGROUND', 'BACKGROUND', 'BACKGROUND'], 'hydration and history are recorded in BACKGROUND');
  const forward = await triageFingerprint();
  assert.deepEqual(forward.ledger.calls.map((c) => c.lane), ['FORWARD', 'FORWARD', 'FORWARD'], 'live triage runs in FORWARD');
  for (const call of forward.ledger.calls) {
    assert.equal(call.specializationPolicyVersion, AI_ROUTING_POLICY.specializationPolicyVersion, 'every call records the specialization version');
    assert.equal(call.routingPolicyVersion, 'routing.2026-09-26.11');
  }
});

// --- 2. Portable schemas ------------------------------------------------------------------------------

test('every task schema is one both providers accept -- with no exemption since Chats v5', () => {
  const schemas: Record<string, Record<string, unknown>> = {
    [AI_TASK_CASE_EXPLANATION.outputSchemaId]: CASE_EXPLANATION_SCHEMA,
    [MAIL_REPLY_DRAFT_SCHEMA_ID]: MAIL_REPLY_DRAFT_SCHEMA,
    [TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID]: TELEGRAM_CONTENT_TRIAGE_SCHEMA,
    [MAIL_CONTENT_TRIAGE_SCHEMA_ID]: MAIL_CONTENT_TRIAGE_SCHEMA,
    'domain-reading.v1': DOMAIN_READING_SCHEMA as unknown as Record<string, unknown>,
    ...EXTRA_TASK_SCHEMAS,
  };
  assert.deepEqual(Object.keys(schemas).sort(), [...new Set(AI_TASKS.map((t) => t.outputSchemaId))].sort(), 'every task schema is checked');
  for (const [id, schema] of Object.entries(schemas)) {
    assert.deepEqual(aiUnexemptedSchemaViolations(id, schema).map(aiPortableSchemaViolationKey), [], `${id} is portable`);
    assert.deepEqual(aiPortableSchemaViolations(schema).map(aiPortableSchemaViolationKey), [], `${id} needs no exemption`);
  }
  // The generic domain reading is portable too, though no task sends it yet.
  assert.deepEqual(aiPortableSchemaViolations(DOMAIN_READING_SCHEMA), []);
});

test('Mail Reply Draft v2: the schema v1 would have failed on both providers is gone, and the task moves in lockstep', () => {
  const task = AI_TASKS.find((t) => t.taskId === 'mail.reply.draft')!;
  assert.equal(task.version, '1.1.0');
  assert.equal(task.outputSchemaId, 'mail-reply-draft.v2');
  assert.equal(AI_ROUTING_POLICY.tasks['mail.reply.draft']!.taskVersion, task.version);
  const flat = JSON.stringify(MAIL_REPLY_DRAFT_SCHEMA);
  assert.doesNotMatch(flat, /maxLength|maxItems|"const"|"claims"/);
});

// --- 3. The gateway's new gates -------------------------------------------------------------------

const ORG = 'org_a';
const REF = 'operational-observation:obs_1';
const PRINCIPAL: AiPrincipal = { organizationId: ORG, userId: 'user_1' };
const PRICED = { listVersion: 'list.p', inputMicrosPerToken: 5, outputMicrosPerToken: 25 };
const T1 = { providerId: 'p1', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 30_000, maxOutputTokens: 2000, pricing: PRICED } as const;
const T2 = { providerId: 'p2', modelId: 'model-b', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 1500, pricing: PRICED } as const;

function routing(patch: Partial<AiRoutingPolicy['tasks'][string]> = {}): AiRoutingPolicy {
  return {
    version: 'routing.test.1',
    specializationPolicyVersion: 'specialization.test.1',
    tasks: {
      'case.explanation': {
        taskId: 'case.explanation',
        taskVersion: AI_TASK_CASE_EXPLANATION.version,
        primary: T1,
        fallback: T2,
        fallbackPermitted: true,
        budgetClass: 'case-explanation',
        lane: 'INTERACTIVE',
        ...patch,
      },
    },
  };
}

const BUDGET: AiBudgetPolicy = {
  version: 'budget.test.1',
  classes: {
    'case-explanation': { maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 4000, taskDaily: { maxInvocations: 50, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 } },
    'telegram-content-triage': { maxInputTokensPerCall: 8000, maxOutputTokensPerCall: 2000, taskDaily: { maxInvocations: 50, maxInputTokens: 400_000, maxOutputTokens: 100_000 } },
    'mail-reply-draft': { maxInputTokensPerCall: 20_000, maxOutputTokensPerCall: 2000, taskDaily: { maxInvocations: 50, maxInputTokens: 800_000, maxOutputTokens: 120_000 } },
  },
  organizationDaily: { maxInvocations: 500, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
  globalDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
};

const POLICIES: readonly AiProviderPolicy[] = [
  { providerId: 'p1', state: 'ACTIVE', ceiling: 'OPERATIONAL', version: 1, recordedAtMs: 0 },
  { providerId: 'p2', state: 'ACTIVE', ceiling: 'OPERATIONAL', version: 1, recordedAtMs: 0 },
];

function context(): AiContextPackage {
  return {
    organizationId: ORG,
    viewerUserId: 'user_1',
    taskId: 'case.explanation',
    sensitivityCeiling: 'OPERATIONAL',
    items: [
      {
        blockId: `${ORG}::block_1`,
        kind: 'STRUCTURED',
        trust: 'GOVERNED_FACT',
        sourceRef: REF,
        content: 'situation detected; revenue down 4200 cents over the period.',
        sensitivity: 'OPERATIONAL',
        readUnder: { resource: 'commercialIntelligence', action: 'view' },
      },
    ],
  };
}

function answer(usage: AiModelResult['usage'] = { inputTokens: 900, outputTokens: 210 }): AiModelResult {
  return {
    output: {
      json: {
        schemaId: 'case-explanation.v2',
        summary: 'Revenue fell over the observed period.',
        claims: [{ kind: 'OBSERVATION', statement: 'Revenue fell by 4200 cents.', citations: [REF], figures: [{ label: 'revenueCents', value: 4200 }] }],
        limitations: ['Nothing after the observed period was supplied.'],
      },
    },
    toolCalls: [],
    stopReason: 'END',
    usage,
    providerRequestId: 'req_1',
    reportedModel: 'model-a-20260101',
    latencyMs: 800,
  };
}

function provider(providerId: string, result: AiModelResult | { failure: string } = answer()): AiProviderPort & { requests: AiModelRequest[] } {
  const port = {
    providerId,
    requests: [] as AiModelRequest[],
    async invoke(request: AiModelRequest): Promise<AiModelResult> {
      port.requests.push(request);
      if ('failure' in result) throw Object.assign(new Error(result.failure), { failure: result.failure });
      return result;
    },
  };
  return port;
}

function gateway(options: { policy?: AiRoutingPolicy; deps?: Partial<AiRuntimeDeps>; providers?: AiProviderPort[]; ledger?: InMemoryAiUsageLedger } = {}) {
  const ledger = options.ledger ?? new InMemoryAiUsageLedger();
  let n = 0;
  const runtime = new AiRuntimeGateway(
    {
      activation: { enabled: true, organizations: [ORG], tasks: ['case.explanation'], providers: ['p1', 'p2'] },
      policy: options.policy ?? routing(),
      budget: BUDGET,
      killSwitches: [],
      maxAttemptsPerTarget: 1,
    },
    {
      providers: options.providers ?? [provider('p1'), provider('p2')],
      ledger,
      authorize: async () => true,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newInvocationId: () => `inv_${++n}`,
      providerPolicies: async () => POLICIES,
      ...options.deps,
    },
  );
  return { runtime, ledger };
}

function request(patch: Partial<AiRunRequest> = {}): AiRunRequest {
  const pkg = context();
  return {
    task: AI_TASK_CASE_EXPLANATION,
    context: pkg,
    instructions: renderCaseExplanationInstructions(pkg.items.map((i) => i.sourceRef)),
    templateId: CASE_EXPLANATION_TEMPLATE_ID,
    templateVersion: CASE_EXPLANATION_TEMPLATE_VERSION,
    schema: CASE_EXPLANATION_SCHEMA,
    evidence: { figures: new Map([[REF, new Set([4200])]]), dates: new Set<string>() },
    ...patch,
  };
}

test('an answer schema with no registered contract is refused before anything is read or called', async () => {
  const p1 = provider('p1');
  let reads = 0;
  const { runtime, ledger } = gateway({
    providers: [p1],
    deps: { operatingBudget: async () => ((reads += 1), { state: 'NONE' }) },
  });
  const result = await runtime.run(PRINCIPAL, request({ task: { ...AI_TASK_CASE_EXPLANATION, outputSchemaId: 'nobody-registered.v1' } }));
  assert.deepEqual(result, { outcome: 'REFUSED_BY_LOOP', refusals: ['OUTPUT_CONTRACT_UNKNOWN'] });
  assert.equal(p1.requests.length, 0);
  assert.equal(ledger.calls.length, 0);
  assert.equal(reads, 0, 'no control was even read');
});

test('a recorded control that cannot be read refuses; it is never read as "no control"', async () => {
  const cases: Partial<AiRuntimeDeps>[] = [
    { operatingBudget: async () => ({ state: 'UNREADABLE' }) },
    { operatingBudget: async () => { throw new Error('db down'); } },
    { storedKillSwitches: async () => { throw new Error('db down'); } },
  ];
  for (const deps of cases) {
    const p1 = provider('p1');
    const { runtime, ledger } = gateway({ providers: [p1], deps });
    assert.deepEqual(await runtime.run(PRINCIPAL, request()), { outcome: 'REFUSED_BY_LOOP', refusals: ['CONTROLS_UNREADABLE'] });
    assert.equal(p1.requests.length, 0);
    assert.equal(ledger.calls.length, 0);
  }
});

test('a stored KILLED switch stops the gateway within its reader, and NONE / an empty log changes nothing', async () => {
  const killed = gateway({ deps: { storedKillSwitches: async (org) => (org === ORG ? [{ scope: 'TASK', value: 'case.explanation' }] : []) } });
  const refused = await killed.runtime.run(PRINCIPAL, request());
  assert.equal(refused.outcome, 'REFUSED_BY_LOOP');
  assert.ok(refused.outcome === 'REFUSED_BY_LOOP' && refused.refusals.includes('KILL_SWITCH'));

  const provider1 = gateway({ deps: { storedKillSwitches: async () => [{ scope: 'PROVIDER', value: 'p1' }] } });
  const served = await provider1.runtime.run(PRINCIPAL, request());
  assert.equal(served.outcome, 'ANSWERED');
  assert.equal(provider1.ledger.calls[0]!.target.providerId, 'p2', 'the killed provider is skipped; the permitted fallback serves');

  const quiet = gateway({ deps: { storedKillSwitches: async () => [], operatingBudget: async () => ({ state: 'NONE' }) } });
  assert.equal((await quiet.runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
});

test('each call is reserved in its lane, records the specialization version, and reconciles to its reported cost', async () => {
  const { runtime, ledger } = gateway();
  assert.equal((await runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
  const call = ledger.calls[0]!;
  assert.equal(call.lane, 'INTERACTIVE');
  assert.equal(call.specializationPolicyVersion, 'specialization.test.1');
  // 900 in x 5 + 210 out x 25 = 9,750 micros.
  assert.equal(call.reconciliation!.costMicros, 9_750);

  const unreported = gateway({ providers: [provider('p1', answer(null as never))] });
  await unreported.runtime.run(PRINCIPAL, request());
  assert.equal(unreported.ledger.calls[0]!.reconciliation!.costMicros, null, 'nothing reported, nothing costed');

  const failed = gateway({ providers: [provider('p1', { failure: 'INVALID_REQUEST' })] });
  await failed.runtime.run(PRINCIPAL, request());
  assert.equal(failed.ledger.calls[0]!.reconciliation!.costMicros, null);
});

test('a caller may move work to BACKGROUND and claim no other lane', async () => {
  const background = gateway();
  assert.equal((await background.runtime.run(PRINCIPAL, request({ lane: 'BACKGROUND' }))).outcome, 'ANSWERED');
  assert.equal(background.ledger.calls[0]!.lane, 'BACKGROUND');
  const claimed = gateway();
  const refused = await claimed.runtime.run(PRINCIPAL, request({ lane: 'FORWARD' }));
  assert.ok(refused.outcome === 'REFUSED_BY_LOOP' && refused.refusals.includes('LANE_NOT_PERMITTED'));
  assert.equal(claimed.ledger.calls.length, 0);
});

function withSpend(micros: number, lane: 'FORWARD' | 'BACKGROUND' | 'INTERACTIVE' | 'SYNTHESIS'): InMemoryAiUsageLedger {
  const ledger = new InMemoryAiUsageLedger();
  // One reconciled call worth `micros` in `lane`: the ledger's own rule decides what it counts.
  ledger.calls.push({
    organizationId: ORG,
    callKey: 'earlier',
    principalUserId: 'user_1',
    taskId: 'case.explanation',
    taskVersion: AI_TASK_CASE_EXPLANATION.version,
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    target: T1,
    routingPolicyVersion: 'routing.test.1',
    budgetClass: 'case-explanation',
    templateId: 't',
    templateVersion: '1',
    contextSourceRefs: [],
    estimate: { inputTokens: 1, outputTokens: 1 },
    fellBackFrom: null,
    callOrdinal: 1,
    requestedAt: new Date('2026-09-26T10:00:00.000Z'),
    lane,
    reconciliation: {
      callKey: 'earlier',
      outcome: 'ANSWERED',
      servedModel: null,
      providerRequestId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      unitCostBasis: 'list.p',
      failureClass: null,
      rejectionCodes: [],
      completedAt: new Date('2026-09-26T10:00:01.000Z'),
      latencyMs: 1,
      costMicros: micros,
    },
  });
  return ledger;
}

test('with a recorded budget, the lane and the organization day bind; with none, only the emergency ceiling does', async () => {
  const RECORDED: AiOperatingBudgetReading = { state: 'RECORDED', budget: AI_OPERATING_BUDGET_INITIAL };
  // INTERACTIVE has $2.50; $2.49 is spent, and this call reserves up to $0.1143 (~16.6k in, 2000 out).
  const lane = gateway({ ledger: withSpend(2_490_000, 'INTERACTIVE'), deps: { operatingBudget: async () => RECORDED } });
  const refused = await lane.runtime.run(PRINCIPAL, request());
  assert.ok(refused.outcome === 'REFUSED_BY_LOOP' && refused.refusals.includes('BUDGET_LANE_EXHAUSTED'));
  // The same spend with no recorded budget is today's behaviour: admitted.
  const today = gateway({ ledger: withSpend(2_490_000, 'INTERACTIVE') });
  assert.equal((await today.runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
  // The emergency ceiling applies either way.
  const emergency = gateway({ ledger: withSpend(24_990_000, 'FORWARD') });
  const stopped = await emergency.runtime.run(PRINCIPAL, request());
  assert.ok(stopped.outcome === 'REFUSED_BY_LOOP' && stopped.refusals.includes('BUDGET_EMERGENCY_CEILING'));
  // Background defers while live work is busy: FORWARD at $6 of $8.
  const background = gateway({ ledger: withSpend(6_000_000, 'FORWARD'), deps: { operatingBudget: async () => RECORDED } });
  const deferred = await background.runtime.run(PRINCIPAL, request({ lane: 'BACKGROUND' }));
  assert.ok(deferred.outcome === 'REFUSED_BY_LOOP' && deferred.refusals.includes('BUDGET_BACKGROUND_DEFERRED'));
});

test('an independent verification is served by the provider that did NOT write its subject', async () => {
  const policy = routing({ strategy: 'OTHER_THAN_SUBJECT', fallbackPermitted: false, lane: 'SYNTHESIS' });
  const p1 = provider('p1');
  const p2 = provider('p2');
  const { runtime, ledger } = gateway({ policy, providers: [p1, p2] });
  assert.equal((await runtime.run(PRINCIPAL, request({ subjectProvider: 'p1' }))).outcome, 'ANSWERED');
  assert.equal(p1.requests.length, 0);
  assert.equal(p2.requests.length, 1);
  assert.equal(ledger.calls[0]!.lane, 'SYNTHESIS');
  const none = await gateway({ policy }).runtime.run(PRINCIPAL, request());
  assert.deepEqual(none, { outcome: 'REFUSED_BY_LOOP', refusals: ['NO_INDEPENDENT_PROVIDER'] });
});
