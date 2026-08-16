// Objective Measure Bindings and Headlines — Commercial Intelligence Stage 3 v1.
//
// The properties these tests exist to hold, in order of how badly they would
// hurt if they broke:
//
//   1. TENANCY. No path — confirming, measuring, recording, listing, dismissing —
//      crosses an organization boundary, and a cross-organization id is NOT-FOUND
//      rather than forbidden.
//   2. NOT MEASURABLE YET IS REAL. An objective with no binding produces no
//      headline, no default binding, no inferred proxy and no error.
//   3. THE POPULATION IS WHAT A HUMAN TICKED. Commercial Signals never enter it.
//      TERM_MATCH noise cannot become a measurement denominator.
//   4. IDEMPOTENCY AND RECURRENCE. The same completed period re-run changes
//      nothing; a later period resights the same row rather than creating one.
//   5. HISTORY IS NOT REVISABLE. Superseding a binding leaves every headline
//      produced under the old one exactly as it was.
//   6. A HEADLINE IS NOT A DECISION. Recording one writes to exactly one table.
//      No priority, no evidence, no work, no outbox row.
//
// They run entirely on the in-memory Prisma double — no database. The double
// enforces the org-scoped uniques the way Postgres does, so idempotency and
// tenant isolation are proven rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARISON_SPAN_DAYS,
  easternTrailingCompleteWindows,
  headlineDetectionKey,
  headlineRecurrenceKey,
  type PopulationWindowAggregate,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { matrixAllows } from '../src/repositories/iam.repository';
