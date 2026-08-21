// The reconciliation runner — behaviour, and what it is structurally unable to do.
//
// TWO KINDS OF TEST LIVE HERE, DELIBERATELY.
//
// The behavioural ones drive `runSweep` through injected seams: what it does with
// a day that reconciles, one that does not, one whose comparison contradicted
// itself, an organization that does not exist, and a date it cannot parse.
//
// The source-constraint ones read this runner's own source and fail if it ever
// names ingestion, projection, recovery, measurement, certification, declaration
// or a Prisma delegate. They are the guard that makes accidental scope expansion
// visible at review time rather than in production — a comment saying "read-only"
// is not a property, and this is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECONCILIATION_STATES,
  reconciliationCertifies,
  type BusinessDate,
  type ReconciliationState,
} from '@emgloop/shared';
import type { ReconciliationDayView } from '@emgloop/database';

import {
  DEFAULT_SWEEP_MODE,
  REFUSED_ORGANIZATION_STATUSES,
  isSweepMode,
  parseArgs,
  parseDates,
  readEnvironment,
  runSweep,
  type DayReconciler,
  type OrganizationLookup,
  type SweepDeps,
} from './reconcile-provider-days';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'reconcile-provider-days.ts'),
  'utf8',
);

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };

function dayView(over: Partial<ReconciliationDayView> = {}): ReconciliationDayView {
  return {
    businessDate: '2026-08-05',
    timezone: 'America/New_York',
    state: 'RECONCILED',
    ruleVersion: 'provider-reconciliation.v1',
    localStage: 'integration_event',
    counts: {
      providerUnique: 10,
      providerDuplicateIds: 0,
      localUnique: 10,
      localDuplicateIds: 0,
      intersection: 10,
      providerOnly: 0,
      localOnly: 0,
      providerOnlyExpected: 0,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 10,
      providerUnattributed: 0,
      localRowsScanned: 10,
      localInWindow: 10,
      localUnresolvedOccurrence: 0,
      localMissingIdentity: 0,
      pagesFetched: 1,
      pageCap: 100,
      truncated: false,
    },
    reason: null,
    observedAt: '2026-08-19T12:00:00.000Z',
    reconciledAt: '2026-08-19T12:00:00.000Z',
    members: [],
    ...over,
  };
}

interface Recorder {
  lines: string[];
  asked: BusinessDate[];
  deps: SweepDeps;
}

function recorder(
  answer: (date: BusinessDate) => Awaited<ReturnType<DayReconciler['reconcileDay']>>,
  organization: { id: string; slug: string; name: string; status: string } | null = ORG,
): Recorder {
  const lines: string[] = [];
  const asked: BusinessDate[] = [];
  let tick = 0;
  const organizations: OrganizationLookup = {
    async findBySlug() {
      return organization;
    },
  };
  const reconciler: DayReconciler = {
    async reconcileDay(input) {
      asked.push(input.businessDate);
      return answer(input.businessDate);
    },
  };
  return {
    lines,
    asked,
    deps: {
      reconciler,
      organizations,
      log: (l) => lines.push(l),
      now: () => new Date(Date.UTC(2026, 7, 19, 12, 0, ++tick)),
    },
  };
}

const request = (dates: BusinessDate[]) => ({
  organizationSlug: ORG.slug,
  dates,
  apiKey: 'test-key',
});

// --- Behaviour ----------------------------------------------------------------

test('a reconciled day is a green run', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'SUCCESS');
  assert.deepEqual(result.reconciled, ['2026-08-05']);
  assert.equal(result.failedDate, null);
});

