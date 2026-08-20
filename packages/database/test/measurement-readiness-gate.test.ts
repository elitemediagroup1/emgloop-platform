// The readiness gate, wired -- Commercial Intelligence Stage 3, PR 5 of 7.
//
// WHAT THESE PROVE, AND WHAT THEY DELIBERATELY DO NOT
//
// The RULE is proved in `packages/shared/test/measurement-readiness.test.ts`, over
// forty cases, purely. Repeating it here would be two files asserting one rule,
// which is how they eventually assert different things. These prove the WIRING:
// that `HeadlineDetectionService` actually resolves the three ledgers, actually
// passes them, refuses BEFORE reading an aggregate, reports which refusal it was,
// and cannot be constructed without the ability to ask.
//
// THE FAKES HERE ARE STRICT, unlike `stage3-readiness-fixtures`' permissive
// defaults. A test that says "no reconciliation exists" must be able to say it.
//
// THE ONE PROPERTY WORTH STATING TWICE: when the gate refuses, no aggregate query
// runs at all. A measurement that is computed and then hidden leaves a number in
// the result object for a later caller to render, and Stage 2 already shipped one
// defect of exactly that shape. `seen.length === 0` is that property, checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPARISON_SPAN_DAYS,
  easternBusinessDatesIn,
  easternTrailingCompleteWindows,
  type BusinessDate,
  type MeasureMetric,
  type PopulationWindowAggregate,
  type ProviderObservationStatus,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { ObjectiveMeasureBindingRepository } from '../src/repositories/objective-measure-binding.repository';
import { HeadlineRepository } from '../src/repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../src/repositories/performance-objective.repository';
import { HeadlineDetectionService } from '../src/services/headline-detection.service';
import type { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';
import type { ProviderObservationRepository } from '../src/repositories/provider-observation.repository';
import type { ProviderReconciliationRepository } from '../src/repositories/provider-reconciliation.repository';
import type { MeasurementSourceRepository } from '../src/repositories/measurement-source.repository';
import {
  fixturePartitions,
  fixtureReconciliation,
  fixtureSource,
  fixtureSources,
  type FixtureMember,
} from './stage3-readiness-fixtures';

const SERVICE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'headline-detection.service.ts'),
  'utf8',
);

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const NOW = new Date('2026-08-16T14:30:00.000Z');
const CAMPAIGN = 'cmp-roof-tx';
const SILENT_CAMPAIGN = 'cmp-roof-texas-dr';
const MEMBERS: FixtureMember[] = [
  { dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN },
  { dimension: 'CAMPAIGN', memberExternalId: SILENT_CAMPAIGN },
];

const WINDOWS = easternTrailingCompleteWindows(NOW, COMPARISON_SPAN_DAYS);
const DATES: BusinessDate[] = [
  ...easternBusinessDatesIn(WINDOWS.prior),
  ...easternBusinessDatesIn(WINDOWS.current),
];

function agg(over: Partial<PopulationWindowAggregate> = {}): PopulationWindowAggregate {
  return {
    totalCalls: 400,
    revenueCents: 4_000_000,
    revenueReported: 400,
    monetizedTrue: 200,
    monetizedReported: 400,
    convertedTrue: 100,
    convertedReported: 400,
    noRouteTrue: 10,
    noRouteReported: 400,
    ...over,
  };
}

async function harness() {
  const prisma = makeCognitivePrisma();
  const bindings = new ObjectiveMeasureBindingRepository(prisma as never);
  const headlines = new HeadlineRepository(prisma as never);
  const objectives = new PerformanceObjectiveRepository(prisma as never);
  return { prisma, bindings, headlines, objectives };
}

async function boundObjective(
  objectives: PerformanceObjectiveRepository,
  bindings: ObjectiveMeasureBindingRepository,
  metric: MeasureMetric = 'CALL_VOLUME',
  title = 'Grow roofing lead volume in Texas',
) {
  const created = await objectives.create(ORG, {
    title,
    description: null,
    scope: 'ORGANIZATION',
    scopeUserId: null,
    createdByUserId: null,
  });
  assert.ok(created?.ok);
  const objective = created.objective;
  const confirmed = await bindings.confirm(ORG, {
    performanceObjectiveId: objective.id,
    metric,
    direction: 'HIGHER_IS_BETTER',
    members: MEMBERS.map((m) => ({
      dimension: m.dimension,
      externalId: m.memberExternalId,
      label: m.memberExternalId,
    })),
    confirmedByUserId: null,
  });
  assert.ok(confirmed?.ok);
  return objective;
}