import { ObjectiveMeasureBindingRepository } from '../src/repositories/objective-measure-binding.repository';
import { HeadlineRepository } from '../src/repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../src/repositories/performance-objective.repository';
import { HeadlineDetectionService } from '../src/services/headline-detection.service';
import type { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

/** A fixed instant so the completed windows are deterministic. */
const NOW = new Date('2026-08-16T14:30:00.000Z');
const WINDOWS = easternTrailingCompleteWindows(NOW, COMPARISON_SPAN_DAYS);
/** A week later, so a second run lands in the NEXT completed period. */
const NEXT_WEEK = new Date('2026-08-23T14:30:00.000Z');

async function make() {
  const prisma = makeCognitivePrisma();
  const bindings = new ObjectiveMeasureBindingRepository(prisma as never);
  const headlines = new HeadlineRepository(prisma as never);
  const objectives = new PerformanceObjectiveRepository(prisma as never);

  await prisma.user.create({
    data: { id: 'user-matt', organizationId: ORG, email: 'matt@alpha.test', name: 'Matt', status: 'ACTIVE', metadata: {} },
  });
  await prisma.user.create({
    data: { id: 'user-beta', organizationId: OTHER_ORG, email: 'b@beta.test', name: 'Beta', status: 'ACTIVE', metadata: {} },
  });

  return { prisma, bindings, headlines, objectives };
}

async function anObjective(
  objectives: PerformanceObjectiveRepository,
  organizationId = ORG,
  title = 'Grow roofing lead revenue in Texas',
) {
  const result = await objectives.create(organizationId, {
    title,
    description: null,
    scope: 'ORGANIZATION',
    scopeUserId: null,
    effectiveFrom: null,
    effectiveTo: null,
    createdByUserId: null,
  });
  assert.ok(result.ok, 'fixture objective must be valid');
  return result.objective;
}

const ROOFING_MEMBERS = [
  { dimension: 'CAMPAIGN', externalId: 'cmp-roof-tx', label: 'Roofing - TX' },
  { dimension: 'CAMPAIGN', externalId: 'cmp-roof-texas-dr', label: 'Roofing - Texas DR' },
];

function agg(over: Partial<PopulationWindowAggregate> = {}): PopulationWindowAggregate {
  return {
    totalCalls: 100,
    revenueCents: 1_000_000,
    revenueReported: 100,
    monetizedTrue: 40,
    monetizedReported: 100,
    convertedTrue: 20,
    convertedReported: 100,
    noRouteTrue: 3,
    noRouteReported: 100,
    ...over,
  };
}

/**
 * A stand-in for the aggregate read boundary.
 *
 * It records the population it was asked about, which is how the tests prove
 * that only explicitly ticked members reach the query — the whole point of
 * rejecting a signal-derived population.
 */
function makeCalls(
  answers: { current: PopulationWindowAggregate | null; prior: PopulationWindowAggregate | null },
) {
  const seen: Array<{ organizationId: string; population: Record<string, unknown>; window: { start: Date; end: Date } }> = [];
  const repo = {
    async aggregatePopulationWindow(
      organizationId: string,
      population: Record<string, unknown>,
      window: { start: Date; end: Date },
    ) {
      // The service asks for the current window first and the prior window
      // second, per objective. Alternating on the call index rather than matching
      // a window boundary matters: last week's CURRENT period is this week's
      // PRIOR period, so a boundary-keyed fake would silently invert the
      // comparison on the second run and the resight test would fail for a reason
      // that has nothing to do with the code under test.
      const isCurrent = seen.length % 2 === 0;
      seen.push({ organizationId, population, window });
      return isCurrent ? answers.current : answers.prior;
    },
  } as unknown as MarketplaceCallRepository;
  return { repo, seen };
}

// --- 1. Tenancy ----------------------------------------------------------------

test('a binding cannot be confirmed against another tenant\'s objective', async () => {
  const { bindings, objectives } = await make();
  const theirs = await anObjective(objectives, OTHER_ORG);

  const result = await bindings.confirm(ORG, {
    performanceObjectiveId: theirs.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: 'user-matt',
  });

  // NOT-FOUND, never forbidden: the existence of another tenant's objective is
  // not leaked, and nothing was written for the caller to audit.
  assert.equal(result, null);
  assert.equal((await bindings.listActive(ORG)).length, 0);
  assert.equal((await bindings.listActive(OTHER_ORG)).length, 0);
});

test('a headline cannot be recorded against another tenant\'s binding', async () => {
  const { bindings, headlines, objectives } = await make();
  const theirObjective = await anObjective(objectives, OTHER_ORG);
  const theirBinding = await bindings.confirm(OTHER_ORG, {
    performanceObjectiveId: theirObjective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(theirBinding?.ok);

  const result = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: theirObjective.id,
    measureBindingId: theirBinding.binding.id,
  }));

  assert.equal(result, null);
  assert.equal((await headlines.list(ORG)).length, 0);
  assert.equal((await headlines.list(OTHER_ORG)).length, 0);
});

test('a binding that belongs to a different objective is refused', async () => {
  const { bindings, headlines, objectives } = await make();
  const a = await anObjective(objectives, ORG, 'Objective A');
  const b = await anObjective(objectives, ORG, 'Objective B');
  const bindingA = await bindings.confirm(ORG, {
    performanceObjectiveId: a.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(bindingA?.ok);

  // Objective B with Objective A's binding: a measurement attributed to intent it
  // was never defined against.
  const result = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: b.id,
    measureBindingId: bindingA.binding.id,
  }));
  assert.equal(result, null);
});

test('cross-tenant reads of a binding and a headline are not-found', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const confirmed = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(confirmed?.ok);
  const recorded = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: confirmed.binding.id,
  }));
  assert.ok(recorded);

  assert.equal(await bindings.get(OTHER_ORG, confirmed.binding.id), null);
  assert.equal(await headlines.get(OTHER_ORG, recorded.headline.id), null);
  assert.equal(await bindings.activeFor(OTHER_ORG, objective.id), null);
  assert.equal(await headlines.dismiss(OTHER_ORG, recorded.headline.id, {
    basis: 'IMMATERIAL', userId: 'user-beta', at: NOW,
  }), null);
  // And the row is untouched by the attempt.
  const still = await headlines.get(ORG, recorded.headline.id);
  assert.equal(still?.dismissedAt, null);
});

