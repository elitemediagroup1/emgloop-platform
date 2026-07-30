// Operational lifecycle — the pure projection from an immutable observation log
// to the current state of a priority.
//
// THIS FILE IS THE DEFINITION OF "CURRENT STATE". The `state`, `ownerUserId`,
// `reopenCount`, `resolvedAt` and `outcome` columns on `operational_priorities`
// are a cache written by `projectLifecycle` in the same transaction as the
// observation that causes them; they exist so a lane can be served by an index
// instead of replaying every log. If the columns and the log ever disagree, the
// log is right and the columns are rebuilt from it.
//
// WHY EVENT-SOURCED. A priority is not a status, it is a journey: detected,
// assigned, contacted, waited on, resolved, and — often — detected again months
// later. Collapsing that to `status` + `resolvedAt` would answer "what is
// happening now" and permanently destroy every question worth asking later:
// how long does recovery take, which interventions work, how often is Loop
// wrong, does contacting within a day matter. Those are statements about a
// distribution of events, and they can only be asked of a log that kept them.
//
// PURE. No clock, no I/O, no randomness. Anything that needs "now" takes it as
// an argument, so a test can state the instant it is reasoning about and a
// fixture cannot rot as the calendar moves.
//
// GENERIC. Nothing here knows what CallGrid is. These are the primitives of the
// DECISION CENTER — the one place in Loop where a decision is made, owned and
// closed, whatever noticed it. CallGrid Intelligence is the first producer to
// arrive; CRM, Accounting, Marketing, Website, Support and Creator intelligence
// are expected to follow, and each is a `sourceSystem` value rather than a new
// table.

export const LIFECYCLE_PROJECTION_VERSION = 'v1';

// --- The vocabulary ---------------------------------------------------------
//
// Mirrors the Prisma enums exactly. Duplicated rather than imported because
// @emgloop/shared must stay Prisma-free — a web consumer depends on this
// contract, never on persistence. The pairing is held by a test in the database
// package that walks the generated enums against these arrays, so a schema
// change that forgets this file fails the suite rather than drifting silently.

export const PRIORITY_STATES = [
  'NEEDS_REVIEW',
  'ASSIGNED',
  'WATCHING',
  'RESOLVED',
  'DISMISSED',
] as const;
export type PriorityState = (typeof PRIORITY_STATES)[number];

