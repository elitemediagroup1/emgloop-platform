// Which interval should the next routine poll read? — Stage 3 PR 10.
//
// The planner is pure, so these are the cheap tests and they carry real weight:
// every property that matters about routine polling except "did it prove
// anything" is decided in this one function.
//
// The two it exists to keep apart:
//
//   the checkpoint moves FORWARD, and only when a run proved coverage;
//   the overlap moves the READ's lower bound backward, and proves nothing.
//
// Nothing in this file returns a checkpoint value, and there is an assertion at
// the bottom saying so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS,
  DEFAULT_POLL_OVERLAP_MS,
  DEFAULT_POLL_SAFETY_LAG_MS,
  planPollInterval,
  type PollIntervalPolicy,
} from '../src/poll-interval-planning';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'poll-interval-planning.ts'),
  'utf8',
);
const CODE = SOURCE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const POLICY: PollIntervalPolicy = {
  overlapMs: DEFAULT_POLL_OVERLAP_MS,
  bootstrapLookbackMs: DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS,
  safetyLagMs: DEFAULT_POLL_SAFETY_LAG_MS,
  maxSpanMs: 31 * DAY,
};

const NOW = new Date('2026-08-21T12:00:00.000Z');
const plan = (completedThrough: Date | null, over: Partial<PollIntervalPolicy> = {}, now = NOW) =>
  planPollInterval({ completedThrough, now, policy: { ...POLICY, ...over } });

// --- 1. Bootstrap ---------------------------------------------------------------

test('1. no checkpoint yields a BOUNDED interval, not all of history', () => {
  const out = plan(null);
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(out.basis, 'BOOTSTRAP');
  const safeNow = NOW.getTime() - DEFAULT_POLL_SAFETY_LAG_MS;
  assert.equal(out.until.getTime(), safeNow);
  assert.equal(out.since.getTime(), safeNow - DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS);
  assert.equal(out.until.getTime() - out.since.getTime(), DAY, 'one bounded day');
});

test('1b. the first interval cannot reach the August outage merely because nothing is stored', () => {
  // The incident window is 2026-08-10T22:06:14Z .. 2026-08-14T13:10:23Z. Routine
  // polling starting fresh a week later must not sweep it as a side effect;
  // recovering it is a separate decision somebody makes on purpose.
  const out = plan(null);
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.ok(
    out.since.getTime() > new Date('2026-08-14T13:10:23.000Z').getTime(),
    'the bootstrap interval starts after the incident, not before it',
  );
});

// --- 2/3. Checkpoint and overlap ---------------------------------------------------

test('2. a checkpoint starts the interval at the proven boundary MINUS the overlap', () => {
  const checkpoint = new Date('2026-08-21T06:00:00.000Z');
  const out = plan(checkpoint);
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(out.basis, 'CHECKPOINT');
  assert.equal(out.since.getTime(), checkpoint.getTime() - DEFAULT_POLL_OVERLAP_MS);
  assert.equal(out.until.getTime(), NOW.getTime() - DEFAULT_POLL_SAFETY_LAG_MS);
  assert.ok(out.since < checkpoint, 'the READ reaches back behind the proven boundary');
});

test('3. the overlap moves the READ backward and never returns a checkpoint value', () => {
  const checkpoint = new Date('2026-08-21T06:00:00.000Z');
  const out = plan(checkpoint);
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  // The only instants the plan produces are the two bounds of the READ. There is
  // no third field carrying a proposed boundary, because proposing one before the
  // read happens is how a checkpoint starts claiming what it did not prove.
  assert.deepEqual(Object.keys(out).sort(), ['basis', 'cappedBySpan', 'plan', 'since', 'until']);
  assert.ok(out.until > checkpoint, 'the interval extends the frontier');
});

test('3b. re-planning from the same checkpoint is stable, and never walks backward', () => {
  const checkpoint = new Date('2026-08-21T06:00:00.000Z');
  const first = plan(checkpoint);
  const second = plan(checkpoint, {}, new Date(NOW.getTime() + HOUR));
  assert.equal(first.plan, 'POLL');
  assert.equal(second.plan, 'POLL');
  if (first.plan !== 'POLL' || second.plan !== 'POLL') return;
  assert.equal(first.since.getTime(), second.since.getTime(), 'the lower bound is the checkpoint\'s');
  assert.ok(second.until > first.until, 'only the frontier moves');
});

test('a zero overlap is honoured, so the policy is genuinely policy', () => {
  const checkpoint = new Date('2026-08-21T06:00:00.000Z');
  const out = plan(checkpoint, { overlapMs: 0 });
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(out.since.getTime(), checkpoint.getTime(), 'exactly at the boundary');
});

// --- The upper bound ----------------------------------------------------------------

test('the upper bound lags the clock, so the volatile edge is never claimed', () => {
  const out = plan(new Date('2026-08-21T06:00:00.000Z'));
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(NOW.getTime() - out.until.getTime(), DEFAULT_POLL_SAFETY_LAG_MS);
  assert.ok(out.until < NOW, 'the boundary is strictly historical');
});

