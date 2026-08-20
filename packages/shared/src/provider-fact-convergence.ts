// Mutable provider fact convergence — Commercial Intelligence Stage 3.
//
// THE PROBLEM THIS EXISTS FOR
//
// CallGrid records mutate after the call ends. For POSTBACK destinations the
// provider says so itself: "BillableType is POSTBACK. Revenue and billable will
// be set when the postback is received." A poller re-reading a 48-hour overlap
// therefore sees the same call many times, and later answers may differ from
// earlier ones.
//
// The dangerous half is that CallGrid's representation of "not yet" and its
// representation of "no" are THE SAME BYTES. `CallRevenue: "0"` is a final zero
// or a pending postback. `CallBillable: false` is a settled non-billable call or
// a pending postback. Nothing on the list endpoint distinguishes them, and there
// is no per-call updatedAt to ask.
//
// So the naive rules are all wrong, and each is wrong in a way that destroys
// money:
//
//   latest payload wins      a pending zero erases a settled $17
//   latest non-null wins     same, because a pending zero is not null
//   REST beats webhook       transport is not evidence
//   positive always wins     cannot distinguish a correction from a conflict
//
// THE RULE
//
// A later observation may be MORE CURRENT without being MORE AUTHORITATIVE.
// UNKNOWN never erases KNOWN. AMBIGUOUS never erases KNOWN. A provider POSITIVE
// may strengthen an unknown or ambiguous value, because a positive is the one
// thing the provider only says when it means it -- a postback that has not
// arrived cannot invent $17.
//
// WHAT THIS FUNCTION IS NOT. It is not first-write policy. The first observation
// of a call writes what the provider said, including a zero, because at that
// moment there is nothing to protect and no reason to disbelieve it. This governs
// only what a LATER observation may do to a fact that already exists -- which is
// why a genuinely final zero stays perfectly representable.
//
// PURE. No clock, no I/O, no provider knowledge beyond the classification handed
// in. Same inputs, same decision, in a test or six months from now.

/** What a later observation is allowed to do to an existing canonical fact. */
export const FACT_CONVERGENCE_DECISIONS = [
  /** The existing value stands. The observation adds nothing usable. */
  'KEEP_EXISTING',
  /** The observation is a safe strengthening. Write it. */
  'UPDATE',
  /** Nothing is known before or after. Write nothing rather than a guess. */
  'REMAIN_UNKNOWN',
  /** Two incompatible assertions. NOTHING is written and a person decides. */
  'CONFLICT',
] as const;

export type FactConvergenceDecision = (typeof FACT_CONVERGENCE_DECISIONS)[number];

/**
 * How a fact behaves over time. Assigned per field from provider evidence, never
 * guessed from a type.
 */
