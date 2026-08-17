// Observation completeness — the persistence and gate layer.
//
// The pure rule is proven in @emgloop/shared. What is proven HERE is that the
// rule is actually reached: that the ledger stores and returns evidence
// faithfully, that certification classifies a provider read honestly, that the
// detection service refuses an unobserved window before it reads an aggregate,
// and that one tenant's certification can never satisfy another's gate.
//
// Everything runs on the in-memory Prisma double. The double enforces the
// org-scoped unique the way Postgres does, so idempotency and isolation are
// proven rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARISON_SPAN_DAYS,
  OBSERVATION_RULE_VERSION,
  easternBusinessDatesIn,
  easternBusinessDayWindow,
  easternTrailingCompleteWindows,
  type BusinessDate,
  type PopulationWindowAggregate,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { ProviderObservationRepository } from '../src/repositories/provider-observation.repository';
import { ObjectiveMeasureBindingRepository } from '../src/repositories/objective-measure-binding.repository';
import { HeadlineRepository } from '../src/repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../src/repositories/performance-objective.repository';
import { HeadlineDetectionService } from '../src/services/headline-detection.service';
import { CALLGRID_PROVIDER, CALLS_STREAM } from '../src/services/provider-observation.service';
import type { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const NOW = new Date('2026-08-17T14:30:00.000Z');
const WINDOWS = easternTrailingCompleteWindows(NOW, COMPARISON_SPAN_DAYS);
const ALL_DATES = [
  ...easternBusinessDatesIn(WINDOWS.prior),
  ...easternBusinessDatesIn(WINDOWS.current),
];
const MISSING: BusinessDate[] = ['2026-08-11', '2026-08-12', '2026-08-13'];

const ROOFING_MEMBERS = [
  { dimension: 'CAMPAIGN', externalId: 'cmp-roof-tx', label: 'Roofing - TX' },
];

function make() {
  const prisma = makeCognitivePrisma();
  return {
    prisma,
    observations: new ProviderObservationRepository(prisma as never),
    bindings: new ObjectiveMeasureBindingRepository(prisma as never),
    headlines: new HeadlineRepository(prisma as never),
    objectives: new PerformanceObjectiveRepository(prisma as never),
  };
}

/** Certify a set of business dates for one organization. */
async function certify(
  observations: ProviderObservationRepository,
  organizationId: string,
  dates: readonly BusinessDate[],
  status: 'SUCCESS' | 'EMPTY' | 'PARTIAL_PAGINATION' | 'ENDPOINT_FAILURE' = 'SUCCESS',
) {
  for (const businessDate of dates) {
    const window = easternBusinessDayWindow(businessDate);
    await observations.recordDay(organizationId, {
      provider: CALLGRID_PROVIDER,
      stream: CALLS_STREAM,
      businessDate,
      timezone: 'America/New_York',
      windowStart: window.start,
      windowEnd: window.end,
      status,
      observedAt: NOW,
      source: 'provider-query',
      recordsObserved: status === 'EMPTY' ? 0 : 900,
      pagesFetched: status === 'EMPTY' ? 1 : 9,
      pageCap: 100,
      truncated: status === 'PARTIAL_PAGINATION',
    });
  }
}

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

/** A call-aggregate double that RECORDS whether it was consulted at all. */
function makeCalls(answers: { current: PopulationWindowAggregate; prior: PopulationWindowAggregate }) {
  const seen: Array<{ start: Date; end: Date }> = [];
  const repo = {
    async aggregatePopulationWindow(
      _organizationId: string,
      _population: Record<string, unknown>,
      window: { start: Date; end: Date },
    ) {
      const isCurrent = seen.length % 2 === 0;
      seen.push(window);
      return isCurrent ? answers.current : answers.prior;
    },
  } as unknown as MarketplaceCallRepository;
  return { repo, seen };
}

async function boundObjective(
  objectives: PerformanceObjectiveRepository,
  bindings: ObjectiveMeasureBindingRepository,
  organizationId = ORG,
) {
  const objective = await unboundObjective(objectives, organizationId);
  const confirmed = await bindings.confirm(organizationId, {
    performanceObjectiveId: objective.id,
    metric: 'CALL_VOLUME',
    direction: 'HIGHER_IS_BETTER',
    members: ROOFING_MEMBERS,
    confirmedByUserId: null,
  });
  assert.ok(confirmed.ok, 'fixture binding must confirm');
  return objective;
}

async function unboundObjective(
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

// --- 1. The gate ------------------------------------------------------------------

test('three unobserved days withhold every objective, and no aggregate is read', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  // Everything observed EXCEPT the three days CallGrid never delivered.
  await certify(observations, ORG, ALL_DATES.filter((d) => !MISSING.includes(d)));

  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 3_400 }), prior: agg({ totalCalls: 9_100 }) });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.established, 0, 'no headline from an ingestion gap');
  assert.equal(summary.withheld, 1);
  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(summary.outcomes[0]!.measurement, null, 'no measurement object at all');
  assert.equal((await headlines.list(ORG)).length, 0);

  // NOT COMPUTED, NOT HIDDEN. The aggregate read never happened, so there is no
  // commercial result anywhere in the process to leak into a log or a surface.
  assert.equal(seen.length, 0, 'the gate must return before any aggregate is queried');

  // The run still reports what it verified and what it could not.
  assert.equal(summary.observation.fullyObserved, false);
  assert.equal(summary.observation.observedDayCount, 11);
  assert.deepEqual(
    summary.observation.uncertified.map((u) => u.businessDate),
    MISSING,
  );
  assert.deepEqual(summary.observation.uncertified.map((u) => u.status), [null, null, null]);
});

