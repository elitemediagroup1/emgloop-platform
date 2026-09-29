// Commissioning Anthropic across the governed domain readings (2026-09-29): every domain through the REAL
// AiRuntimeGateway (a RecordedModelProvider standing in for Anthropic: no key, no network, no bill). Proves
// that each domain's representative Anthropic-shaped answer is accepted and stored as RULE_AND_MODEL with its
// provenance; that the answers the contract audit found the prompt could provoke are rejected WHOLE, the rule
// reading standing; that policy, budget, activation, timeouts, 429s and 5xx fail safe with a recorded code and
// no fabricated reading; that a failed provider is not retried every pass; and that OpenAI is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, type RecordedInvocation } from '@emgloop/providers';
import { entityRefRefusal, type AiActivation, type AiBudgetPolicy, type AiModelResult, type AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { DOMAIN_READING_TEMPLATE_VERSION, renderDomainReadingInstructions } from '../src/services/ai-runtime/templates/domain-reading';
import { calendarDomainProducer } from '../src/services/intelligence-fabric/domains/calendar';
import { callgridDomainProducer, campaignsDomainProducer } from '../src/services/intelligence-fabric/domains/callgrid';
import { crmDomainProducer, creatorsDomainProducer, pipelineContextOf, pipelineDomainProducer, websiteDomainProducer, workDomainProducer } from '../src/services/intelligence-fabric/domains/records';
import { mergeModelReading, MODEL_FAILURE_BACKOFF_MS, type DomainKitPorts } from '../src/services/intelligence-fabric/domain-kit';
import { modelStageSatisfied } from '../src/services/intelligence-fabric/producer-loop';

const ORG = 'demo-org-0001';
const OPERATOR = 'user_operator_1';
const PERSON = 'user_calendar_1';
const NOW = new Date('2026-09-29T12:00:00Z');
const DAY = 864e5;
const DOMAIN_TASKS = ['calendar.domain.reading', 'callgrid.domain.reading', 'campaigns.domain.reading', 'pipeline.domain.reading', 'crm.domain.reading', 'creators.domain.reading', 'work.domain.reading', 'website.domain.reading'];
const ANTHROPIC_ACTIVE: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];

type Answer = Record<string, unknown>;
const ok = (json: Answer): AiModelResult => ({ output: { json }, toolCalls: [], stopReason: 'END', usage: { inputTokens: 900, outputTokens: 120 }, providerRequestId: 'req_1', reportedModel: 'claude-opus-5', latencyMs: 40 });
const answer = (statement: string, signals: Answer[] = [], limitations: string[] = []): Answer => ({ schemaId: 'domain-reading.v1', reading: { statement, status: 'WATCH', confidence: 'MEDIUM' }, signals, limitations });
const signal = (ref: string, patch: Answer = {}): Answer => ({ key: 'model-view', kind: 'ATTENTION', knowledge: 'INFERRED', statement: 'The week is moving in one direction.', entities: [], evidenceRefs: [ref], occurredAt: null, dueAt: null, confidence: 'MEDIUM', severity: 'MEDIUM', owedBy: null, ...patch });

