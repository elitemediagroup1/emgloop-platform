// The reconciliation harness — it must catch the failures it exists to catch,
// and must never report agreement it did not verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileCallGridReport, resolveCallGridWindow, DEFECT_FLAGS,
  type ReconInput, type ReconRow,
} from '../src/index';

const NOW = new Date('2026-07-22T18:30:00.000Z');

function row(key: string, revenueCents: number | null, calls = 40, monetized = 20): ReconRow {
  return { key, label: key.toUpperCase(), calls, monetized, revenueCents, revenueCoverage: revenueCents === null ? 0 : 1 };
}

function input(over: Partial<ReconInput> = {}): ReconInput {
  const rows = [row('a', 500_000), row('b', 300_000)];
  return {
    organizationId: 'org_1',
    dimension: 'buyers',
    topN: 5,
    window: resolveCallGridWindow({ preset: 'yesterday' }, NOW),
    requestedPreset: 'yesterday',
    reportOk: true,
    totals: { totalCalls: 80, billableCalls: 40, revenueCents: 800_000, profitCents: 300_000, revenueCoverage: 1 },
    subpageRows: rows,
    overviewTop: rows[0]!,
    rowCap: null,
    ...over,
  };
}

test('a consistent report reports no defects', () => {
  const r = reconcileCallGridReport(input());
  assert.deepEqual(r.defects, []);
});

test('a divergence between Overview and its subpage is a defect', () => {
  const rows = [row('a', 500_000), row('b', 300_000)];
  const r = reconcileCallGridReport(input({ subpageRows: rows, overviewTop: rows[1]! }));
  const defect = r.defects.find((d) => /top entity is the subpage/i.test(d.label));
  assert.ok(defect, 'expected the mismatch to be flagged');
  assert.equal(defect!.flag, 'ENTITY_MISMATCH');
});

test('an unknown-revenue row ranked above a reported one is flagged as zero coercion', () => {
  const bad = [row('unpriced', null), row('priced', 500_000)];
  const r = reconcileCallGridReport(input({ subpageRows: bad, overviewTop: bad[0]! }));
  const defect = r.defects.find((d) => d.flag === 'ZERO_COERCION');
  assert.ok(defect, 'an unpriced entity must not outrank a priced one');
});

test('unknown revenue ranked last is correct, not a defect', () => {
  const good = [row('priced', 500_000), row('unpriced', null)];
  const r = reconcileCallGridReport(input({ subpageRows: good, overviewTop: good[0]! }));
  assert.equal(r.defects.filter((d) => d.flag === 'ZERO_COERCION').length, 0);
});

test('comparing an in-progress window against a complete period is a date mismatch', () => {
  const live = resolveCallGridWindow({ preset: 'today' }, NOW);
  // Simulate the pre-correction behaviour: comparison runs the full prior day.
  const broken = {
    ...live,
    comparisonBasis: 'complete_period' as const,
    comparisonEnd: new Date(live.start.getTime()),
    comparisonStart: new Date(live.start.getTime() - 86_400_000),
  };
  const r = reconcileCallGridReport(input({ window: broken, requestedPreset: 'today' }));
  const defect = r.defects.find((d) => /equal elapsed period/i.test(d.label));
  assert.ok(defect, 'a partial-vs-complete comparison must be caught');
  assert.equal(defect!.flag, 'DATE_MISMATCH');
  assert.match(defect!.reason, /overstates any decline/);
});

test('the corrected elapsed-matched window passes the same check', () => {
  const r = reconcileCallGridReport(input({
    window: resolveCallGridWindow({ preset: 'today' }, NOW),
    requestedPreset: 'today',
  }));
  assert.equal(r.defects.filter((d) => /equal elapsed period/i.test(d.label)).length, 0);
});

test('an invalid requested range is reported rather than silently substituted', () => {
  const r = reconcileCallGridReport(input({
    window: resolveCallGridWindow({ preset: 'custom', start: 'nonsense', end: 'x' }, NOW),
    requestedPreset: 'custom',
  }));
  assert.ok(r.defects.some((d) => d.label === 'Window is valid'));
});

