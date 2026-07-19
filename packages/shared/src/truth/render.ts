// Truth States — rendering rules.
//
// Framework-agnostic on purpose: this returns a *description* of what to
// display, not JSX. `apps/web` renders it, and so could an email, a PDF export
// or a future native client. Keeping it here means all of them enforce the same
// zero rule rather than each re-deriving it.
//
// THE RULE: only SUCCESS and EMPTY may render a numeric zero. Every other state
// renders the unknown glyph plus a reason. `describeTruth` is total over the six
// states, so there is no path through it that emits a number without a
// measurement behind it.

import { foldTruth, mayRenderZero, type Coverage, type Reason, type Truth, type TruthError } from './state';

/** What an unmeasured value looks like. Never "0". */
export const UNKNOWN_DISPLAY = '—';

/**
 * Semantic weight of a measurement, for styling. Separate from any brand
 * palette — a consumer maps these onto its own tokens.
 */
export type TruthTone = 'good' | 'neutral' | 'caution' | 'critical';

export interface TruthDisplay {
  /** The primary string to show. `UNKNOWN_DISPLAY` whenever there is no value. */
  text: string;
  tone: TruthTone;
  /** Short qualifier shown beside the value, e.g. "lower bound" or "not measured". */
  qualifier: string | null;
  /** Operator-facing explanation. Null only when the measurement is complete. */
  note: string | null;
  /** The action that would resolve this, when one is known. */
  unblockedBy: string | null;
  /** True only for SUCCESS/EMPTY. A consumer may assert on this before printing digits. */
  trustworthy: boolean;
  state: Truth<unknown>['state'];
}

function coverageNote(c: Coverage): string {
  const of = c.total === null ? 'an unknown total' : `${c.total.toLocaleString()}`;
  return `Measured ${c.observed.toLocaleString()} of ${of}. ${c.reason.summary} This figure is a lower bound.`;
}

function reasonNote(r: Reason): string {
  return r.detail ? `${r.summary} ${r.detail}` : r.summary;
}

function errorNote(e: TruthError): string {
  const retry = e.retryable ? ' This may resolve on its own.' : '';
  return `${e.summary}${e.detail ? ` ${e.detail}` : ''}${retry}`;
}

/**
 * Turn a Truth into display instructions.
 *
 * `format` is only ever invoked for value-bearing states, so a formatter can
 * safely assume a real number and never has to defend against null.
 */
export function describeTruth<T>(truth: Truth<T>, format: (value: T) => string): TruthDisplay {
  return foldTruth<T, TruthDisplay>(truth, {
    success: (value) => ({
      text: format(value),
      tone: 'good',
      qualifier: null,
      note: null,
      unblockedBy: null,
      trustworthy: true,
      state: 'success',
    }),
    // The one place a zero is honest: a completed measurement that really is zero.
    empty: (value) => ({
      text: format(value),
      tone: 'neutral',
      qualifier: 'none recorded',
      note: 'Measured, and genuinely zero — not missing.',
      unblockedBy: null,
      trustworthy: true,
      state: 'empty',
    }),
    partial: (value, coverage) => ({
      text: format(value),
      tone: 'caution',
      qualifier: 'lower bound',
      note: coverageNote(coverage),
      unblockedBy: coverage.reason.unblockedBy ?? null,
      trustworthy: false,
      state: 'partial',
    }),
    unknown: (reason) => ({
      text: UNKNOWN_DISPLAY,
      tone: 'neutral',
      qualifier: 'not yet known',
      note: reasonNote(reason),
      unblockedBy: reason.unblockedBy ?? null,
      trustworthy: false,
      state: 'unknown',
    }),
    unavailable: (reason) => ({
      text: UNKNOWN_DISPLAY,
      tone: 'caution',
      qualifier: 'unavailable',
      note: reasonNote(reason),
      unblockedBy: reason.unblockedBy ?? null,
      trustworthy: false,
      state: 'unavailable',
    }),
    error: (error) => ({
      text: UNKNOWN_DISPLAY,
      tone: 'critical',
      qualifier: 'measurement failed',
      note: errorNote(error),
      unblockedBy: error.retryable ? 'Retry the measurement.' : 'Investigate the failure below.',
      trustworthy: false,
      state: 'error',
    }),
  });
}

/**
 * Runtime backstop for the zero rule.
 *
 * The type system already prevents reading `.value` off a non-value state, so
 * this catches the remaining route: a consumer that formats a value-bearing
 * Truth and lands on "0" when the state does not permit one. Cheap enough to
 * leave on, and it converts a silent lie into a loud failure.
 */
export function assertZeroRule(display: TruthDisplay): TruthDisplay {
  const looksZero = /^[^\d-]*0([.,]0+)?$/.test(display.text.trim());
  if (looksZero && !(display.state === 'success' || display.state === 'empty')) {
    throw new Error(
      `Truth zero rule violated: state '${display.state}' rendered "${display.text}". ` +
        'Only SUCCESS and EMPTY may display a numeric zero.',
    );
  }
  return display;
}

/** Convenience: describe and enforce in one call. Prefer this in UI code. */
export function renderTruth<T>(truth: Truth<T>, format: (value: T) => string): TruthDisplay {
  return assertZeroRule(describeTruth(truth, format));
}

/** Whether digits may be printed for this measurement at all. */
export const isPrintableNumber = <T>(t: Truth<T>): boolean => mayRenderZero(t) || t.state === 'partial';
