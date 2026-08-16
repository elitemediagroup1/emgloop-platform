// Commercial Signals — Commercial Intelligence Stage 2.
//
// The properties these tests exist to hold, in order of how badly they would
// hurt if they broke:
//
//   1. TENANCY. No path — establishing, reading, listing, counting, or naming
//      an objective — crosses an organization boundary, and a cross-organization
//      id is NOT-FOUND rather than forbidden. A signal cannot be attached to
//      another tenant's objective even when a caller supplies its id.
//   2. NO OBJECTIVE, NO WRITE. A scoped resolve that misses returns null and
//      performs no write, so the caller has nothing to audit.
//   3. IDEMPOTENCY. Re-evaluating the same observation reaffirms one
//      determination instead of accumulating duplicates, and never rewrites what
//      CI concluded the first time.
//   4. NOTHING DOWNSTREAM. Establishing a signal writes to exactly one table.
//      No decision, no priority, no work, no outbox row, no event.
//   5. THE INCUMBENT `Signal` IS UNTOUCHED. Nothing here reads or writes it.
//
// They run entirely on the in-memory Prisma double — no database. The double
// enforces the org-scoped unique the way Postgres does, so idempotency and
// tenant isolation are proven rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTermMatch, type CommercialObservation } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CommercialSignalRepository } from '../src/repositories/commercial-signal.repository';
import { PerformanceObjectiveRepository } from '../src/repositories/performance-objective.repository';
import { CommercialSignalEvaluationService } from '../src/services/commercial-signal-evaluation.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

const T0 = new Date('2026-08-16T09:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const ROOFING_TITLE = 'Grow roofing lead revenue';
const SSDI_TITLE = 'Increase SSDI buyer capacity';

async function make() {
  const prisma = makeCognitivePrisma();
  const signals = new CommercialSignalRepository(prisma as never);
  const objectives = new PerformanceObjectiveRepository(prisma as never);

  await prisma.user.create({
    data: { id: 'user-matt', organizationId: ORG, email: 'matt@alpha.test', name: 'Matt', status: 'ACTIVE', metadata: {} },
  });
  await prisma.user.create({
    data: { id: 'user-lexi', organizationId: ORG, email: 'lexi@alpha.test', name: 'Lexi', status: 'ACTIVE', metadata: {} },
  });
  await prisma.user.create({
    data: { id: 'user-beta', organizationId: OTHER_ORG, email: 'someone@beta.test', name: 'Beta', status: 'ACTIVE', metadata: {} },
  });

  return { prisma, signals, objectives };
}

async function anObjective(
  objectives: PerformanceObjectiveRepository,
  organizationId: string,
  over: Record<string, unknown> = {},
) {
  const result = await objectives.create(organizationId, {
    title: ROOFING_TITLE,
    scope: 'ORGANIZATION',
    effectiveFrom: T0,
    createdByUserId: null,
    ...over,
  } as never);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('fixture objective was refused');
  return result.objective;
}

function observation(over: Partial<CommercialObservation> = {}): CommercialObservation {
  return {
    sourceSystem: 'CALLGRID',
    sourceKey: 'call-1001',
    sourceReference: 'call-1001',
    observedAt: day(-1),
    summary: 'Call call-1001 (COMPLETED): Roofing - TX / HomeAdvisor',
    descriptors: ['Roofing - TX', 'HomeAdvisor'],
    ...over,
  };
}

/** The relevance a real run would produce, via the real evaluator. */
function relevanceFor(title: string, obs: CommercialObservation) {
  const r = evaluateTermMatch({ title, description: null }, obs);
  assert.ok(r, `fixture expected ${title} to be relevant`);
  return r;
}

// --- Establishing -------------------------------------------------------------

test('a signal records the observation, the objective and the reason', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();

  const result = await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  assert.ok(result);
  assert.equal(result.outcome, 'ESTABLISHED');
  assert.equal(result.signal.performanceObjectiveId, objective.id);
  assert.equal(result.signal.objectiveTitle, ROOFING_TITLE);

  // The source's statement, kept as the source's.
  assert.equal(result.signal.observation.sourceSystem, 'CALLGRID');
  assert.equal(result.signal.observation.sourceKey, 'call-1001');
  assert.equal(result.signal.observation.sourceReference, 'call-1001');
  assert.equal(result.signal.observation.observedAt, day(-1).toISOString());

  // CI's conclusion, kept as CI's.
  assert.equal(result.signal.relevance.basis, 'TERM_MATCH');
  assert.equal(result.signal.relevance.evaluatorId, 'term-match');
  assert.match(result.signal.relevance.rationale, /roofing/);
});

