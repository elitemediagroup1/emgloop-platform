// Stand-ins for the three completeness ledgers the readiness gate reads.
//
// WHY A SHARED FIXTURE AND NOT A COPY IN EACH FILE. `headline.test.ts` and
// `observation-completeness.test.ts` were written before the gate existed and are
// about materiality, recurrence and observation. They still are. What changed is
// that a measurement now also requires reconciliation and a declared authority --
// so those files need a way to say "all of that is fine, ask me about the thing I
// am actually testing", and two hand-written copies of that would drift.
//
// PERMISSIVE BY DEFAULT, AND THAT IS THE POINT. Every helper here answers the
// gate's questions affirmatively, exactly as `makeObservations` certifies every
// day by default. Making the assumption explicit keeps the pre-existing tests
// testing what they were written to test. The gate's own refusals are proved
// against STRICT fakes in `measurement-readiness-gate.test.ts`, and the pure rule
// is proved in `packages/shared/test/measurement-readiness.test.ts`.
//
// NOTHING HERE IS PRODUCTION CODE, and nothing here decides anything: each helper
// returns a fixed answer for whatever it is asked.

import {
  MEASURE_METRICS,
  type BindingDimension,
  type BusinessDate,
  type MeasureMetric,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementSourceDefinition,
  type ReconciliationCounts,
  type ReconciliationDayFact,
  type ReconciliationState,
  type ResolvedExpectation,
} from '@emgloop/shared';

import type { MeasurementSourceRepository } from '../src/repositories/measurement-source.repository';
import type { ProviderReconciliationRepository } from '../src/repositories/provider-reconciliation.repository';
import type {
  MarketplaceCallRepository,
  PopulationPartitionFacts,
} from '../src/repositories/marketplace-call.repository';

export interface FixtureMember {
  dimension: BindingDimension;
  memberExternalId: string;
}

/** Counts that satisfy the three set equations with nothing in them. */
export const EMPTY_COUNTS: ReconciliationCounts = {
  providerUnique: 0,
  providerDuplicateIds: 0,
  localUnique: 0,
  localDuplicateIds: 0,
  intersection: 0,
  providerOnly: 0,
  localOnly: 0,
  providerOnlyExpected: 0,
  providerOnlyNotConfigured: 0,
  providerOnlyExcluded: 0,
  providerOnlyUnknownMember: 0,
};

export const TEST_SOURCE_KEY = 'fixture-provider-stream';

/**
 * A registered provider stream that may be believed about every measure.
 *
 * A DEFINITION ID PER METRIC, because `sourceSupports` fails closed without one --
 * a source listing a metric it has no definition for is not usable, and a fixture
 * that forgot would fail these tests for a reason unrelated to what they assert.
 */
export function fixtureSource(
  over: Partial<MeasurementSourceDefinition> = {},
): MeasurementSourceDefinition {
  return {
    key: TEST_SOURCE_KEY,
    kind: 'PROVIDER_STREAM',
    displayName: 'Fixture provider stream',
    supportedMetrics: [...MEASURE_METRICS],
    measureDefinitionIds: Object.fromEntries(
      MEASURE_METRICS.map((m) => [m, `fixture-binding.v1:${m}`]),
    ) as Record<MeasureMetric, string>,
    provider: 'fixture',
    stream: 'calls',
    ...over,
  };
}

/** One open-ended authority per member, naming the fixture source. */
export function fixtureAuthorities(
  members: readonly FixtureMember[],
  metric: MeasureMetric,
  sourceKey = TEST_SOURCE_KEY,
): MeasureSourceAuthorityDeclaration[] {
  return members.map((m) => ({
    dimension: m.dimension,
    memberExternalId: m.memberExternalId,
    metric,
    sourceKey,
    effectiveFrom: '2000-01-01' as BusinessDate,
    effectiveTo: null,
  }));
}

/**
 * A reconciliation ledger that answers RECONCILED for every date it is asked about.
 *
 * `members` must cover every member the bound populations use: a member with no
 * fact resolves UNKNOWN and the gate refuses, which is correct behaviour and a
 * confusing way for an unrelated test to fail.
 */
