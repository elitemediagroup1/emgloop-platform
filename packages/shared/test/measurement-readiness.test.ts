// Readiness — the twenty ways a measure must refuse to be computed.
//
// THE PROPERTY UNDER TEST, ONCE
//
// Missing authoritative data must never become a number. Not 0 revenue, not 0%
// conversion, not "false" monetization. Every case below is a way the data can be
// absent, unproven, undeclared or contested, and in every one of them the verdict
// must be a reason with a next move rather than an answer.
//
// The counter-property matters just as much: a clean, declared, reconciled
// population must measure. A gate that refuses everything is safe and useless, and
// would teach operators to route around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MATERIALITY_WITHHOLDINGS,
  MATERIALITY_WITHHOLDING_LABELS,
  MATERIALITY_WITHHOLDING_NEXT_ACTIONS,
  READINESS_OUTCOME_BY_REASON,
  READINESS_WITHHOLDINGS,
  assessReadiness,
  assessWindowObservation,
  describeNotReady,
  type BusinessDate,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementSourceDefinition,
  type ProviderObservationStatus,
  type ReadinessInput,
  type ReadinessPartition,
  type ReconciliationCounts,
  type ReconciliationDayFact,
  type ReconciliationMemberFact,
  type SourceOutcomeDayFact,
} from '../src/index';

const DATES: BusinessDate[] = ['2026-08-04', '2026-08-05'];
const CAMPAIGN = 'camp-delivering';

const PROVIDER_SOURCE: MeasurementSourceDefinition = {
  key: 'provider-calls',
  kind: 'PROVIDER_STREAM',
  displayName: 'Call provider',
  supportedMetrics: ['CALL_VOLUME', 'REVENUE', 'NO_ROUTE_RATE'],
  measureDefinitionIds: {
    CALL_VOLUME: 'calls.provider.v1',
    REVENUE: 'revenue.provider.v1',
    NO_ROUTE_RATE: 'no-route.provider.v1',
  },
  provider: 'callgrid',
  stream: 'calls',
};

const REPORT_SOURCE: MeasurementSourceDefinition = {
  key: 'buyer-outcomes',
  kind: 'BUYER_REPORT',
  displayName: 'Buyer outcome report',
  supportedMetrics: ['REVENUE'],
  measureDefinitionIds: { REVENUE: 'revenue.buyer.v1' },
  provider: null,
  stream: null,
};

function observation(overrides: Record<string, ProviderObservationStatus | null> = {}) {
  const m = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of DATES) m.set(d, 'SUCCESS');
  for (const [d, s] of Object.entries(overrides)) {
    if (s === null) m.delete(d);
    else m.set(d, s);
  }
  return assessWindowObservation(DATES, m);
}

function counts(over: Partial<ReconciliationCounts> = {}): ReconciliationCounts {
  return {
    providerUnique: 100,
    providerDuplicateIds: 0,
    localUnique: 100,
    localDuplicateIds: 0,
    intersection: 100,
    providerOnly: 0,
    localOnly: 0,
    providerOnlyExpected: 0,
    providerOnlyNotConfigured: 0,
    providerOnlyExcluded: 0,
    providerOnlyUnknownMember: 0,
    ...over,
  };
}

function member(over: Partial<ReconciliationMemberFact> = {}): ReconciliationMemberFact {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: CAMPAIGN,
    providerCount: 100,
    localCount: 100,
    providerOnly: 0,
    expectation: 'EXPECTED',
    ...over,
  };
}

function day(date: BusinessDate, over: Partial<ReconciliationDayFact> = {}): ReconciliationDayFact {
  return {
    businessDate: date,
    state: 'RECONCILED',
    counts: counts(),
    members: [member()],
    ruleVersion: 'provider-reconciliation.v1',
    ...over,
  };
}