test('an objective with no binding stays NOT_MEASURABLE even when the window is blocked', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await unboundObjective(objectives, ORG, 'Something Loop cannot measure');
  await certify(observations, ORG, ALL_DATES.filter((d) => !MISSING.includes(d)));

  const { repo } = makeCalls({ current: agg(), prior: agg() });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  // Two different silences, kept apart: "we have no definition for this" is not
  // "we could not see the period".
  assert.equal(summary.outcomes[0]!.withheld, 'NOT_MEASURABLE');
  assert.equal(summary.objectivesMeasurable, 0);
});

test('a truncated day blocks the window exactly as a missing one does', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  await certify(observations, ORG, ALL_DATES.filter((d) => d !== '2026-08-12'));
  await certify(observations, ORG, ['2026-08-12'], 'PARTIAL_PAGINATION');

  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 40 }), prior: agg() });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(seen.length, 0);
  assert.equal(summary.observation.uncertified[0]!.status, 'PARTIAL_PAGINATION');
});

test('a failed provider read blocks the window and records which failure it was', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  await certify(observations, ORG, ALL_DATES.filter((d) => d !== '2026-08-05'));
  await certify(observations, ORG, ['2026-08-05'], 'ENDPOINT_FAILURE');

  const { repo } = makeCalls({ current: agg(), prior: agg() });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(summary.observation.uncertified[0]!.status, 'ENDPOINT_FAILURE');
});

test('an entirely empty ledger blocks measurement — the state on the day this ships', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);

  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  // Every day before certification exists is UNKNOWN, including the ones that
  // ingested perfectly. That is the honest cost of the invariant, and it is a
  // property worth pinning so nobody "fixes" it by defaulting to observed.
  assert.equal(summary.observation.observedDayCount, 0);
  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
});

// --- 2. All fourteen certified: measurement proceeds -------------------------------

test('with all fourteen certified, a material move records a Headline as before', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  await certify(observations, ORG, ALL_DATES);

  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.established, 1);
  assert.equal(summary.observation.fullyObserved, true);
  assert.equal(summary.observation.observedDayCount, 14);
  assert.equal(seen.length, 2, 'both windows were aggregated');

  const rows = await headlines.list(ORG);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.measurement.movement, 'DECREASE');
});

test('a proven-empty day certifies, so a genuinely quiet week is still measurable', async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  await certify(observations, ORG, ALL_DATES.filter((d) => !['2026-08-15', '2026-08-16'].includes(d)));
  await certify(observations, ORG, ['2026-08-15', '2026-08-16'], 'EMPTY');

  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.observation.fullyObserved, true);
  assert.equal(summary.established, 1, 'a proven zero is data, not a gap');
});

// --- 3. Headline provenance --------------------------------------------------------

test('a recorded Headline carries the observation rule that governed it', async () => {
  const { observations, bindings, headlines, objectives, prisma } = make();
  await boundObjective(objectives, bindings);
  await certify(observations, ORG, ALL_DATES);

  const { repo } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  await new HeadlineDetectionService(objectives, bindings, repo, headlines, observations).detect(ORG, NOW);

  const row = (prisma as unknown as { headline: { __rows: Array<Record<string, unknown>> } }).headline.__rows[0]!;
  // Stored, not inferred: by the time the rule changes, the evidence for what was
  // observed under the old one is gone.
  assert.equal(row.observationRuleVersion, OBSERVATION_RULE_VERSION);
  assert.equal(row.observedDayCount, 14);
  assert.notEqual(row.observationRuleVersion, 'none', 'a certified row must not look like a legacy one');
});