test('the detection run passes the session organization to every read', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.organizationId === ORG));
});

// --- 2. NOT MEASURABLE YET ------------------------------------------------------

test('an objective with no binding produces no headline and no default binding', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const { repo, seen } = makeCalls({ current: agg(), prior: agg() });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal(summary.objectivesConsidered, 1);
  assert.equal(summary.objectivesMeasurable, 0);
  assert.equal(summary.established, 0);
  assert.equal(summary.outcomes[0]?.withheld, 'NOT_MEASURABLE');
  assert.equal(summary.outcomes[0]?.measureBindingId, null);
  // No proxy was invented, and the source was not even consulted.
  assert.equal(seen.length, 0);
  assert.equal((await headlines.list(ORG)).length, 0);
  assert.equal(await bindings.activeFor(ORG, objective.id), null);
});

test('an unmeasurable objective is a state, not an error, and the run still succeeds', async () => {
  const { bindings, headlines, objectives } = await make();
  await anObjective(objectives, ORG, 'Build stronger relationships with roofing buyers');
  const { repo } = makeCalls({ current: agg(), prior: agg() });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);
  assert.equal(summary.objectivesConsidered, 1);
  assert.equal(summary.withheld, 0, 'not measurable is not the same as withheld by the rule');
});

test('an archived objective is never measured', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  await objectives.setStatus(ORG, objective.id, 'ARCHIVED');

  const { repo } = makeCalls({ current: agg({ totalCalls: 400 }), prior: agg({ totalCalls: 100 }) });
  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal(summary.objectivesConsidered, 0);
  assert.equal((await headlines.list(ORG)).length, 0);
});

// --- 3. The population is what a human ticked ------------------------------------

test('only the explicitly confirmed members reach the aggregate query', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: [
      ...ROOFING_MEMBERS,
      { dimension: 'SOURCE', externalId: 'src-1', label: 'A source' },
    ],
    confirmedByUserId: null,
  });
  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  const asked = seen[0]?.population as Record<string, string[]>;
  assert.deepEqual(asked.campaignExternalIds, ['cmp-roof-texas-dr', 'cmp-roof-tx']);
  assert.deepEqual(asked.sourceExternalIds, ['src-1']);
  assert.deepEqual(asked.buyerExternalIds, []);
  assert.deepEqual(asked.vendorExternalIds, []);
});

test('TERM_MATCH noise cannot enter the population: no signal is ever read', async () => {
  const { prisma, bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);

  // A Commercial Signal exists for this objective and names an SSDI call — the
  // exact production case where TERM_MATCH matched on the word "texas". If the
  // detector consulted signals, this id would appear in the population.
  await prisma.commercialSignal.create({
    data: {
      organizationId: ORG,
      performanceObjectiveId: objective.id,
      sourceSystem: 'CALLGRID',
      sourceKey: 'ssdi-call-9',
      sourceReference: 'ssdi-call-9',
      observedAt: NOW,
      observationSummary: 'Call ssdi-call-9 (COMPLETED): SSDI - Texas',
      relevanceBasis: 'TERM_MATCH',
      relevanceRationale: "Objective and the source's own descriptors share the terms: texas.",
      evaluatorId: 'term-match',
      evaluatorVersion: 'v1',
    },
  });

  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  const asked = JSON.stringify(seen[0]?.population);
  assert.ok(!asked.includes('ssdi'), 'a signal must never define a measurement population');
  assert.ok(!asked.includes('term-match'));
});

test('caller geography is off unless somebody asked for it', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  // EMPTY MEANS NO RESTRICTION. "In Texas" is the campaign selection, not where
  // the caller happened to be, and Loop does not infer one from the other.
  assert.deepEqual((seen[0]?.population as Record<string, string[]>).callerStates, []);
});