test('a day that did not reconcile stops the sweep and leaves later dates untouched', async () => {
  const r = recorder((date) =>
    date === '2026-08-05'
      ? { ok: true as const, day: dayView({ state: 'UNRECONCILED', businessDate: date }) }
      : { ok: true as const, day: dayView({ businessDate: date }) },
  );
  const result = await runSweep(request(['2026-08-05', '2026-08-06', '2026-08-07']), r.deps);
  assert.equal(result.overall, 'STOPPED_NOT_RECONCILED');
  assert.equal(result.failedDate, '2026-08-05');
  // The later dates were never asked about. A sweep that carried on would leave
  // a table full of rows and a false sense the window was worked through.
  assert.deepEqual(r.asked, ['2026-08-05']);
});

test('a recorded non-reconciliation is a successful WRITE and NOT a reconciled day', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView({ state: 'UNKNOWN_EXPECTATION' }) }));
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'STOPPED_NOT_RECONCILED');
  const day = r.lines.find((l) => l.startsWith('event=DAY_RESULT'));
  assert.match(String(day), /written=true/);
  assert.match(String(day), /reconciled=false/);
});

test('a comparison that contradicted itself is a DIFFERENT failure, and nothing was written', async () => {
  const r = recorder(() => ({
    ok: false as const,
    reason: 'DIAGNOSTIC_DEFECT',
    problems: ['intersection + providerOnly !== providerUnique'],
  }));
  const result = await runSweep(request(['2026-08-05', '2026-08-06']), r.deps);
  assert.equal(result.overall, 'DIAGNOSTIC_DEFECT');
  assert.deepEqual(r.asked, ['2026-08-05']);
  const day = r.lines.find((l) => l.startsWith('event=DAY_RESULT'));
  assert.match(String(day), /written=false/);
  assert.match(String(day), /state=REFUSED/);
});

test('every reconciliation state is judged by reconciliationCertifies, not by a local list', async () => {
  // A fifth state added later is handled correctly on the day it is added,
  // because this runner asks the shared predicate rather than naming states.
  for (const state of RECONCILIATION_STATES) {
    const r = recorder(() => ({ ok: true as const, day: dayView({ state }) }));
    const result = await runSweep(request(['2026-08-05']), r.deps);
    assert.equal(
      result.overall === 'SUCCESS',
      reconciliationCertifies(state),
      `${state} must stop the sweep exactly when it does not certify`,
    );
  }
});

test('dates are reconciled sequentially, in the order supplied', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  await runSweep(request(['2026-08-05', '2026-08-06', '2026-08-07']), r.deps);
  assert.deepEqual(r.asked, ['2026-08-05', '2026-08-06', '2026-08-07']);
});

test('an unknown organization is a precondition failure, and nothing is reconciled', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }), null);
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.deepEqual(r.asked, []);
  assert.match(String(result.error), /No organization with slug/);
});

test('a suspended or cancelled organization is refused before any provider request', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const r = recorder(() => ({ ok: true as const, day: dayView() }), { ...ORG, status });
    const result = await runSweep(request(['2026-08-05']), r.deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.deepEqual(r.asked, []);
  }
});

test('an ordinary non-ACTIVE status is accepted — TRIAL is not a reason to refuse', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }), { ...ORG, status: 'TRIAL' });
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'SUCCESS');
});

test('no dates supplied is a precondition failure', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  const result = await runSweep(request([]), r.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.deepEqual(r.asked, []);
});

test('member lines carry the member id and its expectation, and never a call identity', async () => {
  const r = recorder(() => ({
    ok: true as const,
    day: dayView({
      members: [
        {
          dimension: 'CAMPAIGN',
          memberExternalId: 'cmp-1',
          providerCount: 10,
          providerOnly: 0,
          localCount: 10,
          localOnly: 0,
          expectationState: 'EXPECTED',
          expectationId: 'decl_1',
          expectationMatches: 1,
          labelAtObservation: 'A label',
        },
      ],
    }),
  }));
  await runSweep(request(['2026-08-05']), r.deps);
  const member = r.lines.find((l) => l.startsWith('event=MEMBER_RESULT'));
  assert.match(String(member), /member=cmp-1/);
  assert.match(String(member), /expectation=EXPECTED/);
});

