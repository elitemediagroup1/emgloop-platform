// The Loop AI runtime gateway, driven by recorded fixtures. Slices B5 and AI-1.
//
// NO MODEL IS CALLED HERE, and none can be: every provider in this file replays what
// somebody recorded. That is the point -- authorization, activation, routing,
// reservation, fallback, refusal handling, validation, reconciliation and provenance
// are exercised end to end with no credential, no network and no bill.
//
// WHAT THESE PROVE
//
// NO PROVIDER CALL WITHOUT A RESERVATION. Every call -- first attempt, retry or
// fallback -- is reserved in the ledger before it is made. A refused or failed
// reservation means the provider is not touched. The fixtures count their calls so
// "not touched" is an assertion, not a hope.
//
// A BUDGET HOLDS UNDER CONCURRENCY. Ten simultaneous invocations against a cap of
// three make exactly three provider calls.
//
// AN ANSWER IS CHECKED BEFORE ANYBODY SEES IT, AND ACCOUNTED FOR BEFORE IT IS SHOWN.
// A contract-breaking answer is refused whole. An answer whose spend could not be
// recorded is withheld.
//
// A REFUSAL IS AN OUTCOME, NOT A RETRY. An unrecognised error is not weather.
//
// NOTHING A PERSON WROTE REACHES THE LEDGER. Reservations and reconciliations carry
// ids, versions and counts -- a planted string in the context proves it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_ACTIVATION_OFF,
  AI_TASK_CASE_EXPLANATION,
  type AiActivation,
  type AiBudgetPolicy,
  type AiContextPackage,
  type AiModelRequest,
  type AiModelResult,
  type AiRoutingPolicy,
} from '@emgloop/shared';

import {
  AiRuntimeGateway,
  InMemoryAiUsageLedger,
  type AiPrincipal,
  type AiProviderPort,
  type AiRunRequest,
  type AiRuntimeConfig,
  type AiUsageLedger,
} from '../src/services/ai-runtime/gateway';
import {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from '../src/services/ai-runtime/templates/case-explanation';

const ORG = 'org_a';
const REF = 'operational-observation:obs_1';
const NOW = new Date('2026-09-16T12:00:00.000Z');
/** Planted where a person's words go. It must never reach the ledger. */
const SECRET = 'Dana at dana@example.com said the buyer called 555-0101';
const PRINCIPAL: AiPrincipal = { organizationId: ORG, userId: 'user_1' };

function context(patch: Partial<AiContextPackage> = {}): AiContextPackage {
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
        content: `situation detected; revenue down 4200 cents over the period. ${SECRET}`,
        sensitivity: 'OPERATIONAL',
        readUnder: { resource: 'commercialIntelligence', action: 'view' },
      },
    ],
    ...patch,
  };
}

function answer(patch: Record<string, unknown> = {}, result: Partial<AiModelResult> = {}): AiModelResult {
  return {
    output: {
      json: {
        schemaId: 'case-explanation.v2',
        summary: 'Revenue fell over the observed period.',
        claims: [{ kind: 'OBSERVATION', statement: 'Revenue fell by 4200 cents.', citations: [REF], figures: [{ label: 'revenueCents', value: 4200 }] }],
        limitations: ['Nothing after the observed period was supplied.'],
        ...patch,
      },
    },
    toolCalls: [],
    stopReason: 'END',
    usage: { inputTokens: 900, outputTokens: 210 },
    providerRequestId: 'req_1',
    reportedModel: 'model-a-20260101',
    latencyMs: 800,
    ...result,
  };
}

type Step = AiModelResult | { failure: string } | { error: unknown } | 'HANG';

/** A provider that replays recorded outcomes in order and records every request it saw. */
function fixture(providerId: string, ...steps: Step[]): AiProviderPort & { calls: number; requests: AiModelRequest[] } {
  const port = {
    providerId,
    calls: 0,
    requests: [] as AiModelRequest[],
    async invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult> {
      port.calls += 1;
      port.requests.push(request);
      const step = steps[Math.min(port.calls - 1, steps.length - 1)]!;
      if (step === 'HANG') {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { failure: 'CANCELLED' })), { once: true });
        });
      }
      if ('failure' in step) throw Object.assign(new Error(step.failure), { failure: step.failure });
      if ('error' in step) throw step.error;
      return step;
    },
  };
  return port;
}

const TARGET_A = { providerId: 'p1', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 30_000, maxOutputTokens: 2000, pricing: { listVersion: 'list.p1', inputMicrosPerToken: 5, outputMicrosPerToken: 25 } } as const;
const TARGET_B = { providerId: 'p2', modelId: 'model-b', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 1500, pricing: null } as const;