test('a caller-state restriction is applied only when explicitly selected', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const confirmed = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    callerStates: ['tx'],
    confirmedByUserId: null,
  });
  assert.ok(confirmed?.ok);
  // Normalized on the way in, so 'tx' and 'TX' are the same restriction.
  assert.deepEqual(confirmed.binding.callerStates, ['TX']);

  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });
  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);
  assert.deepEqual((seen[0]?.population as Record<string, string[]>).callerStates, ['TX']);
});

test('a binding with no members is refused, so an empty population never measures the whole tenant', async () => {
  const { bindings, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const result = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: [],
    confirmedByUserId: null,
  });
  assert.ok(result && !result.ok);
  assert.equal(result.reason, 'POPULATION_REQUIRED');
});

// --- 4. Complete windows, coverage, thresholds -----------------------------------

test('the detector only ever asks about complete periods', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 200 }), prior: agg({ totalCalls: 100 }) });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  // Neither window may reach the in-progress day.
  for (const s of seen) assert.ok(s.window.end.getTime() <= NOW.getTime());
  assert.equal(summary.currentWindowEnd.getTime(), WINDOWS.current.end.getTime());
  assert.ok(summary.currentWindowEnd.getTime() < NOW.getTime());
});

test('insufficient coverage produces no headline', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({
    current: agg({ totalCalls: 100, revenueCents: 300_000, revenueReported: 20 }),
    prior: agg({ totalCalls: 100, revenueCents: 1_000_000, revenueReported: 100 }),
  });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);
  assert.equal(summary.established, 0);
  assert.equal(summary.withheld, 1);
  assert.equal(summary.outcomes[0]?.withheld, 'INSUFFICIENT_COVERAGE');
  assert.equal((await headlines.list(ORG)).length, 0);
});

test('a zero denominator withholds rather than reporting 0%', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CONVERSION_RATE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({
    current: agg({ totalCalls: 100, convertedTrue: 0, convertedReported: 0 }),
    prior: agg({ totalCalls: 100, convertedTrue: 30, convertedReported: 100 }),
  });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);
  assert.equal(summary.established, 0);
  assert.equal(summary.outcomes[0]?.withheld, 'VALUE_UNKNOWN');
  assert.equal(summary.outcomes[0]?.measurement?.current.value, null);
});

test('twenty ordinary calls produce zero headlines end to end', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const ordinary = agg({ totalCalls: 20, revenueCents: 200_000, revenueReported: 20 });
  const { repo } = makeCalls({ current: ordinary, prior: ordinary });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal(summary.objectivesMeasurable, 1);
  assert.equal(summary.established, 0);
  assert.equal(summary.withheld, 1);
  assert.equal((await headlines.list(ORG)).length, 0);
});

test('a material move produces exactly one headline', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });

  const summary = await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal(summary.established, 1);
  const rows = await headlines.list(ORG);
  assert.equal(rows.length, 1);
  const h = rows[0]!;
  assert.equal(h.measurement.movement, 'DECREASE');
  assert.equal(h.measurement.againstObjective, true);
  assert.equal(h.detectionCount, 1);
  assert.ok(h.statement.includes('fell'));
  // Provenance a reader can check the conclusion against.
  assert.ok(h.ruleId);
  assert.ok(h.ruleVersion);
  assert.ok(h.producerVersion);
  assert.equal(h.measureBindingVersion, 1);
  assert.ok(h.limitations.length > 0);
});

test('positive news is recorded exactly like negative news', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 160 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);
  const h = (await headlines.list(ORG))[0]!;
  assert.equal(h.measurement.movement, 'INCREASE');
  assert.equal(h.measurement.againstObjective, false);
  assert.ok(h.statement.includes('rose'));
});

// --- 5. Idempotency and recurrence -------------------------------------------------

