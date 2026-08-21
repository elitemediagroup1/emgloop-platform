// Is provider coverage keeping up? — Stage 3 operational readiness.
//
// WHY THIS EXISTS AS A SEPARATE QUESTION FROM "DID THE LAST RUN SUCCEED"
//
// A scheduled job that FAILS is visible. A scheduled job that STOPS RUNNING is
// silent, and silence reads as health — which is the August failure mode wearing
// different clothes. This repository has already proved that a red scheduled run
// is not an alert: `drain-outbox.yml` failed on a hundred consecutive runs, for
// months, because two secrets were never set, and nobody noticed.
//
// So the judgement is made about a DURABLE ROW rather than about any run. It stays
// true when the poller failed, was switched off, was never enabled, or the
// deployment that runs it is down.
//
// The properties that matter: it fails toward attention, one bad stream cannot be
// averaged away by a good one, and nothing is clamped to look better than it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COVERAGE_HEALTH_STATUSES,
  DEFAULT_COVERAGE_HEALTH_POLICY,
  assessCoverageHealth,
  coverageNeedsAttention,
  worstCoverageStatus,
  type CoverageHealthPolicy,
} from '../src/coverage-health';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-21T12:00:00.000Z');
const POLICY = DEFAULT_COVERAGE_HEALTH_POLICY;

const at = (hoursBehind: number, policy: CoverageHealthPolicy = POLICY) =>
  assessCoverageHealth({
    completedThrough: new Date(NOW.getTime() - hoursBehind * HOUR),
    now: NOW,
    policy,
  });

test('coverage inside the expected lag for an hourly cadence is HEALTHY', () => {
  for (const hours of [0, 0.5, 1, 2, 2.9]) {
    assert.equal(at(hours).status, 'HEALTHY', `${hours}h behind`);
  }
});

test('three missed hourly passes is LAGGING, not weather', () => {
  // One late pass is GitHub's scheduler being coarse under load, which it
  // documents and which the 48-hour overlap absorbs. Three in a row is not that.
  assert.equal(at(3.1).status, 'LAGGING');
  assert.equal(at(11.9).status, 'LAGGING');
});

test('half a day behind is STALE — the shape of the incident, caught on its first morning', () => {
  assert.equal(at(12.1).status, 'STALE');
  assert.equal(at(74).status, 'STALE', 'the August gap was about three days');
});

test('the thresholds are boundaries, and the boundary instant itself is not late', () => {
  assert.equal(at(POLICY.laggingAfterMs / HOUR).status, 'HEALTHY', 'exactly at is not over');
  assert.equal(at(POLICY.staleAfterMs / HOUR).status, 'LAGGING');
});

test('STALE wins if the two thresholds are ever configured the wrong way round', () => {
  // The answer that gets more attention should win a misconfiguration.
  const inverted: CoverageHealthPolicy = { laggingAfterMs: 12 * HOUR, staleAfterMs: 3 * HOUR };
  assert.equal(at(6, inverted).status, 'STALE');
});

test('no coverage ever proven is NEVER_PROVEN, and its lag is null rather than zero', () => {
  const out = assessCoverageHealth({ completedThrough: null, now: NOW, policy: POLICY });
  assert.equal(out.status, 'NEVER_PROVEN');
  assert.equal(out.lagMs, null, 'a zero here would read as "up to date"');
});

test('IT FAILS TOWARD ATTENTION: an unusable input is never HEALTHY', () => {
  // The cost of a false alarm is somebody looking at a dashboard. The cost of a
  // false all-clear is three days of missing calls.
  const bad: Array<Parameters<typeof assessCoverageHealth>[0]> = [
    { completedThrough: new Date(Number.NaN), now: NOW, policy: POLICY },
    { completedThrough: new Date(NOW), now: new Date(Number.NaN), policy: POLICY },
    { completedThrough: new Date(NOW), now: NOW, policy: { laggingAfterMs: Number.NaN, staleAfterMs: 1 } },
    { completedThrough: new Date(NOW), now: NOW, policy: { laggingAfterMs: -1, staleAfterMs: 1 } },
  ];
  for (const input of bad) {
    assert.notEqual(assessCoverageHealth(input).status, 'HEALTHY');
  }
});

test('a boundary AHEAD of the clock reports a negative lag rather than hiding it', () => {
  // Clock skew between whatever advanced the checkpoint and whatever is reading
  // it. Clamping to zero would turn a real fault into a healthy-looking one.
  const out = assessCoverageHealth({
    completedThrough: new Date(NOW.getTime() + HOUR),
    now: NOW,
    policy: POLICY,
  });
  assert.equal(out.status, 'HEALTHY');
  assert.equal(out.lagMs, -HOUR);
});

test('the lag is the real number, to the millisecond', () => {
  const out = assessCoverageHealth({
    completedThrough: new Date(NOW.getTime() - 4 * HOUR - 1234),
    now: NOW,
    policy: POLICY,
  });
  assert.equal(out.lagMs, 4 * HOUR + 1234);
});

test('ONE STALE STREAM MAKES THE PLATFORM STALE — a healthy tenant cannot average it away', () => {
  assert.equal(worstCoverageStatus(['HEALTHY', 'HEALTHY', 'STALE']), 'STALE');
  assert.equal(worstCoverageStatus(['HEALTHY', 'LAGGING']), 'LAGGING');
  assert.equal(worstCoverageStatus(['LAGGING', 'STALE']), 'STALE');
  assert.equal(worstCoverageStatus(['HEALTHY', 'NEVER_PROVEN']), 'NEVER_PROVEN');
  assert.equal(worstCoverageStatus(['HEALTHY']), 'HEALTHY');
  assert.equal(worstCoverageStatus([]), 'HEALTHY', 'nothing to be unhealthy about');
});

test('needing attention is LAGGING or STALE, and the vocabulary is closed', () => {
  assert.deepEqual([...COVERAGE_HEALTH_STATUSES].sort(), [
    'HEALTHY',
    'LAGGING',
    'NEVER_PROVEN',
    'STALE',
  ]);
  assert.equal(coverageNeedsAttention('LAGGING'), true);
  assert.equal(coverageNeedsAttention('STALE'), true);
  assert.equal(coverageNeedsAttention('HEALTHY'), false);
  // NEVER_PROVEN is left to the caller on purpose: before routine polling is
  // switched on it is the correct and expected state, and afterwards it is not.
  assert.equal(coverageNeedsAttention('NEVER_PROVEN'), false);
});

test('the policy is stated in milliseconds so a watcher can set its own', () => {
  assert.equal(POLICY.laggingAfterMs, 3 * HOUR);
  assert.equal(POLICY.staleAfterMs, 12 * HOUR);
});

test('the assessor is pure: same inputs, same answer, no clock of its own', () => {
  const a = at(5);
  const b = at(5);
  assert.deepEqual(a, b);
});