const POLICY: AiRoutingPolicy = {
  version: 'routing.test.1',
  tasks: {
    'case.explanation': {
      taskId: 'case.explanation',
      taskVersion: AI_TASK_CASE_EXPLANATION.version,
      primary: TARGET_A,
      fallback: TARGET_B,
      fallbackPermitted: true,
      budgetClass: 'standard',
    },
  },
};

function budget(invocations = 50): AiBudgetPolicy {
  return {
    version: 'budget.test.1',
    classes: {
      standard: {
        maxInputTokensPerCall: 50_000,
        maxOutputTokensPerCall: 4000,
        taskDaily: { maxInvocations: invocations, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
      },
    },
    organizationDaily: { maxInvocations: invocations, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
    globalDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
  };
}

const ON: AiActivation = { enabled: true, organizations: [ORG], tasks: ['case.explanation'], providers: ['p1', 'p2'] };

interface WorldOptions {
  config?: Partial<AiRuntimeConfig>;
  ledger?: AiUsageLedger;
  authorize?: (principal: AiPrincipal) => Promise<boolean>;
  ids?: string[];
  schedule?: (fn: () => void, ms: number) => () => void;
}

function world(providers: AiProviderPort[], options: WorldOptions = {}) {
  const ledger = (options.ledger ?? new InMemoryAiUsageLedger()) as InMemoryAiUsageLedger;
  const ids = [...(options.ids ?? [])];
  let minted = 0;
  const runtime = new AiRuntimeGateway(
    {
      activation: ON,
      policy: POLICY,
      budget: budget(),
      killSwitches: [],
      maxAttemptsPerTarget: 1,
      ...options.config,
    },
    {
      providers,
      ledger,
      authorize: options.authorize ?? (async () => true),
      now: () => NOW,
      newInvocationId: () => ids.shift() ?? `inv_${++minted}`,
      schedule: options.schedule,
    },
  );
  return { runtime, ledger };
}

function request(patch: Partial<AiRunRequest> = {}): AiRunRequest {
  const pkg = patch.context ?? context();
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

/** Wraps a ledger so the order of reserve / invoke / reconcile can be asserted. */
function recording(inner: AiUsageLedger, events: string[]): AiUsageLedger {
  return {
    spend: (...args) => inner.spend(...args),
    async reserve(r, b, a) {
      events.push(`reserve:${r.callKey}`);
      return inner.reserve(r, b, a);
    },
    async reconcile(org, rec) {
      events.push(`reconcile:${rec.callKey}:${rec.outcome}`);
      return inner.reconcile(org, rec);
    },
  };
}

// --- 1. The whole sequence -------------------------------------------------------------

test('reserve, then call, then validate, then reconcile, then answer', async () => {
  const events: string[] = [];
  const inner = new InMemoryAiUsageLedger();
  const p1 = fixture('p1', answer());
  const tracked: AiProviderPort = {
    providerId: 'p1',
    async invoke(req, signal) {
      events.push(`invoke:${req.invocationId}`);
      return p1.invoke(req, signal);
    },
  };
  const { runtime } = world([tracked], { ledger: recording(inner, events), ids: ['inv_x'] });
  const result = await runtime.run(PRINCIPAL, request());

  assert.equal(result.outcome, 'ANSWERED');
  assert.deepEqual(events, ['reserve:inv_x', 'invoke:inv_x', 'reconcile:inv_x:ANSWERED'], 'the order is the guarantee');

  const row = inner.calls[0]!;
  assert.equal(row.principalUserId, 'user_1', 'whose authority it was');
  assert.equal(row.routingPolicyVersion, 'routing.test.1');
  assert.equal(row.budgetClass, 'standard');
  assert.equal(row.fellBackFrom, null);
  assert.equal(row.callOrdinal, 1);
  assert.ok(row.estimate.inputTokens > 900, 'the reserve errs high');
  assert.equal(row.estimate.outputTokens, 2000, "the route's own output ceiling");
  assert.deepEqual(row.reconciliation?.usage, { inputTokens: 900, outputTokens: 210 });
  assert.equal(row.reconciliation?.servedModel, 'model-a-20260101');
  assert.equal(row.reconciliation?.unitCostBasis, 'list.p1', 'raw usage plus the price list it is valued with');

  if (result.outcome === 'ANSWERED') {
    assert.equal(result.provenance.routingPolicyVersion, 'routing.test.1');
    assert.equal(result.provenance.calls, 1);
    assert.equal(result.provenance.viewerUserId, 'user_1');
  }
});

test('the request carries exactly what the routing policy says -- no silent model or limit', async () => {
  const p1 = fixture('p1', answer());
  const { runtime } = world([p1]);
  await runtime.run(PRINCIPAL, request());
  const sent = p1.requests[0]!;
  assert.deepEqual(sent.model, { providerId: 'p1', modelId: 'model-a' });
  assert.equal(sent.reasoningEffort, 'medium');
  assert.deepEqual(sent.limits, { maxOutputTokens: 2000, timeoutMs: 30_000 });
  assert.deepEqual(sent.tools, [], 'no tools, so nothing a model says can be executed');
  assert.equal(sent.output.kind, 'JSON_SCHEMA');
});

// --- 2. Who may ask --------------------------------------------------------------------

test('a context assembled for someone else, or elsewhere, is refused before anything else', async () => {
  const p1 = fixture('p1', answer());
  const { runtime, ledger } = world([p1]);
  for (const principal of [
    { organizationId: 'org_b', userId: 'user_1' },
    { organizationId: ORG, userId: 'user_2' },
    { organizationId: '', userId: 'user_1' },
  ]) {
    const result = await runtime.run(principal, request());
    assert.deepEqual(result, { outcome: 'REFUSED_BY_LOOP', refusals: ['NOT_AUTHORIZED'] }, JSON.stringify(principal));
  }
  // A context for another task is not borrowed either.
  const wrongTask = await runtime.run(PRINCIPAL, request({ context: context({ taskId: 'other.task' }) }));
  assert.equal(wrongTask.outcome, 'REFUSED_BY_LOOP');
  assert.equal(p1.calls, 0);
  assert.equal(ledger.calls.length, 0);
});

test('an unauthorized person learns nothing, spends nothing, and nobody is called', async () => {
  const p1 = fixture('p1', answer());
  let ledgerRead = false;
  const ledger: AiUsageLedger = {
    async spend() {
      ledgerRead = true;
      throw new Error('should not be read');
    },
    async reserve() {
      throw new Error('should not be reserved');
    },
    async reconcile() {
      throw new Error('should not be reconciled');
    },
  };
  for (const authorize of [async () => false, async () => { throw new Error('iam down'); }]) {
    const { runtime } = world([p1], { ledger, authorize, config: { activation: AI_ACTIVATION_OFF } });
    const result = await runtime.run(PRINCIPAL, request());
    assert.deepEqual(result, { outcome: 'REFUSED_BY_LOOP', refusals: ['NOT_AUTHORIZED'] });
  }
  assert.equal(ledgerRead, false, 'not even the spend is read for them');
  assert.equal(p1.calls, 0);
});

// --- 3. Off by default -------------------------------------------------------------------

test('a registered provider with a working client still makes zero calls until activation', async () => {
  const p1 = fixture('p1', answer());
  const p2 = fixture('p2', answer());
  for (const activation of [
    AI_ACTIVATION_OFF,
    { ...ON, enabled: false },
    { ...ON, organizations: [] },
    { ...ON, tasks: [] },
    { ...ON, providers: [] },
  ]) {
    const { runtime, ledger } = world([p1, p2], { config: { activation } });
    const result = await runtime.run(PRINCIPAL, request());
    assert.equal(result.outcome, 'REFUSED_BY_LOOP', JSON.stringify(activation));
    assert.equal(ledger.calls.length, 0);
  }
  assert.equal(p1.calls + p2.calls, 0);
});

test('a kill switch, a missing budget and a refused context each stop it before any reservation', async () => {
  const p1 = fixture('p1', answer());
  const cases: Array<[Partial<AiRuntimeConfig>, Partial<AiRunRequest>, string]> = [
    [{ killSwitches: [{ scope: 'GLOBAL' }] }, {}, 'KILL_SWITCH'],
    [{ killSwitches: [{ scope: 'ORGANIZATION', value: ORG }] }, {}, 'KILL_SWITCH'],
    [{ killSwitches: [{ scope: 'TASK', value: 'case.explanation' }] }, {}, 'KILL_SWITCH'],
    [{ budget: null }, {}, 'BUDGET_NOT_CONFIGURED'],
    [{}, { context: context({ sensitivityCeiling: 'OPERATIONAL', items: [{ ...context().items[0]!, sensitivity: 'CONTACT_IDENTIFIER' }] }) }, 'CONTEXT_REFUSED'],
    [{}, { context: context({ items: [] }) }, 'CONTEXT_REFUSED'],
  ];
  for (const [config, req, refusal] of cases) {
    const { runtime, ledger } = world([p1], { config });
    const result = await runtime.run(PRINCIPAL, request(req));
    assert.equal(result.outcome, 'REFUSED_BY_LOOP', refusal);
    if (result.outcome === 'REFUSED_BY_LOOP') assert.ok(result.refusals.includes(refusal as never), `${refusal}: ${result.refusals}`);
    assert.equal(ledger.calls.length, 0);
  }
  assert.equal(p1.calls, 0);
});

// --- 4. The reservation is authoritative -----------------------------------------------------

test('a refused reservation means the provider is not called', async () => {
  const p1 = fixture('p1', answer());
  const refusing: AiUsageLedger = {
    spend: async () => ({ organization: { invocations: 0, inputTokens: 0, outputTokens: 0 }, task: { invocations: 0, inputTokens: 0, outputTokens: 0 }, global: { invocations: 0, inputTokens: 0, outputTokens: 0 } }),
    reserve: async () => ({ ok: false, refusals: ['BUDGET_ORGANIZATION_EXHAUSTED'] }),
    reconcile: async () => true,
  };
  const { runtime } = world([p1], { ledger: refusing });
  const result = await runtime.run(PRINCIPAL, request());
  assert.deepEqual(result, { outcome: 'REFUSED_BY_LOOP', refusals: ['BUDGET_ORGANIZATION_EXHAUSTED'] });
  assert.equal(p1.calls, 0, 'the cheap check said yes; the authoritative one said no; nothing was sent');
});

test('a ledger that cannot reserve, or cannot even be read, means no call', async () => {
  const p1 = fixture('p1', answer());
  const broken: AiUsageLedger = {
    spend: async () => ({ organization: { invocations: 0, inputTokens: 0, outputTokens: 0 }, task: { invocations: 0, inputTokens: 0, outputTokens: 0 }, global: { invocations: 0, inputTokens: 0, outputTokens: 0 } }),
    reserve: async () => {
      throw new Error('connection reset');
    },
    reconcile: async () => true,
  };
  assert.deepEqual(await world([p1], { ledger: broken }).runtime.run(PRINCIPAL, request()), { outcome: 'REFUSED_BY_LOOP', refusals: ['LEDGER_UNAVAILABLE'] });
  const unreadable: AiUsageLedger = { ...broken, spend: async () => { throw new Error('down'); } };
  assert.deepEqual(await world([p1], { ledger: unreadable }).runtime.run(PRINCIPAL, request()), { outcome: 'REFUSED_BY_LOOP', refusals: ['LEDGER_UNAVAILABLE'] });
  assert.equal(p1.calls, 0);
});

test('ten simultaneous invocations against a cap of three make exactly three calls', async () => {
  const p1 = fixture('p1', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1], { ledger, config: { budget: budget(3), policy: { ...POLICY, tasks: { 'case.explanation': { ...POLICY.tasks['case.explanation']!, fallbackPermitted: false } } } } });
  const results = await Promise.all(Array.from({ length: 10 }, () => runtime.run(PRINCIPAL, request())));
  assert.equal(p1.calls, 3);
  assert.equal(ledger.calls.length, 3);
  assert.equal(results.filter((r) => r.outcome === 'ANSWERED').length, 3);
  const refused = results.filter((r) => r.outcome === 'REFUSED_BY_LOOP');
  assert.equal(refused.length, 7);
  for (const r of refused) {
    if (r.outcome === 'REFUSED_BY_LOOP') assert.ok(r.refusals.some((x) => x.startsWith('BUDGET_')), `${r.refusals}`);
  }
});

test('a duplicate invocation id is refused, and the provider is not called twice', async () => {
  const p1 = fixture('p1', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1], { ledger, ids: ['inv_same', 'inv_same'] });
  assert.equal((await runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
  assert.deepEqual(await runtime.run(PRINCIPAL, request()), { outcome: 'REFUSED_BY_LOOP', refusals: ['DUPLICATE_INVOCATION'] });
  assert.equal(p1.calls, 1);
  assert.equal(ledger.calls.length, 1);
});

// --- 5. Retry, fallback, and what each costs --------------------------------------------------

test('a retry is a second call with its own reservation, and the failed one is reconciled as unreported', async () => {
  const p1 = fixture('p1', { failure: 'RATE_LIMITED' }, answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1], { ledger, ids: ['inv_r'], config: { maxAttemptsPerTarget: 2 } });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(p1.calls, 2);
  assert.deepEqual(ledger.calls.map((c) => c.callKey), ['inv_r', 'inv_r.2']);
  const [first, second] = ledger.calls;
  assert.equal(first!.reconciliation?.outcome, 'FAILED');
  assert.equal(first!.reconciliation?.failureClass, 'RATE_LIMITED');
  assert.equal(first!.reconciliation?.usage, null, 'unreported, so the reserve keeps counting -- never zero');
  assert.equal(second!.callOrdinal, 2);
  assert.equal(second!.fellBackFrom, null, 'a retry on the same model is not a fallback');
  if (result.outcome === 'ANSWERED') assert.equal(result.provenance.calls, 2);
});

test('a primary that is unavailable falls back, and the fallback is recorded as one', async () => {
  const p1 = fixture('p1', { failure: 'UNAVAILABLE' });
  const p2 = fixture('p2', answer({}, { reportedModel: 'model-b-1' }));
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger, ids: ['inv_f'] });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(p1.calls, 1);
  assert.equal(p2.calls, 1);
  const fallback = ledger.calls[1]!;
  assert.equal(fallback.callKey, 'inv_f.2');
  assert.equal(fallback.fellBackFrom, 'p1/model-a');
  assert.equal(fallback.target.modelId, 'model-b');
  assert.equal(fallback.estimate.outputTokens, 1500, "the fallback is reserved at its own route's ceiling");
  if (result.outcome === 'ANSWERED') {
    assert.deepEqual(result.provenance.requestedModel, { providerId: 'p2', modelId: 'model-b' });
    assert.equal(result.provenance.servedModel, 'model-b-1');
  }
  assert.equal(p2.requests[0]!.reasoningEffort, 'low', "the fallback runs under its own policy");
});