/** An observation ledger that certifies every date in both windows. */
function observed(): ProviderObservationRepository {
  return {
    async statusesForDates(
      _organizationId: string,
      _provider: string,
      _stream: string,
      dates: readonly BusinessDate[],
    ) {
      return new Map<BusinessDate, ProviderObservationStatus>(
        dates.map((d) => [d, 'SUCCESS' as ProviderObservationStatus]),
      );
    },
  } as unknown as ProviderObservationRepository;
}

/**
 * The aggregate read, which RECORDS EVERY CALL.
 *
 * `seen` is the whole point: a gate that refuses must leave it empty.
 */
function countingCalls(
  partitions = fixturePartitions(0, 0),
  answers = { current: agg({ totalCalls: 900 }), prior: agg({ totalCalls: 300 }) },
) {
  const seen: Array<{ organizationId: string }> = [];
  const repo = {
    async aggregatePopulationWindow(organizationId: string) {
      const isCurrent = seen.length % 2 === 0;
      seen.push({ organizationId });
      return isCurrent ? answers.current : answers.prior;
    },
    ...partitions,
  } as unknown as MarketplaceCallRepository;
  return { repo, seen };
}

/** A reconciliation ledger that holds nothing at all. */
function unreconciled(): ProviderReconciliationRepository {
  return {
    async factsForDates() {
      return [];
    },
  } as unknown as ProviderReconciliationRepository;
}

async function run(
  over: {
    reconciliation?: ProviderReconciliationRepository;
    sources?: MeasurementSourceRepository;
    partitions?: ReturnType<typeof fixturePartitions>;
    metric?: MeasureMetric;
  } = {},
) {
  const { bindings, headlines, objectives } = await harness();
  await boundObjective(objectives, bindings, over.metric ?? 'CALL_VOLUME');
  const { repo, seen } = countingCalls(over.partitions);
  const summary = await new HeadlineDetectionService(
    objectives,
    bindings,
    repo,
    headlines,
    observed(),
    over.reconciliation ?? fixtureReconciliation(MEMBERS),
    over.sources ?? fixtureSources(),
  ).detect(ORG, NOW);
  return { summary, seen, headlines, outcome: summary.outcomes[0]! };
}

// --- The baseline: everything answered, so it measures ----------------------------

test('a fully ready population measures and records exactly as before', async () => {
  const { summary, seen, outcome } = await run();
  assert.equal(outcome.withheld, null, 'nothing stood in the way');
  assert.ok(outcome.measurement, 'a measurement was produced');
  assert.equal(outcome.readiness?.ready, true);
  assert.equal(outcome.readiness?.outcome, 'READY');
  assert.equal(summary.established, 1);
  assert.equal(seen.length, 2, 'both windows were aggregated');
});

test('the resolved source travels with the verdict, so a reader can see WHOSE number it was', async () => {
  const { outcome } = await run();
  assert.deepEqual(outcome.readiness?.resolvedSourceKeys, ['fixture-provider-stream']);
});

// --- Each refusal, through the service --------------------------------------------

test('a window nobody reconciled withholds, and NO aggregate is read', async () => {
  const { summary, seen, outcome, headlines } = await run({ reconciliation: unreconciled() });
  assert.equal(outcome.withheld, 'RECONCILIATION_MISSING');
  assert.equal(outcome.measurement, null, 'not computed, not merely hidden');
  assert.equal(seen.length, 0, 'the population was never summed');
  assert.equal(summary.withheld, 1);
  assert.equal(summary.established, 0);
  assert.equal((await headlines.list(ORG)).length, 0);
});

test('an unsound comparison withholds as INCONCLUSIVE, not as a gap', async () => {
  const { outcome, seen } = await run({
    reconciliation: fixtureReconciliation(MEMBERS, { state: 'INCONCLUSIVE' }),
  });
  assert.equal(outcome.withheld, 'RECONCILIATION_INCONCLUSIVE');
  assert.equal(seen.length, 0);
});

test('an undeclared campaign is a CONFIG_ERROR only a person can clear', async () => {
  const { outcome, seen } = await run({
    reconciliation: fixtureReconciliation(MEMBERS, { expectation: 'UNKNOWN' }),
  });
  assert.equal(outcome.withheld, 'CAMPAIGN_EXPECTATION_UNKNOWN');
  assert.equal(outcome.readiness?.outcome, 'CONFIG_ERROR');
  assert.equal(seen.length, 0);
});

test('a campaign declared not to participate, that participated, contradicts itself', async () => {
  const { outcome } = await run({
    reconciliation: fixtureReconciliation(MEMBERS, {
      expectation: 'NOT_CONFIGURED',
      localCount: 12,
    }),
  });
  assert.equal(outcome.withheld, 'CAMPAIGN_EXPECTATION_CONTRADICTED');
});