test('rerunning the same date asks again rather than skipping it', async () => {
  // Idempotency belongs to the day upsert, not to this runner. Skipping a date
  // because a row exists would make re-reconciling after a fix impossible, which
  // is exactly the operation an operator needs.
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  await runSweep(request(['2026-08-05']), r.deps);
  await runSweep(request(['2026-08-05']), r.deps);
  assert.deepEqual(r.asked, ['2026-08-05', '2026-08-05']);
});

// --- Input handling -----------------------------------------------------------

test('dates are parsed with the same predicate the service applies', () => {
  assert.deepEqual(parseDates('2026-08-05').dates, ['2026-08-05']);
  assert.deepEqual(parseDates(' 2026-08-05 , 2026-08-06 ').dates, ['2026-08-05', '2026-08-06']);
  assert.deepEqual(parseDates('2026-08-05,,').dates, ['2026-08-05']);
  // Rejected, never coerced: guessing at a date would point a production write at
  // a day nobody asked for.
  assert.deepEqual(parseDates('05/08/2026').invalid, ['05/08/2026']);
  assert.deepEqual(parseDates('2026-8-5').invalid, ['2026-8-5']);
  assert.deepEqual(parseDates('yesterday').invalid, ['yesterday']);
});

test('missing credentials are reported BY NAME, never by value', () => {
  const missing = readEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.missing.sort(), ['CALLGRID_API_KEY', 'DATABASE_URL']);
  const present = readEnvironment({
    DATABASE_URL: 'postgres://x',
    CALLGRID_API_KEY: 'secret',
  } as NodeJS.ProcessEnv);
  assert.equal(present.ok, true);
});

test('flags parse in either spelling, and no mode means no mode', () => {
  assert.deepEqual(parseArgs(['--organization', 'a', '--dates', '2026-08-05']), {
    organization: 'a',
    dates: '2026-08-05',
    mode: null,
  });
  assert.deepEqual(parseArgs(['--org', 'a', '--date', '2026-08-05']), {
    organization: 'a',
    dates: '2026-08-05',
    mode: null,
  });
});

test('the mode is parsed raw and never coerced', () => {
  // `null` is "not supplied", which resolves to GATE. A MISSPELLING is not
  // absence and must not resolve to anything -- `main` refuses it. Returning a
  // coerced 'GATE' here would make the two indistinguishable.
  assert.equal(parseArgs(['--evidence']).mode, 'EVIDENCE');
  assert.equal(parseArgs(['--mode', 'evidence']).mode, 'EVIDENCE');
  assert.equal(parseArgs(['--mode', 'GATE']).mode, 'GATE');
  assert.equal(parseArgs(['--mode', 'sweep']).mode, 'SWEEP');
  assert.equal(isSweepMode('SWEEP'), false);
  assert.equal(isSweepMode('EVIDENCE'), true);
  assert.equal(isSweepMode('GATE'), true);
  assert.equal(DEFAULT_SWEEP_MODE, 'GATE');
});

// --- Evidence mode ---------------------------------------------------------------
//
// The one branch that differs is what happens after a day whose row was WRITTEN.
// Everything below either proves that branch, or proves that nothing else moved.

/** The three states a written day can carry that are not RECONCILED. */
const FINDING_STATES = ['UNRECONCILED', 'UNKNOWN_EXPECTATION', 'INCONCLUSIVE'] as const;

const evidence = (dates: BusinessDate[]) => ({ ...request(dates), mode: 'EVIDENCE' as const });

test('GATE is what a request without a mode gets', async () => {
  const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d, state: 'UNRECONCILED' }) }));
  const result = await runSweep(request(['2026-08-06', '2026-08-07']), r.deps);
  assert.equal(result.mode, 'GATE');
  assert.equal(result.overall, 'STOPPED_NOT_RECONCILED');
  assert.deepEqual(r.asked, ['2026-08-06'], 'the second date was never asked');
});