export const FACT_KINDS = [
  /** Identity or occurrence. It cannot change; a difference is a defect. */
  'IMMUTABLE',
  /**
   * A boolean the provider asserts only when it is true. `false` is
   * indistinguishable from "not yet", so false neither asserts nor erases.
   */
  'MONOTONIC_ASSERTION',
  /**
   * An amount the provider settles upward from an ambiguous zero. A positive is
   * an assertion; a zero is not evidence of anything.
   */
  'MONOTONIC_AMOUNT',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export interface FactConvergence<T> {
  decision: FactConvergenceDecision;
  /** The value to persist. Present ONLY on UPDATE. */
  value?: T;
  /** One plain sentence, for the revision record and for a human reading it. */
  reason: string;
}

/**
 * The CallGrid facts this rule governs, and how each behaves.
 *
 * DELIBERATELY SHORT. Every member here is backed by provider evidence about
 * that specific field. A fact whose settlement semantics are unresolved is
 * ABSENT rather than given a plausible-looking kind -- descriptive fields
 * (labels, geography, status, duration) may legitimately change and there is no
 * established downstream reason to refresh them, so they are not converged at
 * all until there is one.
 *
 * `cost` is absent for the same reason: it is CallGrid's telco cost, no evidence
 * establishes that it settles upward, and money must not be given a monotonic
 * rule on symmetry with revenue alone.
 */
export const CALLGRID_FACT_KINDS = {
  revenue: 'MONOTONIC_AMOUNT',
  payout: 'MONOTONIC_AMOUNT',
  billable: 'MONOTONIC_ASSERTION',
  paid: 'MONOTONIC_ASSERTION',
  converted: 'MONOTONIC_ASSERTION',
  occurredAt: 'IMMUTABLE',
  externalId: 'IMMUTABLE',
} as const satisfies Record<string, FactKind>;

export type CallGridFact = keyof typeof CALLGRID_FACT_KINDS;

export function isCallGridFact(value: unknown): value is CallGridFact {
  return typeof value === 'string' && Object.hasOwn(CALLGRID_FACT_KINDS, value);
}

/** Absent, in every shape a payload uses to say it. */
function unknown(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * What a later observation may do to one existing canonical fact.
 *
 * Read the MONOTONIC_AMOUNT branch as a table -- it is the one that decides
 * money, and every row of it was chosen against a way of losing some:
 *
 *   existing   incoming   decision         why
 *   unknown    positive   UPDATE           the provider only says $17 when it means it
 *   unknown    zero       REMAIN_UNKNOWN   a pending postback looks exactly like this
 *   zero       positive   UPDATE           the postback arrived; the zero was "not yet"
 *   positive   zero       KEEP_EXISTING    a settled amount is not un-earned by silence
 *   positive   same       KEEP_EXISTING    nothing changed
 *   positive   different  CONFLICT         a correction and a defect look identical
 */
export function convergeFact<T>(input: {
  kind: FactKind;
  existing: T | null | undefined;
  incoming: T | null | undefined;
}): FactConvergence<T> {
  const { kind, existing, incoming } = input;

  if (kind === 'IMMUTABLE') {
    if (unknown(incoming)) return { decision: 'KEEP_EXISTING', reason: 'the observation says nothing' };
    if (unknown(existing)) {
      return { decision: 'UPDATE', value: incoming as T, reason: 'first value for an immutable fact' };
    }
    if (Object.is(existing, incoming) || String(existing) === String(incoming)) {
      return { decision: 'KEEP_EXISTING', reason: 'unchanged' };
    }
    return {
      decision: 'CONFLICT',
      reason: 'an immutable fact was observed with a different value; this is a defect, not a correction',
    };
  }

  if (kind === 'MONOTONIC_ASSERTION') {
    if (incoming === true) {
      return existing === true
        ? { decision: 'KEEP_EXISTING', reason: 'already asserted' }
        : { decision: 'UPDATE', value: true as T, reason: 'the provider asserted it; a positive is only said when meant' };
    }
    // FALSE AND ABSENT ARE THE SAME EVIDENCE HERE, and that is the whole point.
    // A postback that has not arrived reports false, so a false can neither
    // establish a negative nor take one back.
    if (existing === true) {
      return { decision: 'KEEP_EXISTING', reason: 'an ambiguous false may not erase an asserted true' };
    }
    if (unknown(existing)) {
      return { decision: 'REMAIN_UNKNOWN', reason: 'a pending postback and a settled false are indistinguishable' };
    }
    return { decision: 'KEEP_EXISTING', reason: 'already false, and nothing new was asserted' };
  }

  // MONOTONIC_AMOUNT
  const existingNumber = typeof existing === 'number' && Number.isFinite(existing) ? existing : null;
  const incomingNumber = typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : null;

  if (incomingNumber === null || incomingNumber === 0) {
    if (existingNumber !== null && existingNumber > 0) {
      return { decision: 'KEEP_EXISTING', reason: 'an ambiguous zero may not erase a settled amount' };
    }
    if (existingNumber === null) {
      return { decision: 'REMAIN_UNKNOWN', reason: 'a pending postback and a settled zero are indistinguishable' };
    }
    return { decision: 'KEEP_EXISTING', reason: 'already zero, and nothing new was asserted' };
  }
  if (existingNumber === null || existingNumber === 0) {
    return {
      decision: 'UPDATE',
      value: incomingNumber as T,
      reason: existingNumber === 0 ? 'the postback settled a pending zero' : 'the provider settled an unknown amount',
    };
  }
  if (existingNumber === incomingNumber) return { decision: 'KEEP_EXISTING', reason: 'unchanged' };
  return {
    decision: 'CONFLICT',
    reason: 'two different settled amounts; a provider correction and a defect are indistinguishable here',
  };
}