test('re-running the same completed period changes nothing at all', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const service = new HeadlineDetectionService(objectives, bindings, repo, headlines);

  await service.detect(ORG, NOW);
  const first = (await headlines.list(ORG))[0]!;

  // Three more runs in the same period, as a server-rendered page refresh would.
  await service.detect(ORG, NOW);
  await service.detect(ORG, NOW);
  const summary = await service.detect(ORG, NOW);

  assert.equal(summary.alreadyRecorded, 1);
  assert.equal(summary.established, 0);
  assert.equal(summary.resighted, 0);
  const rows = await headlines.list(ORG);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.detectionCount, 1, 'a refresh must not manufacture a sighting');
  assert.equal(rows[0]?.lastDetectedAt, first.lastDetectedAt);
});

test('the same condition in the next completed period resights the same row', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const service = new HeadlineDetectionService(objectives, bindings, repo, headlines);

  await service.detect(ORG, NOW);
  const before = (await headlines.list(ORG))[0]!;

  const summary = await service.detect(ORG, NEXT_WEEK);

  assert.equal(summary.resighted, 1);
  assert.equal(summary.established, 0);
  const rows = await headlines.list(ORG);
  assert.equal(rows.length, 1, 'a persisting condition is one row, not one per week');
  const after = rows[0]!;
  assert.equal(after.id, before.id);
  assert.equal(after.detectionCount, 2);
  assert.equal(after.firstDetectedAt, before.firstDetectedAt, 'first detection is never rewritten');
  assert.notEqual(after.lastDetectedAt, before.lastDetectedAt);
  // The measurement itself is history and must not be revised by a later run.
  assert.equal(after.statement, before.statement);
  assert.equal(after.currentValue, before.currentValue);
});

test('a resight rewrites nothing but the counters, even when the numbers moved', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const confirmed = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(confirmed?.ok);

  const base = headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: confirmed.binding.id,
  });
  const first = await headlines.record(ORG, base);
  assert.equal(first?.outcome, 'ESTABLISHED');

  const second = await headlines.record(ORG, {
    ...base,
    detectionKey: 'ci-7d:2026-08-16',
    detectedAt: NEXT_WEEK,
    statement: 'A COMPLETELY DIFFERENT SENTENCE',
    currentValue: 999,
  });
  assert.equal(second?.outcome, 'RESIGHTED');
  assert.equal(second.headline.statement, first!.headline.statement);
  assert.equal(second.headline.measurement.currentValue, first!.headline.measurement.currentValue);
  assert.equal(second.headline.detectionCount, 2);
});

test('rose and fell are two headlines, not one row that flips meaning', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const confirmed = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(confirmed?.ok);

  const key = (movement: 'INCREASE' | 'DECREASE') =>
    headlineRecurrenceKey({
      measureBindingId: confirmed.binding.id,
      metric: 'CALL_VOLUME',
      ruleId: 'ci.objective-measure-change',
      movement,
    });

  await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: confirmed.binding.id,
    recurrenceKey: key('DECREASE'),
    movement: 'DECREASE',
  }));
  await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: confirmed.binding.id,
    recurrenceKey: key('INCREASE'),
    movement: 'INCREASE',
  }));

  assert.equal((await headlines.list(ORG)).length, 2);
});

// --- 6. History is not revisable ----------------------------------------------------

test('superseding a binding leaves past headlines exactly as they were', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const v1 = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: 'user-matt',
  });
  assert.ok(v1?.ok);

  const recorded = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: v1.binding.id,
  }));
  assert.ok(recorded);

  // Matt changes his mind about what the objective means.
  const v2 = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: [{ dimension: 'BUYER', externalId: 'buy-9', label: 'A buyer' }],
    confirmedByUserId: 'user-matt',
  });
  assert.ok(v2?.ok);
  assert.equal(v2.binding.version, 2);
  assert.equal(v2.supersededBindingId, v1.binding.id);

  // The old definition is kept, marked superseded, and NOT rewritten.
  const old = await bindings.get(ORG, v1.binding.id);
  assert.equal(old?.metric, 'CALL_VOLUME');
  assert.equal(old?.members.length, 2);
  assert.ok(old?.supersededAt);
  assert.equal(old?.supersededByBindingId, v2.binding.id);

  // And the headline still points at the version it was produced under.
  const after = await headlines.get(ORG, recorded.headline.id);
  assert.equal(after?.measureBindingId, v1.binding.id);
  assert.equal(after?.measureBindingVersion, 1);
  assert.equal(after?.statement, recorded.headline.statement);
});