function authority(
  over: Partial<MeasureSourceAuthorityDeclaration> = {},
): MeasureSourceAuthorityDeclaration {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: CAMPAIGN,
    metric: 'REVENUE',
    sourceKey: 'provider-calls',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    ...over,
  };
}

const PARTITION: ReadinessPartition = {
  dimension: 'CAMPAIGN',
  memberExternalId: CAMPAIGN,
  localCalls: 200,
};

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    metric: 'REVENUE',
    dates: DATES,
    observation: observation(),
    partitions: [PARTITION],
    unattributedCalls: 0,
    reconciliation: DATES.map((d) => day(d)),
    authorities: [authority()],
    sources: [PROVIDER_SOURCE, REPORT_SOURCE],
    outcomeDays: [],
    ...over,
  };
}

function reasons(r: ReturnType<typeof assessReadiness>): string[] {
  return r.findings.map((f) => f.reason);
}

// --- 20. The path that must work ------------------------------------------------------

test('20 · a declared, observed, reconciled population is READY', () => {
  const r = assessReadiness(input());
  assert.equal(r.ready, true);
  assert.equal(r.outcome, 'READY');
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.resolvedSourceKeys, ['provider-calls']);
});

// --- 1–3. The day itself ----------------------------------------------------------------

test('1 · an unobserved day refuses first, and nothing else is even considered', () => {
  const r = assessReadiness(
    input({
      observation: observation({ '2026-08-05': null }),
      // Everything below is also broken. None of it should be reported: there is
      // no point resolving authority for a day nobody read.
      authorities: [],
      reconciliation: [],
    }),
  );
  assert.deepEqual(reasons(r), ['WINDOW_NOT_OBSERVED']);
  assert.equal(r.findings[0]?.businessDate, '2026-08-05');
  assert.equal(r.outcome, 'NOT_READY');
});

test('2 · an observed day that was never reconciled is NOT_READY', () => {
  const r = assessReadiness(input({ reconciliation: [day('2026-08-04')] }));
  assert.deepEqual(reasons(r), ['RECONCILIATION_MISSING']);
  assert.equal(r.findings[0]?.businessDate, '2026-08-05');
  assert.equal(r.outcome, 'NOT_READY');
});

test('3 · an unsound comparison is INCONCLUSIVE and blocks every population that day', () => {
  const r = assessReadiness(
    input({ reconciliation: [day('2026-08-04'), day('2026-08-05', { state: 'INCONCLUSIVE' })] }),
  );
  assert.deepEqual(reasons(r), ['RECONCILIATION_INCONCLUSIVE']);
  assert.equal(r.outcome, 'INCONCLUSIVE');
});

// --- 4–7. What the campaign was expected to do ---------------------------------------------

test('4 · an undeclared campaign is a CONFIG_ERROR — only a person can answer it', () => {
  const undeclared = [
    day('2026-08-04', { members: [member({ expectation: 'UNKNOWN' })] }),
    day('2026-08-05', { members: [member({ expectation: 'UNKNOWN' })] }),
  ];
  const r = assessReadiness(input({ reconciliation: undeclared }));
  assert.deepEqual(reasons(r), ['CAMPAIGN_EXPECTATION_UNKNOWN', 'CAMPAIGN_EXPECTATION_UNKNOWN']);
  assert.equal(r.outcome, 'CONFIG_ERROR');
});

test('4b · a bound member the day never saw is undeclared, not silently absent', () => {
  // The August 2026 shape: a campaign that contributed ZERO rows must still be
  // assessed, or a campaign that went completely silent would vanish from the
  // population and the gate would happily measure the survivors.
  const silent: ReadinessPartition = { dimension: 'CAMPAIGN', memberExternalId: 'camp-silent', localCalls: 0 };
  const r = assessReadiness(input({ partitions: [PARTITION, silent] }));
  assert.ok(reasons(r).includes('CAMPAIGN_EXPECTATION_UNKNOWN'));
  assert.equal(r.findings.find((f) => f.reason === 'CAMPAIGN_EXPECTATION_UNKNOWN')?.memberExternalId, 'camp-silent');
});

