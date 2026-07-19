// CallGrid reconciliation harness — contract tests.
//
// These prove the HARNESS is trustworthy. They do not prove Loop's production
// data is correct; only a run against real CallGrid records can do that. The
// distinction matters and is stated in the sprint report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile,
  formatReconcileReport,
  BUSINESS_DEFINITIONS,
  type CallGridSourceCall,
  type LoopCall,
} from '../src/services/callgrid-reconciliation.harness';

const SINCE = new Date('2026-07-01T00:00:00.000Z');
const UNTIL = new Date('2026-07-08T00:00:00.000Z');
const opts = { since: SINCE, until: UNTIL, sourceMoneyUnit: 'dollars' as const };

const srcCall = (o: Partial<CallGridSourceCall> & { call_id: string }): CallGridSourceCall => ({
  started_at: '2026-07-02T10:00:00.000Z',
  duration_seconds: 120,
  revenue: 25.5,
  payout: 10,
  buyer: 'Acme',
  qualified: true,
  ...o,
});

const loopCall = (o: Partial<LoopCall> & { externalId: string }): LoopCall => ({
  sourceOccurredAt: new Date('2026-07-02T10:00:00.000Z'),
  durationSeconds: 120,
  revenueCents: 2550,
  payoutCents: 1000,
  costCents: null,
  buyerLabel: 'Acme',
  campaignLabel: null,
  sourceLabel: null,
  qualified: true,
  converted: null,
  duplicate: null,
  ...o,
});

test('exact match reconciles clean', () => {
  const r = reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts);
  assert.equal(r.passed, true, r.summary);
  assert.equal(r.missingInLoop.length, 0);
  assert.equal(r.extraInLoop.length, 0);
  assert.equal(r.fieldMismatches.length, 0);
});

test('dollars are converted to cents without a 100x error', () => {
  const r = reconcile([srcCall({ call_id: 'a', revenue: 25.5 })], [loopCall({ externalId: 'a', revenueCents: 2550 })], opts);
  assert.equal(r.aggregates.find((c) => c.metric === 'Revenue')?.status, 'pass');
  // And the inverse is caught: storing dollars where cents were expected.
  const bad = reconcile([srcCall({ call_id: 'a', revenue: 25.5 })], [loopCall({ externalId: 'a', revenueCents: 25 })], opts);
  assert.equal(bad.passed, false);
});

test('a cents-denominated source is not double-converted', () => {
  const r = reconcile(
    [srcCall({ call_id: 'a', revenue: 2550, payout: 1000 })],
    [loopCall({ externalId: 'a' })],
    { ...opts, sourceMoneyUnit: 'cents' },
  );
  assert.equal(r.aggregates.find((c) => c.metric === 'Revenue')?.status, 'pass');
});

test('a record missing from Loop is reported as missed ingestion', () => {
  const r = reconcile([srcCall({ call_id: 'a' }), srcCall({ call_id: 'b' })], [loopCall({ externalId: 'a' })], opts);
  assert.equal(r.passed, false);
  assert.deepEqual(r.missingInLoop, ['b']);
  assert.equal(r.extraInLoop.length, 0, 'a missed record must not also report as extra');
});

test('an extra Loop record is reported separately from a missing one', () => {
  const r = reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' }), loopCall({ externalId: 'ghost' })], opts);
  assert.equal(r.passed, false);
  assert.deepEqual(r.extraInLoop, ['ghost']);
  assert.equal(r.missingInLoop.length, 0);
});

test('a whole-hour timestamp delta is called out as a timezone signature', () => {
  const r = reconcile(
    [srcCall({ call_id: 'a', started_at: '2026-07-02T10:00:00.000Z' })],
    [loopCall({ externalId: 'a', sourceOccurredAt: new Date('2026-07-02T15:00:00.000Z') })],
    opts,
  );
  const m = r.fieldMismatches.find((x) => x.metric.startsWith('timestamp'));
  assert.ok(m, 'a timestamp mismatch must be reported');
  assert.match(m!.reason ?? '', /timezone/i);
});

test('rounding-only money differences pass within tolerance, real ones do not', () => {
  const within = reconcile([srcCall({ call_id: 'a', revenue: 10.005 })], [loopCall({ externalId: 'a', revenueCents: 1001 })], opts);
  assert.equal(within.aggregates.find((c) => c.metric === 'Revenue')?.status, 'pass');
  const beyond = reconcile([srcCall({ call_id: 'a', revenue: 10 })], [loopCall({ externalId: 'a', revenueCents: 1100 })], opts);
  assert.equal(beyond.aggregates.find((c) => c.metric === 'Revenue')?.status, 'fail');
});