test('an expected campaign whose records did not arrive is POPULATION_INCOMPLETE', async () => {
  const { outcome } = await run({
    reconciliation: fixtureReconciliation(MEMBERS, { providerOnly: 106 }),
  });
  assert.equal(outcome.withheld, 'POPULATION_INCOMPLETE');
  assert.ok(
    outcome.readiness?.findings.some((f) => f.detail.includes('106')),
    'the finding says how many, so an operator knows the size of the hole',
  );
});

test('no declared authority fails closed — it never falls back to the provider', async () => {
  const { outcome, seen } = await run({
    sources: fixtureSources({ withoutAuthorityFor: [CAMPAIGN, SILENT_CAMPAIGN] }),
  });
  assert.equal(outcome.withheld, 'SOURCE_AUTHORITY_MISSING');
  assert.equal(seen.length, 0);
});

test('two declared authorities fail closed too, with no tie-break', async () => {
  const { outcome } = await run({ sources: fixtureSources({ perMember: 2 }) });
  assert.equal(outcome.withheld, 'SOURCE_AUTHORITY_CONFLICT');
});

test('an authority naming a source that does not supply the measure is refused', async () => {
  const { outcome } = await run({
    metric: 'REVENUE',
    sources: fixtureSources({
      sources: [fixtureSource({ supportedMetrics: ['CALL_VOLUME'] })],
    }),
  });
  assert.equal(outcome.withheld, 'MEASURE_NOT_SUPPORTED_BY_SOURCE');
});

test('a population containing calls that belong to no bound member is refused whole', async () => {
  const { outcome, seen } = await run({ partitions: fixturePartitions(0, 3) });
  assert.equal(outcome.withheld, 'CALL_UNATTRIBUTED');
  assert.equal(seen.length, 0);
});

test('a measure authoritative from a report withholds until the report exists', async () => {
  // `SourceOutcomeDay` is not persisted yet and the service passes no outcome
  // days, so a BUYER_REPORT authority resolves PENDING rather than being computed
  // from whatever happens to sit in the call rows. This is the deferral failing
  // closed, asserted rather than assumed.
  const { outcome, seen } = await run({
    metric: 'REVENUE',
    sources: fixtureSources({
      sources: [fixtureSource({ kind: 'BUYER_REPORT', provider: null, stream: null })],
    }),
  });
  assert.equal(outcome.withheld, 'AUTHORITATIVE_DATA_PENDING');
  assert.equal(seen.length, 0);
});

// --- The subtle ones --------------------------------------------------------------

test('a bound campaign that contributed NOTHING is still assessed', async () => {
  // The August 2026 shape: a campaign that goes completely silent must not vanish
  // from the population and leave the gate finding nothing wrong with measuring
  // the survivors. Only the silent one lacks an authority, and that is enough.
  const { outcome, seen } = await run({
    partitions: fixturePartitions(0, 0),
    sources: fixtureSources({ withoutAuthorityFor: [SILENT_CAMPAIGN] }),
  });
  assert.equal(outcome.withheld, 'SOURCE_AUTHORITY_MISSING');
  assert.ok(
    outcome.readiness?.findings.some((f) => f.memberExternalId === SILENT_CAMPAIGN),
    'the silent member is the one named',
  );
  assert.equal(seen.length, 0);
});

test('every finding survives on the outcome, not only the one that names the refusal', async () => {
  const { outcome } = await run({
    reconciliation: fixtureReconciliation(MEMBERS, { expectation: 'UNKNOWN' }),
    sources: fixtureSources({ withoutAuthorityFor: [CAMPAIGN, SILENT_CAMPAIGN] }),
  });
  // TWO problems per member per date, accumulated rather than short-circuited, so
  // an operator declares the campaigns AND declares the authorities in one sitting
  // instead of fixing one and re-running to discover the other.
  const reasons = new Set(outcome.readiness?.findings.map((f) => f.reason));
  assert.deepEqual(
    [...reasons].sort(),
    ['CAMPAIGN_EXPECTATION_UNKNOWN', 'SOURCE_AUTHORITY_MISSING'],
  );
  assert.equal(outcome.readiness?.findings.length, DATES.length * MEMBERS.length * 2);
  // And the one reported is the most severe -- both are CONFIG_ERROR here, so it
  // is the first the gate produced, which is deterministic.
  assert.equal(outcome.withheld, 'CAMPAIGN_EXPECTATION_UNKNOWN');
});

test('the day facts are resolved ONCE per run, however many objectives there are', async () => {
  const { bindings, headlines, objectives } = await harness();
  await boundObjective(objectives, bindings, 'CALL_VOLUME', 'First objective');
  await boundObjective(objectives, bindings, 'CALL_VOLUME', 'Second objective');
  await boundObjective(objectives, bindings, 'CALL_VOLUME', 'Third objective');

  let factReads = 0;
  const counting = {
    async factsForDates(
      organizationId: string,
      provider: string,
      stream: string,
      dates: readonly BusinessDate[],
    ) {
      factReads += 1;
      return fixtureReconciliation(MEMBERS).factsForDates(organizationId, provider, stream, dates);
    },
  } as unknown as ProviderReconciliationRepository;

  const { repo } = countingCalls();
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observed(), counting, fixtureSources(),
  ).detect(ORG, NOW);

  assert.equal(summary.objectivesMeasurable, 3);
  assert.equal(factReads, 1, 'a day is reconciled once, not once per objective');
});