test('5 · an expected campaign missing records is POPULATION_INCOMPLETE', () => {
  const short = day('2026-08-05', {
    state: 'UNRECONCILED',
    counts: counts({ providerUnique: 101, providerOnly: 1, providerOnlyExpected: 1 }),
    members: [member({ providerCount: 101, providerOnly: 1 })],
  });
  const r = assessReadiness(input({ reconciliation: [day('2026-08-04'), short] }));
  assert.deepEqual(reasons(r), ['POPULATION_INCOMPLETE']);
  assert.equal(r.outcome, 'NOT_READY');
  assert.ok(r.findings[0]?.detail.includes('1 records'));
});

test('6 · a NOT_CONFIGURED campaign contributes absences and no objection', () => {
  const notConfigured = (d: BusinessDate) =>
    day(d, {
      counts: counts({ providerUnique: 106, providerOnly: 6, providerOnlyNotConfigured: 6 }),
      members: [member({ providerCount: 6, localCount: 0, providerOnly: 6, expectation: 'NOT_CONFIGURED' })],
    });
  const r = assessReadiness(input({ reconciliation: DATES.map(notConfigured) }));
  assert.equal(r.ready, true, 'a campaign that was never connected cannot have failed to deliver');
});

test('7 · an EXCLUDED campaign is likewise no objection', () => {
  const excluded = (d: BusinessDate) =>
    day(d, {
      counts: counts({ providerUnique: 103, providerOnly: 3, providerOnlyExcluded: 3 }),
      members: [member({ providerCount: 3, localCount: 0, providerOnly: 3, expectation: 'EXCLUDED' })],
    });
  const r = assessReadiness(input({ reconciliation: DATES.map(excluded) }));
  assert.equal(r.ready, true);
});

test('NOT_CONFIGURED is a classification and never a failure reason', () => {
  assert.equal(MATERIALITY_WITHHOLDINGS.includes('CAMPAIGN_NOT_CONFIGURED' as never), false);
});

// --- 8–10. Whose number is it -----------------------------------------------------------

test('8 · no declared authority fails closed — never a default to the provider', () => {
  const r = assessReadiness(input({ authorities: [] }));
  assert.deepEqual(reasons(r), ['SOURCE_AUTHORITY_MISSING', 'SOURCE_AUTHORITY_MISSING']);
  assert.equal(r.outcome, 'CONFIG_ERROR');
  assert.deepEqual(r.resolvedSourceKeys, []);
});

test('9 · two declared authorities fail closed too, with no tie-break', () => {
  const r = assessReadiness(
    input({ authorities: [authority(), authority({ sourceKey: 'buyer-outcomes' })] }),
  );
  assert.deepEqual(reasons(r), ['SOURCE_AUTHORITY_CONFLICT', 'SOURCE_AUTHORITY_CONFLICT']);
  assert.equal(r.outcome, 'CONFIG_ERROR');
});

test('10 · an authority naming a source that does not supply the measure is refused', () => {
  const r = assessReadiness(
    input({ metric: 'CONVERSION_RATE', authorities: [authority({ metric: 'CONVERSION_RATE' })] }),
  );
  assert.deepEqual(reasons(r), ['MEASURE_NOT_SUPPORTED_BY_SOURCE', 'MEASURE_NOT_SUPPORTED_BY_SOURCE']);
});

test('10b · an authority naming a source that does not exist is refused the same way', () => {
  const r = assessReadiness(input({ authorities: [authority({ sourceKey: 'nope' })] }));
  assert.deepEqual(reasons(r), ['MEASURE_NOT_SUPPORTED_BY_SOURCE', 'MEASURE_NOT_SUPPORTED_BY_SOURCE']);
});

// --- 11–13. A source that arrives ----------------------------------------------------------

