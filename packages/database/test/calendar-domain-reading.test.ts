// Calendar's domain reading through the REAL AiRuntimeGateway and the REAL domain-reading.v1 contract (a
// RecordedModelProvider: no key, no network, no bill). The production defect of 2026-09-28, after #342: every
// Calendar answer reached Anthropic and was discarded (OUTPUT_INVALID 3/3). Template v1 rule 5 told the model
// to write occurredAt/dueAt as a bare YYYY-MM-DD; the signal contract accepts only a UTC instant, so every
// dated signal was refused (BAD_INSTANT -> UNSUPPORTED_DATE_IN_TEXT). Calendar is the one activated domain
// whose sources carry instants, so it is the one whose readings date their signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET } from '@emgloop/providers';
import type { AiActivation, AiModelResult, AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { DOMAIN_READING_TEMPLATE_ID, DOMAIN_READING_TEMPLATE_VERSION, renderDomainReadingInstructions } from '../src/services/ai-runtime/templates/domain-reading';
import { calendarDomainProducer } from '../src/services/intelligence-fabric/domains/calendar';
import { MODEL_REJECTION_BACKOFF_MS, type DomainKitPorts } from '../src/services/intelligence-fabric/domain-kit';
import { IntelligenceProducerRegistry } from '../src/services/intelligence-fabric/producer';
import { runIntelligenceProducerCycle, type ProducerLoopDeps } from '../src/services/intelligence-fabric/producer-loop';
import type { IntelligenceRefreshClaim } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';

const ORG = 'demo-org-0001';
const USER = 'user_calendar_1';
const T0 = new Date('2026-09-28T12:00:00Z');
const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];
const TASKS = ['calendar.domain.reading'];
const TARGET = { scope: 'PRINCIPAL', organizationId: ORG, userId: USER, domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
const REVIEW_STARTS = '2026-09-28T15:00:00.000Z';

// A client review (2 outside attendees, mail waiting on the person) overlapping a standup.
const EVENTS = [
  { id: 'ev1', summary: 'Premier review', startsAt: new Date(REVIEW_STARTS), endsAt: new Date('2026-09-28T16:00:00Z'), status: 'confirmed', externalAttendeeCount: 2, attendeeHashes: ['h1'], selfResponse: 'accepted' },
  { id: 'ev2', summary: 'Standup', startsAt: new Date('2026-09-28T15:30:00Z'), endsAt: new Date('2026-09-28T15:45:00Z'), status: 'confirmed', externalAttendeeCount: 0, attendeeHashes: ['h2'], selfResponse: 'accepted' },
];

function calendarFacts(events: () => typeof EVENTS) {
  return {
    calendarTimeZone: async () => 'America/New_York',
    calendarEvents: async () => events(),
    waitingThreadParticipants: async () => [['h1']],
    sentMailTo: async () => true,
    connectedGooglePrincipals: async () => [{ organizationId: ORG, userId: USER }],
  } as never;
}

type Signal = Record<string, unknown>;
const signal = (patch: Signal = {}): Signal => ({
  key: 'client-review',
  kind: 'ATTENTION',
  knowledge: 'INFERRED',
  statement: 'The client review with 2 outside attendees is the meeting that matters, and it collides with your standup.',
  entities: ['work_event:ev1'],
  evidenceRefs: ['work_event:ev1'],
  occurredAt: null,
  dueAt: REVIEW_STARTS,
  confidence: 'MEDIUM',
  severity: 'HIGH',
  owedBy: null,
  ...patch,
});
const answer = (opts: { reading?: string; signals?: Signal[]; json?: unknown; stopReason?: AiModelResult['stopReason'] } = {}): AiModelResult => ({
  output: {
    json: opts.json ?? {
      schemaId: 'domain-reading.v1',
      reading: { statement: opts.reading ?? 'Your 2 meetings today turn on one client review, which overlaps the standup.', status: 'ATTENTION', confidence: 'MEDIUM' },
      signals: opts.signals ?? [signal()],
      limitations: [],
    },
  },
  toolCalls: [],
  stopReason: opts.stopReason ?? 'END',
  usage: { inputTokens: 1400, outputTokens: 220 },
  providerRequestId: 'req_cal',
  reportedModel: 'claude-opus-5',
  latencyMs: 40,
});

/** The kit's backoff port, answered from the in-memory ledger exactly as the repository answers it. */
const ledgerBackoff = (ledger: InMemoryAiUsageLedger): NonNullable<DomainKitPorts['modelRejectedSince']> => async (q) =>
  ledger.calls.some(
    (c) =>
      c.organizationId === q.organizationId &&
      c.taskId === q.taskId &&
      c.taskVersion === q.taskVersion &&
      c.templateId === DOMAIN_READING_TEMPLATE_ID &&
      c.templateVersion === q.templateVersion &&
      c.reconciliation?.outcome === 'REJECTED_BY_LOOP' &&
      c.requestedAt >= q.since &&
      (q.userId === null || c.principalUserId === q.userId),
  );

function harness(results: AiModelResult[], opts: { backoff?: boolean; events?: () => typeof EVENTS } = {}) {
  let now = T0;
  const clock = { set: (d: Date) => void (now = d), now: () => now };
  const ledger = new InMemoryAiUsageLedger();
  const activation: AiActivation = { enabled: true, organizations: [ORG], tasks: TASKS, providers: ['anthropic'] };
  // One recorded answer per call, in order (a RecordedModelProvider each); a call beyond them fails loudly.
  const recorded = results.map((result) => new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result }], (m) => aiCatalogCapabilities('anthropic', m)));
  let next = 0;
  const provider = {
    providerId: 'anthropic',
    capabilities: (m: string) => aiCatalogCapabilities('anthropic', m),
    invoke: (request: never, signal: AbortSignal) => {
      const r = recorded[next++];
      if (!r) throw new Error('an unexpected, unrecorded provider call');
      return r.invoke(request, signal);
    },
  };
  const gateway = new AiRuntimeGateway(
    { activation, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [provider], ledger, authorize: async () => true, now: () => now, newInvocationId: () => `inv_${Math.random().toString(36).slice(2)}`, providerPolicies: async () => POLICY },
  );
  const producer = calendarDomainProducer(calendarFacts(opts.events ?? (() => EVENTS)), {
    modelEnabled: (id) => TASKS.includes(id),
    reader: new DomainReadingService(gateway),
    principalFor: async (t) => (t.scope === 'PRINCIPAL' ? { organizationId: t.organizationId, userId: t.userId } : null),
    ...(opts.backoff === false ? {} : { modelRejectedSince: ledgerBackoff(ledger) }),
  });
  const readOnce = async () => {
    const g = await producer.gather(TARGET, now);
    assert.equal(g.status, 'READY');
    const r = await producer.read(TARGET, (g as { context: never }).context, 'calendar:fp', now);
    assert.equal(r.status, 'READ');
    return r as { modelStage?: string; digest: { provenance: { producerKind: string }; content: { reading: { statement: string }; signals: Signal[]; limitations: string[] } } };
  };
  return { ledger, producer, clock, readOnce };
}