test('GATE still stops on every finding state, token for token', async () => {
  for (const state of FINDING_STATES) {
    const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d, state }) }));
    const result = await runSweep(request(['2026-08-06', '2026-08-07']), r.deps);
    assert.equal(result.overall, 'STOPPED_NOT_RECONCILED', `${state} must still stop a gate run`);
    assert.equal(result.failedDate, '2026-08-06');
    assert.deepEqual(r.asked, ['2026-08-06']);
  }
});

for (const state of FINDING_STATES) {
  test(`EVIDENCE continues through ${state} and reaches every requested date`, async () => {
    const dates: BusinessDate[] = ['2026-08-06', '2026-08-07', '2026-08-08'];
    const r = recorder((d) => ({
      ok: true,
      day: dayView({ businessDate: d, state: d === '2026-08-07' ? 'RECONCILED' : state }),
    }));
    const result = await runSweep(evidence(dates), r.deps);
    assert.deepEqual(r.asked, dates, 'no date was skipped');
    assert.equal(result.mode, 'EVIDENCE');
    assert.equal(result.overall, 'COMPLETE_WITH_FINDINGS');
    assert.deepEqual(result.reconciled, ['2026-08-07']);
    assert.equal(result.failedDate, null, 'a finding is not a failure');
  });
}

test('every processed date lands in exactly one bucket, and the buckets partition the request', async () => {
  const dates: BusinessDate[] = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const states: Record<string, ReconciliationState> = {
    '2026-08-06': 'UNKNOWN_EXPECTATION',
    '2026-08-07': 'RECONCILED',
    '2026-08-08': 'INCONCLUSIVE',
    '2026-08-09': 'UNRECONCILED',
  };
  const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d, state: states[d] }) }));
  const result = await runSweep(evidence(dates), r.deps);

  assert.deepEqual(result.reconciled, ['2026-08-07']);
  assert.deepEqual(result.unknownExpectation, ['2026-08-06']);
  assert.deepEqual(result.inconclusive, ['2026-08-08']);
  assert.deepEqual(result.unreconciled, ['2026-08-09']);

  const all = [
    ...result.reconciled,
    ...result.unreconciled,
    ...result.unknownExpectation,
    ...result.inconclusive,
  ];
  assert.equal(all.length, dates.length, 'no date was counted twice or dropped');
  assert.equal(new Set(all).size, dates.length);
  for (const d of dates) assert.ok(all.includes(d), `${d} must be bucketed`);
});

test('all reconciled is SUCCESS, in either mode', async () => {
  for (const req of [request(['2026-08-06', '2026-08-07']), evidence(['2026-08-06', '2026-08-07'])]) {
    const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d }) }));
    const result = await runSweep(req, r.deps);
    assert.equal(result.overall, 'SUCCESS');
    assert.equal(result.reconciled.length, 2);
    assert.equal(result.unreconciled.length + result.unknownExpectation.length + result.inconclusive.length, 0);
  }
});

test('one finding among many is never SUCCESS', async () => {
  const dates: BusinessDate[] = ['2026-08-06', '2026-08-07', '2026-08-08'];
  const r = recorder((d) => ({
    ok: true,
    day: dayView({ businessDate: d, state: d === '2026-08-08' ? 'UNRECONCILED' : 'RECONCILED' }),
  }));
  const result = await runSweep(evidence(dates), r.deps);
  assert.equal(result.overall, 'COMPLETE_WITH_FINDINGS');
  assert.notEqual(result.overall, 'SUCCESS');
  assert.equal(result.reconciled.length, 2);
});