function reportInput(outcomeDays: SourceOutcomeDayFact[]): ReadinessInput {
  return input({ authorities: [authority({ sourceKey: 'buyer-outcomes' })], outcomeDays });
}

test('11 · a report that has not arrived is PENDING, not zero', () => {
  const r = assessReadiness(reportInput([]));
  assert.deepEqual(reasons(r), ['AUTHORITATIVE_DATA_PENDING', 'AUTHORITATIVE_DATA_PENDING']);
  assert.equal(r.outcome, 'NOT_READY');
});

test('12 · a report with unmatched rows is INCOMPLETE, not a smaller total', () => {
  const r = assessReadiness(
    reportInput(
      DATES.map((d) => ({ sourceKey: 'buyer-outcomes', businessDate: d, state: 'PARTIAL' as const, version: 1 })),
    ),
  );
  assert.deepEqual(reasons(r), ['AUTHORITATIVE_DATA_INCOMPLETE', 'AUTHORITATIVE_DATA_INCOMPLETE']);
});

test('13 · a complete report measures', () => {
  const r = assessReadiness(
    reportInput(
      DATES.map((d) => ({ sourceKey: 'buyer-outcomes', businessDate: d, state: 'COMPLETE' as const, version: 1 })),
    ),
  );
  assert.equal(r.ready, true);
  assert.deepEqual(r.resolvedSourceKeys, ['buyer-outcomes']);
});

test('13b · a superseded version is not data — the correction has not been imported', () => {
  const r = assessReadiness(
    reportInput(
      DATES.map((d) => ({ sourceKey: 'buyer-outcomes', businessDate: d, state: 'SUPERSEDED' as const, version: 1 })),
    ),
  );
  assert.deepEqual(reasons(r), ['AUTHORITATIVE_DATA_PENDING', 'AUTHORITATIVE_DATA_PENDING']);
});

test('13c · a provider stream needs no availability row of its own', () => {
  // Observation and reconciliation already answered it. A third fact asserting the
  // same thing would be the parallel-system failure by construction.
  assert.equal(assessReadiness(input({ outcomeDays: [] })).ready, true);
});

// --- 14–15. Population problems -------------------------------------------------------------

test('14 · a population containing unattributed calls is refused whole', () => {
  const r = assessReadiness(input({ unattributedCalls: 3, authorities: [] }));
  assert.deepEqual(reasons(r), ['CALL_UNATTRIBUTED'], 'and nothing else is assessed');
  assert.equal(r.outcome, 'CONFIG_ERROR');
});

test('15 · two sources with different definitions of a measure may not be summed', () => {
  const second = 'camp-buyer-sourced';
  const r = assessReadiness(
    input({
      partitions: [PARTITION, { dimension: 'CAMPAIGN', memberExternalId: second, localCalls: 50 }],
      authorities: [authority(), authority({ memberExternalId: second, sourceKey: 'buyer-outcomes' })],
      reconciliation: DATES.map((d) =>
        day(d, { members: [member(), member({ memberExternalId: second })] }),
      ),
      outcomeDays: DATES.map((d) => ({
        sourceKey: 'buyer-outcomes',
        businessDate: d,
        state: 'COMPLETE' as const,
        version: 1,
      })),
    }),
  );
  assert.ok(reasons(r).includes('MIXED_SOURCE_AGGREGATION_UNSUPPORTED'));
  assert.equal(r.outcome, 'CONFIG_ERROR');
});