test('an unobserved window still refuses before anything else is resolved', async () => {
  const { bindings, headlines, objectives } = await harness();
  await boundObjective(objectives, bindings);
  let factReads = 0;
  const counting = {
    async factsForDates() {
      factReads += 1;
      return [];
    },
  } as unknown as ProviderReconciliationRepository;
  const blind = {
    async statusesForDates() {
      return new Map<BusinessDate, ProviderObservationStatus>();
    },
  } as unknown as ProviderObservationRepository;

  const { repo, seen } = countingCalls();
  const summary = await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, blind, counting, fixtureSources(),
  ).detect(ORG, NOW);

  assert.equal(summary.outcomes[0]!.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(summary.outcomes[0]!.readiness, null, 'no population was resolved to judge');
  assert.equal(factReads, 0, 'the cheapest refusal still costs nothing');
  assert.equal(seen.length, 0);
});

// --- Tenancy ----------------------------------------------------------------------

test('every readiness read is scoped to the session organization', async () => {
  const { bindings, headlines, objectives } = await harness();
  await boundObjective(objectives, bindings);
  const orgs: string[] = [];
  const recording = {
    async factsForDates(organizationId: string, p: string, s: string, d: readonly BusinessDate[]) {
      orgs.push(organizationId);
      return fixtureReconciliation(MEMBERS).factsForDates(organizationId, p, s, d);
    },
  } as unknown as ProviderReconciliationRepository;
  const recordingSources = {
    async readinessFacts(organizationId: string, members: readonly FixtureMember[], metric: MeasureMetric) {
      orgs.push(organizationId);
      return fixtureSources().readinessFacts(organizationId, members, metric);
    },
  } as unknown as MeasurementSourceRepository;
  const partitionOrgs: string[] = [];
  const partitions = {
    async partitionPopulationWindows(
      organizationId: string,
      population: Parameters<
        ReturnType<typeof fixturePartitions>['partitionPopulationWindows']
      >[1],
      windows: Parameters<
        ReturnType<typeof fixturePartitions>['partitionPopulationWindows']
      >[2],
    ) {
      partitionOrgs.push(organizationId);
      return fixturePartitions().partitionPopulationWindows(organizationId, population, windows);
    },
  };

  const { repo, seen } = countingCalls(partitions);
  await new HeadlineDetectionService(
    objectives, bindings, repo, headlines, observed(), recording, recordingSources,
  ).detect(ORG, NOW);

  assert.ok(orgs.length >= 2);
  assert.ok(orgs.every((o) => o === ORG));
  assert.ok(partitionOrgs.every((o) => o === ORG));
  assert.ok(seen.every((s) => s.organizationId === ORG));
  assert.ok(!orgs.includes(OTHER_ORG));
});

// --- Boundaries, proved by reading the service's own source ------------------------

test('the measurement path can never write the facts it gates on', async () => {
  // A service that could declare an expectation, declare an authority, reconcile a
  // day or certify one would be able to unblock itself, and the gate would be
  // decoration. It resolves and it reads; nothing more.
  for (const symbol of [
    '.declare(',
    'declareAuthority',
    'registerSource',
    'correctMeasureDefinition',
    'recordDay',
    'certifyDay',
    'reconcileDay',
    'previewDeclaration',
    'previewAuthorityDeclaration',
  ]) {
    assert.ok(!SERVICE_SOURCE.includes(symbol), `the service must not call ${symbol}`);
  }
});

test('the service touches no Prisma delegate and no provider', async () => {
  assert.ok(!/prisma\.\w+\./.test(SERVICE_SOURCE), 'persistence goes through repositories');
  for (const symbol of ['CallGridClient', 'fetch(', 'process.env', 'Math.random']) {
    assert.ok(!SERVICE_SOURCE.includes(symbol), `the service must not reference ${symbol}`);
  }
});

test('the readiness verdict is resolved, never constructed by hand', async () => {
  // `assessReadiness` is the only way a verdict may come into existence here. A
  // literal would be this file deciding what "ready" means, which is precisely the
  // parallel system the pure module exists to prevent.
  assert.ok(SERVICE_SOURCE.includes('assessReadiness({'));
  assert.ok(!/ready:\s*true/.test(SERVICE_SOURCE));
  assert.ok(!/outcome:\s*'READY'/.test(SERVICE_SOURCE));
});