test('a killed primary is served by the permitted fallback, and the first call says so', async () => {
  const p1 = fixture('p1', answer());
  const p2 = fixture('p2', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger, config: { killSwitches: [{ scope: 'PROVIDER', value: 'p1' }] } });
  assert.equal((await runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
  assert.equal(p1.calls, 0);
  assert.equal(ledger.calls[0]!.fellBackFrom, 'p1/model-a', 'the provider never changes silently');
  // Whereas a merely unregistered FALLBACK changes nothing about the primary call.
  const only = world([fixture('p1', answer())]);
  await only.runtime.run(PRINCIPAL, request());
  assert.equal(only.ledger.calls[0]!.fellBackFrom, null);
});

test('a fallback whose reservation is refused is not made', async () => {
  const p1 = fixture('p1', { failure: 'UNAVAILABLE' });
  const p2 = fixture('p2', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger, config: { budget: budget(1) } });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') {
    assert.equal(result.failure, 'UNAVAILABLE', "the reason is the primary's failure");
    assert.equal(result.provenance.calls, 1);
    assert.equal(result.provenance.usage, null, 'nobody reported usage; unknown is not free');
  }
  assert.equal(p2.calls, 0, 'no reservation, no call -- even for a fallback');
  assert.equal(ledger.calls.length, 1);
});