test('EVIDENCE still stops when the comparison contradicted itself and nothing was written', async () => {
  const r = recorder((d) =>
    d === '2026-08-07'
      ? { ok: false, reason: 'DIAGNOSTIC_DEFECT', problems: ['intersection + providerOnly !== providerUnique'] }
      : { ok: true, day: dayView({ businessDate: d }) },
  );
  const result = await runSweep(evidence(['2026-08-06', '2026-08-07', '2026-08-08']), r.deps);
  assert.equal(result.overall, 'DIAGNOSTIC_DEFECT');
  assert.equal(result.failedDate, '2026-08-07');
  assert.deepEqual(r.asked, ['2026-08-06', '2026-08-07'], 'the run stopped; 08-08 was never asked');
});

test('EVIDENCE aborts when the provider read or the write throws — nothing is swallowed', async () => {
  const r = recorder((d) => {
    if (d === '2026-08-07') throw new Error('provider read failed');
    return { ok: true, day: dayView({ businessDate: d }) };
  });
  await assert.rejects(
    () => runSweep(evidence(['2026-08-06', '2026-08-07', '2026-08-08']), r.deps),
    /provider read failed/,
  );
  assert.deepEqual(r.asked, ['2026-08-06', '2026-08-07'], '08-08 was never attempted');
});

test('EVIDENCE stops on a stored state this build cannot read', async () => {
  // `toDayView` returns null when the stored vocabulary is unrecognisable. It is
  // not a finding of a known kind, so it may be neither bucketed nor dropped.
  const r = recorder((d) => ({
    ok: true,
    day: dayView({ businessDate: d, state: d === '2026-08-07' ? null : 'RECONCILED' }),
  }));
  const result = await runSweep(evidence(['2026-08-06', '2026-08-07', '2026-08-08']), r.deps);
  assert.equal(result.overall, 'STOPPED_UNREADABLE_STATE');
  assert.equal(result.failedDate, '2026-08-07');
  assert.deepEqual(r.asked, ['2026-08-06', '2026-08-07']);
  assert.deepEqual(result.reconciled, ['2026-08-06']);
});

test('the summary emits every required token, naming dates rather than counting them', async () => {
  const dates: BusinessDate[] = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const states: Record<string, ReconciliationState> = {
    '2026-08-06': 'UNKNOWN_EXPECTATION',
    '2026-08-07': 'RECONCILED',
    '2026-08-08': 'INCONCLUSIVE',
    '2026-08-09': 'UNRECONCILED',
  };
  const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d, state: states[d] }) }));
  await runSweep(evidence(dates), r.deps);
  const summary = r.lines.find((l) => l.includes('event=SWEEP_COMPLETE')) ?? '';
  for (const token of [
    'RECONCILED_DATES=2026-08-07',
    'UNRECONCILED_DATES=2026-08-09',
    'UNKNOWN_EXPECTATION_DATES=2026-08-06',
    'INCONCLUSIVE_DATES=2026-08-08',
    'FAILED_DATE=',
    'OVERALL_RESULT=COMPLETE_WITH_FINDINGS',
  ]) {
    assert.ok(summary.includes(token), `the summary must carry ${token}`);
  }
  assert.ok(summary.includes('mode=EVIDENCE'));
});

test('the sweep announces which mode it is running before it touches a provider', async () => {
  const r = recorder((d) => ({ ok: true, day: dayView({ businessDate: d }) }));
  await runSweep(evidence(['2026-08-06']), r.deps);
  const start = r.lines.find((l) => l.includes('event=SWEEP_START')) ?? '';
  assert.ok(start.includes('mode=EVIDENCE'));
  assert.ok(r.lines.indexOf(start) < r.lines.findIndex((l) => l.includes('event=DAY_RESULT')));
});

test('bucket order follows the order supplied, and a re-run gives the same answer', async () => {
  const dates: BusinessDate[] = ['2026-08-09', '2026-08-06', '2026-08-08', '2026-08-07'];
  const answer = (d: BusinessDate) => ({
    ok: true as const,
    day: dayView({ businessDate: d, state: 'UNRECONCILED' as ReconciliationState }),
  });
  const first = await runSweep(evidence(dates), recorder(answer).deps);
  const second = await runSweep(evidence(dates), recorder(answer).deps);
  assert.deepEqual(first.unreconciled, dates, 'supplied order, not sorted');
  assert.deepEqual(first.unreconciled, second.unreconciled);
  assert.equal(first.overall, second.overall);
});