test('15b · two sources DECLARING the same definition may be summed — a data change, not a code change', () => {
  const second = 'camp-buyer-sourced';
  const agreeing: MeasurementSourceDefinition = {
    ...REPORT_SOURCE,
    measureDefinitionIds: { REVENUE: 'revenue.provider.v1' },
  };
  const r = assessReadiness(
    input({
      sources: [PROVIDER_SOURCE, agreeing],
      partitions: [PARTITION, { dimension: 'CAMPAIGN', memberExternalId: second, localCalls: 50 }],
      authorities: [authority(), authority({ memberExternalId: second, sourceKey: 'buyer-outcomes' })],
      reconciliation: DATES.map((d) =>
        day(d, { members: [member(), member({ memberExternalId: second })] }),
      ),
      outcomeDays: DATES.map((d) => ({
        sourceKey: 'buyer-outcomes',
        businessDate: d,
        state: 'COMPLETE' as const,
        version: 1,
      })),
    }),
  );
  assert.equal(r.ready, true);
  assert.deepEqual(r.resolvedSourceKeys, ['provider-calls', 'buyer-outcomes']);
});

// --- 16–19. Resolution, history, isolation, windows ---------------------------------------------

test('16 · one campaign measured from the provider and another from a report both resolve', () => {
  const second = 'camp-buyer-sourced';
  const r = assessReadiness(
    input({
      metric: 'CALL_VOLUME',
      authorities: [
        authority({ metric: 'CALL_VOLUME' }),
        authority({ metric: 'CALL_VOLUME', memberExternalId: second, sourceKey: 'provider-calls' }),
      ],
      partitions: [PARTITION, { dimension: 'CAMPAIGN', memberExternalId: second, localCalls: 50 }],
      reconciliation: DATES.map((d) =>
        day(d, { members: [member(), member({ memberExternalId: second })] }),
      ),
    }),
  );
  assert.equal(r.ready, true);
});

test('17 · a day resolves the authority in force on THAT day', () => {
  const rows = [
    authority({ sourceKey: 'provider-calls', effectiveFrom: '2026-01-01', effectiveTo: '2026-08-05' }),
    authority({ sourceKey: 'buyer-outcomes', effectiveFrom: '2026-08-05', effectiveTo: null }),
  ];
  const r = assessReadiness(input({ authorities: rows }));
  // 08-04 resolves the provider; 08-05 resolves the report, whose data has not
  // arrived. The boundary is exact and half-open.
  assert.ok(reasons(r).includes('AUTHORITATIVE_DATA_PENDING'));
  assert.equal(r.findings[0]?.businessDate, '2026-08-05', 'and not 08-04');
  assert.deepEqual(r.resolvedSourceKeys, ['provider-calls', 'buyer-outcomes']);

  // AND the window is refused for a second reason, which is the design working
  // rather than a duplicate complaint: authority changed INSIDE the compared
  // period, so summing the days would add one definition of the measure to a
  // different one. Mixing definitions across time is the same defect as mixing
  // them across campaigns, and it must fail the same way.
  assert.ok(reasons(r).includes('MIXED_SOURCE_AGGREGATION_UNSUPPORTED'));
});

test('18 · a campaign broken OUTSIDE the bound population does not block it', () => {
  // The reason reconciliation is explained per member. One unattached campaign
  // must not stop every objective in the organization.
  const withStranger = (d: BusinessDate) =>
    day(d, {
      state: 'UNRECONCILED',
      counts: counts({ providerUnique: 197, providerOnly: 97, providerOnlyExpected: 97 }),
      members: [
        member(),
        member({ memberExternalId: 'camp-not-bound', providerCount: 97, localCount: 0, providerOnly: 97 }),
      ],
    });
  const r = assessReadiness(input({ reconciliation: DATES.map(withStranger) }));
  assert.equal(r.ready, true, 'the bound population is intact even though the day is not');
});

test('19 · one failing date in a multi-day window withholds the whole comparison', () => {
  const r = assessReadiness(
    input({
      reconciliation: [
        day('2026-08-04'),
        day('2026-08-05', {
          state: 'UNRECONCILED',
          counts: counts({ providerUnique: 102, providerOnly: 2, providerOnlyExpected: 2 }),
          members: [member({ providerCount: 102, providerOnly: 2 })],
        }),
      ],
    }),
  );
  assert.equal(r.ready, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]?.businessDate, '2026-08-05', 'and it names which day');
});

