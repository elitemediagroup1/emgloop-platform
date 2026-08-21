// What interval should the next routine provider poll read?
//
// PURE. No clock, no I/O, no provider. `now` is supplied, the checkpoint is
// supplied, the policy is supplied, and the answer is two instants. The decision
// is separated from the persistence for the same reason `convergeFact` and
// `decideEffectiveDatedWrite` are: a rule that can be exercised without a
// database gets exercised, and a rule that is spelled out at three call sites
// gets three answers.
//
// THE TWO CONCEPTS THIS FILE KEEPS APART
//
//   CHECKPOINT   the provider time through which coverage has been PROVEN.
//                It only ever moves forward, and only after a run proved it.
//   OVERLAP      already-proven provider time this poll deliberately re-reads,
//                because CallGrid records mutate after the call ends.
//
// The overlap moves the interval's LOWER bound backward. It never moves the
// checkpoint backward, and nothing in this file returns a new checkpoint value:
// the plan says what to READ, and only a completed run says what was covered.
//
// WHY RE-READ AT ALL. "BillableType is POSTBACK. Revenue and billable will be
// set when the postback is received." A settled fact can arrive hours after the
// call, on a record whose occurrence is already behind the checkpoint. Loop's
// answer to that is not an exactly-once protocol; it is a bounded re-read on top
// of canonical identity, observation provenance and fact convergence, all of
// which already exist and all of which are idempotent.

/** Instants only. Business days belong to operations that reason about business days. */
export type PollPlanBasis = 'BOOTSTRAP' | 'CHECKPOINT';

export interface PollIntervalPolicy {
  /**
   * How far back before the checkpoint to re-read, in milliseconds.
   *
   * POLICY, NOT A PROVIDER FACT. CallGrid publishes no settlement SLA and the
   * list endpoint carries no per-record updatedAt, so nothing in this repository
   * can prove the correct duration. What the repository does state, in two
   * places written before this one, is the expectation of "a poller re-reading a
   * 48-hour overlap": `provider-fact-convergence.ts` and the
   * provider_fact_revisions migration both reason from it. This default matches
   * that, and the sibling `LOCAL_SCAN_MARGIN_MS` in reconciliation independently
   * chose the same two days for the same class of lateness.
   */
  overlapMs: number;
  /**
   * How far back the FIRST poll reaches when no checkpoint exists.
   *
   * Bounded on purpose. "All history" and "the earliest record" are both ways of
   * making the first routine run sweep an outage nobody decided to recover.
   */
  bootstrapLookbackMs: number;
  /**
   * How far behind `now` the upper bound is held.
   *
   * The boundary instant is the volatile edge: a call occurring in the same
   * moment as the request may be written by the provider just after it is
   * answered, and a checkpoint advanced to `now` would claim that instant was
   * covered. The overlap is the real safety net -- this only reduces how often it
   * has to be. Small by design; a large lag is a scheduling decision, not this one.
   */
  safetyLagMs: number;
  /**
   * The widest interval the reader will accept, in milliseconds.
   *
   * SUPPLIED, NOT RESTATED. The ceiling belongs to `readCallGridInterval`
   * (INTERVAL_MAX_SPAN_DAYS) and a second copy here would disagree with it the
   * first time either moved.
   */
  maxSpanMs: number;
}

/** Two days. See `overlapMs` -- this is policy, and it is labelled as policy. */
export const DEFAULT_POLL_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * One day. See `bootstrapLookbackMs`.
 *
 * Chosen so the first run is provably affordable as well as bounded: the busiest
 * observed CallGrid day in this repository's evidence is 2026-08-10 at 7,298
 * calls, which is 73 pages against a 500-page budget.
 */
export const DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Two minutes. See `safetyLagMs`. */
export const DEFAULT_POLL_SAFETY_LAG_MS = 2 * 60 * 1000;

export type PollIntervalPlan =
  | {
      plan: 'POLL';
      basis: PollPlanBasis;
      /** INCLUSIVE lower bound, already carrying the overlap. */
      since: Date;
      /** EXCLUSIVE upper bound. What a successful run would advance to. */
      until: Date;
      /**
       * True when the span ceiling, not the clock, chose `until`.
       *
       * A poller that has been off for a month cannot read the month in one
       * request. It reads a ceiling-wide chunk, advances the checkpoint to the
       * END OF THAT CHUNK, and continues from there next time. The alternative --
       * moving `since` forward to fit -- would skip everything in between while
       * advancing as though it had not.
       */
      cappedBySpan: boolean;
    }
  | { plan: 'NOTHING_DUE'; basis: PollPlanBasis; reason: string };

export interface PollIntervalInput {
  /**
   * The provider time coverage has been PROVEN through, or null when no routine
   * interval has ever been proven complete. Null is not zero and not "the
   * beginning of time": it selects the bootstrap lookback.
   */
  completedThrough: Date | null;
  now: Date;
  policy: PollIntervalPolicy;
}

function finite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Choose the next routine interval, or say there is nothing to read.
 *
 * FAILS CLOSED. Every refusal returns NOTHING_DUE, which reads nothing and
 * therefore advances nothing. There is no path here that returns an interval it
 * is unsure about.
 */
export function planPollInterval(input: PollIntervalInput): PollIntervalPlan {
  const { completedThrough, now, policy } = input;
  const basis: PollPlanBasis = completedThrough ? 'CHECKPOINT' : 'BOOTSTRAP';

  if (
    !finite(policy.overlapMs) ||
    !finite(policy.bootstrapLookbackMs) ||
    !finite(policy.safetyLagMs) ||
    !finite(policy.maxSpanMs) ||
    policy.maxSpanMs === 0
  ) {
    return { plan: 'NOTHING_DUE', basis, reason: 'The interval policy is not usable.' };
  }
  if (!Number.isFinite(now.getTime())) {
    return { plan: 'NOTHING_DUE', basis, reason: 'The supplied clock is not a valid instant.' };
  }
  if (completedThrough && !Number.isFinite(completedThrough.getTime())) {
    return { plan: 'NOTHING_DUE', basis, reason: 'The stored checkpoint is not a valid instant.' };
  }

  const safeNow = now.getTime() - policy.safetyLagMs;

  // THE LOWER BOUND. With a checkpoint it is the proven boundary pulled back by
  // the overlap; without one it is a bounded reach into the recent past. Neither
  // is a claim: both are where reading starts.
  const sinceMs = completedThrough
    ? completedThrough.getTime() - policy.overlapMs
    : safeNow - policy.bootstrapLookbackMs;

  // THE UPPER BOUND. The clock, or the span ceiling, whichever is nearer. The
  // ceiling is applied to `until` and never to `since`, so a long outage is
  // caught up in chunks rather than jumped over.
  const untilMs = Math.min(safeNow, sinceMs + policy.maxSpanMs);

  if (untilMs <= sinceMs) {
    return {
      plan: 'NOTHING_DUE',
      basis,
      reason:
        'The next interval would be empty or reversed. Coverage already reaches the safe boundary.',
    };
  }

  return {
    plan: 'POLL',
    basis,
    since: new Date(sinceMs),
    until: new Date(untilMs),
    cappedBySpan: untilMs < safeNow,
  };
}
