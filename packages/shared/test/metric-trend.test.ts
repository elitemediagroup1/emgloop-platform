import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trend, trendLabel, metricValue, type TrendResult } from '../src/metric-trend';

const v = (n: number) => metricValue(n, true);
const unknown = metricValue(null, true);
const unavailable = metricValue(0, false);

test('percentage increase', () => {
  const r = trend(v(100), v(120));
  assert.deepEqual(r, { kind: 'up', pct: 20 });
  assert.equal(trendLabel(r), '↑ 20.0%');
});

test('percentage decrease, one-decimal rounding (spec example 222173→173134 cents)', () => {
  const r = trend(v(222173), v(173134)) as Extract<TrendResult, { kind: 'down' }>;
  assert.equal(r.kind, 'down');
  assert.equal(r.pct, 22.1);
  assert.equal(trendLabel(r), '↓ 22.1%');
});

test('computed no change → — 0.0%', () => {
  const r = trend(v(100), v(100));
  assert.deepEqual(r, { kind: 'flat' });
  assert.equal(trendLabel(r), '— 0.0%');
});

test('zero to zero → No change', () => {
  assert.deepEqual(trend(v(0), v(0)), { kind: 'no_change' });
  assert.equal(trendLabel({ kind: 'no_change' }), 'No change');
});

test('zero baseline to positive → New today (never Infinity)', () => {
  assert.deepEqual(trend(v(0), v(55)), { kind: 'new' });
  assert.equal(trendLabel({ kind: 'new' }), 'New today');
});

test('unknown value → Unknown', () => {
  assert.deepEqual(trend(unknown, v(10)), { kind: 'unknown' });
  assert.deepEqual(trend(v(10), unknown), { kind: 'unknown' });
  assert.equal(trendLabel({ kind: 'unknown' }), 'Unknown');
});

test('unavailable read → Unavailable, and it outranks unknown', () => {
  assert.deepEqual(trend(unavailable, v(10)), { kind: 'unavailable' });
  assert.deepEqual(trend(unavailable, unknown), { kind: 'unavailable' });
  assert.equal(trendLabel({ kind: 'unavailable' }), 'Unavailable');
});

test('currency precision: trend is computed on exact cents, not rounded dollars', () => {
  // $1.00 → $1.01. Rounded to whole dollars this is 0%; on exact cents it is +1.0%.
  const r = trend(v(100), v(101));
  assert.deepEqual(r, { kind: 'up', pct: 1 });
  assert.equal(trendLabel(r), '↑ 1.0%');
});