test('THE AUGUST 6 SHAPE: 91 provider-only across four members, one of them EXPECTED', async () => {
  // The first production reconciliation of the Stage 3 window, pinned. The day
  // is UNKNOWN_EXPECTATION because three members carrying absences have no
  // declaration -- which MASKS, at the day level, the four calls a campaign
  // declared EXPECTED never delivered. `deriveReconciliationState` tests unknown
  // expectation before providerOnlyExpected, so resolving those three
  // declarations would move this day to UNRECONCILED and not to RECONCILED.
  //
  // A gate run stops here and reports one date. An evidence run records it and
  // carries on, which is the whole reason this mode exists.
  const augustSix = dayView({
    businessDate: '2026-08-06',
    state: 'UNKNOWN_EXPECTATION',
    counts: {
      providerUnique: 1220,
      providerDuplicateIds: 0,
      localUnique: 1129,
      localDuplicateIds: 0,
      intersection: 1129,
      providerOnly: 91,
      localOnly: 0,
      providerOnlyExpected: 4,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 87,
    },
  });
  // The three set equations the database enforces, checked on the fixture so a
  // typo here cannot pin a shape production could never produce.
  const c = augustSix.counts;
  assert.equal(c.intersection + c.providerOnly, c.providerUnique);
  assert.equal(c.intersection + c.localOnly, c.localUnique);
  assert.equal(
    c.providerOnlyExpected + c.providerOnlyNotConfigured + c.providerOnlyExcluded + c.providerOnlyUnknownMember,
    c.providerOnly,
  );

  const dates: BusinessDate[] = ['2026-08-06', '2026-08-07'];
  const answer = (d: BusinessDate) =>
    d === '2026-08-06'
      ? { ok: true as const, day: augustSix }
      : { ok: true as const, day: dayView({ businessDate: d }) };

  const gate = recorder(answer);
  const gateResult = await runSweep(request(dates), gate.deps);
  assert.equal(gateResult.overall, 'STOPPED_NOT_RECONCILED');
  assert.deepEqual(gate.asked, ['2026-08-06'], 'the gate stops, as it did in production');

  const sweep = recorder(answer);
  const sweepResult = await runSweep(evidence(dates), sweep.deps);
  assert.deepEqual(sweep.asked, dates);
  assert.deepEqual(sweepResult.unknownExpectation, ['2026-08-06']);
  assert.deepEqual(sweepResult.reconciled, ['2026-08-07']);
  assert.equal(sweepResult.overall, 'COMPLETE_WITH_FINDINGS');
});

test('evidence mode changes no verdict — the same day yields the same state either way', async () => {
  for (const state of FINDING_STATES) {
    const answer = (d: BusinessDate) => ({ ok: true as const, day: dayView({ businessDate: d, state }) });
    const gate = await runSweep(request(['2026-08-06']), recorder(answer).deps);
    const sweep = await runSweep(evidence(['2026-08-06']), recorder(answer).deps);
    assert.equal(gate.outcomes[0]!.state, state);
    assert.equal(sweep.outcomes[0]!.state, state);
    assert.equal(gate.outcomes[0]!.reconciled, false);
    assert.equal(sweep.outcomes[0]!.reconciled, false);
  }
});

test('the runner still decides nothing about which findings matter', () => {
  // The bucket map is keyed on the shipped vocabulary and carries no judgement:
  // no severity, no threshold, no "ignore this one". A mode that skipped some
  // findings would be this file overruling the pure state rule.
  assert.ok(!/severity|ignorable|tolerate|acceptable/i.test(RUNNER_SOURCE));
  assert.ok(RUNNER_SOURCE.includes('reconciliationCertifies'), 'the certifying test is still asked');
  assert.ok(!/reconciled\s*=\s*true/.test(RUNNER_SOURCE), 'nothing is declared reconciled locally');
});