test('root cause, pinned: an answer written as template v1 instructed (dueAt as YYYY-MM-DD) is refused whole -- UNSUPPORTED_DATE_IN_TEXT', async () => {
  const h = harness([answer({ signals: [signal({ dueAt: '2026-09-28' })] })]);
  const r = await h.readOnce();
  assert.equal(r.modelStage, 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT', 'the code production could not see');
  assert.equal(r.digest.provenance.producerKind, 'RULE');
  assert.equal(h.ledger.calls.length, 1, 'it was paid for');
  const rec = h.ledger.calls[0]!.reconciliation!;
  assert.equal(rec.outcome, 'REJECTED_BY_LOOP');
  assert.equal(rec.failureClass, 'OUTPUT_INVALID', 'what the status page showed 3/3');
  assert.deepEqual(rec.rejectionCodes, ['UNSUPPORTED_DATE_IN_TEXT']);
});

test('template v2 asks for the shape the contract accepts: occurredAt/dueAt copied as instants, never a date alone; no clock times; no quotes', () => {
  assert.equal(DOMAIN_READING_TEMPLATE_VERSION, '2', 'a changed prompt is a new version (and a new reading identity)');
  const text = renderDomainReadingInstructions({ domainDescription: 'x', audience: 'PRINCIPAL', lookFor: [] }, ['work_event:ev1'], []);
  assert.match(text, /`occurredAt` and `dueAt` are instants: copy one exactly as a source writes it \(YYYY-MM-DDTHH:MM:SS\.sssZ\)/);
  assert.match(text, /Never a date alone/);
  assert.match(text, /never write a clock time/);
  assert.match(text, /No quotation marks of any kind \(not even around a title\)/);
  assert.doesNotMatch(text, /occurredAt and dueAt likewise/, 'the v1 contradiction is gone');
});

test('Calendar context: every event carries the instants a signal may copy, and the day carries the counts a reading may state', async () => {
  const h = harness([]);
  const g = await h.producer.gather(TARGET, T0);
  // Reach the model stage's context the way the kit does.
  let seen: { items: { sourceRef: string; content: string }[]; evidence: { figures: Map<string, Set<number>>; dates: Set<string> } } | null = null;
  const probe = calendarDomainProducer(calendarFacts(() => EVENTS), {
    modelEnabled: () => true,
    reader: { read: async (_p, req) => ((seen = { items: req.context.items as never, evidence: req.evidence as never }), { outcome: 'REFUSED_BY_MODEL' }) },
    principalFor: async () => ({ organizationId: ORG, userId: USER }),
  });
  await probe.read(TARGET, (g as { context: never }).context, 'calendar:fp', T0);
  assert.ok(seen);
  const s = seen as NonNullable<typeof seen>;
  assert.deepEqual(JSON.parse(s.items[0]!.content), { meetingsToday: 2, withOutsideAttendees: 1, overlappingPairs: 1, meetingsWithMailWaitingOnYou: 1, meetingsWithNoFollowUpSent: 0 });
  assert.equal(s.items[0]!.sourceRef, 'work_events:day');
  const ev1 = JSON.parse(s.items.find((i) => i.sourceRef === 'work_event:ev1')!.content);
  assert.equal(ev1.starts, REVIEW_STARTS);
  assert.equal(ev1.ends, '2026-09-28T16:00:00.000Z');
  assert.deepEqual([...s.evidence.figures.get('work_events:day')!].sort(), [0, 1, 2]);
  assert.ok(s.evidence.dates.has('2026-09-28'));
});

test('a valid Calendar answer (instants copied, counts grounded) becomes RULE_AND_MODEL: one BACKGROUND call, the model signal kept with its instant', async () => {
  const h = harness([answer()]);
  const r = await h.readOnce();
  assert.equal(r.modelStage, 'MODEL_READ');
  assert.equal(r.digest.provenance.producerKind, 'RULE_AND_MODEL');
  assert.equal(r.digest.content.reading.statement, 'Your 2 meetings today turn on one client review, which overlaps the standup.');
  const model = r.digest.content.signals.find((s) => s.key === 'm.client-review')!;
  assert.equal(model.dueAt, REVIEW_STARTS);
  assert.ok(r.digest.content.signals.some((s) => s.key === 'meetings-today' && s.knowledge === 'MEASURED'), "the rule's MEASURED facts stay");
  assert.equal(h.ledger.calls.length, 1);
  assert.equal(h.ledger.calls[0]!.lane, 'BACKGROUND');
  assert.equal(h.ledger.calls[0]!.reconciliation!.outcome, 'ANSWERED');
});

test('malformed or unsupported output still fails closed, each with its code, and the honest rule reading is written', async () => {
  const cases: [string, AiModelResult, string][] = [
    ['a clock time no source figure holds', answer({ signals: [signal({ statement: 'The client review at 11:00 overlaps your standup.' })] }), 'REJECTED_OUTPUT:UNSUPPORTED_NUMBER_IN_TEXT'],
    ['a count the day does not hold', answer({ reading: 'Your 5 meetings today are crowded.' }), 'REJECTED_OUTPUT:UNSUPPORTED_NUMBER_IN_TEXT'],
    ['a quoted title', answer({ signals: [signal({ statement: 'The "Premier review" is the meeting that matters.' })] }), 'REJECTED_OUTPUT:VERBATIM_CONTENT'],
    ['an instant on a date no source has', answer({ signals: [signal({ dueAt: '2026-10-05T15:00:00.000Z' })] }), 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT'],
    ['a date written in text that no source has', answer({ reading: 'The review moved from 2026-09-21.' }), 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT'],
    ['an entity not supplied', answer({ signals: [signal({ entities: ['work_event:ev9'] })] }), 'REJECTED_OUTPUT:ENTITY_NOT_SUPPLIED'],
    ['a citation not supplied', answer({ signals: [signal({ statement: 'The client review collides with your standup.', evidenceRefs: ['work_event:ev9'] })] }), 'REJECTED_OUTPUT:CITATION_NOT_SUPPLIED'],
    ['MEASURED from a model', answer({ signals: [signal({ knowledge: 'MEASURED' })] }), 'REJECTED_OUTPUT:WRONG_SCHEMA'],
    ['a reading that instructs', answer({ reading: 'You should prepare for the client review before the standup.' }), 'REJECTED_OUTPUT:RECOMMENDS_AN_ACTION'],
    ['not a domain-reading.v1 answer', answer({ json: { schemaId: 'domain-reading.v1', signals: [] } }), 'REJECTED_OUTPUT:WRONG_SCHEMA'],
    ['a truncated answer', answer({ stopReason: 'MAX_TOKENS' }), 'REJECTED_OUTPUT:WRONG_SCHEMA'],
  ];
  for (const [what, result, code] of cases) {
    const h = harness([result]);
    const r = await h.readOnce();
    assert.equal(r.modelStage, code, what);
    assert.equal(r.digest.provenance.producerKind, 'RULE', what);
    assert.match(r.digest.content.limitations.join(' '), /rule-based reading; the model reading was not available/, what);
    assert.ok(!r.digest.content.signals.some((s) => String(s.key).startsWith('m.')), `${what}: nothing of the rejected answer is kept`);
  }
});

test('the rejection code is telemetry only: bounded codes, never the answer', async () => {
  const { modelStageCode } = await import('../src/services/intelligence-fabric/domain-kit');
  assert.equal(modelStageCode({ outcome: 'REJECTED_OUTPUT', codes: ['VERBATIM_CONTENT', 'UNSUPPORTED_DATE_IN_TEXT', 'VERBATIM_CONTENT'] }), 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT+VERBATIM_CONTENT');
  assert.equal(modelStageCode({ outcome: 'REJECTED_OUTPUT', codes: ['The "Premier review" at 3pm'] }), 'REJECTED_OUTPUT:OTHER');
  assert.equal(modelStageCode({ outcome: 'MODEL_BACKOFF' }), 'MODEL_BACKOFF:REJECTED_OUTPUT');
});

test('bounded: after a rejected answer, the same subject is not paid for again for a day, however its calendar moves; a day later, once', async () => {
  let events = EVENTS;
  const h = harness([answer({ signals: [signal({ dueAt: '2026-09-28' })] }), answer()], { events: () => events });
  assert.equal((await h.readOnce()).modelStage, 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT');
  // The calendar moves every ten minutes for the rest of the day: no further spend.
  for (let i = 1; i <= 12; i += 1) {
    h.clock.set(new Date(T0.getTime() + i * 10 * 60_000));
    events = [...EVENTS.slice(0, 1), { ...EVENTS[1]!, id: `ev_moved_${i}` }];
    const r = await h.readOnce();
    assert.equal(r.modelStage, 'MODEL_BACKOFF:REJECTED_OUTPUT');
    assert.equal(r.digest.provenance.producerKind, 'RULE');
  }
  assert.equal(h.ledger.calls.length, 1, 'one paid invalid answer, not one per pass');
  h.clock.set(new Date(T0.getTime() + MODEL_REJECTION_BACKOFF_MS + 60_000));
  events = EVENTS;
  assert.equal((await h.readOnce()).modelStage, 'MODEL_READ', 'after the backoff the reading is asked again, once');
  assert.equal(h.ledger.calls.length, 2);
});

test('the backoff is per subject and per question: another person, another task version or template is asked at once; an unreadable ledger spends nothing', async () => {
  const h = harness([answer({ signals: [signal({ dueAt: '2026-09-28' })] })]);
  await h.readOnce();
  const port = ledgerBackoff(h.ledger);
  const q = { organizationId: ORG, userId: USER, taskId: 'calendar.domain.reading', taskVersion: h.ledger.calls[0]!.taskVersion, templateVersion: DOMAIN_READING_TEMPLATE_VERSION, since: T0 };
  assert.equal(await port(q), true);
  assert.equal(await port({ ...q, userId: 'someone_else' }), false, 'another person');
  assert.equal(await port({ ...q, templateVersion: '3' }), false, 'a fixed template is a new question');
  assert.equal(await port({ ...q, taskVersion: `${q.taskVersion}.next` }), false, 'a new task version too');
  assert.equal(await port({ ...q, organizationId: 'other-org' }), false, 'never across organizations');
  // A ledger that cannot be read: no call (fail closed), and the stage retries next pass.
  let calls = 0;
  const p = calendarDomainProducer(calendarFacts(() => EVENTS), {
    modelEnabled: () => true,
    reader: { read: async () => ((calls += 1), { outcome: 'REFUSED_BY_MODEL' }) },
    principalFor: async () => ({ organizationId: ORG, userId: USER }),
    modelRejectedSince: async () => {
      throw new Error('ledger down');
    },
  });
  const g = await p.gather(TARGET, T0);
  const r = (await p.read(TARGET, (g as { context: never }).context, 'calendar:fp', T0)) as { modelStage?: string };
  assert.equal(r.modelStage, 'FAILED:BACKOFF_UNREADABLE');
  assert.equal(calls, 0);
});

/** A one-target refresh queue and digest store, so passes of the REAL producer loop persist what they wrote. */
function loopWorld() {
  const stored = new Map<string, { fingerprint: string; status: 'CURRENT' | 'STALE'; version: number }>();
  const claim = (): IntelligenceRefreshClaim => ({ id: 'q1', target: TARGET, reason: 'EVIDENCE_CHANGED', sourceId: null, sourceRevision: null, fingerprint: null, requestCount: 1, attempts: 1, leaseOwner: 'w', leaseExpiresAt: T0 });
  const deps = (registry: IntelligenceProducerRegistry, now: () => Date): ProducerLoopDeps => ({
    registry,
    leaseOwner: 'w',
    now,
    queue: { claim: async () => [claim()], complete: async () => true, retry: async () => 'RETRYING', hold: async () => true },
    digests: {
      storedFingerprint: async () => stored.get('calendar') ?? null,
      markTargetStale: async () => ({ moved: 0 }),
      reaffirmTarget: async () => ({ moved: 1 }),
      upsert: async (_p, d) => {
        stored.set('calendar', { fingerprint: d.fingerprint, status: 'CURRENT', version: 1 });
        return { outcome: 'WRITTEN', digest: {} } as never;
      },
      upsertOrganization: async () => ({ outcome: 'WRITTEN', digest: {} }) as never,
    },
  });
  return { deps };
}

test('an unchanged, successfully model-backed Calendar reading is never paid for again: pass after pass, one call', async () => {
  const h = harness([answer()]);
  const w = loopWorld();
  const registry = new IntelligenceProducerRegistry([h.producer], [h.producer.id]);
  const first = await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), { limit: 10, leaseMs: 60_000, maxAttempts: 3 });
  assert.deepEqual(first.modelStages, { MODEL_READ: 1 });
  for (let i = 1; i <= 6; i += 1) {
    // Minutes later, same calendar, nothing started or ended in between.
    h.clock.set(new Date(T0.getTime() + i * 5 * 60_000));
    const pass = await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), { limit: 10, leaseMs: 60_000, maxAttempts: 3 });
    assert.equal(pass.skippedUnchangedBeforeRead, 1);
    assert.deepEqual(pass.modelStages, {});
  }
  assert.equal(h.ledger.calls.length, 1);
});

test('a rejected Calendar reading is not re-asked on unchanged evidence either (the loop), and changed evidence inside the day costs nothing', async () => {
  let events = EVENTS;
  const h = harness([answer({ signals: [signal({ dueAt: '2026-09-28' })] })], { events: () => events });
  const w = loopWorld();
  const registry = new IntelligenceProducerRegistry([h.producer], [h.producer.id]);
  const opts = { limit: 10, leaseMs: 60_000, maxAttempts: 3 };
  assert.deepEqual((await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), opts)).modelStages, { 'REJECTED_OUTPUT:UNSUPPORTED_DATE_IN_TEXT': 1 });
  h.clock.set(new Date(T0.getTime() + 5 * 60_000));
  assert.equal((await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), opts)).skippedUnchangedBeforeRead, 1);
  events = [...EVENTS, { ...EVENTS[1]!, id: 'ev3', startsAt: new Date('2026-09-28T18:00:00Z'), endsAt: new Date('2026-09-28T18:30:00Z') }];
  h.clock.set(new Date(T0.getTime() + 10 * 60_000));
  assert.deepEqual((await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), opts)).modelStages, { 'MODEL_BACKOFF:REJECTED_OUTPUT': 1 });
  h.clock.set(new Date(T0.getTime() + 15 * 60_000));
  assert.equal((await runIntelligenceProducerCycle(w.deps(registry, h.clock.now), opts)).skippedUnchangedBeforeRead, 1, 'the backoff reading satisfies the gate');
  assert.equal(h.ledger.calls.length, 1);
});
