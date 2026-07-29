// Historical series — the capability that makes "is this normal?" answerable.
//
// WHY THIS EXISTS
// The engine could previously see exactly two points: the selected window and one
// comparison window. Two points can express a CHANGE. They cannot express
// consistency, volatility, a trend, an oscillation, a new high, a new low, an
// emerging entity or a dormant one — every one of those is a statement about a
// DISTRIBUTION, and a distribution needs a series.
//
// Asking two points to answer those questions is how a product starts inventing.
// "Buyer X is volatile" from a single delta is a guess wearing a statistic's
// clothes. So the series is built explicitly, its size is reported, and every
// statistic over it refuses to compute below a stated minimum.
//
// WHAT IT DOES NOT DO
// It does not change how a window is resolved, what a metric means, or how a
// period is compared. It reads the SAME canonical aggregation for earlier
// periods of the same shape. It adds history; it redefines nothing.
//
// THE RULE THAT SHAPES EVERYTHING BELOW
// **Never compare incomplete periods.** A live window is a partial measurement,
// and putting one in a series corrupts the mean, the deviation and the trend all
// at once — the exact defect that made "Today" report an -85% collapse every
// morning. `buildHistoryPeriods` therefore anchors on the last COMPLETE Eastern
// day and never emits a period that touches the in-progress one.

import { startOfEasternDay, startOfPreviousEasternDay } from './business-time';
import type { CallGridWindow } from './callgrid-window';

export const HISTORY_VERSION = 'v1';

/** How many prior periods the surfaces request. Enough for a distribution, cheap enough to load. */
export const DEFAULT_HISTORY_PERIODS = 8;

/** Minimum usable points before any distribution statistic is reported at all. */
export const MIN_SERIES_POINTS = 4;

/** One earlier period of the same shape as the selected window. */
export interface HistoryPeriod {
  /** 1 = the period immediately before the selected one. */
  index: number;
  start: Date;
  end: Date;
  /** Whole Eastern days spanned. Equal for every period in a series. */
  spanDays: number;
}

/**
 * Whole Eastern days covered by a window, counting the calendar days it touches.
 *
 * Computed by walking Eastern day boundaries rather than dividing elapsed
 * milliseconds, because a DST period is 23 or 25 hours long and division would
 * silently produce a fractional day.
 */
export function easternSpanDays(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let cursor = startOfEasternDay(start);
  let days = 0;
  // Guard the loop: no reporting period is longer than a few years.
  while (cursor.getTime() < end.getTime() && days < 4000) {
    days += 1;
    cursor = startOfNextDay(cursor);
  }
  return days;
}

function startOfNextDay(dayStart: Date): Date {
  // Step from a day start into the next day, then re-anchor. Adding 26h clears a
  // 25-hour fall-back day without ever landing back inside the same one.
  return startOfEasternDay(new Date(dayStart.getTime() + 26 * 3600_000));
}

function shiftBackDays(dayStart: Date, days: number): Date {
  let cursor = dayStart;
  for (let i = 0; i < days; i += 1) cursor = startOfPreviousEasternDay(cursor);
  return cursor;
}

/**
 * Build `count` complete periods immediately preceding the selected window.
 *
 * Returns `[]` — deliberately, not a shortened series — when the selected window
 * is live or invalid. A live window has no well-defined "same shape" predecessor
 * to compare against without reintroducing the partial-versus-complete defect,
 * and a caller that receives an empty series correctly reports "no history"
 * rather than reasoning over a corrupted one.
 */
export function buildHistoryPeriods(
  window: CallGridWindow,
  count: number = DEFAULT_HISTORY_PERIODS,
): HistoryPeriod[] {
  if (!window.isValid || window.includesLiveData || !window.isCompleted) return [];
  const spanDays = easternSpanDays(window.start, window.end);
  if (spanDays <= 0 || count <= 0) return [];

  const periods: HistoryPeriod[] = [];
  let end = startOfEasternDay(window.start);
  for (let i = 1; i <= count; i += 1) {
    const start = shiftBackDays(end, spanDays);
    periods.push({ index: i, start, end, spanDays });
    end = start;
  }
  return periods;
}

// --- The series itself --------------------------------------------------------