export const OBSERVATION_TYPES = [
  'SITUATION_DETECTED',
  'SITUATION_RESIGHTED',
  'REOPENED',
  'REVIEWED',
  'ASSIGNED',
  'OWNER_CHANGED',
  'WATCH_STARTED',
  'WATCH_STOPPED',
  'NOTE_ADDED',
  'CONTACT_ATTEMPTED',
  'CONTACT_COMPLETED',
  'AWAITING_RESPONSE',
  'RESPONSE_RECEIVED',
  'ESCALATED',
  'OUTCOME_RECORDED',
  'RESOLVED',
  'DISMISSED',
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const OPERATIONAL_OUTCOMES = [
  'RECOVERED',
  'PARTIALLY_RECOVERED',
  'NOT_RECOVERED',
  'NO_ACTION_NEEDED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK',
  'NOT_ACTIONABLE',
  'UNKNOWN',
] as const;
export type OperationalOutcome = (typeof OPERATIONAL_OUTCOMES)[number];

export type LifecycleActorType = 'HUMAN' | 'SYSTEM';

/** Lanes an operator can move an item into by deciding. */
export const CLOSED_STATES: readonly PriorityState[] = ['RESOLVED', 'DISMISSED'];
export function isClosed(state: PriorityState): boolean {
  return CLOSED_STATES.includes(state);
}

/**
 * Outcomes that mean "Loop should not have raised this".
 *
 * Used for the false-positive rate, which is the single most important number
 * Loop can publish about itself: a system that never reports how often it was
 * wrong cannot be calibrated by the person relying on it.
 */
export const FALSE_POSITIVE_OUTCOMES: readonly OperationalOutcome[] = [
  'FALSE_POSITIVE',
  'NO_ACTION_NEEDED',
];

// --- The log entry ----------------------------------------------------------

/** One immutable fact. Mirrors an `operational_observations` row, Prisma-free. */
export interface LifecycleObservation {
  id: string;
  /** Monotonic per priority. The projection's ordering key — see below. */
  sequence: number;
  observationType: ObservationType;
  /** When it happened in the world. */
  occurredAt: Date;
  /** When Loop learned about it. */
  recordedAt: Date;
  actorType: LifecycleActorType;
  actorUserId: string | null;
  source: string;
  note: string | null;
  assignedToUserId: string | null;
  outcome: OperationalOutcome | null;
  measuredEffectCents: number | null;
  measuredEffectBasis: string | null;
}

/** Exactly the projection columns on `operational_priorities`. */
export interface LifecycleProjection {
  state: PriorityState;
  ownerUserId: string | null;
  stateChangedAt: Date | null;
  reopenCount: number;
  resolvedAt: Date | null;
  outcome: OperationalOutcome | null;
  measuredEffectCents: number | null;
  observationCount: number;
  lastObservationAt: Date | null;
  projectionVersion: string;
}

/**
 * Order the log.
 *
 * By `sequence`, which is the order Loop LEARNED things — deliberately not by
 * `occurredAt`. An operator who records on Thursday that they called on Tuesday
 * is adding a fact to the end of the log, not rewriting Wednesday's decision to
 * assign it. Ordering by occurrence would let a backdated note silently reorder
 * decisions that were made in full knowledge of what preceded them, which is how
 * an audit trail becomes untrustworthy. The timeline UI can and does sort by
 * `occurredAt` for display; state must not.
 */
export function orderLog(
  observations: readonly LifecycleObservation[],
): LifecycleObservation[] {
  return [...observations].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/**
 * Replay the log into the current state.
 *
 * Total and deterministic: the same log always produces the same projection, in
 * any process, at any time. An empty log yields the opening state (NEEDS_REVIEW,
 * unowned) rather than throwing — a priority whose observations failed to load
 * must read as "needs review", never as resolved.
 */
export function projectLifecycle(
  observations: readonly LifecycleObservation[],
): LifecycleProjection {
  const log = orderLog(observations);

  let state: PriorityState = 'NEEDS_REVIEW';
  let ownerUserId: string | null = null;
  let stateChangedAt: Date | null = null;
  let reopenCount = 0;
  let resolvedAt: Date | null = null;
  let outcome: OperationalOutcome | null = null;
  let measuredEffectCents: number | null = null;
  let lastObservationAt: Date | null = null;

  const enter = (next: PriorityState, at: Date) => {
    if (next !== state) stateChangedAt = at;
    state = next;
  };

  for (const o of log) {
    lastObservationAt = o.occurredAt;

    switch (o.observationType) {
      // --- Producer facts -------------------------------------------------
      case 'SITUATION_DETECTED':
        // Opening fact. The state is already NEEDS_REVIEW; stamping the change
        // time here gives "unreviewed for N days" an honest starting point.
        if (stateChangedAt === null) stateChangedAt = o.occurredAt;
        break;

      case 'SITUATION_RESIGHTED':
        // Still happening. Deliberately does NOT touch the lane: an item someone
        // owns does not go back to needing review because the engine ran again.
        break;

      case 'REOPENED':
        // Closed, and then observed again. This is the fact that makes "resolved"
        // meaningful — a resolution that did not hold is the most informative
        // event in the log, and it must never be silently overwritten.
        reopenCount += 1;
        resolvedAt = null;
        outcome = null;
        enter('NEEDS_REVIEW', o.occurredAt);
        break;

      // --- Operator decisions ----------------------------------------------
      case 'REVIEWED':
        // A human looked. Deliberately NOT a lane change: this queue is cleared
        // by deciding, not by reading. Recording it lets Loop distinguish "nobody
        // has looked at this" from "somebody looked and chose not to act yet",
        // which are very different operational facts.
        break;

      case 'ASSIGNED':
        ownerUserId = o.assignedToUserId;
        enter('ASSIGNED', o.occurredAt);
        break;

      case 'OWNER_CHANGED':
        // Ownership moves without disturbing the lane. Reassigning a watched item
        // must not drag it out of WATCHING, and reassigning a closed one must not
        // resurrect it.
        ownerUserId = o.assignedToUserId;
        break;

      case 'WATCH_STARTED':
        enter('WATCHING', o.occurredAt);
        break;

      case 'WATCH_STOPPED':
        // Falls back to where it belongs rather than to a fixed lane: an owned
        // item returns to its owner, an unowned one returns to the queue.
        enter(ownerUserId ? 'ASSIGNED' : 'NEEDS_REVIEW', o.occurredAt);
        break;

      // --- Progress ---------------------------------------------------------
      // Work being done. None of these move the lane — they are what happened
      // INSIDE it, and they are the raw material for every duration statistic
      // Loop will later compute about which interventions work.
      case 'NOTE_ADDED':
      case 'CONTACT_ATTEMPTED':
      case 'CONTACT_COMPLETED':
      case 'AWAITING_RESPONSE':
      case 'RESPONSE_RECEIVED':
      case 'ESCALATED':
        break;

      case 'OUTCOME_RECORDED':
        // An outcome can be measured before the item is closed (revenue returned;
        // the operator is still watching whether it holds). Last write wins
        // rather than accumulating: a second recording is a correction far more
        // often than it is an addition, and summing would quietly inflate every
        // recovery figure Loop reports. `summarizeHistory` exposes the full set
        // so a reader can see the corrections.
        if (o.outcome !== null) outcome = o.outcome;
        if (o.measuredEffectCents !== null) measuredEffectCents = o.measuredEffectCents;
        break;

      case 'RESOLVED':
        if (o.outcome !== null) outcome = o.outcome;
        if (o.measuredEffectCents !== null) measuredEffectCents = o.measuredEffectCents;
        resolvedAt = o.occurredAt;
        enter('RESOLVED', o.occurredAt);
        break;

      case 'DISMISSED':
        if (o.outcome !== null) outcome = o.outcome;
        resolvedAt = o.occurredAt;
        enter('DISMISSED', o.occurredAt);
        break;

      default: {
        // Exhaustiveness. A new observation type cannot be added without a
        // deliberate decision about what it means for state.
        const unreachable: never = o.observationType;
        throw new Error(`Unhandled observation type: ${String(unreachable)}`);
      }
    }
  }

  return {
    state,
    ownerUserId,
    stateChangedAt,
    reopenCount,
    resolvedAt,
    outcome,
    measuredEffectCents,
    observationCount: log.length,
    lastObservationAt,
    projectionVersion: LIFECYCLE_PROJECTION_VERSION,
  };
}

// --- Operational history ----------------------------------------------------
//
// What the log knows that the projection deliberately drops. Computed on demand
// rather than stored, because none of it is needed to render a lane and all of
// it is derivable — a stored copy would be a second thing to keep true.

export interface LifecycleHistory {
  firstDetectedAt: Date | null;
  lastDetectedAt: Date | null;
  /** How many analysis runs have seen it, including the first. */
  detectionCount: number;
  timesReopened: number;
  /** Detected → the first decision that moved it out of NEEDS_REVIEW. */
  msToFirstDecision: number | null;
  /** Detected → closed. Null while open, and null if it was never detected. */
  msToResolution: number | null;
  contactAttempts: number;
  /** Every outcome ever recorded, oldest first, so corrections stay visible. */
  recordedOutcomes: { outcome: OperationalOutcome | null; cents: number | null; at: Date }[];
  /** Distinct humans who touched it. */
  humanActors: string[];
}

export function summarizeHistory(observations: readonly LifecycleObservation[]): LifecycleHistory {
  const log = orderLog(observations);

  const detections = log.filter(
    (o) => o.observationType === 'SITUATION_DETECTED' || o.observationType === 'SITUATION_RESIGHTED',
  );
  const first = log.find((o) => o.observationType === 'SITUATION_DETECTED') ?? null;

  const DECIDING: readonly ObservationType[] = [
    'ASSIGNED',
    'WATCH_STARTED',
    'RESOLVED',
    'DISMISSED',
  ];
  const firstDecision = log.find((o) => DECIDING.includes(o.observationType)) ?? null;
  const close = [...log].reverse().find(
    (o) => o.observationType === 'RESOLVED' || o.observationType === 'DISMISSED',
  ) ?? null;

  // A duration is only reported when BOTH ends are real. A missing detection
  // start would otherwise silently become epoch-to-now, and a fabricated
  // "resolved in 20,000 days" is worse than no figure.
  const span = (a: Date | null, b: Date | null): number | null =>
    a && b ? Math.max(0, b.getTime() - a.getTime()) : null;

  // Only count a close that was not later reopened.
  const reopens = log.filter((o) => o.observationType === 'REOPENED').length;
  const stillClosed =
    close !== null && !log.some((o) => o.observationType === 'REOPENED' && o.sequence > close.sequence);

  return {
    firstDetectedAt: first?.occurredAt ?? null,
    lastDetectedAt: detections[detections.length - 1]?.occurredAt ?? null,
    detectionCount: detections.length,
    timesReopened: reopens,
    msToFirstDecision: span(first?.occurredAt ?? null, firstDecision?.occurredAt ?? null),
    msToResolution: stillClosed ? span(first?.occurredAt ?? null, close.occurredAt) : null,
    contactAttempts: log.filter(
      (o) => o.observationType === 'CONTACT_ATTEMPTED' || o.observationType === 'CONTACT_COMPLETED',
    ).length,
    recordedOutcomes: log
      .filter((o) => o.outcome !== null || o.measuredEffectCents !== null)
      .map((o) => ({ outcome: o.outcome, cents: o.measuredEffectCents, at: o.occurredAt })),
    humanActors: [
      ...new Set(
        log.filter((o) => o.actorType === 'HUMAN' && o.actorUserId).map((o) => o.actorUserId!),
      ),
    ],
  };
}

// --- Decision activity ------------------------------------------------------
//
// The organisation-level view: what happened to Loop's recommendations. Every
// figure here declares the sample it was computed from, and every rate that
// cannot be computed says so rather than rendering 0% — "0% false positives" and
// "nothing has been closed yet" look identical and only one of them is a claim.

export interface DecisionActivityInput {
  state: PriorityState;
  outcome: OperationalOutcome | null;
  measuredEffectCents: number | null;
  reopenCount: number;
  msToResolution: number | null;
}

export interface Rate {
  /** Null whenever the denominator is zero — never a percentage off nothing. */
  percent: number | null;
  numerator: number;
  denominator: number;
  /** Present exactly when `percent` is null. */
  unavailableReason: string | null;
}

export interface DecisionActivity {
  total: number;
  open: number;
  needsReview: number;
  assigned: number;
  watching: number;
  resolved: number;
  dismissed: number;
  /** Sum of measured effects on CLOSED items only. Null when none was measured. */
  measuredEffectCents: number | null;
  measuredEffectSample: number;
  falsePositiveRate: Rate;
  reopenRate: Rate;
  /** Median, not mean: one six-month straggler must not define "typical". */
  medianResolutionMs: number | null;
  medianResolutionSample: number;
  /** Stated whenever the sample is too small for any rate to mean anything. */
  insufficientHistory: string | null;
}

/** Below this, a rate is arithmetic rather than evidence, and says so. */
export const MIN_CLOSED_FOR_RATES = 4;

function rate(numerator: number, denominator: number, why: string): Rate {
  if (denominator <= 0) {
    return { percent: null, numerator, denominator, unavailableReason: why };
  }
  return {
    percent: Math.round((numerator / denominator) * 100),
    numerator,
    denominator,
    unavailableReason: null,
  };
}

export function summarizeDecisionActivity(
  rows: readonly DecisionActivityInput[],
): DecisionActivity {
  const by = (s: PriorityState) => rows.filter((r) => r.state === s).length;
  const closed = rows.filter((r) => isClosed(r.state));

  const measured = closed.filter((r) => r.measuredEffectCents !== null);
  const durations = closed
    .map((r) => r.msToResolution)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  const median = durations.length
    ? durations.length % 2 === 1
      ? durations[(durations.length - 1) / 2]!
      : Math.round((durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2)
    : null;

  return {
    total: rows.length,
    open: rows.filter((r) => !isClosed(r.state)).length,
    needsReview: by('NEEDS_REVIEW'),
    assigned: by('ASSIGNED'),
    watching: by('WATCHING'),
    resolved: by('RESOLVED'),
    dismissed: by('DISMISSED'),
    measuredEffectCents: measured.length
      ? measured.reduce((sum, r) => sum + (r.measuredEffectCents ?? 0), 0)
      : null,
    measuredEffectSample: measured.length,
    falsePositiveRate: rate(
      closed.filter((r) => r.outcome !== null && FALSE_POSITIVE_OUTCOMES.includes(r.outcome))
        .length,
      closed.filter((r) => r.outcome !== null).length,
      'No closed priority has recorded an outcome yet, so how often Loop was wrong cannot be measured.',
    ),
    reopenRate: rate(
      rows.filter((r) => r.reopenCount > 0).length,
      closed.length,
      'Nothing has been closed yet, so how often a resolution fails to hold cannot be measured.',
    ),
    medianResolutionMs: median,
    medianResolutionSample: durations.length,
    insufficientHistory:
      closed.length < MIN_CLOSED_FOR_RATES
        ? `Not enough history yet. Rates need ${MIN_CLOSED_FOR_RATES} closed priorities; there ${closed.length === 1 ? 'is' : 'are'} ${closed.length}.`
        : null,
  };
}

// --- Standing, from the record ----------------------------------------------
//
// What the operational record knows that a single analysis run cannot: whether
// this is the first sighting, how persistent it has been, and whether it was
// closed and came back.
//
// This is the half of "how bad is this" that the engine has to withhold. The
// engine reads one window and can only observe SPREADING; everything else —
// new, recurring, relapsed — is a statement about sightings over time, and the
// log is the only place those exist. Kept here rather than in the engine so the
// engine stays a pure function of one report.

export interface Standing {
  /** Mirrors the engine's escalation vocabulary so a surface renders one thing. */
  state: 'NEW' | 'HOLDING' | 'GETTING_WORSE' | 'UNKNOWN';
  basis: string;
  /** True when this has been closed at least once and detected again. */
  relapsed: boolean;
}

/**
 * Classify how a priority is standing, from detection facts alone.
 *
 * Deliberately conservative. It says how OFTEN something has been seen and
 * whether a resolution failed to hold — both directly counted — and never
 * whether the underlying number is getting bigger, which is the engine's job and
 * needs the metric series, not the sighting log. A relapse outranks persistence
 * because a resolution that did not hold is a stronger signal than a problem
 * nobody has closed yet.
 */
export function standingOf(record: {
  detectionCount: number;
  reopenCount: number;
}): Standing {
  if (record.reopenCount > 0) {
    return {
      state: 'GETTING_WORSE',
      basis:
        record.reopenCount === 1
          ? 'This was closed once and has been detected again. A resolution that did not hold.'
          : `This has been closed and detected again ${record.reopenCount} times.`,
      relapsed: true,
    };
  }
  if (record.detectionCount <= 1) {
    return {
      state: 'NEW',
      basis: 'First period in which Loop has detected this.',
      relapsed: false,
    };
  }
  return {
    state: 'HOLDING',
    basis: `Detected in ${record.detectionCount} analysis periods and still open. Whether the underlying number is worsening or easing is a separate question the period comparison answers.`,
    relapsed: false,
  };
}
