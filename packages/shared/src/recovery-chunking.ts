// Split an explicit recovery interval into deterministic, re-runnable chunks.
//
// PURE. Two instants and a limit go in, a list of intervals comes out. No clock,
// no I/O, no provider.
//
// WHY CHUNK AT ALL. The canonical reader will accept a 31-day interval and the
// page budget will accept 50,000 records, so the August window -- roughly three
// and a half days and on the order of 25,000 calls -- fits inside one request on
// paper. Three things make that the wrong shape anyway:
//
//   1. The whole interval is held in memory so the caller can judge completeness
//      before writing any of it. 25,000 mapped records at once is a different
//      kind of risk from 7,000.
//   2. One unmappable provider record fails the WHOLE interval closed -- that is
//      the shipped policy and it is the right one. At one interval, a single
//      malformed record means nothing at all is recovered. At one chunk per day,
//      it means one day is held back and named.
//   3. A partial apply twenty thousand records in is a state nobody can reason
//      about. A partial apply inside one day is a state an operator can look at.
//
// WHY EASTERN DAYS. Reconciliation, certification and measurement all reason in
// Eastern business days, and the verification that has to follow a recovery is
// per business day. Chunking on the same boundary means the thing we recovered
// and the thing we then check are the same unit. `easternBusinessDayWindow` is the
// one helper allowed to decide where a day begins, so the boundaries come from it
// rather than from arithmetic here.
//
// THE ENDS ARE CLIPPED, NOT ROUNDED. An operator asking for 18:06 on the 10th
// through 09:10 on the 14th gets exactly that: a short first chunk, whole days in
// between, a short last chunk. Rounding outward would read provider time nobody
// asked for; rounding inward would silently drop the hours the incident started
// and ended in.

import {
  easternBusinessDate,
  easternBusinessDayWindow,
  startOfNextEasternDay,
  type BusinessDate,
} from './business-time';

export interface RecoveryChunk {
  /** The Eastern business date this chunk falls inside. */
  businessDate: BusinessDate;
  /** INCLUSIVE lower bound. Clipped to the requested interval. */
  since: Date;
  /** EXCLUSIVE upper bound. Clipped to the requested interval. */
  until: Date;
  /** True when the chunk covers less than its whole business day. */
  partialDay: boolean;
}

export type RecoveryChunkPlan =
  | { ok: true; chunks: RecoveryChunk[] }
  | { ok: false; reason: string };

/**
 * The most chunks one recovery run will plan.
 *
 * A BOUND ON THE OPERATION, NOT A CLAIM ABOUT ANYTHING. A recovery spanning more
 * than about two months of business days is not a recovery, it is a backfill, and
 * it should be asked for in pieces by somebody who has decided that is what they
 * want. Refusing is louder than silently working through sixty sequential days.
 */
export const MAX_RECOVERY_CHUNKS = 62;

/**
 * Split `[since, until)` on Eastern business-day boundaries, clipping both ends.
 *
 * FAILS CLOSED. Every refusal returns `ok: false` with a reason and no chunks, so
 * a caller that ignores the discriminant recovers nothing rather than something
 * arbitrary.
 */
export function planRecoveryChunks(since: Date, until: Date): RecoveryChunkPlan {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())) {
    return { ok: false, reason: 'Both bounds must be valid instants.' };
  }
  if (until.getTime() <= since.getTime()) {
    // Half-open means `[t, t)` contains no instant at all, so a caller asking for
    // one is asking for nothing and almost certainly meant something else.
    return { ok: false, reason: 'The upper bound must be strictly after the lower bound.' };
  }

  const chunks: RecoveryChunk[] = [];
  let cursor = since;
  while (cursor.getTime() < until.getTime()) {
    const businessDate = easternBusinessDate(cursor);
    const day = easternBusinessDayWindow(businessDate);
    // The next boundary comes from the day helper, so a DST day that is 23 or 25
    // hours long is handled by the one place that knows that.
    const nextBoundary = day.end.getTime() > cursor.getTime() ? day.end : startOfNextEasternDay(cursor);
    const chunkEnd = new Date(Math.min(nextBoundary.getTime(), until.getTime()));
    if (chunkEnd.getTime() <= cursor.getTime()) {
      // A boundary that did not advance would loop forever. It cannot happen with
      // the helpers above; refusing is still cheaper than trusting that.
      return { ok: false, reason: 'The day boundary did not advance; refusing to plan.' };
    }
    chunks.push({
      businessDate,
      since: cursor,
      until: chunkEnd,
      partialDay: cursor.getTime() > day.start.getTime() || chunkEnd.getTime() < day.end.getTime(),
    });
    if (chunks.length > MAX_RECOVERY_CHUNKS) {
      return {
        ok: false,
        reason:
          `A recovery of more than ${MAX_RECOVERY_CHUNKS} business days is a backfill, not a recovery. ` +
          'Ask for it in pieces.',
      };
    }
    cursor = chunkEnd;
  }

  if (chunks.length === 0) return { ok: false, reason: 'The interval produced no chunks.' };
  return { ok: true, chunks };
}

/**
 * Whether a list of chunks tiles its interval exactly: no gap, no overlap.
 *
 * Not used to decide anything at runtime -- it is the property the planner is
 * asserted against, stated once so the test and the reader agree on what "tiles"
 * means rather than each spelling it out.
 */
export function chunksTile(chunks: readonly RecoveryChunk[], since: Date, until: Date): boolean {
  if (chunks.length === 0) return false;
  if (chunks[0]!.since.getTime() !== since.getTime()) return false;
  if (chunks[chunks.length - 1]!.until.getTime() !== until.getTime()) return false;
  for (let i = 1; i < chunks.length; i += 1) {
    if (chunks[i]!.since.getTime() !== chunks[i - 1]!.until.getTime()) return false;
  }
  return true;
}
