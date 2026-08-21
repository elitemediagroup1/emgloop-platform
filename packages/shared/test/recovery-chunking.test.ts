// Splitting a recovery interval into Eastern business-day chunks — Stage 3.
//
// The property that matters is that the chunks TILE the requested interval: no
// gap, no overlap, first chunk starting exactly where the operator asked and last
// chunk ending exactly where they asked. A gap silently skips provider time a
// recovery was meant to cover; an overlap is harmless but means a chunk boundary
// is not what it says.
//
// The second property is that the ENDS ARE CLIPPED. Rounding outward reads
// provider time nobody asked for. Rounding inward drops the hours an incident
// started and ended in — which, for the window this operation exists to recover,
// is where the incident actually begins.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { easternBusinessDayWindow } from '../src/business-time';
import {
  MAX_RECOVERY_CHUNKS,
  chunksTile,
  planRecoveryChunks,
  type RecoveryChunk,
} from '../src/recovery-chunking';

/** The known incident window, used ONLY as a fixture. Nothing here recovers it. */
const INCIDENT_SINCE = new Date('2026-08-10T22:06:14.000Z');
const INCIDENT_UNTIL = new Date('2026-08-14T13:10:23.000Z');

const chunksOf = (since: Date, until: Date): RecoveryChunk[] => {
  const plan = planRecoveryChunks(since, until);
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  return plan.ok ? plan.chunks : [];
};

test('the chunks tile the requested interval exactly: no gap, no overlap', () => {
  const chunks = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  assert.ok(chunksTile(chunks, INCIDENT_SINCE, INCIDENT_UNTIL));
  assert.equal(chunks[0]!.since.getTime(), INCIDENT_SINCE.getTime(), 'starts where asked');
  assert.equal(chunks[chunks.length - 1]!.until.getTime(), INCIDENT_UNTIL.getTime(), 'ends where asked');
});

test('a mid-day start and a mid-day end produce partial chunks at the ends only', () => {
  const chunks = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  assert.ok(chunks.length >= 4, `expected at least four chunks, got ${chunks.length}`);
  assert.equal(chunks[0]!.partialDay, true, 'the first day starts part-way through');
  assert.equal(chunks[chunks.length - 1]!.partialDay, true, 'the last day ends part-way through');
  for (const middle of chunks.slice(1, -1)) {
    assert.equal(middle.partialDay, false, `${middle.businessDate} should be a whole day`);
    const day = easternBusinessDayWindow(middle.businessDate);
    assert.equal(middle.since.getTime(), day.start.getTime());
    assert.equal(middle.until.getTime(), day.end.getTime());
  }
});

test('every chunk names the Eastern business date it falls inside', () => {
  const chunks = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  const dates = chunks.map((c) => c.businessDate);
  assert.deepEqual(dates, [...new Set(dates)], 'one chunk per business date');
  for (const chunk of chunks) {
    const day = easternBusinessDayWindow(chunk.businessDate);
    assert.ok(chunk.since >= day.start && chunk.since < day.end, `${chunk.businessDate} contains its start`);
    assert.ok(chunk.until > day.start && chunk.until <= day.end, `${chunk.businessDate} contains its end`);
  }
  // The verification that follows a recovery is per business day, so the unit
  // recovered and the unit checked are the same unit.
  assert.deepEqual(dates, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
});

test('an interval inside a single day is one partial chunk', () => {
  const day = easternBusinessDayWindow('2026-08-11');
  const since = new Date(day.start.getTime() + 3 * 60 * 60 * 1000);
  const until = new Date(day.start.getTime() + 5 * 60 * 60 * 1000);
  const chunks = chunksOf(since, until);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.partialDay, true);
  assert.ok(chunksTile(chunks, since, until));
});

test('an interval that is exactly one business day is one WHOLE chunk', () => {
  const day = easternBusinessDayWindow('2026-08-11');
  const chunks = chunksOf(day.start, day.end);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.partialDay, false);
  assert.equal(chunks[0]!.businessDate, '2026-08-11');
});

test('a DST day is whatever the day helper says it is, not 24 hours of arithmetic', () => {
  // 2026-11-01 is the US fall-back day: 25 hours long in Eastern.
  const day = easternBusinessDayWindow('2026-11-01');
  const chunks = chunksOf(day.start, day.end);
  assert.equal(chunks.length, 1, 'still exactly one day');
  assert.equal(chunks[0]!.partialDay, false);
  assert.equal(day.end.getTime() - day.start.getTime(), 25 * 60 * 60 * 1000, 'and it really is 25 hours');
});

test('a DST boundary crossed mid-interval still tiles', () => {
  const before = easternBusinessDayWindow('2026-10-31');
  const after = easternBusinessDayWindow('2026-11-02');
  const since = new Date(before.start.getTime() + 60 * 60 * 1000);
  const until = new Date(after.start.getTime() + 60 * 60 * 1000);
  const chunks = chunksOf(since, until);
  assert.ok(chunksTile(chunks, since, until));
  assert.deepEqual(chunks.map((c) => c.businessDate), ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('reversed, equal and invalid bounds are refused with a reason and no chunks', () => {
  for (const [since, until] of [
    [INCIDENT_UNTIL, INCIDENT_SINCE],
    [INCIDENT_SINCE, INCIDENT_SINCE],
    [new Date(Number.NaN), INCIDENT_UNTIL],
    [INCIDENT_SINCE, new Date(Number.NaN)],
  ] as const) {
    const plan = planRecoveryChunks(since, until);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.ok(plan.reason.length > 0);
  }
});

test('an interval wider than the chunk ceiling is refused, not silently worked through', () => {
  const since = new Date('2026-01-01T05:00:00.000Z');
  const until = new Date('2026-06-01T04:00:00.000Z');
  const plan = planRecoveryChunks(since, until);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.reason, /backfill/);
});

test('an interval at exactly the ceiling is accepted', () => {
  const start = easternBusinessDayWindow('2026-06-01').start;
  const end = easternBusinessDayWindow('2026-06-01');
  // MAX_RECOVERY_CHUNKS whole days, ending on a day boundary.
  const until = new Date(end.start.getTime() + MAX_RECOVERY_CHUNKS * 24 * 60 * 60 * 1000);
  const plan = planRecoveryChunks(start, until);
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  if (plan.ok) assert.ok(plan.chunks.length <= MAX_RECOVERY_CHUNKS + 1);
});

test('the plan is deterministic: the same interval always produces the same chunks', () => {
  const a = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  const b = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  assert.deepEqual(
    a.map((c) => [c.businessDate, c.since.toISOString(), c.until.toISOString(), c.partialDay]),
    b.map((c) => [c.businessDate, c.since.toISOString(), c.until.toISOString(), c.partialDay]),
  );
});

test('chunksTile rejects a gap and an overlap', () => {
  const chunks = chunksOf(INCIDENT_SINCE, INCIDENT_UNTIL);
  const gapped = chunks.map((c, i) =>
    i === 1 ? { ...c, since: new Date(c.since.getTime() + 1000) } : c,
  );
  assert.equal(chunksTile(gapped, INCIDENT_SINCE, INCIDENT_UNTIL), false);
  const overlapped = chunks.map((c, i) =>
    i === 1 ? { ...c, since: new Date(c.since.getTime() - 1000) } : c,
  );
  assert.equal(chunksTile(overlapped, INCIDENT_SINCE, INCIDENT_UNTIL), false);
});