test('a long outage is caught up in SPAN-WIDE CHUNKS, never jumped over', () => {
  // The poller has been off for ninety days. Moving `since` forward to fit the
  // ceiling would skip sixty days while advancing as though it had read them.
  const checkpoint = new Date(NOW.getTime() - 90 * DAY);
  const out = plan(checkpoint);
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(out.cappedBySpan, true);
  assert.equal(out.since.getTime(), checkpoint.getTime() - DEFAULT_POLL_OVERLAP_MS, 'the lower bound is NOT moved');
  assert.equal(out.until.getTime() - out.since.getTime(), POLICY.maxSpanMs, 'one ceiling-wide chunk');
  assert.ok(out.until < NOW, 'and the frontier is not reached in one run');

  // The next run continues from where that chunk ended: forward, no gap.
  const next = plan(out.until);
  assert.equal(next.plan, 'POLL');
  if (next.plan !== 'POLL') return;
  assert.ok(next.since <= out.until, 'no interval is skipped between chunks');
  assert.ok(next.until > out.until, 'and it makes progress');
});

test('an ordinary interval is not marked as capped', () => {
  const out = plan(new Date('2026-08-21T06:00:00.000Z'));
  assert.equal(out.plan, 'POLL');
  if (out.plan !== 'POLL') return;
  assert.equal(out.cappedBySpan, false);
});

test('the planner can never propose an interval the reader would refuse', () => {
  // `maxSpanMs` is supplied by the caller FROM the reader's own ceiling. Whatever
  // the checkpoint's age, the proposed span stays within it.
  for (const ageDays of [0, 1, 30, 31, 32, 400]) {
    const out = plan(new Date(NOW.getTime() - ageDays * DAY));
    assert.equal(out.plan, 'POLL');
    if (out.plan !== 'POLL') continue;
    const span = out.until.getTime() - out.since.getTime();
    assert.ok(span > 0 && span <= POLICY.maxSpanMs, `span for ${ageDays}d was ${span}`);
  }
});

// --- Failing closed -----------------------------------------------------------------

test('a checkpoint already at the safe boundary with no overlap reads nothing', () => {
  const safeNow = new Date(NOW.getTime() - DEFAULT_POLL_SAFETY_LAG_MS);
  const out = plan(safeNow, { overlapMs: 0 });
  assert.equal(out.plan, 'NOTHING_DUE');
  if (out.plan !== 'NOTHING_DUE') return;
  assert.equal(out.basis, 'CHECKPOINT');
  assert.ok(out.reason.length > 0);
});

test('a checkpoint ahead of the clock reads nothing rather than reversing an interval', () => {
  const out = plan(new Date(NOW.getTime() + DAY), { overlapMs: 0 });
  assert.equal(out.plan, 'NOTHING_DUE');
});

test('an unusable policy or clock refuses, and refusing reads nothing', () => {
  for (const broken of [
    { overlapMs: Number.NaN },
    { bootstrapLookbackMs: -1 },
    { safetyLagMs: Number.POSITIVE_INFINITY },
    { maxSpanMs: 0 },
  ] as Array<Partial<PollIntervalPolicy>>) {
    assert.equal(plan(null, broken).plan, 'NOTHING_DUE');
  }
  assert.equal(plan(null, {}, new Date(Number.NaN)).plan, 'NOTHING_DUE');
  assert.equal(plan(new Date(Number.NaN)).plan, 'NOTHING_DUE');
});

// --- 16/17/18. What the checkpoint is NOT --------------------------------------------

test('16. the planner reasons in instants, never in business days', () => {
  for (const symbol of [
    'easternBusinessDayWindow',
    'BusinessDate',
    'businessDate',
    'timezone',
    'BUSINESS_TIME_ZONE',
    'setHours',
  ]) {
    assert.ok(!CODE.includes(symbol), `the planner must not reference ${symbol}`);
  }
});

test('17/18. no bound is derived from an event occurrence or from execution time', () => {
  for (const symbol of ['occurredAt', 'max(', 'Math.max', 'lastEvent', 'newest', 'Date.now(', 'new Date()']) {
    assert.ok(!CODE.includes(symbol), `the planner must not reference ${symbol}`);
  }
  // The clock is supplied, and it only ever produces the UPPER bound.
  assert.ok(CODE.includes('now.getTime()'));
});

test('the planner is pure: no persistence, no provider, no advancement', () => {
  for (const symbol of ['prisma', 'repository', 'Repository', 'advance', 'fetch(', 'await ']) {
    assert.ok(!CODE.includes(symbol), `the planner must not reference ${symbol}`);
  }
});

test('the same inputs always produce the same plan', () => {
  const checkpoint = new Date('2026-08-21T06:00:00.000Z');
  assert.deepEqual(plan(checkpoint), plan(checkpoint));
});
