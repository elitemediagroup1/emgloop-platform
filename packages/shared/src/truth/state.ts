// Truth States — the platform's semantic model for "what do we actually know".
//
// WHY THIS EXISTS
//
// EMG Loop could not distinguish six genuinely different facts about a number:
// the query succeeded, the value is truly zero, only part was measured, we lack
// the evidence to say, the answer cannot exist yet, or the measurement failed.
// All six collapsed into `0`, `$0` or "No data". A database outage rendered
// pixel-identically to a healthy, empty marketplace. That is not a formatting
// bug; it is the platform asserting knowledge it does not have.
//
// THE DESIGN RULE THAT MAKES THIS WORK
//
// `value` does not exist on the union members that have no value. This is not a
// convention — it is the type. Reaching for `.value` on a Truth that might be
// UNKNOWN is a COMPILE ERROR, not a silent zero:
//
//     const revenue: Truth<number> = ...
//     money(revenue.value)        // ✗ does not compile
//     if (hasValue(revenue)) money(revenue.value)   // ✓ narrowed, legitimate
//
// A framework that merely *asks* engineers to check the state would fail the
// only test that matters: could someone accidentally render UNKNOWN as zero.
// Here they cannot, because there is nothing to render.
//
// DELIBERATELY ABSENT: there is no `valueOr(truth, 0)` helper anywhere in this
// module, and there must never be one. It would be the single most convenient
// way to reintroduce every bug this model exists to prevent.

/** The six states. Every measurement in the platform is exactly one of these. */
export type TruthState =
  /** Query completed, data complete, measurement trustworthy. */
  | 'success'
  /** Query completed. The measured value is genuinely zero. NOT unknown. */
  | 'empty'
  /** Query completed over part of the data. Coverage and cause are both known. */
  | 'partial'
  /** Insufficient evidence to answer. Not an error — we simply have not seen enough. */
  | 'unknown'
  /** The answer cannot currently exist: the provider does not expose it, or it is unmapped. */
  | 'unavailable'
  /** A measurement was attempted and failed. */
  | 'error';

/**
 * Why a measurement is not a plain success. Machine-readable `code` for logic
 * and metrics; prose for the operator. `unblockedBy` is what makes this useful
 * rather than merely honest — it names the next step.
 */
export interface Reason {
  /** Stable, machine-readable. e.g. 'no-calls-ingested', 'provider-field-unmapped'. */
  code: string;
  /** One line, operator-facing, plain language. */
  summary: string;
  detail?: string;
  /** The action that would resolve this. */
  unblockedBy?: string;
  /** Which sensor/system supplies the missing thing, so the reader knows who to ask. */
  provider?: string;
  /** Where this claim can be checked. */
  citation?: string;
}

/**
 * How much of the intended data was actually measured. Required on PARTIAL —
 * a partial result without coverage is indistinguishable from a complete one,
 * which is exactly the failure this model prevents.
 */
export interface Coverage {
  observed: number;
  /**
   * The true denominator, or null when the denominator is ITSELF unknown
   * (e.g. provider pagination that never reported a total). Null here is
   * honest; defaulting it to `observed` would fake completeness.
   */
  total: number | null;
  reason: Reason;
}

/** A failed measurement. `retryable` lets a caller distinguish transient from structural. */
export interface TruthError {
  code:
    | 'db-unavailable'
    | 'db-not-configured'
    | 'provider-timeout'
    | 'provider-auth-failed'
    | 'repository-exception'
    | 'unspecified';
  summary: string;
  detail?: string;
  retryable: boolean;
}

/**
 * Minimal reference to a supporting record.
 *
 * Deliberately structural and minimal so that `@emgloop/brain`'s richer
 * `Evidence` is assignable to it without redeclaration. Brain remains the
 * canonical owner of evidence semantics; this is the kernel subset the shared
 * layer needs, and shared cannot depend on brain (brain depends on shared).
 */
export interface TruthEvidenceRef {
  kind: string;
  description: string;
  ref?: string;
}

interface TruthBase {
  /** ISO-8601. Injected by the caller — this module has no clock. */
  measuredAt: string;
  /** Records supporting the measurement. Empty is allowed; absent is not. */
  evidence: readonly TruthEvidenceRef[];
  /** Optional label for what was measured, useful in logs and serialized payloads. */
  subject?: string;
}

/**
 * A measured value and everything known about how far to trust it.
 *
 * Note which members carry `value` and which do not — that asymmetry IS the
 * safety property. EMPTY carries a value because "genuinely zero" is a
 * measurement; UNKNOWN does not, because there is nothing to report.
 */