test('fallback does not happen where policy forbids it, or where the failure forbids it', async () => {
  const noFallbackPolicy: AiRoutingPolicy = { ...POLICY, tasks: { 'case.explanation': { ...POLICY.tasks['case.explanation']!, fallbackPermitted: false } } };
  for (const [config, step] of [
    [{ policy: noFallbackPolicy }, { failure: 'UNAVAILABLE' }],
    [{}, { failure: 'AUTH' }],
    [{}, { failure: 'INVALID_REQUEST' }],
    [{}, { failure: 'CONTEXT_TOO_LARGE' }],
  ] as const) {
    const p1 = fixture('p1', step as Step);
    const p2 = fixture('p2', answer());
    const { runtime } = world([p1, p2], { config: config as Partial<AiRuntimeConfig> });
    const result = await runtime.run(PRINCIPAL, request());
    assert.equal(result.outcome, 'FAILED', JSON.stringify(step));
    assert.equal(p2.calls, 0, `${JSON.stringify(step)} must not reach the fallback`);
  }
});

test('an error nobody recognises is not retried and not fallen back from', async () => {
  for (const error of [new Error('socket hang up'), { failure: 'SOMETHING_NEW' }, 'a string', null]) {
    const p1 = fixture('p1', { error });
    const p2 = fixture('p2', answer());
    const { runtime, ledger } = world([p1, p2], { config: { maxAttemptsPerTarget: 3 } });
    const result = await runtime.run(PRINCIPAL, request());
    assert.equal(result.outcome, 'FAILED');
    if (result.outcome === 'FAILED') assert.equal(result.failure, 'UNCLASSIFIED');
    assert.equal(p1.calls, 1, 'not retried');
    assert.equal(p2.calls, 0, 'not fallen back from');
    assert.equal(ledger.calls[0]!.reconciliation?.failureClass, 'UNCLASSIFIED', 'recorded as a class, never as the error text');
  }
});