test('a value the source never supplied is UNVERIFIABLE, never a pass', () => {
  // The documented CallGrid webhook carries no economics at all. Reporting that
  // as agreement would be the single most misleading thing this harness could do.
  const r = reconcile(
    [srcCall({ call_id: 'a', revenue: null, payout: null })],
    [loopCall({ externalId: 'a', revenueCents: 9999, payoutCents: 1 })],
    opts,
  );
  const rev = r.aggregates.find((c) => c.metric === 'Revenue');
  assert.equal(rev?.status, 'unverifiable');
  assert.notEqual(rev?.status, 'pass');
  assert.match(rev?.reason ?? '', /did not supply/i);
});

test('records outside the half-open window are excluded from both sides', () => {
  const r = reconcile(
    [
      srcCall({ call_id: 'before', started_at: '2026-06-30T23:59:59.999Z' }),
      srcCall({ call_id: 'edge-start', started_at: '2026-07-01T00:00:00.000Z' }),
      srcCall({ call_id: 'edge-end', started_at: '2026-07-08T00:00:00.000Z' }),
    ],
    [loopCall({ externalId: 'edge-start', sourceOccurredAt: new Date('2026-07-01T00:00:00.000Z') })],
    opts,
  );
  // since is inclusive, until is exclusive — matching every Loop query.
  assert.equal(r.sourceRecords, 1, 'only edge-start falls inside [since, until)');
  assert.equal(r.passed, true, r.summary);
});

test('field mismatches name the affected record so it can be investigated', () => {
  const r = reconcile(
    [srcCall({ call_id: 'a', duration_seconds: 120 })],
    [loopCall({ externalId: 'a', durationSeconds: 2 })],
    opts,
  );
  const m = r.fieldMismatches.find((x) => x.metric.startsWith('duration'));
  assert.ok(m, 'duration mismatch must be reported — 120s vs 2 is a seconds/minutes bug');
  assert.deepEqual(m!.affected, ['a']);
});

test('aggregate counts of outcome flags are compared', () => {
  // Converted IS a direct CallGrid field, so a count gap is a genuine failure.
  const r = reconcile(
    [srcCall({ call_id: 'a', converted: true }), srcCall({ call_id: 'b', converted: false })],
    [loopCall({ externalId: 'a', converted: true }), loopCall({ externalId: 'b', converted: true })],
    opts,
  );
  assert.equal(r.aggregates.find((c) => c.metric === 'Converted calls')?.status, 'fail');

  // Qualified is NOT — it is a Loop derivation, so the same gap is not a failure.
  const q = reconcile(
    [srcCall({ call_id: 'a', qualified: null })],
    [loopCall({ externalId: 'a', qualified: true })],
    opts,
  );
  assert.equal(q.aggregates.find((c) => c.metric === 'Qualified calls')?.status, 'definition-mismatch');
});

test('the report renders a readable table', () => {
  const out = formatReconcileReport(reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts));
  assert.match(out, /CallGrid reconciliation/);
  assert.match(out, /Revenue/);
  assert.match(out, /PASS/);
});

// --- Profit invariant (Sprint 33: CallGrid sends CallProfit) ----------------