// --- 4. Tenancy --------------------------------------------------------------------

test("another organization's certification cannot satisfy this one's gate", async () => {
  const { observations, bindings, headlines, objectives } = make();
  await boundObjective(objectives, bindings);
  // The OTHER tenant has certified every single day. That must count for nothing.
  await certify(observations, OTHER_ORG, ALL_DATES);

  const { repo, seen } = makeCalls({ current: agg({ totalCalls: 60 }), prior: agg({ totalCalls: 100 }) });
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observations,
  ).detect(ORG, NOW);

  assert.equal(summary.observation.observedDayCount, 0);
  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(seen.length, 0);
  assert.equal((await headlines.list(ORG)).length, 0);
});

test('two organizations certify the same calendar day independently', async () => {
  const { observations } = make();
  await certify(observations, ORG, ['2026-08-12'], 'SUCCESS');
  await certify(observations, OTHER_ORG, ['2026-08-12'], 'ENDPOINT_FAILURE');

  const mine = await observations.statusesForDates(ORG, CALLGRID_PROVIDER, CALLS_STREAM, ['2026-08-12']);
  const theirs = await observations.statusesForDates(OTHER_ORG, CALLGRID_PROVIDER, CALLS_STREAM, ['2026-08-12']);
  assert.equal(mine.get('2026-08-12'), 'SUCCESS');
  assert.equal(theirs.get('2026-08-12'), 'ENDPOINT_FAILURE');
});

// --- 5. The ledger itself ----------------------------------------------------------

test('re-certifying a day updates the evidence rather than duplicating the row', async () => {
  const { observations, prisma } = make();
  await certify(observations, ORG, ['2026-08-12'], 'ENDPOINT_FAILURE');
  await certify(observations, ORG, ['2026-08-12'], 'SUCCESS');

  const rows = (prisma as unknown as {
    providerObservationDay: { __rows: Array<Record<string, unknown>> };
  }).providerObservationDay.__rows;
  assert.equal(rows.length, 1, 'one day, one current answer');

  const stored = await observations.listForDates(ORG, CALLGRID_PROVIDER, CALLS_STREAM, ['2026-08-12']);
  assert.equal(stored[0]!.status, 'SUCCESS', 'a retry that succeeded supersedes the failure');
  assert.equal(stored[0]!.truncated, false);
});

test('a business date round-trips through the DATE column unchanged', async () => {
  const { observations } = make();
  await certify(observations, ORG, ALL_DATES);
  const stored = await observations.listForDates(ORG, CALLGRID_PROVIDER, CALLS_STREAM, ALL_DATES);
  assert.deepEqual(stored.map((s) => s.businessDate), ALL_DATES);
  // And the evidence names the exact UTC interval that was read, so a reader
  // never has to re-derive a DST boundary to audit the row.
  const aug12 = stored.find((s) => s.businessDate === '2026-08-12')!;
  assert.equal(aug12.timezone, 'America/New_York');
});

test('a stream is certified on its own — the calls endpoint says nothing about reports', async () => {
  const { observations } = make();
  const window = easternBusinessDayWindow('2026-08-12');
  await observations.recordDay(ORG, {
    provider: CALLGRID_PROVIDER,
    stream: 'auction-reports',
    businessDate: '2026-08-12',
    timezone: 'America/New_York',
    windowStart: window.start,
    windowEnd: window.end,
    status: 'SUCCESS',
    observedAt: NOW,
    source: 'provider-query',
    recordsObserved: 5,
    pagesFetched: 1,
    pageCap: 100,
    truncated: false,
  });

  const calls = await observations.statusesForDates(ORG, CALLGRID_PROVIDER, CALLS_STREAM, ['2026-08-12']);
  assert.equal(calls.size, 0, 'a different stream must not certify this one');
});

test('an unqueried date is simply absent, never defaulted to observed', async () => {
  const { observations } = make();
  await certify(observations, ORG, ['2026-08-10']);
  const found = await observations.statusesForDates(
    ORG, CALLGRID_PROVIDER, CALLS_STREAM, ['2026-08-10', '2026-08-11'],
  );
  assert.equal(found.get('2026-08-10'), 'SUCCESS');
  assert.equal(found.has('2026-08-11'), false);
});