test('fact and inference stay in separate groups on the read contract', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();
  const result = await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.ok(result);

  // A reader can always tell which half is the source speaking. Flattening these
  // is how CI's inference eventually gets presented as the source's fact.
  assert.deepEqual(
    Object.keys(result.signal.observation).sort(),
    ['observedAt', 'sourceKey', 'sourceReference', 'sourceSystem', 'summary'],
  );
  assert.deepEqual(
    Object.keys(result.signal.relevance).sort(),
    ['basis', 'evaluatorId', 'evaluatorVersion', 'rationale'],
  );
  // No score reached persistence either.
  assert.ok(!('confidence' in result.signal.relevance));
  assert.ok(!('score' in result.signal));
});

test('the observation is referenced, not copied', async () => {
  const { prisma, signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();
  await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  const row = prisma.commercialSignal.__rows[0];
  // A one-line restatement plus a handle back to the authority. Not the record.
  assert.equal(row.sourceKey, 'call-1001');
  assert.ok(!('revenueCents' in row), 'CI must not take custody of the call record');
  assert.ok(!('callerState' in row));
  assert.ok(!('buyerLabel' in row));
});

// --- Tenancy ------------------------------------------------------------------

test('an objective belonging to another tenant is not-found, and writes nothing', async () => {
  const { prisma, signals, objectives } = await make();
  const theirs = await anObjective(objectives, OTHER_ORG);
  const obs = observation();

  const result = await signals.establish(ORG, {
    performanceObjectiveId: theirs.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  // Null, not a thrown "forbidden": the existence of another tenant's objective
  // is not something this API will confirm.
  assert.equal(result, null);
  // NO WRITE, NO AUDIT. The caller has nothing to record.
  assert.equal(prisma.commercialSignal.__rows.length, 0);
});

test('an unknown objective id gets the same answer as another tenant s', async () => {
  const { signals } = await make();
  const obs = observation();
  const result = await signals.establish(ORG, {
    performanceObjectiveId: 'objective-that-never-existed',
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.equal(result, null);
});

test('a signal is invisible to another organization', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();
  const established = await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.ok(established);

  assert.equal(await signals.get(OTHER_ORG, established.signal.id), null);
  assert.deepEqual(await signals.list(OTHER_ORG), []);
  assert.equal((await signals.count(OTHER_ORG)).value, 0);

  assert.ok(await signals.get(ORG, established.signal.id));
  assert.equal((await signals.list(ORG)).length, 1);
  assert.equal((await signals.count(ORG)).value, 1);
});

test('listing by objective cannot reach across the tenant boundary', async () => {
  const { signals, objectives } = await make();
  const mine = await anObjective(objectives, ORG);
  const theirs = await anObjective(objectives, OTHER_ORG);
  const obs = observation();

  await signals.establish(ORG, {
    performanceObjectiveId: mine.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  await signals.establish(OTHER_ORG, {
    performanceObjectiveId: theirs.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  // Filtering by the OTHER tenant's objective id, from inside this tenant, is
  // an empty list — the organization is ANDed in, never replaced by the filter.
  assert.deepEqual(await signals.list(ORG, { performanceObjectiveId: theirs.id }), []);
  assert.equal((await signals.list(ORG, { performanceObjectiveId: mine.id })).length, 1);
});

test('the same observation in two tenants produces two independent signals', async () => {
  const { signals, objectives } = await make();
  const mine = await anObjective(objectives, ORG);
  const theirs = await anObjective(objectives, OTHER_ORG);
  const obs = observation();

  const a = await signals.establish(ORG, {
    performanceObjectiveId: mine.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  const b = await signals.establish(OTHER_ORG, {
    performanceObjectiveId: theirs.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  // The unique is TENANT-SCOPED. One tenant evaluating a source key must never
  // block another from evaluating the same one — the marketplace_calls global
  // unique is precisely the defect this avoids.
  assert.equal(a?.outcome, 'ESTABLISHED');
  assert.equal(b?.outcome, 'ESTABLISHED');
});

// --- USER scope does not create hierarchy -------------------------------------

test('a USER-scoped objective yields a signal owned by the ORGANIZATION', async () => {
  const { prisma, signals, objectives } = await make();
  const personal = await anObjective(objectives, ORG, {
    title: ROOFING_TITLE,
    scope: 'USER',
    scopeUserId: 'user-lexi',
  });
  const obs = observation();

  const result = await signals.establish(ORG, {
    performanceObjectiveId: personal.id,
    observation: obs,
    relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.ok(result);

  const row = prisma.commercialSignal.__rows[0];
  assert.equal(row.organizationId, ORG);
  // User scope says whose objective it IS. It is not a second tenancy, and the
  // signal carries no user column at all — there is nothing here for a later
  // query to mistake for a reporting relationship.
  assert.ok(!('userId' in row));
  assert.ok(!('scopeUserId' in row));
  assert.ok(!('managerId' in row));
  assert.ok(!('ownerUserId' in row));
});

// --- Idempotency --------------------------------------------------------------

test('re-evaluating the same observation reaffirms rather than duplicating', async () => {
  const { prisma, signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();
  const relevance = relevanceFor(ROOFING_TITLE, obs);

  const first = await signals.establish(ORG, { performanceObjectiveId: objective.id, observation: obs, relevance });
  const second = await signals.establish(ORG, { performanceObjectiveId: objective.id, observation: obs, relevance });
  const third = await signals.establish(ORG, { performanceObjectiveId: objective.id, observation: obs, relevance });

  assert.equal(first?.outcome, 'ESTABLISHED');
  assert.equal(second?.outcome, 'REAFFIRMED');
  assert.equal(third?.outcome, 'REAFFIRMED');
  assert.equal(prisma.commercialSignal.__rows.length, 1);
  assert.equal(third.signal.evaluationCount, 3);
  assert.equal(third.signal.id, first.signal.id);
});

test('reaffirming does not rewrite what CI concluded the first time', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();

  const first = await signals.establish(ORG, {
    performanceObjectiveId: objective.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.ok(first);

  // A later run arrives with a different story about the same observation.
  const second = await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: { ...obs, summary: 'REWRITTEN', observedAt: day(5) },
    relevance: {
      basis: 'TERM_MATCH',
      rationale: 'REWRITTEN RATIONALE',
      evaluatorId: 'term-match',
      evaluatorVersion: 'v99',
    },
  });
  assert.ok(second);

  // History is not revisable. A record of what CI believed is worth nothing if a
  // later run can quietly replace it.
  assert.equal(second.signal.relevance.rationale, first.signal.relevance.rationale);
  assert.equal(second.signal.relevance.evaluatorVersion, 'v1');
  assert.equal(second.signal.observation.summary, first.signal.observation.summary);
  assert.equal(second.signal.observation.observedAt, first.signal.observation.observedAt);
  assert.equal(second.signal.firstEvaluatedAt, first.signal.firstEvaluatedAt);
});

test('a different objective over the same observation is a separate signal', async () => {
  const { prisma, signals, objectives } = await make();
  const roofing = await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  const partnerships = await anObjective(objectives, ORG, { title: 'Expand HomeAdvisor partnerships' });
  const obs = observation();

  await signals.establish(ORG, {
    performanceObjectiveId: roofing.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  await signals.establish(ORG, {
    performanceObjectiveId: partnerships.id,
    observation: obs,
    relevance: relevanceFor('Expand HomeAdvisor partnerships', obs),
  });

  // Relevance is a relation. The same fact against two intents is two facts
  // about relevance, not one row with two owners.
  assert.equal(prisma.commercialSignal.__rows.length, 2);
});

test('a different evaluator records its own determination rather than overwriting', async () => {
  const { prisma, signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();
  const base = relevanceFor(ROOFING_TITLE, obs);

  await signals.establish(ORG, { performanceObjectiveId: objective.id, observation: obs, relevance: base });
  const other = await signals.establish(ORG, {
    performanceObjectiveId: objective.id,
    observation: obs,
    relevance: { ...base, evaluatorId: 'some-future-evaluator' },
  });

  assert.equal(other?.outcome, 'ESTABLISHED');
  assert.equal(prisma.commercialSignal.__rows.length, 2);
});

// --- Nothing downstream -------------------------------------------------------

test('establishing a signal writes to exactly one table', async () => {
  const { prisma, signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();

  await signals.establish(ORG, {
    performanceObjectiveId: objective.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });

  // A signal is intelligence. It is not authorization and it is not execution.
  assert.equal(prisma.commercialSignal.__rows.length, 1);
  assert.equal(prisma.operationalPriority.__rows.length, 0, 'no decision was opened');
  assert.equal(prisma.operationalObservation.__rows.length, 0);
  assert.equal(prisma.cognitiveDecision.__rows.length, 0);
  assert.equal(prisma.stateChangeOutbox.__rows.length, 0, 'no event was published');
  assert.equal(prisma.stateChangeDelivery.__rows.length, 0);
  assert.equal(prisma.intelligenceHypothesis.__rows.length, 0);
  assert.equal(prisma.loopEvent.__rows.length, 0);
  // And the repository records no audit of its own — that stays the caller's
  // job, so that no audit row can exist for a write that did not happen.
  assert.equal(prisma.auditLog.__rows.length, 0);
});

test('the incumbent behavioural Signal delegate is never reached', async () => {
  const { prisma, signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const obs = observation();

  // The double has no `signal` delegate at all. If anything in this subsystem
  // ever touched the incumbent model, this suite would throw rather than pass
  // quietly — which is the point of asserting on its absence.
  assert.equal(prisma.signal, undefined);

  await signals.establish(ORG, {
    performanceObjectiveId: objective.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
  });
  assert.equal(prisma.commercialSignal.__rows.length, 1);
});

// --- Listing ------------------------------------------------------------------

test('signals list newest observation first, by the SOURCE clock', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);

  for (const [key, at] of [['call-a', day(-3)], ['call-b', day(-1)], ['call-c', day(-2)]] as const) {
    const obs = observation({ sourceKey: key, observedAt: at });
    await signals.establish(ORG, {
      performanceObjectiveId: objective.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
    });
  }

  const listed = await signals.list(ORG);
  // When the fact happened, not when Loop got round to looking at it. This is an
  // inspection ordering, not a ranking: there is no column that could rank.
  assert.deepEqual(listed.map((s) => s.observation.sourceKey), ['call-b', 'call-c', 'call-a']);
});

test('observedSince filters on source time', async () => {
  const { signals, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  for (const [key, at] of [['old', day(-10)], ['recent', day(-1)]] as const) {
    const obs = observation({ sourceKey: key, observedAt: at });
    await signals.establish(ORG, {
      performanceObjectiveId: objective.id, observation: obs, relevance: relevanceFor(ROOFING_TITLE, obs),
    });
  }
  const recent = await signals.list(ORG, { observedSince: day(-5) });
  assert.deepEqual(recent.map((s) => s.observation.sourceKey), ['recent']);
});

// --- The evaluation service ---------------------------------------------------

/** A stand-in for the source domain's read, so no second table is faked. */
function callsReturning(rows: Array<Record<string, unknown>>) {
  return {
    listWindowSummaries: async (
      _organizationId: string,
      _since: Date,
      _until: Date,
      take: number,
    ) => rows.slice(0, take),
  };
}

function aCall(over: Record<string, unknown> = {}) {
  return {
    id: 'mc-1',
    provider: 'callgrid',
    externalId: 'call-1001',
    sourceOccurredAt: day(-1),
    buyerLabel: null,
    vendorLabel: null,
    sourceLabel: 'HomeAdvisor',
    campaignLabel: 'Roofing - TX',
    callerState: 'TX',
    status: 'COMPLETED',
    ...over,
  };
}

test('a run evaluates every observation against every ACTIVE objective', async () => {
  const { prisma, signals, objectives } = await make();
  await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  await anObjective(objectives, ORG, { title: SSDI_TITLE });
  const archived = await anObjective(objectives, ORG, { title: 'Grow roofing referrals' });
  await objectives.setStatus(ORG, archived.id, 'ARCHIVED');

  const service = new CommercialSignalEvaluationService(
    objectives,
    callsReturning([aCall()]) as never,
    signals,
  );
  const summary = await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal(summary.observationsExamined, 1);
  // Two ACTIVE objectives considered; the archived one is history, not intent.
  assert.equal(summary.objectivesConsidered, 2);
  // Only the roofing objective shares subject matter with the call.
  assert.equal(summary.established, 1);
  assert.equal(summary.reaffirmed, 0);
  assert.equal(prisma.commercialSignal.__rows.length, 1);
  assert.equal(prisma.commercialSignal.__rows[0].relevanceBasis, 'TERM_MATCH');
});

test('the same call is relevant to one objective and irrelevant to another', async () => {
  const { signals, objectives } = await make();
  const roofing = await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  const ssdi = await anObjective(objectives, ORG, { title: SSDI_TITLE });

  const service = new CommercialSignalEvaluationService(objectives, callsReturning([aCall()]) as never, signals);
  await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal((await signals.list(ORG, { performanceObjectiveId: roofing.id })).length, 1);
  assert.equal((await signals.list(ORG, { performanceObjectiveId: ssdi.id })).length, 0);
});

test('re-running the same window establishes nothing new', async () => {
  const { prisma, signals, objectives } = await make();
  await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  const service = new CommercialSignalEvaluationService(objectives, callsReturning([aCall()]) as never, signals);

  const first = await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });
  const second = await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal(first.established, 1);
  assert.equal(second.established, 0);
  assert.equal(second.reaffirmed, 1);
  assert.equal(prisma.commercialSignal.__rows.length, 1);
});

test('a run with no matching activity records nothing at all', async () => {
  const { prisma, signals, objectives } = await make();
  await anObjective(objectives, ORG, { title: SSDI_TITLE });
  const service = new CommercialSignalEvaluationService(objectives, callsReturning([aCall()]) as never, signals);

  const summary = await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal(summary.observationsExamined, 1);
  assert.equal(summary.established, 0);
  // No negative row. The absence of a signal means only that no positive
  // determination was recorded — never that Loop examined this and dismissed it.
  assert.equal(prisma.commercialSignal.__rows.length, 0);
});

test('a run reads no other tenant s objectives', async () => {
  const { prisma, signals, objectives } = await make();
  await anObjective(objectives, OTHER_ORG, { title: ROOFING_TITLE });
  const service = new CommercialSignalEvaluationService(objectives, callsReturning([aCall()]) as never, signals);

  const summary = await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal(summary.objectivesConsidered, 0);
  assert.equal(prisma.commercialSignal.__rows.length, 0);
});

test('a run is bounded, and reports how much it actually examined', async () => {
  const { signals, objectives } = await make();
  await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  const many = Array.from({ length: 10 }, (_, i) =>
    aCall({ id: `mc-${i}`, externalId: `call-${i}` }),
  );
  const service = new CommercialSignalEvaluationService(objectives, callsReturning(many) as never, signals);

  const summary = await service.evaluateRecentActivity(ORG, {
    since: day(-7), until: day(1), maxObservations: 4,
  });

  // Truncation is visible to the caller rather than silent.
  assert.equal(summary.observationsExamined, 4);
  assert.equal(summary.established, 4);
});

test('a run creates nothing outside commercial_signals', async () => {
  const { prisma, signals, objectives } = await make();
  await anObjective(objectives, ORG, { title: ROOFING_TITLE });
  const service = new CommercialSignalEvaluationService(objectives, callsReturning([aCall()]) as never, signals);
  await service.evaluateRecentActivity(ORG, { since: day(-7), until: day(1) });

  assert.equal(prisma.operationalPriority.__rows.length, 0);
  assert.equal(prisma.cognitiveDecision.__rows.length, 0);
  assert.equal(prisma.stateChangeOutbox.__rows.length, 0);
  assert.equal(prisma.loopEvent.__rows.length, 0);
  assert.equal(prisma.auditLog.__rows.length, 0);
});