test('only one binding is active at a time, and the newest wins', async () => {
  const { bindings, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  for (const metric of ['CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE']) {
    const r = await bindings.confirm(ORG, {
      performanceObjectiveId: objective.id,
      metric,
      direction: 'HIGHER_IS_BETTER',
      members: ROOFING_MEMBERS,
      confirmedByUserId: null,
    });
    assert.ok(r?.ok);
  }
  const active = await bindings.activeFor(ORG, objective.id);
  assert.equal(active?.metric, 'MONETIZED_RATE');
  assert.equal(active?.version, 3);
  assert.equal((await bindings.listActive(ORG)).length, 1);
  assert.equal((await bindings.history(ORG, objective.id)).length, 3);
});

test('retiring a binding leaves the objective not measurable, and keeps the record', async () => {
  const { bindings, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const v1 = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(v1?.ok);

  assert.ok(await bindings.retire(ORG, v1.binding.id));
  assert.equal(await bindings.activeFor(ORG, objective.id), null);
  assert.equal((await bindings.history(ORG, objective.id)).length, 1);
  // Retiring twice would rewrite the first supersession's timestamp.
  assert.equal(await bindings.retire(ORG, v1.binding.id), null);
});

test('the confirmed label is kept for display and is never the identity', async () => {
  const { bindings, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const r = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: [{ dimension: 'CAMPAIGN', externalId: 'cmp-1', label: 'Roofing - TX' }],
    confirmedByUserId: null,
  });
  assert.ok(r?.ok);
  const member = r.binding.members[0]!;
  assert.equal(member.externalId, 'cmp-1');
  assert.equal(member.labelAtConfirmation, 'Roofing - TX');
});

// --- 7. Dismissal ---------------------------------------------------------------------

test('WRONG and IMMATERIAL are recorded distinctly', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const b = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(b?.ok);

  const one = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: b.binding.id,
    recurrenceKey: 'k-1',
  }));
  const two = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: b.binding.id,
    recurrenceKey: 'k-2',
  }));
  assert.ok(one && two);

  const wrong = await headlines.dismiss(ORG, one.headline.id, { basis: 'WRONG', userId: 'user-matt', at: NOW });
  const immaterial = await headlines.dismiss(ORG, two.headline.id, { basis: 'IMMATERIAL', userId: 'user-matt', at: NOW });

  assert.equal(wrong?.dismissalBasis, 'WRONG');
  assert.equal(immaterial?.dismissalBasis, 'IMMATERIAL');
  assert.equal(wrong?.dismissedByName, 'Matt');
  assert.equal((await headlines.list(ORG, { dismissed: true })).length, 2);
  assert.equal((await headlines.list(ORG, { dismissed: false })).length, 0);
});

test('dismissing twice is refused, so attention feedback cannot be rewritten', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  const b = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(b?.ok);
  const h = await headlines.record(ORG, headlineInput({
    performanceObjectiveId: objective.id,
    measureBindingId: b.binding.id,
  }));
  assert.ok(h);

  assert.ok(await headlines.dismiss(ORG, h.headline.id, { basis: 'WRONG', userId: 'user-matt', at: NOW }));
  assert.equal(await headlines.dismiss(ORG, h.headline.id, { basis: 'IMMATERIAL', userId: 'user-matt', at: NOW }), null);
  const after = await headlines.get(ORG, h.headline.id);
  assert.equal(after?.dismissalBasis, 'WRONG');
});