/** One period's measured values. Nulls are ABSENT, never zero. */
export interface HistoryPoint {
  period: HistoryPeriod;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
  /** Per-entity revenue for this period, keyed by entity key, per dimension. */
  entityRevenueCents: Record<string, number | null>;
  /** Per-entity call counts for this period, keyed by entity key. */
  entityCalls: Record<string, number>;
  /**
   * Display name per entity key, as it was reported IN THIS PERIOD.
   *
   * Kept per-point rather than resolved once, because an entity absent from the
   * selected window has no current label — its name can only come from a period
   * where it was present. Without this an entity that disappeared could only be
   * reported by its opaque provider id.
   */
  entityLabels: Record<string, string>;
}

export interface HistorySeries {
  /** Most recent prior period FIRST. */
  points: HistoryPoint[];
  /** True when history was requested but the window shape forbade it. */
  suppressedForLiveWindow: boolean;
}

export const EMPTY_SERIES: HistorySeries = { points: [], suppressedForLiveWindow: false };

// --- Distribution statistics --------------------------------------------------
//
// Every one returns a reason when it declines to compute. A null with no reason
// is indistinguishable from a bug, and a surface cannot explain it to an operator.

export interface SeriesStat {
  value: number | null;
  /** Points that carried a usable value. */
  usablePoints: number;
  /** Points in the series, including unusable ones. */
  totalPoints: number;
  /** Why `value` is null. Null when the value computed. */
  reason: string | null;
}