test("CallGrid's stated Profit is checked against Revenue - Payout", () => {
  // CORRECTED: this test originally asserted revenue - payout - COST, which is
  // CallGrid's Net Profit. The daily report of 2026-07-18 proved Profit does not
  // subtract cost. The old assertion was encoding my mistake.
  const ok = reconcile(
    [srcCall({ call_id: 'a', revenue: 25.5, payout: 10, cost: 1.5, profit: 15.5 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  assert.equal(ok.fieldMismatches.filter((m) => m.metric.startsWith('profit-invariant')).length, 0);

  const bad = reconcile(
    [srcCall({ call_id: 'a', revenue: 25.5, payout: 10, cost: 1.5, profit: 99 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  const m = bad.fieldMismatches.find((x) => x.metric.startsWith('profit-invariant'));
  assert.ok(m, 'a Profit contradicting Revenue - Payout must be reported');
  assert.match(m!.reason ?? '', /same unit|defined differently/i);
});

test('the profit invariant is skipped when profit is not supplied', () => {
  const r = reconcile([srcCall({ call_id: 'a', profit: null })], [loopCall({ externalId: 'a' })], opts);
  assert.equal(r.fieldMismatches.filter((m) => m.metric.startsWith('profit-invariant')).length, 0);
});

// --- Business Definition Matrix --------------------------------------------
//
// A reconciliation may only fail on metrics that MEAN the same thing.
// "Qualified: source 0, Loop 41, FAIL" is not a data defect — CallGrid has no
// notion of qualified — and reporting it as one trains an operator to ignore
// the report, which is worse than having no report.

test('a metric CallGrid does not measure is NOT reported as a failure', () => {
  const r = reconcile(
    [srcCall({ call_id: 'a', qualified: null }), srcCall({ call_id: 'b', qualified: null })],
    [loopCall({ externalId: 'a', qualified: true }), loopCall({ externalId: 'b', qualified: true })],
    opts,
  );
  const q = r.aggregates.find((c) => c.metric === 'Qualified calls');
  assert.equal(q?.status, 'definition-mismatch', 'qualified is a Loop derivation, not a CallGrid fact');
  assert.notEqual(q?.status, 'fail');
  assert.equal(q?.difference, 'not comparable');
});

test('a definition mismatch does not fail the whole reconciliation', () => {
  const r = reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts);
  assert.equal(r.passed, true, 'values agree, so reconciliation passes');
  assert.ok(r.definitionMismatches.length > 0, 'but incomparable metrics are still surfaced');
  assert.equal(
    r.definitionMismatches.every((d) => d.status === 'definition-mismatch'),
    true,
  );
});

test('every definition mismatch carries a recommended action', () => {
  const r = reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts);
  for (const d of r.definitionMismatches) {
    assert.match(
      d.reason ?? '',
      /Recommended action: (compare|rename|remap|keep-separate)/,
      `${d.metric} must recommend an action`,
    );
  }
});

test('equivalent metrics are still compared normally', () => {
  // The matrix must not become a way to excuse real failures.
  const r = reconcile(
    [srcCall({ call_id: 'a', revenue: 10 })],
    [loopCall({ externalId: 'a', revenueCents: 9999 })],
    opts,
  );
  const rev = r.aggregates.find((c) => c.metric === 'Revenue');
  assert.equal(rev?.status, 'fail', 'Revenue IS equivalent, so a value gap is a real failure');
  assert.equal(r.passed, false);
});

test('definition mismatches are excluded from the failure count', () => {
  const r = reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts);
  assert.doesNotMatch(r.summary, /^[1-9][0-9]* value mismatch/, 'no value mismatches reported');
  assert.match(r.summary, /NOT COMPARED/, 'but the incomparable ones are named');
});

test('the matrix is grounded, not aspirational', () => {
  for (const d of BUSINESS_DEFINITIONS) {
    assert.ok(d.loopDefinition.length > 20, `${d.metric} needs a real Loop definition`);
    assert.ok(d.callgridDefinition.length > 15, `${d.metric} needs a real CallGrid definition`);
    assert.ok(d.note.length > 30, `${d.metric} needs a substantive note`);
    // A metric CallGrid does not measure must not be marked equivalent.
    if (d.callgridTerm === null) {
      assert.notEqual(d.status, 'equivalent', `${d.metric} has no CallGrid term — cannot be equivalent`);
    }
  }
});

// --- Ground truth: the CallGrid report for 2026-07-18 (US/Eastern) ----------
//
// Real reported figures, used as fixtures. These correct an invariant I had
// wrong: I asserted profit == revenue - payout - cost, which is CallGrid's NET
// Profit. Profit does not subtract cost.

test('Profit = Revenue - Payout, and cost is NOT subtracted', () => {
  // FE Inbounds RTB: 497.27 - 422.69 = 74.58, with telco cost also present.
  const r = reconcile(
    [srcCall({ call_id: 'a', revenue: 497.27, payout: 422.69, cost: 6.88, profit: 74.58 })],
    [loopCall({ externalId: 'a', revenueCents: 49727, payoutCents: 42269, costCents: 688 })],
    opts,
  );
  assert.equal(
    r.fieldMismatches.filter((m) => m.metric.startsWith('profit-invariant')).length,
    0,
    'a cost-bearing record must NOT fail the profit invariant',
  );
});

test('the old invariant would have failed this real record', () => {
  // Guards the regression directly: revenue - payout - cost = 67.70, not 74.58.
  const revenue = 497.27, payout = 422.69, cost = 6.88, statedProfit = 74.58;
  assert.equal(+(revenue - payout).toFixed(2), statedProfit, 'correct formula');
  assert.notEqual(+(revenue - payout - cost).toFixed(2), statedProfit, 'the formula I had was wrong');
});

test('Net Profit = Profit - Cost, checked separately', () => {
  const ok = reconcile(
    [srcCall({ call_id: 'a', revenue: 540.17, payout: 461.30, cost: 13.76, profit: 78.87, netProfit: 65.11 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  assert.equal(ok.fieldMismatches.filter((m) => m.metric.startsWith('net-profit-invariant')).length, 0);

  const bad = reconcile(
    [srcCall({ call_id: 'a', revenue: 540.17, payout: 461.30, cost: 13.76, profit: 78.87, netProfit: 99.99 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  assert.ok(bad.fieldMismatches.find((m) => m.metric.startsWith('net-profit-invariant')));
});

test('a pure-cost call: Revenue 0, Payout 0, Profit 0, Net Profit negative', () => {
  // The Home Insurance row — decisive proof that Profit excludes cost.
  const r = reconcile(
    [srcCall({ call_id: 'a', revenue: 0, payout: 0, cost: 0.04, profit: 0, netProfit: -0.04 })],
    [loopCall({ externalId: 'a', revenueCents: 0, payoutCents: 0, costCents: 4 })],
    opts,
  );
  assert.equal(r.fieldMismatches.filter((m) => m.metric.includes('invariant')).length, 0);
});

test('Profit and Net Profit are classified differently in the matrix', () => {
  const profit = BUSINESS_DEFINITIONS.find((d) => d.metric === 'Profit');
  const net = BUSINESS_DEFINITIONS.find((d) => d.metric === 'Net profit');
  assert.equal(profit?.status, 'different', "Loop's derived margin is not CallGrid's Profit");
  assert.equal(profit?.recommendation, 'remap');
  assert.equal(net?.status, 'equivalent', "it IS CallGrid's Net Profit");
});

test('Duplicate is registered as unmapped rather than silently reporting zero', () => {
  const dup = BUSINESS_DEFINITIONS.find((d) => d.metric === 'Duplicate calls');
  assert.equal(dup?.status, 'different');
  assert.equal(dup?.recommendation, 'remap');
  assert.match(dup?.loopDefinition ?? '', /NEITHER adapter maps it/);
});

// --- Why aggregate EQUALITY alone cannot prove the money unit --------------
//
// Recorded because the reasoning is subtle and will otherwise be re-litigated.
// The harness applies the same x100 to the source that centsOrNull applies to
// the ingested value, so a comparison is self-consistent under either unit
// hypothesis. What discriminates them is the ABSOLUTE value against CallGrid's
// independently published report.

test('equality alone is tautological — both unit hypotheses reconcile to $0.00', () => {
  const src = (revenue: number) => [
    { call_id: 'a', started_at: '2026-07-18T12:00:00.000Z', revenue, payout: 0, profit: revenue },
  ];
  const lp = (cents: number) => [
    {
      externalId: 'a', sourceOccurredAt: new Date('2026-07-18T12:00:00.000Z'),
      durationSeconds: null, revenueCents: cents, payoutCents: 0, costCents: null,
      buyerLabel: null, campaignLabel: null, sourceLabel: null,
      qualified: null, converted: null, duplicate: null,
    },
  ];

  // A: source states dollars. B: source states cents and Loop inflates 100x.
  const a = reconcile(src(540.17) as never, lp(54017) as never, opts);
  const b = reconcile(src(54017) as never, lp(5401700) as never, opts);

  const rev = (r: typeof a) => r.aggregates.find((c) => c.metric === 'Revenue')!;
  assert.equal(rev(a).status, 'pass', 'dollars hypothesis reconciles');
  assert.equal(rev(b).status, 'pass', 'cents hypothesis ALSO reconciles');
  assert.equal(rev(a).difference, '$0.00');
  assert.equal(rev(b).difference, '$0.00');
});

test('the ABSOLUTE value discriminates: only one hypothesis renders $540.17', () => {
  // CallGrid's published report for 2026-07-18 states Revenue $540.17.
  const asDollars = Math.round(540.17 * 100); // centsOrNull on a dollar figure
  const asCents = Math.round(54017 * 100); // centsOrNull on a minor-unit figure
  assert.equal(asDollars, 54017, 'dollars hypothesis stores 54017 cents -> renders $540.17');
  assert.equal(asCents, 5401700, 'cents hypothesis stores 5401700 -> renders $54,017.00');
  assert.notEqual(asDollars, asCents, 'the two are distinguishable by value, not by equality');
});

test('the profit invariant and margins are scale-invariant and cannot settle the unit', () => {
  // Both hold under a uniform 100x inflation, so they corroborate the ARITHMETIC
  // and not the UNIT. Worth pinning so neither is later cited as unit evidence.
  for (const k of [1, 100]) {
    const rev = 540.17 * k, pay = 461.30 * k, profit = 78.87 * k;
    assert.ok(Math.abs(rev - pay - profit) < 0.011 * k, 'profit invariant holds at scale ' + k);
    assert.ok(Math.abs(profit / rev - 0.146) < 0.001, 'margin identical at scale ' + k);
  }
});