test('a dismissed headline keeps recording recurrence, and never reopens', async () => {
  const { bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const service = new HeadlineDetectionService(objectives, bindings, repo, headlines);

  await service.detect(ORG, NOW);
  const h = (await headlines.list(ORG))[0]!;
  await headlines.dismiss(ORG, h.id, { basis: 'IMMATERIAL', userId: 'user-matt', at: NOW });

  // The condition persists into the next completed period.
  await service.detect(ORG, NEXT_WEEK);

  const after = await headlines.get(ORG, h.id);
  // How long a condition somebody called immaterial persisted is exactly the fact
  // that says whether that call was right — so recurrence keeps accruing.
  assert.equal(after?.detectionCount, 2);
  // And it does NOT reopen. Dismissal is a human's statement and a later sighting
  // is an observation; an observation never overturns a decision.
  assert.ok(after?.dismissedAt);
  assert.equal(after?.dismissalBasis, 'IMMATERIAL');
});

// --- 8. Nothing downstream -------------------------------------------------------------

test('recording a headline writes to exactly one table', async () => {
  const { prisma, bindings, headlines, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });

  await new HeadlineDetectionService(objectives, bindings, repo, headlines).detect(ORG, NOW);

  assert.equal((await headlines.list(ORG)).length, 1);
  // A Headline is awareness. It is not judgement, not execution, and not an event.
  assert.equal(await prisma.operationalPriority.count(), 0);
  assert.equal(await prisma.operationalObservation.count(), 0);
  assert.equal(await prisma.decisionEvidence.count(), 0);
  assert.equal(await prisma.stateChangeOutbox.count(), 0);
  assert.equal(await prisma.cognitiveDecision.count(), 0);
  assert.equal(await prisma.intelligenceHypothesis.count(), 0);
  assert.equal(await prisma.commercialSignal.count(), 0);
  assert.equal(await prisma.auditLog.count(), 0, 'the action audits the run, not the repository');
});

test('confirming a binding writes to exactly one table', async () => {
  const { prisma, bindings, objectives } = await make();
  const objective = await anObjective(objectives, ORG);
  await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric: 'REVENUE',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: 'user-matt',
  });
  assert.equal(await prisma.objectiveMeasureBinding.count(), 1);
  assert.equal(await prisma.headline.count(), 0);
  assert.equal(await prisma.operationalPriority.count(), 0);
  assert.equal(await prisma.stateChangeOutbox.count(), 0);
  assert.equal(await prisma.commercialSignal.count(), 0);
});

test('the count is Truth, so an empty result cannot read as a confident zero', async () => {
  const { headlines } = await make();
  const count = await headlines.count(ORG);
  assert.equal(count.state, 'empty');
});

// --- 9. RBAC ---------------------------------------------------------------------------

test('Stage 3 reuses the existing commercialIntelligence grants and invents nothing', async () => {
  // No new resource, no new action, no new role. Reading and writing Stage 3 use
  // exactly the grants Stage 1 established.
  assert.ok(matrixAllows('OWNER', 'commercialIntelligence', 'update'));
  assert.ok(matrixAllows('ADMIN', 'commercialIntelligence', 'update'));
  assert.ok(matrixAllows('READ_ONLY', 'commercialIntelligence', 'view'));
  assert.ok(!matrixAllows('READ_ONLY', 'commercialIntelligence', 'update'));
  assert.ok(!matrixAllows('EMPLOYEE', 'commercialIntelligence', 'update'));
});

test('MANAGER is still view-only, and is still not an organizational relationship', async () => {
  assert.ok(matrixAllows('MANAGER', 'commercialIntelligence', 'view'));
  assert.ok(!matrixAllows('MANAGER', 'commercialIntelligence', 'update'));
  assert.ok(!matrixAllows('MANAGER', 'commercialIntelligence', 'create'));
  assert.ok(!matrixAllows('MANAGER', 'commercialIntelligence', 'delete'));
});