export function fixtureReconciliation(
  members: readonly FixtureMember[],
  over: {
    state?: ReconciliationState;
    expectation?: ResolvedExpectation;
    providerOnly?: number;
    localCount?: number;
    /** Dates to answer for. Omit to answer for every date requested. */
    only?: readonly BusinessDate[];
  } = {},
): ProviderReconciliationRepository {
  return {
    async factsForDates(
      _organizationId: string,
      _provider: string,
      _stream: string,
      dates: readonly BusinessDate[],
    ): Promise<ReconciliationDayFact[]> {
      const answered = over.only ? dates.filter((d) => over.only!.includes(d)) : dates;
      return answered.map((businessDate) => ({
        businessDate,
        state: over.state ?? 'RECONCILED',
        counts: EMPTY_COUNTS,
        ruleVersion: 'fixture.v1',
        members: members.map((m) => ({
          dimension: m.dimension,
          memberExternalId: m.memberExternalId,
          providerCount: 0,
          localCount: over.localCount ?? 0,
          providerOnly: over.providerOnly ?? 0,
          expectation: over.expectation ?? 'EXPECTED',
        })),
      }));
    },
  } as unknown as ProviderReconciliationRepository;
}

/** A source registry that declares the fixture source authoritative for whatever is asked. */
export function fixtureSources(
  over: {
    sources?: readonly MeasurementSourceDefinition[];
    /** Return no authority for these members, so the gate reports MISSING. */
    withoutAuthorityFor?: readonly string[];
    sourceKey?: string;
    /** Emit this many authorities per member. Two is a CONFLICT. */
    perMember?: number;
  } = {},
): MeasurementSourceRepository {
  return {
    async readinessFacts(
      _organizationId: string,
      members: readonly FixtureMember[],
      metric: MeasureMetric,
    ) {
      const wanted = members.filter(
        (m) => !(over.withoutAuthorityFor ?? []).includes(m.memberExternalId),
      );
      const once = fixtureAuthorities(wanted, metric, over.sourceKey ?? TEST_SOURCE_KEY);
      const authorities =
        (over.perMember ?? 1) <= 1
          ? once
          : once.flatMap((a) =>
              Array.from({ length: over.perMember ?? 1 }, (_, i) => ({
                ...a,
                sourceKey: i === 0 ? a.sourceKey : `${a.sourceKey}-${i}`,
              })),
            );
      return { sources: over.sources ? [...over.sources] : [fixtureSource()], authorities };
    },
  } as unknown as MeasurementSourceRepository;
}

/**
 * The partition read, derived from the population it is handed.
 *
 * Mirrors the real repository's contract: EVERY bound member is returned, whether
 * or not it contributed calls, in a fixed dimension order.
 */
export function fixturePartitions(
  localCallsPerMember = 0,
  unattributedCalls = 0,
): Pick<MarketplaceCallRepository, 'partitionPopulationWindows'> {
  return {
    async partitionPopulationWindows(
      _organizationId: string,
      population: {
        campaignExternalIds?: readonly string[];
        sourceExternalIds?: readonly string[];
        buyerExternalIds?: readonly string[];
        vendorExternalIds?: readonly string[];
      },
    ): Promise<PopulationPartitionFacts | null> {
      const partitions: PopulationPartitionFacts['partitions'] = [];
      const add = (dimension: BindingDimension, ids: readonly string[] | undefined) => {
        for (const memberExternalId of ids ?? []) {
          partitions.push({ dimension, memberExternalId, localCalls: localCallsPerMember });
        }
      };
      add('CAMPAIGN', population.campaignExternalIds);
      add('SOURCE', population.sourceExternalIds);
      add('BUYER', population.buyerExternalIds);
      add('VENDOR', population.vendorExternalIds);
      if (partitions.length === 0) return null;
      return { partitions, unattributedCalls };
    },
  };
}
