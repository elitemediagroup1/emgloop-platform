// Truth States — constructors and repository helpers.
//
// Every constructor takes `measuredAt` explicitly. This module has no clock, no
// I/O and no randomness, so a Truth is reproducible and testable: the same
// inputs always produce the same object. That discipline is inherited from
// @emgloop/brain and is worth keeping at the kernel.

import type { Coverage, Reason, Truth, TruthError, TruthEvidenceRef } from './state';

export interface TruthMeta {
  /** ISO-8601. Required — a measurement without a time cannot be reasoned about later. */
  measuredAt: string;
  evidence?: readonly TruthEvidenceRef[];
  subject?: string;
}

const base = (meta: TruthMeta) => ({
  measuredAt: meta.measuredAt,
  evidence: meta.evidence ?? [],
  ...(meta.subject === undefined ? {} : { subject: meta.subject }),
});

/** The query completed and the data is complete. */
export function success<T>(value: T, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'success', value };
}

/**
 * The query completed and the measured value is genuinely zero.
 *
 * The caller passes the zero explicitly (`0`, `[]`, `{}`) because "the zero of
 * T" is not something this module can know. Requiring it also forces the author
 * to have actually decided that zero is the truth here, rather than reaching for
 * EMPTY as a convenient default when they mean UNKNOWN.
 */
export function empty<T>(zeroValue: T, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'empty', value: zeroValue };
}

/**
 * The query completed over part of the data. The value is a LOWER BOUND.
 * Coverage is mandatory in the type — a partial result that cannot say how
 * partial is indistinguishable from a complete one.
 */
export function partial<T>(value: T, coverage: Coverage, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'partial', value, coverage };
}

/** Not enough evidence to answer. Carries no value, by design. */
export function unknown<T>(reason: Reason, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'unknown', reason };
}

/** The answer cannot currently exist — unexposed, unmapped, or structurally absent. */
export function unavailable<T>(reason: Reason, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'unavailable', reason };
}

/** A measurement was attempted and failed. */
export function failed<T>(error: TruthError, meta: TruthMeta): Truth<T> {
  return { ...base(meta), state: 'error', error };
}

// --- Repository helpers ----------------------------------------------------

/**
 * Classify a completed numeric read into SUCCESS or EMPTY.
 *
 * The distinction this draws is the one repositories get wrong: a count of 0
 * from a query that ran fine is EMPTY (a real measurement), not UNKNOWN. Use
 * this only when the read genuinely completed over the whole population.
 */
export function measuredCount(value: number, meta: TruthMeta): Truth<number> {
  return value === 0 ? empty(0, meta) : success(value, meta);
}

/**
 * Classify a completed list read into SUCCESS or EMPTY.
 */
export function measuredList<T>(items: readonly T[], meta: TruthMeta): Truth<readonly T[]> {
  return items.length === 0 ? empty([] as readonly T[], meta) : success(items, meta);
}

/**
 * Classify a bounded read that may have hit a cap.
 *
 * When `capBound` is true the result is PARTIAL and the value is explicitly a
 * lower bound; otherwise it is SUCCESS/EMPTY. This is the shape the marketplace
 * revenue and traffic reads already produce via QueryCoverage.
 */
export function measuredBounded<T>(
  value: T,
  opts: { capBound: boolean; coverage: Coverage; isZero: boolean },
  meta: TruthMeta,
): Truth<T> {
  if (opts.capBound) return partial(value, opts.coverage, meta);
  return opts.isZero ? empty(value, meta) : success(value, meta);
}

/** Map a thrown value onto a structured TruthError. Transient causes stay retryable. */
export function errorFromException(e: unknown): TruthError {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return { code: 'provider-timeout', summary: 'The provider did not respond in time.', detail: message, retryable: true };
  }
  if (lower.includes('econnrefused') || lower.includes('connection') || lower.includes('terminated')) {
    return { code: 'db-unavailable', summary: 'The database was unreachable.', detail: message, retryable: true };
  }
  if (lower.includes('auth') || lower.includes('permission') || lower.includes('denied')) {
    return { code: 'provider-auth-failed', summary: 'The measurement was refused by the provider.', detail: message, retryable: false };
  }
  return { code: 'repository-exception', summary: 'The measurement failed.', detail: message, retryable: false };
}

/**
 * Run a repository read and convert BOTH outcomes into a Truth.
 *
 * This is the adoption lever: wrapping a read here means a thrown exception
 * becomes ERROR rather than propagating into a caller that will render zero.
 * A read that throws is a fact about the system, not an empty result.
 */
export async function measure<T>(
  read: () => Promise<T>,
  classify: (value: T, meta: TruthMeta) => Truth<T>,
  meta: TruthMeta,
): Promise<Truth<T>> {
  try {
    return classify(await read(), meta);
  } catch (e) {
    return failed<T>(errorFromException(e), meta);
  }
}

/**
 * Combine several measurements into one posture, worst-state-wins.
 *
 * Ordering is deliberate: ERROR outranks UNAVAILABLE outranks UNKNOWN outranks
 * PARTIAL. A briefing built from a failed read and three good ones is not
 * three-quarters trustworthy — it is compromised, and must say so.
 */
export function weakestState<T>(truths: readonly Truth<T>[]): Truth<T>['state'] {
  const rank: Record<Truth<T>['state'], number> = {
    error: 5,
    unavailable: 4,
    unknown: 3,
    partial: 2,
    empty: 1,
    success: 0,
  };
  return truths.reduce<Truth<T>['state']>(
    (worst, t) => (rank[t.state] > rank[worst] ? t.state : worst),
    'success',
  );
}