function usable(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

function insufficient(values: readonly (number | null)[], need: number, what: string): SeriesStat {
  const u = usable(values);
  return {
    value: null,
    usablePoints: u.length,
    totalPoints: values.length,
    reason: `${what} needs at least ${need} periods carrying a value; ${u.length} of ${values.length} did.`,
  };
}

export function mean(values: readonly (number | null)[]): SeriesStat {
  const u = usable(values);
  if (u.length < 1) return insufficient(values, 1, 'An average');
  return {
    value: u.reduce((s, v) => s + v, 0) / u.length,
    usablePoints: u.length,
    totalPoints: values.length,
    reason: null,
  };
}

/** Population standard deviation over the usable points. */
export function stdev(values: readonly (number | null)[]): SeriesStat {
  const u = usable(values);
  if (u.length < MIN_SERIES_POINTS) return insufficient(values, MIN_SERIES_POINTS, 'A deviation');
  const m = u.reduce((s, v) => s + v, 0) / u.length;
  const variance = u.reduce((s, v) => s + (v - m) ** 2, 0) / u.length;
  return {
    value: Math.sqrt(variance),
    usablePoints: u.length,
    totalPoints: values.length,
    reason: null,
  };
}

/**
 * Volatility as the coefficient of variation (stdev / mean).
 *
 * Unitless on purpose, so revenue volatility and call-volume volatility are
 * comparable. Undefined at a mean of zero or below — dividing by it would
 * manufacture an enormous volatility from a quiet period.
 */
export function volatility(values: readonly (number | null)[]): SeriesStat {
  const sd = stdev(values);
  if (sd.value === null) return sd;
  const m = mean(values);
  if (m.value === null || m.value <= 0) {
    return {
      value: null,
      usablePoints: sd.usablePoints,
      totalPoints: sd.totalPoints,
      reason: 'Volatility is undefined when the average is zero or negative — there is no base to vary against.',
    };
  }
  return { value: sd.value / m.value, usablePoints: sd.usablePoints, totalPoints: sd.totalPoints, reason: null };
}

/**
 * Least-squares trend slope, expressed as a fraction of the mean per period.
 *
 * Series order is most-recent-first, so the regression runs over reversed indices
 * and a POSITIVE slope means increasing over time.
 */
export function trendPerPeriod(values: readonly (number | null)[]): SeriesStat {
  const indexed = values
    .map((v, i) => ({ x: values.length - 1 - i, y: v }))
    .filter((p): p is { x: number; y: number } => p.y !== null && Number.isFinite(p.y));

  if (indexed.length < MIN_SERIES_POINTS) return insufficient(values, MIN_SERIES_POINTS, 'A trend');

  const n = indexed.length;
  const sumX = indexed.reduce((s, p) => s + p.x, 0);
  const sumY = indexed.reduce((s, p) => s + p.y, 0);
  const sumXY = indexed.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = indexed.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return { value: null, usablePoints: n, totalPoints: values.length, reason: 'A trend needs at least two distinct periods.' };
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const avg = sumY / n;
  if (avg === 0) {
    return { value: null, usablePoints: n, totalPoints: values.length, reason: 'A relative trend is undefined against an average of zero.' };
  }
  return { value: slope / Math.abs(avg), usablePoints: n, totalPoints: values.length, reason: null };
}

/**
 * How many times the period-over-period direction flipped.
 *
 * High oscillation is what separates "declining" from "unstable" — and the two
 * call for completely different reviews, so the engine must not report one as the
 * other.
 */
export function oscillations(values: readonly (number | null)[]): SeriesStat {
  const u = usable(values);
  if (u.length < MIN_SERIES_POINTS) return insufficient(values, MIN_SERIES_POINTS, 'An oscillation count');
  const chronological = [...u].reverse();
  let flips = 0;
  let lastDirection = 0;
  for (let i = 1; i < chronological.length; i += 1) {
    const delta = chronological[i]! - chronological[i - 1]!;
    const direction = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (direction !== 0) {
      if (lastDirection !== 0 && direction !== lastDirection) flips += 1;
      lastDirection = direction;
    }
  }
  return { value: flips, usablePoints: u.length, totalPoints: values.length, reason: null };
}

export type Extreme = 'HIGH' | 'LOW' | null;

/**
 * Whether `current` sits outside every value in the series.
 *
 * Requires a full minimum series: calling one period a "new high" against two
 * prior points is not a record, it is a coincidence.
 */
export function extremeVersusSeries(current: number | null, values: readonly (number | null)[]): {
  extreme: Extreme;
  usablePoints: number;
  reason: string | null;
} {
  const u = usable(values);
  if (current === null) {
    return { extreme: null, usablePoints: u.length, reason: 'The current period carries no value to compare.' };
  }
  if (u.length < MIN_SERIES_POINTS) {
    return {
      extreme: null,
      usablePoints: u.length,
      reason: `A high or low needs at least ${MIN_SERIES_POINTS} prior periods carrying a value; ${u.length} did.`,
    };
  }
  const max = Math.max(...u);
  const min = Math.min(...u);
  if (current > max) return { extreme: 'HIGH', usablePoints: u.length, reason: null };
  if (current < min) return { extreme: 'LOW', usablePoints: u.length, reason: null };
  return { extreme: null, usablePoints: u.length, reason: null };
}

/**
 * How far the current value sits from the series mean, in standard deviations.
 *
 * The basis for spike and drop detection. Null (with a reason) whenever the
 * deviation is unavailable or zero — a flat series makes every difference
 * infinitely significant, which is an artefact, not a signal.
 */
export function zScore(current: number | null, values: readonly (number | null)[]): SeriesStat {
  const sd = stdev(values);
  if (sd.value === null) return sd;
  const m = mean(values);
  if (current === null || m.value === null) {
    return { value: null, usablePoints: sd.usablePoints, totalPoints: sd.totalPoints, reason: 'The current period carries no value to compare.' };
  }
  if (sd.value === 0) {
    return {
      value: null,
      usablePoints: sd.usablePoints,
      totalPoints: sd.totalPoints,
      reason: 'Every prior period held the same value, so no deviation scale exists to measure against.',
    };
  }
  return { value: (current - m.value) / sd.value, usablePoints: sd.usablePoints, totalPoints: sd.totalPoints, reason: null };
}

// --- Series projections -------------------------------------------------------

/** Pull one metric out of the series, most-recent-first, preserving nulls. */
export function seriesOf(
  series: HistorySeries,
  metric: 'totalCalls' | 'billableCalls' | 'revenueCents' | 'profitCents',
): (number | null)[] {
  return series.points.map((p) => p[metric]);
}

/**
 * The key an entity is stored under in a history point.
 *
 * Namespaced by dimension because the provider's id spaces are not guaranteed
 * distinct across buyers, vendors, sources and campaigns. A collision would make
 * one entity's history silently answer for another's — and the first symptom
 * would be a confident, wrong "this buyer disappeared" finding.
 */
export function historyEntityKey(dimension: string, entityKey: string): string {
  return `${dimension}::${entityKey}`;
}

/** Pull one entity's revenue across the series, preserving nulls. */
export function entitySeries(series: HistorySeries, entityKey: string): (number | null)[] {
  return series.points.map((p) => p.entityRevenueCents[entityKey] ?? null);
}

/** Pull one entity's call counts across the series. Absence is 0 calls, which is a real measurement. */
export function entityCallSeries(series: HistorySeries, entityKey: string): number[] {
  return series.points.map((p) => p.entityCalls[entityKey] ?? 0);
}