test('a call past its deadline is a timeout, and the fallback serves', async () => {
  const p1 = fixture('p1', 'HANG');
  const p2 = fixture('p2', answer());
  // The first call's deadline fires as soon as it is armed, so the test waits for
  // nothing; the fallback's deadline never fires.
  let armed = 0;
  const schedule = (fn: () => void) => {
    armed += 1;
    if (armed === 1) queueMicrotask(fn);
    return () => undefined;
  };
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger, schedule });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(ledger.calls[0]!.reconciliation?.failureClass, 'TIMEOUT', 'not CANCELLED: Loop set the deadline, nobody cancelled');
});

test('a result that arrives after the deadline is not used', async () => {
  let release: () => void = () => undefined;
  const late: AiProviderPort = {
    providerId: 'p1',
    invoke: () => new Promise((resolve) => { release = () => resolve(answer()); }),
  };
  const schedule = (fn: () => void) => {
    queueMicrotask(() => {
      fn();
      release();
    });
    return () => undefined;
  };
  const noFallback: AiRoutingPolicy = { ...POLICY, tasks: { 'case.explanation': { ...POLICY.tasks['case.explanation']!, fallbackPermitted: false } } };
  const { runtime } = world([late], { schedule, config: { policy: noFallback } });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.equal(result.failure, 'TIMEOUT');
});