/** The real gateway over a recorded Anthropic (and, never activated, a recorded OpenAI that must never be called). */
function harness(opts: { anthropic?: RecordedInvocation['result'] | { failure: RecordedInvocation['failure'] }; tasks?: string[]; policies?: readonly AiProviderPolicy[]; budget?: AiBudgetPolicy; providers?: string[] } = {}) {
  const calls = { anthropic: 0, openai: 0 };
  const recording = (modelId: string, x: typeof opts.anthropic): RecordedInvocation => (x && 'failure' in x ? { modelId, failure: x.failure } : { modelId, result: (x as AiModelResult) ?? ok(answer('Nothing material changed.')) });
  const anthropic = new RecordedModelProvider('anthropic', [recording('claude-opus-5', opts.anthropic)], (m) => aiCatalogCapabilities('anthropic', m));
  const openai = new RecordedModelProvider('openai', [{ modelId: 'gpt-6-astra', result: ok(answer('OpenAI must never answer this.')) }], (m) => aiCatalogCapabilities('openai', m));
  const count = (p: RecordedModelProvider, k: 'anthropic' | 'openai') => ({ providerId: p.providerId, capabilities: (m: string) => p.capabilities(m), invoke: (r: never, s: AbortSignal) => ((calls[k] += 1), p.invoke(r, s)) });
  const activation: AiActivation = { enabled: true, organizations: [ORG], tasks: opts.tasks ?? DOMAIN_TASKS, providers: opts.providers ?? ['anthropic'] };
  const ledger = new InMemoryAiUsageLedger();
  const gateway = new AiRuntimeGateway(
    { activation, policy: AI_ROUTING_POLICY, budget: opts.budget ?? AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [count(anthropic, 'anthropic'), count(openai, 'openai')] as never, ledger, authorize: async () => true, now: () => NOW, newInvocationId: () => `inv_${Math.random().toString(36).slice(2)}`, providerPolicies: async () => opts.policies ?? ANTHROPIC_ACTIVE },
  );
  const kit = (patch: Partial<DomainKitPorts> = {}): DomainKitPorts => ({
    modelEnabled: (id) => (opts.tasks ?? DOMAIN_TASKS).includes(id),
    reader: new DomainReadingService(gateway),
    principalFor: async (t) => (t.scope === 'PRINCIPAL' ? { organizationId: t.organizationId, userId: t.userId } : { organizationId: ORG, userId: OPERATOR }),
    ...patch,
  });
  return { calls, ledger, kit };
}

const org = (domain: string) => ({ scope: 'ORGANIZATION', organizationId: ORG, domain, subjectKind: 'DOMAIN', subjectRef: 'domain' }) as const;
const dim = { key: 'c1', label: 'c1', calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0 };
const agg = { calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0, buyers: [dim], vendors: [], sources: [], campaigns: [dim] };
const callsPort = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async () => agg, organizationIdsWithCallsSince: async () => [] } as never;
const calendarFacts = {
  calendarTimeZone: async () => 'UTC',
  calendarEvents: async () => [{ id: 'ev1', summary: 'Premier review', startsAt: new Date('2026-09-29T15:00:00Z'), endsAt: new Date('2026-09-29T16:00:00Z'), status: 'confirmed', externalAttendeeCount: 2, attendeeHashes: ['h1'], selfResponse: 'accepted' }],
  waitingThreadParticipants: async () => [],
  sentMailTo: async () => true,
  connectedGooglePrincipals: async () => [],
} as never;