export type Truth<T> =
  | (TruthBase & { state: 'success'; value: T })
  | (TruthBase & { state: 'empty'; value: T })
  | (TruthBase & { state: 'partial'; value: T; coverage: Coverage })
  | (TruthBase & { state: 'unknown'; reason: Reason })
  | (TruthBase & { state: 'unavailable'; reason: Reason })
  | (TruthBase & { state: 'error'; error: TruthError });

/** The states that carry a value. Narrowing through this is the ONLY safe way to read one. */
export type ValueBearing<T> = Extract<Truth<T>, { value: T }>;

// --- Guards ----------------------------------------------------------------

export const isSuccess = <T>(t: Truth<T>): t is TruthBase & { state: 'success'; value: T } =>
  t.state === 'success';

export const isEmpty = <T>(t: Truth<T>): t is TruthBase & { state: 'empty'; value: T } =>
  t.state === 'empty';

export const isPartial = <T>(t: Truth<T>): t is TruthBase & { state: 'partial'; value: T; coverage: Coverage } =>
  t.state === 'partial';

export const isUnknown = <T>(t: Truth<T>): t is TruthBase & { state: 'unknown'; reason: Reason } =>
  t.state === 'unknown';

export const isUnavailable = <T>(t: Truth<T>): t is TruthBase & { state: 'unavailable'; reason: Reason } =>
  t.state === 'unavailable';

export const isError = <T>(t: Truth<T>): t is TruthBase & { state: 'error'; error: TruthError } =>
  t.state === 'error';

/**
 * Narrows to the states that actually carry a value. This is the intended
 * gateway: `if (hasValue(t)) { ...t.value... }`.
 */
export const hasValue = <T>(t: Truth<T>): t is ValueBearing<T> =>
  t.state === 'success' || t.state === 'empty' || t.state === 'partial';

/**
 * Whether this measurement may be presented as complete and final.
 * PARTIAL deliberately returns false: it has a value, but that value is a
 * lower bound and must never be shown without its coverage.
 */
export const isComplete = <T>(t: Truth<T>): boolean => t.state === 'success' || t.state === 'empty';

/**
 * THE ZERO RULE, as an executable predicate.
 *
 * Only SUCCESS and EMPTY may render a numeric zero. Everything else showing "0"
 * is the platform claiming a measurement it does not have. Renderers assert on
 * this; tests assert on it for every state.
 */
export const mayRenderZero = <T>(t: Truth<T>): boolean => t.state === 'success' || t.state === 'empty';

/** The explanatory reason, where one exists. Errors carry a TruthError instead. */
export const reasonOf = <T>(t: Truth<T>): Reason | null =>
  t.state === 'unknown' || t.state === 'unavailable'
    ? t.reason
    : t.state === 'partial'
      ? t.coverage.reason
      : null;

// --- Exhaustive handling ---------------------------------------------------

export interface TruthHandlers<T, R> {
  success: (value: T, truth: Extract<Truth<T>, { state: 'success' }>) => R;
  empty: (value: T, truth: Extract<Truth<T>, { state: 'empty' }>) => R;
  partial: (value: T, coverage: Coverage, truth: Extract<Truth<T>, { state: 'partial' }>) => R;
  unknown: (reason: Reason, truth: Extract<Truth<T>, { state: 'unknown' }>) => R;
  unavailable: (reason: Reason, truth: Extract<Truth<T>, { state: 'unavailable' }>) => R;
  error: (error: TruthError, truth: Extract<Truth<T>, { state: 'error' }>) => R;
}

/**
 * Handle every state, exhaustively. All six handlers are REQUIRED, so adding a
 * seventh state later becomes a compile error at every call site rather than a
 * silently-unhandled branch.
 */
export function foldTruth<T, R>(t: Truth<T>, h: TruthHandlers<T, R>): R {
  switch (t.state) {
    case 'success':
      return h.success(t.value, t);
    case 'empty':
      return h.empty(t.value, t);
    case 'partial':
      return h.partial(t.value, t.coverage, t);
    case 'unknown':
      return h.unknown(t.reason, t);
    case 'unavailable':
      return h.unavailable(t.reason, t);
    case 'error':
      return h.error(t.error, t);
    default: {
      // Exhaustiveness: if a state is added without updating this switch, the
      // assignment below fails to compile.
      const exhaustive: never = t;
      throw new Error(`Unhandled truth state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Apply a function to the value, preserving state and provenance.
 * Non-value states pass through untouched — mapping cannot invent a value.
 */
export function mapTruth<T, U>(t: Truth<T>, fn: (value: T) => U): Truth<U> {
  if (t.state === 'success') return { ...t, value: fn(t.value) };
  if (t.state === 'empty') return { ...t, value: fn(t.value) };
  if (t.state === 'partial') return { ...t, value: fn(t.value) };
  return t;
}