test('an unknown role degrades to least privilege, and can never write', async () => {
  // The platform rule is "unknown role -> least privilege", and least privilege
  // here is READ_ONLY rather than nothing. What matters for Stage 3 is that an
  // unrecognised role can never confirm a binding, run a detection or dismiss a
  // headline — all three of which are guarded by `update`.
  assert.ok(!matrixAllows('SOMETHING_ELSE', 'commercialIntelligence', 'update'));
  assert.ok(!matrixAllows('SOMETHING_ELSE', 'commercialIntelligence', 'create'));
  assert.ok(!matrixAllows('SOMETHING_ELSE', 'commercialIntelligence', 'manage'));
  assert.equal(
    matrixAllows('SOMETHING_ELSE', 'commercialIntelligence', 'view'),
    matrixAllows('READ_ONLY', 'commercialIntelligence', 'view'),
  );
});

// --- 10. A Headline is not a Decision, and the API surface proves it -----------------------

test('the headline repository exposes no lifecycle method, and cannot grow one by accident', async () => {
  // The cheapest way for the D1 decision to erode is somebody adding a
  // convenient `assign()` later. This asserts on the surface so that change
  // fails a test instead of shipping.
  const surface = Object.getOwnPropertyNames(HeadlineRepository.prototype);
  const forbidden =
    /assign|owner|claim|resolve|close|reopen|escalate|watch|promote|priority|outcome|lane|state|notify|manager|team|hierarchy/i;
  assert.deepEqual(surface.filter((m) => forbidden.test(m)), []);

  assert.deepEqual(
    surface.sort(),
    ['constructor', 'record', 'resight', 'get', 'list', 'dismiss', 'count', 'contextFor'].sort(),
  );
});

test('the binding repository exposes no update path, so a definition cannot be edited', async () => {
  // Immutability is enforced by the API, not by discipline. `confirm` writes a
  // new version; `retire` writes two supersession columns once. There is nothing
  // that could rewrite a metric, a population or a direction.
  const surface = Object.getOwnPropertyNames(ObjectiveMeasureBindingRepository.prototype);
  assert.ok(!surface.includes('update'));
  assert.ok(!surface.includes('edit'));
  assert.deepEqual(
    surface.sort(),
    ['constructor', 'confirm', 'activeFor', 'listActive', 'get', 'history', 'retire', 'nameOf', 'namesFor'].sort(),
  );
});

test('the detection service exposes one entry point and no side-effecting extras', async () => {
  const surface = Object.getOwnPropertyNames(HeadlineDetectionService.prototype);
  assert.deepEqual(surface.sort(), ['constructor', 'detect'].sort());
});

// --- helpers ----------------------------------------------------------------------------

function headlineInput(over: Partial<Parameters<HeadlineRepository['record']>[1]> & {
  performanceObjectiveId: string;
  measureBindingId: string;
}): Parameters<HeadlineRepository['record']>[1] {
  return {
    recurrenceKey: 'rk-default',
    detectionKey: headlineDetectionKey(WINDOWS.current.start),
    ruleId: 'ci.objective-measure-change',
    ruleVersion: 'v1',
    producerVersion: 'ci-headline.v1',
    metric: 'CALL_VOLUME',
    movement: 'DECREASE',
    againstObjective: true,
    statement: 'Call volume fell 40%, from 100 to 60, across 2 campaigns over the last 7 complete days.',
    currentValue: 60,
    priorValue: 100,
    absoluteChange: -40,
    percentageChange: -0.4,
    currentDenominator: 60,
    priorDenominator: 100,
    currentCoverage: null,
    priorCoverage: null,
    comparisonBasis: 'Trailing 7 complete Eastern days against the 7 complete Eastern days before them',
    currentWindowStart: WINDOWS.current.start,
    currentWindowEnd: WINDOWS.current.end,
    priorWindowStart: WINDOWS.prior.start,
    priorWindowEnd: WINDOWS.prior.end,
    limitations: ['Counts calls Loop received from the provider.'],
    unknowns: [],
    detectedAt: NOW,
    ...over,
  };
}