// --- Verdict mechanics ----------------------------------------------------------------------

test('the verdict takes the most severe outcome present', () => {
  const r = assessReadiness(
    input({
      authorities: [],
      reconciliation: [day('2026-08-04'), day('2026-08-05', { state: 'INCONCLUSIVE' })],
    }),
  );
  assert.ok(reasons(r).includes('SOURCE_AUTHORITY_MISSING'), 'a CONFIG_ERROR is present');
  assert.ok(reasons(r).includes('RECONCILIATION_INCONCLUSIVE'));
  assert.equal(r.outcome, 'INCONCLUSIVE', 'evidence that impeaches itself outranks a decision');
});

test('problems accumulate so an operator fixes four things in one sitting', () => {
  const r = assessReadiness(
    input({
      authorities: [],
      reconciliation: DATES.map((d) => day(d, { members: [member({ expectation: 'UNKNOWN' })] })),
    }),
  );
  assert.equal(r.findings.length, 4, 'two dates x two problems');
});

test('the same input gives the same verdict, every time', () => {
  const built = input({ authorities: [] });
  assert.deepEqual(assessReadiness(built), assessReadiness(built));
});

test('every readiness reason is a member of the ONE withholding vocabulary', () => {
  for (const r of READINESS_WITHHOLDINGS) {
    assert.ok(MATERIALITY_WITHHOLDINGS.includes(r), `${r} is not in the closed vocabulary`);
  }
});

test('every withholding has a label and a next action', () => {
  for (const w of MATERIALITY_WITHHOLDINGS) {
    assert.ok(MATERIALITY_WITHHOLDING_LABELS[w]?.length > 0, `${w} has no label`);
    assert.ok(MATERIALITY_WITHHOLDING_NEXT_ACTIONS[w]?.length > 0, `${w} has no next action`);
  }
});

test('every readiness reason maps to exactly one outcome', () => {
  for (const r of READINESS_WITHHOLDINGS) {
    assert.ok(READINESS_OUTCOME_BY_REASON[r], `${r} has no outcome`);
    assert.notEqual(READINESS_OUTCOME_BY_REASON[r], 'READY', 'a reason is never a readiness');
  }
});

test('a not-ready verdict summarises what to go and fix, and caps the list', () => {
  const r = assessReadiness(
    input({
      authorities: [],
      reconciliation: DATES.map((d) => day(d, { members: [member({ expectation: 'UNKNOWN' })] })),
    }),
  );
  const said = describeNotReady(r, 1);
  assert.ok(said.includes('CAMPAIGN_EXPECTATION_UNKNOWN'));
  assert.ok(said.includes('and 1 more'), 'the cap states that it applied');
  assert.equal(describeNotReady(assessReadiness(input())), '', 'a ready measure has nothing to say');
});

// --- The contract stays generic ------------------------------------------------------------------

test('no line of business is named anywhere in the new contracts', () => {
  // A program measured from a counterparty's report is DATA -- an authority row
  // naming an external id and a source key. The day one of them reaches this
  // layer as a branch, the model has stopped being configurable.
  const files = [
    'member-expectation.ts',
    'provider-reconciliation.ts',
    'measurement-source.ts',
    'measurement-readiness.ts',
  ];
  const forbidden = /\bSSDI\b|\b1696\b|retainer|spanish|home security|final expense/i;
  for (const f of files) {
    const source = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.equal(forbidden.test(source), false, `${f} names a specific line of business`);
  }
});

test('the contracts reach for no clock, no environment and no network', () => {
  const files = [
    'member-expectation.ts',
    'provider-reconciliation.ts',
    'measurement-source.ts',
    'measurement-readiness.ts',
  ];
  const impure = /Date\.now|new Date\(|process\.env|fetch\(|Math\.random|prisma\./;
  for (const f of files) {
    const source = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.equal(impure.test(source), false, `${f} is not pure`);
  }
});