test('a cancelled invocation stops, is recorded as cancelled, and does not fall back', async () => {
  const controller = new AbortController();
  const p1: AiProviderPort = {
    providerId: 'p1',
    invoke: (_req, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { failure: 'CANCELLED' })), { once: true });
        controller.abort();
      }),
  };
  const p2 = fixture('p2', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger });
  const result = await runtime.run(PRINCIPAL, request({ signal: controller.signal }));
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.equal(result.failure, 'CANCELLED');
  assert.equal(p2.calls, 0);
  assert.equal(ledger.calls[0]!.reconciliation?.outcome, 'CANCELLED');

  // Already cancelled before anything: nothing is reserved at all.
  const before = new AbortController();
  before.abort();
  const p3 = fixture('p1', answer());
  const idle = world([p3]);
  const early = await idle.runtime.run(PRINCIPAL, request({ signal: before.signal }));
  assert.equal(early.outcome, 'FAILED');
  assert.equal(p3.calls, 0);
  assert.equal(idle.ledger.calls.length, 0);
});

// --- 6. The answer ------------------------------------------------------------------------------

test('an answer that breaks its contract is refused whole, reconciled, and not fallen back from', async () => {
  const p1 = fixture('p1', answer({ claims: [{ kind: 'OBSERVATION', statement: 'Revenue fell by 9999 cents.', citations: ['decision-evidence:invented'], figures: [{ label: 'x', value: 9999 }] }] }));
  const p2 = fixture('p2', answer());
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([p1, p2], { ledger });
  const result = await runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'REJECTED_OUTPUT');
  if (result.outcome === 'REJECTED_OUTPUT') {
    assert.ok(result.rejections.includes('CITATION_NOT_SUPPLIED'));
    assert.ok(result.rejections.includes('FIGURE_NOT_SUPPORTED'));
    assert.equal('output' in result, false, 'nothing of the answer is returned');
  }
  assert.equal(p2.calls, 0, 'a second opinion is not a fallback');
  const row = ledger.calls[0]!;
  assert.equal(row.reconciliation?.outcome, 'REJECTED_BY_LOOP');
  assert.deepEqual([...row.reconciliation!.rejectionCodes].sort(), ['CITATION_NOT_SUPPLIED', 'FIGURE_NOT_SUPPORTED', 'UNSUPPORTED_NUMBER_IN_TEXT']);
  assert.deepEqual(row.reconciliation?.usage, { inputTokens: 900, outputTokens: 210 }, 'a rejected answer still cost money');
});