// --- Source constraints -------------------------------------------------------

test('the runner references no ingestion, projection, recovery or measurement machinery', () => {
  // A static assertion, deliberately: adding any of these to that file breaks
  // this suite, which is the point. "It observes and records" becomes a checked
  // property rather than a claim in a header.
  const forbidden = [
    'IngestionService',
    'NormalizationEngine',
    'MarketplaceCall',
    'projectInteraction',
    'projectWindow',
    'CallGridReconciliationService',
    'HeadlineDetectionService',
    'CommercialSignal',
    'ObjectiveMeasureBinding',
    'OperationalPriority',
    'ensureLiveOrganization',
    'createUser',
    'interaction.',
  ];
  for (const symbol of forbidden) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner cannot certify a day or declare an expectation', () => {
  // Reconciliation observes. Certification is a different fact with a different
  // write, and expectation is a HUMAN statement that no automated run may make.
  for (const symbol of [
    'certifyDay',
    'ProviderObservationService',
    'ProviderObservationRepository',
    'recordDay',
    'declare(',
    'ProviderMemberExpectationRepository',
    'DeclareExpectationInput',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reach ${symbol}`);
  }
});

test('the runner has exactly one production write path, and it is reconcileDay', () => {
  // `prisma.$disconnect()` is deliberately allowed and deliberately not matched
  // — closing the connection this script opened is hygiene, not data access —
  // so the pattern targets `prisma.<model>` rather than the client itself.
  assert.equal(
    /prisma\.[a-z]/.test(RUNNER_SOURCE),
    false,
    'the runner must not reach a Prisma model delegate',
  );
  for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '.deleteMany(', '$executeRaw', '$queryRaw']) {
    assert.ok(!RUNNER_SOURCE.includes(verb), `the runner must not call ${verb} directly`);
  }
  assert.ok(RUNNER_SOURCE.includes('reconcileDay('), 'reconciliation is invoked, not reimplemented');
});

test('the runner computes no window, pagination, occurrence or verdict of its own', () => {
  for (const symbol of [
    'easternBusinessDayWindow',   // the day boundary belongs to the service
    'resolveCallOccurrence',      // occurrence belongs to the canonical resolver
    'getCallGridProvider',        // the provider read belongs to the adapter
    'fetchAllCallGridCalls',
    'maxPages',
    'listEventsForOccurrenceWindow',  // the local read belongs to the service's seam
    'normalizeExternalIdentity',  // identity normalisation belongs to shared
    'deriveReconciliationState',  // the verdict belongs to the pure contract
    'assessReconciliation',
    'countProblems',
    'windowStart',
    'campaignId',                 // member attribution belongs to the service
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not touch ${symbol}`);
  }
});