/** Every in-scope domain: its producer, its context, the evidence ref its rule supplies, and an entity it supplies. */
async function domain(name: string, kit: DomainKitPorts) {
  const facts = {} as never;
  switch (name) {
    case 'CALENDAR': {
      const p = calendarDomainProducer(calendarFacts, kit);
      const target = { scope: 'PRINCIPAL', organizationId: ORG, userId: PERSON, domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
      const g = await p.gather(target, NOW);
      return { p, target, ctx: (g as { context: never }).context, ref: 'work_event:ev1', entity: null as string | null };
    }
    case 'CALLGRID':
    case 'CAMPAIGNS': {
      const p = (name === 'CALLGRID' ? callgridDomainProducer : campaignsDomainProducer)(callsPort, kit);
      const g = await p.gather(org(name), NOW);
      return { p, target: org(name), ctx: (g as { context: never }).context, ref: 'marketplace_calls:7d', entity: null };
    }
    case 'PIPELINE': {
      const read = { complete: true, totalRecords: 4, records: [{ id: 'cust1', basis: 'HUMAN_WORK', workEvents: [], status: 'Quoted', enteredAt: new Date(NOW.getTime() - 40 * DAY), lastWorkedAt: new Date(NOW.getTime() - 20 * DAY), clockAt: new Date(NOW.getTime() - 20 * DAY), stalled: true }] } as never;
      return { p: pipelineDomainProducer({} as never, {} as never, facts, kit), target: org('PIPELINE'), ctx: pipelineContextOf(read, NOW, { conversations: 2, conversationsAssigned: 1 }) as never, ref: 'intake:status', entity: 'customer:cust1' };
    }
    case 'CRM':
      return { p: crmDomainProducer(facts, kit), target: org('CRM'), ctx: { people: 40, companies: 10, awaiting: 30, newEstablished: 2, priorEstablished: 10, active: 12, started: 1, ended: 3 } as never, ref: 'parties:established', entity: null };
    case 'CREATORS':
      return { p: creatorsDomainProducer({ roster: async () => [] }, facts, kit), target: org('CREATORS'), ctx: { creators: 3, needsEmg: 2, needsCreator: 1, inProduction: 4, dueSoon: 1, waitingOnEmg: ['creator:p1'] } as never, ref: 'creator_profiles:all', entity: 'creator:p1' };
    case 'WORK':
      return { p: workDomainProducer(facts, kit), target: org('WORK'), ctx: { activeInstances: 5, openStages: 9, unassigned: 2, overdue: 1, dueSoon: 2, pastReturn: 1, completed7d: 4, completedPrior7d: 10, overdueInstanceIds: ['w1'], pastReturnInstanceIds: ['w2'], personal: false } as never, ref: 'work_stages:open', entity: 'work_instance:w1' };
    case 'WEBSITE':
      return { p: websiteDomainProducer([], facts, kit), target: org('WEBSITE'), ctx: { bySource: [{ sourceId: 'WEBSITE_EVENTS', week: { sessions: 120, formSubmits: 3, appointmentRequests: 1 }, prior: { sessions: 200, formSubmits: 3, appointmentRequests: 1 } }] } as never, ref: 'website_events:7d', entity: null };
    default:
      throw new Error(name);
  }
}
const DOMAINS = ['CALENDAR', 'CALLGRID', 'CAMPAIGNS', 'PIPELINE', 'CRM', 'CREATORS', 'WORK', 'WEBSITE'];

type Read = { status: string; modelStage?: string; digest: { content: { reading: { statement: string }; signals: { key: string; entities?: string[] }[] }; provenance: Record<string, unknown>; aiInvocationId: string | null } };
async function readOnce(name: string, h: ReturnType<typeof harness>, patch: Partial<DomainKitPorts> = {}): Promise<Read> {
  const d = await domain(name, h.kit(patch));
  return (await d.p.read(d.target as never, d.ctx, `${name.toLowerCase()}:fp`, NOW)) as unknown as Read;
}

test('EVERY DOMAIN: a representative Anthropic answer passes the contract and is stored RULE_AND_MODEL, with its model stage, identity and invocation recorded', async () => {
  for (const name of DOMAINS) {
    const d0 = await domain(name, harness().kit());
    const valid = answer('Nothing material changed this week.', [signal(d0.ref, d0.entity ? { entities: [d0.entity] } : {})]);
    const h = harness({ anthropic: ok(valid) });
    const r = await readOnce(name, h);
    assert.equal(r.status, 'READ', name);
    assert.equal(r.modelStage, 'MODEL_READ', `${name}: ${r.modelStage}`);
    assert.equal(r.digest.provenance.producerKind, 'RULE_AND_MODEL', name);
    assert.equal(r.digest.provenance.modelStage, 'MODEL_READ', name);
    assert.equal(r.digest.provenance.readingIdentity, `model:${name.toLowerCase()}.domain.reading@1.0.0/domain-reading.v1/${DOMAIN_READING_TEMPLATE_VERSION}`, name);
    assert.ok(r.digest.aiInvocationId, `${name}: the invocation is named`);
    assert.equal(r.digest.content.reading.statement, 'Nothing material changed this week.', `${name}: silence is an answer`);
    assert.ok(r.digest.content.signals.some((s) => s.key === 'm.model-view'), `${name}: the model's signal joins the rule's, keyed apart`);
    assert.deepEqual([h.calls.anthropic, h.calls.openai, h.ledger.calls.length, h.ledger.calls[0]!.lane], [1, 0, 1, 'BACKGROUND'], name);
  }
});

test('a number copied exactly from the source passes; the same fact rounded, abbreviated or computed is refused', async () => {
  // Work's rule: "9 open steps across 5 pieces of work" (work_stages:open), "Completed steps are down 60% ... (10 to 4)".
  const pass = await readOnce('WORK', harness({ anthropic: ok(answer('Nine is not a number here; 9 open steps remain.', [signal('work_stages:open', { statement: 'There are 9 open steps across 5 pieces of work.' })])) }));
  assert.equal(pass.modelStage, 'MODEL_READ');
  for (const bad of ['Completed steps fell by 6 on the week before.', 'About 10.5 steps are open.', 'There are 1.2k open steps.']) {
    const r = await readOnce('WORK', harness({ anthropic: ok(answer('Work is steady.', [signal('work_stages:open', { statement: bad })])) }));
    assert.match(r.modelStage!, /^REJECTED_OUTPUT:.*UNSUPPORTED_NUMBER_IN_TEXT/, bad);
  }
});

test('ADVERSARIAL: every answer the audit found the prompt could provoke is refused whole -- the RULE reading stands, the stage says why', async () => {
  const cases: [string, Answer, RegExp][] = [
    ['owedBy on a non-obligation (template v2 told the model "otherwise UNKNOWN")', answer('Work is steady.', [signal('work_stages:open', { owedBy: 'UNKNOWN' })]), /WRONG_SCHEMA/],
    ['an entity nobody supplied', answer('Work is steady.', [signal('work_stages:open', { entities: ['work_instance:w9'] })]), /ENTITY_NOT_SUPPLIED/],
    ['a citation nobody supplied', answer('Work is steady.', [signal('work_stages:made-up')]), /CITATION_NOT_SUPPLIED/],
    ['a quotation', answer('The team called it "fine".'), /VERBATIM_CONTENT/],
    ['a date no source has', answer('Work has been steady since 2026-01-01.'), /UNSUPPORTED_DATE_IN_TEXT/],
    ['a date alone as an instant', answer('Work is steady.', [signal('work_stages:open', { occurredAt: '2026-09-29' })]), /UNSUPPORTED_DATE_IN_TEXT/],
    ['a MEASURED claim by a model', answer('Work is steady.', [signal('work_stages:open', { knowledge: 'MEASURED' })]), /WRONG_SCHEMA/],
    ['a sentence past 280 characters', answer('Work is steady. '.repeat(20)), /ANSWER_TOO_LONG/],
    ['more than eight limitations', answer('Work is steady.', [], Array.from({ length: 9 }, () => 'A gap.')), /ANSWER_TOO_LONG/],
    ['advice', answer('You should call the buyer this week.'), /RECOMMENDS_AN_ACTION/],
    ['a numeric self-confidence', answer('Work is steady, 90% likely.'), /NUMERIC_CONFIDENCE_PRESENT/],
    ['a duplicate key', answer('Work is steady.', [signal('work_stages:open'), signal('work_stages:open')]), /WRONG_SCHEMA/],
    ['not the schema at all', { schemaId: 'domain-reading.v1', reading: 'Work is steady.' }, /WRONG_SCHEMA|EMPTY_ANSWER/],
    ['another schema', { ...answer('Work is steady.'), schemaId: 'mail-reply-draft.v1' }, /WRONG_SCHEMA|EMPTY_ANSWER/],
  ];
  for (const [label, bad, code] of cases) {
    const h = harness({ anthropic: ok(bad) });
    const r = await readOnce('WORK', h);
    assert.equal(r.status, 'READ', label);
    assert.match(r.modelStage ?? '', /^REJECTED_OUTPUT/, `${label}: ${r.modelStage}`);
    assert.match(r.modelStage ?? '', code, `${label}: ${r.modelStage}`);
    assert.equal(r.digest.provenance.producerKind, 'RULE', `${label}: the rule reading stands`);
    assert.equal(r.digest.provenance.modelStage, r.modelStage, label);
    assert.equal(r.digest.aiInvocationId, null, `${label}: no model answer is attributed`);
    assert.ok(!r.digest.content.signals.some((s) => s.key.startsWith('m.')), `${label}: nothing of the model's is kept`);
    assert.equal(h.calls.anthropic, 1, `${label}: paid once, never retried here`);
    assert.ok(modelStageSatisfied(r.modelStage), `${label}: a spent answer is not re-asked until the evidence changes`);
  }
});

test('FAILURES: timeout, 429 and 5xx store the rule reading with the failure code, are retried later -- never every pass -- and never fall back to OpenAI', async () => {
  for (const failure of ['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE'] as const) {
    const h = harness({ anthropic: { failure: { failure, message: 'provider said something' } } });
    const r = await readOnce('CALLGRID', h);
    assert.equal(r.modelStage, `FAILED:${failure}`);
    assert.equal(r.digest.provenance.producerKind, 'RULE');
    assert.equal(r.digest.provenance.modelStage, `FAILED:${failure}`);
    assert.equal(JSON.stringify(r.digest).includes('provider said'), false, 'no provider text is stored');
    assert.deepEqual([h.calls.anthropic, h.calls.openai], [1, 0], `${failure}: OpenAI is not activated, so it is never a fallback`);
    assert.equal(modelStageSatisfied(r.modelStage), false, 'a failure is tried again');
    // Within the failure window the next read costs nothing: no provider call, no ledger row.
    const asked: { since: Date }[] = [];
    const again = await readOnce('CALLGRID', h, { modelFailedSince: async (q) => (asked.push(q), true), modelRejectedSince: async () => false });
    assert.equal(again.modelStage, 'MODEL_BACKOFF:FAILED');
    assert.deepEqual([h.calls.anthropic, h.ledger.calls.length], [1, 1]);
    assert.equal(NOW.getTime() - asked[0]!.since.getTime(), MODEL_FAILURE_BACKOFF_MS);
    assert.equal(modelStageSatisfied(again.modelStage), false, 'after the window it is attempted again, even with unchanged evidence');
  }
  // An unreadable backoff fails closed: no call.
  const h = harness();
  const r = await readOnce('CALLGRID', h, { modelRejectedSince: async () => false, modelFailedSince: async () => { throw new Error('db down'); } });
  assert.deepEqual([r.modelStage, h.calls.anthropic], ['FAILED:BACKOFF_UNREADABLE', 0]);
});

test('POLICY, BUDGET, ACTIVATION: each refuses before any provider call, with its code on the stored reading', async () => {
  // No recorded policy: POLICY_DENIED.
  let h = harness({ policies: [] });
  let r = await readOnce('PIPELINE', h);
  assert.match(r.modelStage!, /^REFUSED_BY_LOOP:.*POLICY/);
  assert.deepEqual([h.calls.anthropic, r.digest.provenance.producerKind], [0, 'RULE']);
  // A policy whose ceiling is OPERATIONAL admits the organization domains (OPERATIONAL) but not Calendar (communication content).
  h = harness({ policies: [{ ...ANTHROPIC_ACTIVE[0]!, ceiling: 'OPERATIONAL' }] });
  assert.equal((await readOnce('PIPELINE', h)).modelStage, 'MODEL_READ');
  assert.match((await readOnce('CALENDAR', h)).modelStage!, /^REFUSED_BY_LOOP:.*POLICY/);
  // Budget: the domain-reading class exhausted.
  const exhausted = { ...AI_BUDGET_POLICY, classes: { ...AI_BUDGET_POLICY.classes, 'domain-reading': { ...AI_BUDGET_POLICY.classes['domain-reading']!, taskDaily: { maxInvocations: 0, maxInputTokens: 0, maxOutputTokens: 0 } } } } as AiBudgetPolicy;
  h = harness({ budget: exhausted });
  r = await readOnce('CRM', h);
  assert.match(r.modelStage!, /^REFUSED_BY_LOOP:.*BUDGET/);
  assert.deepEqual([h.calls.anthropic, h.ledger.calls.length, r.digest.provenance.producerKind], [0, 0, 'RULE']);
  assert.equal(modelStageSatisfied(r.modelStage), false, 'a refusal is tried again next pass -- free, since nothing reaches the provider');
  // Activation: the kit is told a task is on, but the deployment's activation does not list it -- the gateway refuses.
  h = harness({ tasks: ['pipeline.domain.reading'] });
  r = await readOnce('CRM', h, { modelEnabled: () => true });
  assert.match(r.modelStage!, /^REFUSED_BY_LOOP:/);
  assert.equal(h.calls.anthropic, 0);
  // And a task the deployment did not activate is never even asked.
  r = await readOnce('CRM', harness({ tasks: [] }));
  assert.equal(r.modelStage, 'MODEL_NOT_ACTIVATED');
  assert.equal(r.digest.provenance.readingIdentity, 'rule;model-off:crm.domain.reading');
  // No acting operator for the organization: no call, and the stage says so.
  h = harness();
  r = await readOnce('WORK', h, { principalFor: async () => null });
  assert.deepEqual([r.modelStage, h.calls.anthropic], ['NO_PRINCIPAL', 0]);
});

test('MERGE: model keys stay inside the key grammar and never collide; a merge the digest contract would refuse is caught before the write', () => {
  const rule = [{ key: 'open', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: 's', evidenceRefs: ['x:y'], metric: { name: 'n', value: 1, unit: 'count' } }] as never;
  const long = 'a'.repeat(62);
  const m = mergeModelReading(rule, [{ key: `${long}x`, kind: 'RISK', knowledge: 'INFERRED', statement: 's', evidenceRefs: ['x:y'] }, { key: `${long}y`, kind: 'RISK', knowledge: 'INFERRED', statement: 't', evidenceRefs: ['x:y'] }] as never, 'ORGANIZATION');
  assert.deepEqual(m.signals.map((s) => s.key), ['open', `m.${long}`], 'cut before prefixing; the repeat is dropped, never renamed');
  assert.deepEqual(m.refusals, []);
  // A reference an ORGANIZATION reading may not carry (a person's private kind) is refused by the merged check.
  const privateRef = ['telegram_conversation:k1', 'work_thread:k1', 'work_event:k1'].find((r) => entityRefRefusal(r, 'ORGANIZATION') !== null && entityRefRefusal(r, 'PRINCIPAL') === null);
  assert.ok(privateRef, 'a principal-only reference kind exists');
  const refused = mergeModelReading(rule, [{ key: 'k', kind: 'RISK', knowledge: 'INFERRED', statement: 's', evidenceRefs: ['x:y'], entities: [privateRef!] }] as never, 'ORGANIZATION');
  assert.ok(refused.refusals.length > 0);
});

test('TEMPLATE v3: the prompt says what the contract enforces, asks for one concise sentence, and makes silence a correct answer', () => {
  assert.equal(DOMAIN_READING_TEMPLATE_VERSION, '3');
  const text = renderDomainReadingInstructions({ domainDescription: 'the organization calls', audience: 'ORGANIZATION', lookFor: ['what moved'] }, ['marketplace_calls:7d'], ['provider_member:callgrid:campaign:c1']);
  assert.match(text, /On every other kind of signal `owedBy` must be null/);
  assert.equal(/otherwise UNKNOWN\./.test(text), false, 'the v2 contradiction is gone');
  assert.match(text, /exactly as written/);
  assert.match(text, /Do not round, abbreviate/);
  assert.match(text, /never write 7-day or 24 hours unless a source states 7 or 24/);
  assert.match(text, /at most 200 characters/);
  assert.match(text, /at most 280 characters/);
  assert.match(text, /at most 6 of these references/);
  assert.match(text, /`limitations`: at most 8/);
  assert.match(text, /unique within your answer/);
  assert.match(text, /If nothing material changed, say exactly that/);
  assert.match(text, /Never fill/);
  assert.match(text, /Stay inside this one domain/);
  assert.match(text, /Zero signals is a good answer/);
});