test('a body that is not the shape asked for is rejected, not thrown on', async () => {
  for (const json of [
    { schemaId: 'case-explanation.v2', summary: 's', claims: [{ kind: 'OBSERVATION', statement: 'no citations array', figures: [] }], limitations: [] },
    { schemaId: 'case-explanation.v2', summary: 's', claims: 'nope', limitations: [] },
    'not even an object',
  ]) {
    const p1 = fixture('p1', { ...answer(), output: { json } });
    const { runtime } = world([p1]);
    const result = await runtime.run(PRINCIPAL, request());
    assert.equal(result.outcome, 'REJECTED_OUTPUT', JSON.stringify(json));
    if (result.outcome === 'REJECTED_OUTPUT') assert.deepEqual(result.rejections, ['WRONG_SCHEMA']);
  }
  const text = fixture('p1', { ...answer(), output: { text: '{not json' } });
  assert.equal((await world([text]).runtime.run(PRINCIPAL, request())).outcome, 'REJECTED_OUTPUT');
});

test('a truncated answer is rejected even if what arrived happens to parse', async () => {
  const p1 = fixture('p1', answer({}, { stopReason: 'MAX_TOKENS' }));
  const ledger = new InMemoryAiUsageLedger();
  const result = await world([p1], { ledger }).runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'REJECTED_OUTPUT');
  assert.equal(ledger.calls[0]!.reconciliation?.failureClass, 'OUTPUT_TRUNCATED');
});

test('an unfinished answer is rejected as incomplete, and is not fallen back from', async () => {
  const p1 = fixture('p1', answer({}, { stopReason: 'INCOMPLETE' }));
  const p2 = fixture('p2', answer());
  const ledger = new InMemoryAiUsageLedger();
  const result = await world([p1, p2], { ledger }).runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'REJECTED_OUTPUT');
  assert.equal(ledger.calls[0]!.reconciliation?.failureClass, 'OUTPUT_INCOMPLETE');
  assert.equal(p2.calls, 0);
});

test('a refusal stops: Loop does not ask another provider until one agrees', async () => {
  for (const stopReason of ['REFUSAL', 'CONTENT_FILTERED'] as const) {
    const p1 = fixture('p1', answer({}, { stopReason }));
    const p2 = fixture('p2', answer());
    const ledger = new InMemoryAiUsageLedger();
    const result = await world([p1, p2], { ledger }).runtime.run(PRINCIPAL, request());
    assert.equal(result.outcome, 'REFUSED_BY_MODEL');
    assert.equal(p2.calls, 0);
    assert.equal(ledger.calls[0]!.reconciliation?.outcome, 'REFUSED_BY_MODEL');
  }
});

test('an answer whose spend could not be recorded is withheld', async () => {
  const p1 = fixture('p1', answer());
  const inner = new InMemoryAiUsageLedger();
  const flaky: AiUsageLedger = {
    spend: (...a) => inner.spend(...a),
    reserve: (...a) => inner.reserve(...a),
    reconcile: async () => {
      throw new Error('write failed');
    },
  };
  const result = await world([p1], { ledger: flaky }).runtime.run(PRINCIPAL, request());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.equal(result.failure, 'LEDGER_UNAVAILABLE');
  assert.equal('output' in result, false);
  // And a reconcile that finds no row is treated the same way.
  const fresh = new InMemoryAiUsageLedger();
  const vanished: AiUsageLedger = {
    spend: (...a) => fresh.spend(...a),
    reserve: (...a) => fresh.reserve(...a),
    reconcile: async () => false,
  };
  assert.equal((await world([fixture('p1', answer())], { ledger: vanished }).runtime.run(PRINCIPAL, request())).outcome, 'FAILED');
});

// --- 7. Estimates are replaced by what happened ------------------------------------------------

test('an under-estimate is corrected upward, and the next admission sees the real spend', async () => {
  const huge = fixture('p1', answer({}, { usage: { inputTokens: 400_000, outputTokens: 210 } }));
  const ledger = new InMemoryAiUsageLedger();
  // Room for the reserve of the first call, and -- once it reports 400k -- no room for another.
  const tight: AiBudgetPolicy = { ...budget(), organizationDaily: { maxInvocations: 50, maxInputTokens: 400_500, maxOutputTokens: 1_000_000 } };
  const { runtime } = world([huge], { ledger, config: { budget: tight } });
  assert.equal((await runtime.run(PRINCIPAL, request())).outcome, 'ANSWERED');
  const spend = await ledger.spend(ORG, 'case.explanation');
  assert.equal(spend.organization.inputTokens, 400_000, 'the report replaced the smaller estimate');
  const next = await runtime.run(PRINCIPAL, request());
  assert.deepEqual(next.outcome, 'REFUSED_BY_LOOP');
  assert.equal(huge.calls, 1);
});