test('the runner never emits a raw call identity', () => {
  // Member ids and expectation states are the organization's own configuration
  // and are safe to print. A CALL identity is not, and there is no code path
  // here that reaches one: the day view exposes counts and member facts only.
  for (const symbol of ['externalId', 'identity=', 'providerOnlyIds', 'hashIdentity', 'idHashes']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not print ${symbol}`);
  }
  // And nothing PII-shaped can reach it either, since it never reads a payload.
  for (const symbol of ['payload', 'caller', 'fromNumber', 'recordingUrl', 'transcript']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner has no schedule of its own and no parallelism', () => {
  // A parallel sweep cannot stop at the first day that fails, because by then it
  // has already worked through the others.
  assert.equal(RUNNER_SOURCE.includes('Promise.all'), false);
  assert.equal(RUNNER_SOURCE.includes('Promise.allSettled'), false);
  assert.equal(RUNNER_SOURCE.includes('setInterval'), false);
});

// --- The workflow that invokes it ---------------------------------------------
//
// A runner with no way to be started is a runner that does not exist -- the
// defect PR #163 found in `certifyDay`, which shipped with no caller at all.
// These assert the trigger exists AND that it is the only kind of trigger there.

const WORKFLOW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'reconcile-provider-days.yml'),
  'utf8',
);

test('the workflow exists and invokes this runner', () => {
  assert.match(WORKFLOW_SOURCE, /npm run reconcile:provider-days/);
  assert.match(WORKFLOW_SOURCE, /--organization/);
  assert.match(WORKFLOW_SOURCE, /--dates/);
});

test('the workflow is human-started only — no schedule, no push, no pull_request', () => {
  assert.match(WORKFLOW_SOURCE, /workflow_dispatch:/);
  // A `cron:` here would automate an operation nobody has yet run once by hand.
  assert.equal(/^\s{0,4}schedule:/m.test(WORKFLOW_SOURCE), false, 'no schedule trigger');
  assert.equal(/^\s{0,4}push:/m.test(WORKFLOW_SOURCE), false, 'no push trigger');
  assert.equal(/^\s{0,4}pull_request:/m.test(WORKFLOW_SOURCE), false, 'no pull_request trigger');
  assert.equal(WORKFLOW_SOURCE.includes('cron:'), false, 'no cron');
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const safety = WORKFLOW_SOURCE.indexOf('npm run test:operations');
  const production = WORKFLOW_SOURCE.indexOf('npm run reconcile:provider-days');
  assert.ok(safety > 0, 'the safety suite runs');
  assert.ok(production > 0, 'the reconciliation runs');
  assert.ok(
    safety < production,
    'the constraint tests must run before the production credential is used, or they prove nothing about this run',
  );
});

test('the workflow requires both production secrets and names them without printing values', () => {
  assert.match(WORKFLOW_SOURCE, /DIRECT_DATABASE_URL/);
  assert.match(WORKFLOW_SOURCE, /CALLGRID_API_KEY/);
  assert.match(WORKFLOW_SOURCE, /Missing repository secret/);
  // The secret VALUES must only ever reach `env:`, never an `echo`.
  assert.equal(/echo[^\n]*\$\{\{\s*secrets\./.test(WORKFLOW_SOURCE), false);
});

test('the workflow offers both modes and defaults to the stopping one', () => {
  assert.ok(/mode:[\s\S]{0,400}default:\s*gate/.test(WORKFLOW_SOURCE));
  assert.ok(/options:[\s\S]{0,80}- gate[\s\S]{0,40}- evidence/.test(WORKFLOW_SOURCE));
  // The default must be the RESTRICTIVE one. A workflow defaulting to evidence
  // would turn every ordinary dispatch into a sweep without anybody choosing it.
  assert.ok(!/mode:[\s\S]{0,400}default:\s*evidence/.test(WORKFLOW_SOURCE));
});

test('the workflow passes the mode as a value, never interpolated into the script', () => {
  assert.ok(WORKFLOW_SOURCE.includes('MODE: ${{ inputs.mode }}'));
  assert.ok(WORKFLOW_SOURCE.includes('--mode "${MODE}"'));
  // A `${{ }}` expansion inside `run:` is pasted as literal shell text, which is
  // how an input becomes a command.
  const runBodies = WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1);
  for (const body of runBodies) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input may be interpolated into a run body');
  }
});

test('the workflow still cannot reach any other operation', () => {
  for (const other of [
    'certify:observation-days',
    'declare:member-expectations',
    'declare:source-authority',
    'register:measurement-source',
    'bootstrap:stage3',
    'migrate deploy',
  ]) {
    assert.ok(!WORKFLOW_SOURCE.includes(other), `the workflow must not invoke ${other}`);
  }
});

test('the workflow serialises runs against itself', () => {
  assert.match(WORKFLOW_SOURCE, /concurrency:/);
  assert.match(WORKFLOW_SOURCE, /cancel-in-progress:\s*false/);
});
