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

test("CallGrid's stated profit is checked against revenue - payout - cost", () => {
  // Consistent: 25.50 - 10 - 1.50 = 14.00
  const ok = reconcile(
    [srcCall({ call_id: 'a', revenue: 25.5, payout: 10, cost: 1.5, profit: 14 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  assert.equal(ok.fieldMismatches.filter((m) => m.metric.startsWith('profit-invariant')).length, 0);

  // Inconsistent: stated profit disagrees with the arithmetic.
  const bad = reconcile(
    [srcCall({ call_id: 'a', revenue: 25.5, payout: 10, cost: 1.5, profit: 99 })],
    [loopCall({ externalId: 'a' })],
    opts,
  );
  const m = bad.fieldMismatches.find((x) => x.metric.startsWith('profit-invariant'));
  assert.ok(m, 'a profit that contradicts the arithmetic must be reported');
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
