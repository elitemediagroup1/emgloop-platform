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

// --- Coverage-aware summation ----------------------------------------------
//
// This is where fabricated zeros are actually born. `total += value ?? 0` looks
// harmless and is the single most common way an unknown becomes a confident
// number: a row whose amount the provider never sent contributes 0, and the sum
// is then presented as complete. Row-level nulls are honest — the sensor really
// did not say — so the fix is not to wrap every field, it is to stop LOSING
// that fact when the rows are added up.

export interface SumCoverage {
  /** Sum of the values that were actually known. */
  total: number;
  /** Rows that carried a value. */
  counted: number;
  /** Rows examined whose value was absent. */
  missing: number;
}

/** Sum only what is known, and keep count of what was not. Never coerces null to 0. */
export function sumKnown(values: Iterable<number | null | undefined>): SumCoverage {
  let total = 0;
  let counted = 0;
  let missing = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      counted += 1;
    } else {
      missing += 1;
    }
  }
  return { total, counted, missing };
}

/**
 * Turn a coverage-aware sum into the right Truth state.
 *
 * The four-way mapping is the whole point, and each branch is a different fact:
 *
 *   no rows at all           → EMPTY   (measured; genuinely nothing)
 *   all rows carried a value → SUCCESS (complete)
 *   some rows did            → PARTIAL (a lower bound, with real coverage)
 *   rows existed, none did   → UNKNOWN (we have rows but know no amounts)
 *
 * That last case is the one `?? 0` got most wrong: summing five orders whose
 * totals are all unknown produced `0`, which reads as "these orders were worth
 * nothing" rather than "we cannot price these orders".
 */
export function truthFromSum(sum: SumCoverage, reason: Reason, meta: TruthMeta): Truth<number> {
  const examined = sum.counted + sum.missing;

  if (examined === 0) return empty(0, meta);
  if (sum.missing === 0) return success(sum.total, meta);

  if (sum.counted === 0) {
    return unknown<number>(
      {
        ...reason,
        summary: `${reason.summary} None of the ${examined} record(s) examined carried a value.`,
      },
      meta,
    );
  }

  return partial(
    sum.total,
    {
      observed: sum.counted,
      total: examined,
      reason: {
        ...reason,
        summary: `${reason.summary} ${sum.missing} of ${examined} record(s) had no value, so this total is a lower bound.`,
      },
    },
    meta,
  );
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