test('a failed read is disclosed, and partial coverage is a limitation not a defect', () => {
  const failed = reconcileCallGridReport(input({ reportOk: false }));
  assert.ok(failed.sections.some((s) => s.lines.some((l) => l.label === 'Canonical read succeeded' && l.flag === 'MISSING_PROVIDER_DATA')));

  const partial = reconcileCallGridReport(input({
    totals: { totalCalls: 80, billableCalls: 40, revenueCents: 400_000, profitCents: 100_000, revenueCoverage: 0.5 },
  }));
  const cov = partial.sections.flatMap((s) => s.lines).find((l) => l.label === 'Revenue coverage')!;
  assert.equal(cov.flag, 'CAP_LIMITATION');
  assert.ok(!DEFECT_FLAGS.has(cov.flag), 'disclosed partial coverage is not a defect');
});

// --- The provider leg: honesty about what was NOT checked -------------------------

test('without CallGrid figures the provider leg is unverified, never a match', () => {
  const r = reconcileCallGridReport(input());
  assert.ok(r.unverified.length > 0);
  assert.equal(r.fullyReconciled, false, 'nothing may be called fully reconciled while unverified');
  for (const line of r.unverified) {
    assert.equal(line.other, null);
    assert.match(line.reason, /never returned 200|compared by hand/);
  }
});

test('supplied CallGrid figures are compared and agreement is recorded', () => {
  const r = reconcileCallGridReport(input({
    callgridFigures: {
      totalCalls: 80, billableCalls: 40, revenueCents: 800_000, profitCents: 300_000, topEntityName: 'A',
    },
  }));
  const provider = r.sections.find((s) => s.title.startsWith('CallGrid comparison'))!;
  for (const line of provider.lines) {
    assert.equal(line.flag, 'MATCH', `${line.label}: ${line.reason}`);
  }
});

test('a real numeric discrepancy against CallGrid is a defect', () => {
  const r = reconcileCallGridReport(input({
    callgridFigures: { totalCalls: 95 },
  }));
  const line = r.sections.flatMap((s) => s.lines).find((l) => l.label === 'Total calls')!;
  assert.equal(line.flag, 'ENTITY_MISMATCH');
  assert.ok(r.defects.includes(line));
});

test('a sub-1% money difference is rounding, not a defect', () => {
  const r = reconcileCallGridReport(input({
    callgridFigures: { revenueCents: 800_050 }, // 50 cents apart on $8,000
  }));
  const line = r.sections.flatMap((s) => s.lines).find((l) => l.label === 'Revenue (cents)')!;
  assert.equal(line.flag, 'ROUNDING_DIFFERENCE');
  assert.ok(!DEFECT_FLAGS.has(line.flag));
});

test('unknown Loop revenue is not numerically compared against a CallGrid figure', () => {
  const r = reconcileCallGridReport(input({
    totals: { totalCalls: 80, billableCalls: 40, revenueCents: null, profitCents: null, revenueCoverage: 0 },
    callgridFigures: { revenueCents: 800_000 },
  }));
  const line = r.sections.flatMap((s) => s.lines).find((l) => l.label === 'Revenue (cents)')!;
  assert.equal(line.flag, 'UNKNOWN');
  assert.match(line.reason, /not shown as zero/);
});

test('bid grains are declared unreconcilable against an Eastern calendar window', () => {
  for (const dimension of ['bids-source', 'bids-destination'] as const) {
    const r = reconcileCallGridReport(input({ dimension }));
    const guard = r.sections.find((s) => s.title === 'Grain guard');
    assert.ok(guard, dimension);
    assert.equal(guard!.lines[0]!.flag, 'GRAIN_MISMATCH');
    assert.match(guard!.lines[0]!.reason, /snapshot-only/);
  }
});

test('every line carries a reason — no result is unexplained', () => {
  const r = reconcileCallGridReport(input({ rowCap: 1000 }));
  for (const s of r.sections) {
    for (const l of s.lines) {
      assert.ok(l.reason.length > 10, `${s.title} / ${l.label} has no reason`);
    }
  }
});
