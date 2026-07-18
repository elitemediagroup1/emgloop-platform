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
  const r = reconcile(
    [srcCall({ call_id: 'a', qualified: true }), srcCall({ call_id: 'b', qualified: false })],
    [loopCall({ externalId: 'a', qualified: true }), loopCall({ externalId: 'b', qualified: true })],
    opts,
  );
  assert.equal(r.aggregates.find((c) => c.metric === 'Qualified calls')?.status, 'fail');
});

test('the report renders a readable table', () => {
  const out = formatReconcileReport(reconcile([srcCall({ call_id: 'a' })], [loopCall({ externalId: 'a' })], opts));
  assert.match(out, /CallGrid reconciliation/);
  assert.match(out, /Revenue/);
  assert.match(out, /PASS/);
});