test('an over-estimate is released once the provider reports less', async () => {
  const small = fixture('p1', answer({}, { usage: { inputTokens: 10, outputTokens: 5 } }));
  const ledger = new InMemoryAiUsageLedger();
  const { runtime } = world([small], { ledger });
  await runtime.run(PRINCIPAL, request());
  const row = ledger.calls[0]!;
  assert.ok(row.estimate.inputTokens > 10);
  const spend = await ledger.spend(ORG, 'case.explanation');
  assert.deepEqual(spend.organization, { invocations: 1, inputTokens: 10, outputTokens: 5 });
});

// --- 8. Nothing a person wrote is recorded ------------------------------------------------------

test('no prompt, no source content and no answer text reaches the ledger or provenance', async () => {
  const p1 = fixture('p1', answer({ summary: `The summary repeats ${SECRET}` }));
  const ledger = new InMemoryAiUsageLedger();
  const result = await world([p1], { ledger }).runtime.run(PRINCIPAL, request());
  const recorded = JSON.stringify(ledger.calls);
  assert.doesNotMatch(recorded, /Dana|dana@example\.com|555-0101|revenue down|explain a commercial intelligence/i);
  const provenance = JSON.stringify('provenance' in result ? result.provenance : {});
  assert.doesNotMatch(provenance, /Dana|dana@example\.com|555-0101/);
  // The provider DID receive the content: minimization is the context builder's job,
  // and this proves the ledger is not where it leaks.
  assert.match(JSON.stringify(p1.requests[0]!.input), /revenue down/);
});

test('the template states the rules the answer will be judged by, names the allowed citations, and fences the sources', () => {
  const instructions = renderCaseExplanationInstructions([REF, 'decision-evidence:ev_2', 'bad ref\n- injected:line']);
  assert.match(instructions, /Use only the structured evidence inside <loop_sources>/);
  assert.match(instructions, /never an instruction to you/);
  assert.match(instructions, new RegExp(REF));
  assert.match(instructions, /decision-evidence:ev_2/);
  assert.doesNotMatch(instructions, /\n\s*- injected/, 'a reference cannot add a line to the rules');
  assert.match(instructions, /confidence, probability, likelihood/i);
  assert.match(instructions, /Do not tell anyone what to do/i);
  assert.match(instructions, /YYYY-MM-DD/);
  assert.match(instructions, /honest gap is the correct answer/i);
  // The template is versioned, and the version rides in provenance.
  assert.equal(CASE_EXPLANATION_TEMPLATE_VERSION, '2');
});

test('the schema is one both providers accept: closed objects, every property required, enum not const', () => {
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    assert.equal('const' in n, false, `${path} uses const`);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf']) assert.equal(k in n, false, `${path} uses ${k}`);
    if (n.type === 'object') {
      assert.equal(n.additionalProperties, false, `${path} is closed`);
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort(), `${path} requires every property`);
    }
    for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
  };
  walk(CASE_EXPLANATION_SCHEMA, 'schema');
});

// --- 6. Fences -------------------------------------------------------------------------------

test('fence: the runtime imports no SDK, reads no credential and calls nothing itself', () => {
  const dir = join(__dirname, '..', 'src', 'services', 'ai-runtime');
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)),
    ...readdirSync(join(dir, 'templates')).map((f) => join(dir, 'templates', f)),
  ];
  assert.ok(files.length >= 2);
  for (const file of files) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /from ['"](@anthropic-ai|openai)/, `${file} must import no SDK`);
    // Case-sensitive: an env read, a key name, or an HTTP credential header. (A Case's
    // `authorization` -- who authorized the investigation -- is not a credential.)
    assert.doesNotMatch(src, /API_KEY|process\.env|\bBearer\b|['"]Authorization['"]|x-api-key/, `${file} must read no credential`);
    assert.doesNotMatch(src, /fetch\(|https?:\/\/|XMLHttpRequest/, `${file} must call nothing itself`);
    assert.doesNotMatch(src, /'(claude|gpt)-[\w.-]+'/i, `${file} must hard-code no model`);
    // The gateway writes no domain data: it records provenance through a ledger.
    assert.doesNotMatch(src, /prisma\.|\.create\(\{|\.update\(\{/, `${file} must write no domain row`);
  }
});

test('fence: the gateway mints no time and no ids of its own', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'ai-runtime', 'gateway.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)|randomUUID|Math\.random/);
  assert.match(src, /this\.deps\.now\(\)/);
  assert.match(src, /this\.deps\.newInvocationId\(\)/);
});
