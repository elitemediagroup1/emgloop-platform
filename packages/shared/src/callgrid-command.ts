// The CallGrid command center — what the executive layer says, composed from what
// Loop already measured. PURE: no I/O, no clock (now is passed in), no model.
//
// Six things live here, each a projection over existing contracts rather than a new
// source of truth:
//
//   • BUCKETS — the time buckets a period is charted in (Eastern hours for a day,
//     Eastern days otherwise), and the comparison period's buckets aligned to them.
//   • KPIS — Net Profit, Revenue, Billable Calls, Margin and Telco Cost, from the
//     canonical report's metrics (Net Profit = revenue − payout − cost, exactly as
//     `profitCents` defines it), each with its comparison and a sparkline.
//   • FRESHNESS — Live, Current, Stale, Degraded or Unavailable, from when CallGrid
//     last actually delivered data. Never from the clock the page was rendered by.
//   • COVERAGE — whether Loop's call record covers the comparison period. A period
//     before the record starts was not observed, so it is never compared against.
//   • THE BRIEF — the health band with a few words of reason, then at most two short
//     sentences (what changed, what to review first) within 45 words. Each sentence
//     carries its basis: a measured fact, arithmetic on measured facts, Loop's
//     reading, or an unknown. No sentence claims a cause.
//   • PRIORITIES AND FUNNELS — the kind of a Situation (risk, opportunity, needs
//     investigation) read off the finding that raised it, and funnels that show a
//     stage only when its data exists.

import { easternWallTimeToUtc, easternYmd, type EasternYmd } from './business-time';
import { profitCents } from './callgrid-metric-contract';
import type { CallGridWindow } from './callgrid-window';
import { HEALTH_BAND_LABEL, type HealthBand } from './callgrid-health';
import { voiceOf, type Situation } from './callgrid-situation';
import type { FindingType } from './callgrid-intelligence';

const DAY = 86_400_000;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- Buckets --------------------------------------------------------------------------

export interface TimeBucket {
  readonly start: Date;
  readonly end: Date;
  /** Axis label, in Eastern time: "9 AM", "Mon 14", "Sep 14". */
  readonly label: string;
}

export interface CallGridBuckets {
  readonly grain: 'hour' | 'day';
  readonly current: readonly TimeBucket[];
  /** The comparison period's buckets, index-aligned with `current` (hour of day, day of period). */
  readonly comparison: readonly TimeBucket[];
}

function addDaysYmd(d: EasternYmd, n: number): EasternYmd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + n * DAY);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Eastern hour buckets over [start, end): wall-clock hours, so a clock-change day stays honest. */
function hourBuckets(start: Date, end: Date): TimeBucket[] {
  const day = easternYmd(start);
  const out: TimeBucket[] = [];
  for (let h = 0; h < 24; h += 1) {
    const s = easternWallTimeToUtc(day.year, day.month, day.day, h);
    const e = h === 23 ? easternWallTimeToUtc(...ymdArgs(addDaysYmd(day, 1))) : easternWallTimeToUtc(day.year, day.month, day.day, h + 1);
    if (e.getTime() <= s.getTime()) continue; // the hour a spring-forward day does not have
    if (s.getTime() >= end.getTime()) break;
    out.push({ start: s, end: e.getTime() > end.getTime() ? end : e, label: hourLabel(h) });
  }
  return out;
}
function ymdArgs(d: EasternYmd): [number, number, number] {
  return [d.year, d.month, d.day];
}

/** Eastern day buckets over [start, end). */
function dayBuckets(start: Date, end: Date, weekly: boolean): TimeBucket[] {
  const out: TimeBucket[] = [];
  let d = easternYmd(start);
  for (let i = 0; i < 400; i += 1) {
    const s = easternWallTimeToUtc(...ymdArgs(d));
    if (s.getTime() >= end.getTime()) break;
    const next = addDaysYmd(d, 1);
    const e = easternWallTimeToUtc(...ymdArgs(next));
    const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]!;
    out.push({
      start: s,
      end: e.getTime() > end.getTime() ? end : e,
      label: weekly ? `${weekday} ${d.day}` : `${MONTHS_SHORT[d.month - 1]} ${d.day}`,
    });
    d = next;
  }
  return out;
}

/**
 * The buckets a window is charted in. A single day is hourly; anything longer is
 * daily. The comparison buckets cover the comparison window only — for an
 * in-progress period that window already ends at the same elapsed point, so the
 * two series stop at the same place and never compare a partial against a whole.
 */
export function callGridBuckets(window: CallGridWindow): CallGridBuckets {
  if (window.isSingleDay) {
    return {
      grain: 'hour',
      current: hourBuckets(window.start, window.end),
      comparison: window.comparisonStart && window.comparisonEnd ? hourBuckets(window.comparisonStart, window.comparisonEnd) : [],
    };
  }
  const days = Math.round((window.end.getTime() - window.start.getTime()) / DAY);
  const weekly = days <= 8;
  return {
    grain: 'day',
    current: dayBuckets(window.start, window.end, weekly),
    comparison: window.comparisonStart && window.comparisonEnd ? dayBuckets(window.comparisonStart, window.comparisonEnd, weekly) : [],
  };
}

// --- KPIs -----------------------------------------------------------------------------------

/** The window economics the KPIs read — structurally the canonical report's metrics. */
export interface CommandMetrics {
  readonly available: boolean;
  readonly totalCalls: number | null;
  readonly billableCalls: number | null;
  readonly revenueCents: number | null;
  readonly profitCents: number | null;
  readonly costCents: number | null;
  readonly revenueCoverage: number | null;
  readonly profitCoverage: number | null;
}

/** One bucket of the series behind a sparkline — structurally the repository's series point. */
export interface CommandSeriesPoint {
  readonly calls: number;
  readonly monetized: number;
  readonly revenueCents: number;
  readonly payoutCents: number;
  readonly costCents: number;
  readonly callsWithRevenue: number;
  readonly callsWithCost: number;
}

export const CALLGRID_KPIS = ['netProfit', 'revenue', 'billableCalls', 'margin', 'telcoCost'] as const;
export type CallGridKpiKey = (typeof CALLGRID_KPIS)[number];

export const CALLGRID_KPI_LABELS: Readonly<Record<CallGridKpiKey, string>> = Object.freeze({
  netProfit: 'Net Profit',
  revenue: 'Revenue',
  billableCalls: 'Billable Calls',
  margin: 'Margin',
  telcoCost: 'Telco Cost',
});

export interface CallGridKpi {
  readonly key: CallGridKpiKey;
  readonly label: string;
  /** Cents for money, a count for calls, a percentage (0–100) for margin. Null when unknown. */
  readonly value: number | null;
  readonly kind: 'money' | 'count' | 'percent';
  readonly state: 'VALUE' | 'UNKNOWN' | 'UNAVAILABLE';
  /** Change against the comparison period, or null when no honest comparison exists. */
  readonly change: { readonly direction: 'up' | 'down' | 'flat'; readonly text: string; readonly favorable: boolean | null } | null;
  /** Why there is no change line, when there is none. */
  readonly noChangeReason: string | null;
  /** Per-bucket values for the sparkline; null where the bucket had nothing measurable. */
  readonly spark: readonly (number | null)[];
  /** Below full coverage, the value is a lower bound (or, for profit, may overstate) — and says so. */
  readonly coverageNote: string | null;
  /** The figure this one is part of, in the same words the brief uses ("of 289 total calls"). */
  readonly subline: string | null;
}

function pctChange(cur: number, prior: number): number {
  return Math.round(((cur - prior) / Math.abs(prior)) * 100);
}
function marginOf(profit: number | null, revenue: number | null): number | null {
  if (profit === null || revenue === null || revenue <= 0) return null;
  return Math.round((profit / revenue) * 1000) / 10;
}

/**
 * The five KPIs. Every value is the canonical report's own figure: Net Profit is the
 * report's `profitCents` (revenue − payout − cost), Margin is Net Profit ÷ Revenue,
 * Telco Cost is the report's `costCents`. Nothing is recomputed from the series.
 */
export function callGridKpis(input: {
  readonly metrics: CommandMetrics;
  readonly comparison: CommandMetrics | null;
  readonly series: readonly CommandSeriesPoint[];
  /** Set when the period has a comparison but Loop's record does not cover it (see `assessCallGridCoverage`). */
  readonly comparisonWithheld?: boolean;
}): CallGridKpi[] {
  const { metrics: m, comparison: c, series } = input;
  const unavailable = !m.available;
  const priorOk = c !== null && c.available;

  const sparkProfit = series.map((p) =>
    p.calls === 0 ? 0 : p.callsWithRevenue === 0 ? null : profitCents(p.revenueCents, p.payoutCents, p.costCents),
  );
  const sparkRevenue = series.map((p) => (p.calls === 0 ? 0 : p.callsWithRevenue === 0 ? null : p.revenueCents));
  const sparkBillable = series.map((p) => p.monetized);
  const sparkMargin = series.map((p) =>
    p.callsWithRevenue === 0 ? null : marginOf(profitCents(p.revenueCents, p.payoutCents, p.costCents), p.revenueCents),
  );
  const sparkCost = series.map((p) => (p.calls === 0 ? 0 : p.callsWithCost === 0 ? null : p.costCents));

  const partial = (cov: number | null, what: string) =>
    cov !== null && cov > 0 && cov < 1 ? `${Math.round(cov * 100)}% of calls reported ${what}, so this is incomplete for the period.` : null;

  const build = (
    key: CallGridKpiKey,
    kind: CallGridKpi['kind'],
    value: number | null,
    prior: number | null,
    spark: readonly (number | null)[],
    higherIsBetter: boolean | null,
    coverageNote: string | null,
  ): CallGridKpi => {
    let change: CallGridKpi['change'] = null;
    let noChangeReason: string | null = null;
    if (unavailable) noChangeReason = 'CallGrid data could not be read.';
    else if (!c && input.comparisonWithheld) noChangeReason = 'No valid comparison.';
    else if (!c) noChangeReason = 'No comparison period for this selection.';
    else if (!priorOk) noChangeReason = 'The comparison period could not be read.';
    else if (value === null || prior === null) noChangeReason = 'Not known for both periods.';
    else if (kind === 'percent') {
      const diff = Math.round((value - prior) * 10) / 10;
      const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      change = { direction, text: `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff).toFixed(1)} pts`, favorable: higherIsBetter === null || direction === 'flat' ? null : (direction === 'up') === higherIsBetter };
    } else if (prior === 0) noChangeReason = 'Nothing in the comparison period to compare with.';
    else {
      const pct = pctChange(value, prior);
      const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
      change = { direction, text: `${Math.abs(pct)}%`, favorable: higherIsBetter === null || direction === 'flat' ? null : (direction === 'up') === higherIsBetter };
    }
    return {
      key,
      label: CALLGRID_KPI_LABELS[key],
      value: unavailable ? null : value,
      kind,
      state: unavailable ? 'UNAVAILABLE' : value === null ? 'UNKNOWN' : 'VALUE',
      change,
      noChangeReason: change ? null : noChangeReason,
      spark,
      coverageNote,
      subline: key === 'billableCalls' && !unavailable && m.totalCalls !== null ? `of ${m.totalCalls.toLocaleString('en-US')} total calls` : null,
    };
  };

  return [
    build('netProfit', 'money', m.profitCents, c?.profitCents ?? null, sparkProfit, true, partial(m.profitCoverage, 'revenue, payout and cost')),
    build('revenue', 'money', m.revenueCents, c?.revenueCents ?? null, sparkRevenue, true, partial(m.revenueCoverage, 'revenue')),
    build('billableCalls', 'count', m.billableCalls, c?.billableCalls ?? null, sparkBillable, true, null),
    build('margin', 'percent', marginOf(m.profitCents, m.revenueCents), c ? marginOf(c.profitCents, c.revenueCents) : null, sparkMargin, true, partial(m.profitCoverage, 'revenue, payout and cost')),
    build('telcoCost', 'money', m.costCents, c?.costCents ?? null, sparkCost, false, null),
  ];
}

// --- Freshness --------------------------------------------------------------------------------

export type CallGridFreshnessState = 'LIVE' | 'CURRENT' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE' | 'COMPLETED';

/** How recent a delivery must be to say Live, and how old before a live period is Stale. */
export const CALLGRID_FRESHNESS_POLICY = Object.freeze({
  liveMs: 15 * 60_000,
  // The same line coverage health draws between HEALTHY and LAGGING.
  currentMs: 3 * 3_600_000,
  failureLookbackMs: 24 * 3_600_000,
});

export interface CallGridFreshnessInput {
  readonly now: Date;
  /** The report for the selected period could be read. */
  readonly readOk: boolean;
  /** The selected period includes today. */
  readonly periodLive: boolean;
  /** When CallGrid last delivered anything Loop received (webhook or sync). Null when never. */
  readonly lastDeliveryAt: Date | null;
  /** The routine poll's proven coverage, when it runs. */
  readonly pollCompletedThrough: Date | null;
  /** Recent deliveries: status and receipt time, newest first. */
  readonly recentDeliveries: readonly { readonly status: string; readonly receivedAt: Date }[];
  /** False when the freshness facts themselves could not be read. */
  readonly factsOk: boolean;
}

export interface CallGridFreshness {
  readonly state: CallGridFreshnessState;
  /** The short word for the badge. */
  readonly word: string;
  /** One sentence: what Loop knows about how current this is. */
  readonly detail: string;
  /** The instant the data is current to, when known. The badge time comes from HERE. */
  readonly asOf: Date | null;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'moments ago';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/**
 * How current the CallGrid picture is. "Live" is earned only by a recent delivery;
 * the render clock never makes anything live.
 */
export function assessCallGridFreshness(input: CallGridFreshnessInput): CallGridFreshness {
  const { now } = input;
  if (!input.readOk) {
    return { state: 'UNAVAILABLE', word: 'Unavailable', detail: 'Loop could not read CallGrid data for this period.', asOf: null };
  }
  const latest = [input.lastDeliveryAt, input.pollCompletedThrough]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  if (!input.factsOk) {
    return {
      state: 'DEGRADED', word: 'Unverified',
      detail: 'The data is shown, but Loop could not read when CallGrid last delivered, so it cannot say how current it is.',
      asOf: null,
    };
  }
  if (latest === null) {
    return { state: 'UNAVAILABLE', word: 'No data', detail: 'Loop has not received any data from CallGrid yet.', asOf: null };
  }
  const since = now.getTime() - CALLGRID_FRESHNESS_POLICY.failureLookbackMs;
  const recent = input.recentDeliveries.filter((d) => d.receivedAt.getTime() >= since);
  const failed = recent.filter((d) => d.status === 'FAILED').length;
  if (failed > 0) {
    return {
      state: 'DEGRADED', word: 'Degraded',
      detail: `${failed} of the last ${recent.length} CallGrid deliveries in the past 24 hours failed to process, so some calls may be missing or incomplete.`,
      asOf: latest,
    };
  }
  if (!input.periodLive) {
    return { state: 'COMPLETED', word: 'Completed', detail: `A completed period. CallGrid last delivered data ${ago(now.getTime() - latest.getTime())}.`, asOf: latest };
  }
  const age = now.getTime() - latest.getTime();
  if (age <= CALLGRID_FRESHNESS_POLICY.liveMs) {
    return { state: 'LIVE', word: 'Live', detail: `CallGrid delivered data ${ago(age)}.`, asOf: latest };
  }
  if (age <= CALLGRID_FRESHNESS_POLICY.currentMs) {
    return { state: 'CURRENT', word: 'Current', detail: `CallGrid last delivered data ${ago(age)}.`, asOf: latest };
  }
  return {
    state: 'STALE', word: 'Stale',
    detail: `Nothing has arrived from CallGrid for ${ago(age).replace(' ago', '')}. That can mean no calls, or a delivery problem — calls since then may be missing.`,
    asOf: latest,
  };
}

// --- Coverage of Loop's record ------------------------------------------------------------------

/**
 * Whether Loop's call record covers the period being compared against.
 *
 * Loop's record of an organization's calls begins at the earliest call it holds.
 * Before that, nothing was observed -- which is not the same as nothing happening.
 * Comparing a month against a prior month the record only half covers would show
 * a +305% "increase" that is really the record starting.
 *
 * THE RULES, deterministic and judged by Eastern business day:
 *   1. The record covers a day from the Eastern day of its earliest call onward.
 *   2. A comparison is VALID only when the record covers the comparison period's
 *      first day. Otherwise it is withheld: BEFORE_RECORD.
 *   3. The selected period is PARTIAL when it starts before the record does.
 *      Its figures are real but cover only part of it, so it is never compared.
 *   4. No record at all means no comparison: NO_RECORD.
 *   5. If the record's start could not be read, the comparison is withheld:
 *      UNKNOWN. This fails closed.
 *   6. A period with no comparison window is NONE, and nothing is withheld.
 *
 * A gap inside the record (an ingestion outage) is not detected here. This
 * rule is about where the record starts, not whether it is continuous.
 */
export type ComparisonCoverage = 'VALID' | 'NONE' | 'BEFORE_RECORD' | 'NO_RECORD' | 'UNKNOWN';

export interface CallGridCoverage {
  /** The earliest call Loop holds for the organization; null when none, or not read. */
  readonly recordStartsAt: Date | null;
  readonly comparison: ComparisonCoverage;
  /** The selected period starts before Loop's record, so its figures cover only part of it. */
  readonly currentPartial: boolean;
  /** One short line when a comparison is withheld or the period is partial; null otherwise. */
  readonly note: string | null;
}

function ymdKey(d: EasternYmd): number {
  return d.year * 10_000 + d.month * 100 + d.day;
}
function shortDay(d: EasternYmd, yearOf: EasternYmd): string {
  return `${MONTHS_SHORT[d.month - 1]} ${d.day}${d.year === yearOf.year ? '' : `, ${d.year}`}`;
}

/** Does Loop's record, starting at `recordStartsAt`, cover the Eastern day `start` falls on? */
export function callGridRecordCovers(recordStartsAt: Date | null, start: Date): boolean {
  return recordStartsAt !== null && ymdKey(easternYmd(recordStartsAt)) <= ymdKey(easternYmd(start));
}

export function assessCallGridCoverage(
  window: CallGridWindow,
  record: { readonly ok: boolean; readonly startsAt: Date | null },
): CallGridCoverage {
  const hasComparison = window.comparisonBasis !== 'none' && window.comparisonStart !== null && window.comparisonEnd !== null;
  const startsAt = record.ok ? record.startsAt : null;
  const first = easternYmd(window.start);
  const currentPartial = startsAt !== null && !callGridRecordCovers(startsAt, window.start);
  const day = startsAt ? shortDay(easternYmd(startsAt), first) : null;

  let comparison: ComparisonCoverage;
  if (!hasComparison) comparison = 'NONE';
  else if (!record.ok) comparison = 'UNKNOWN';
  else if (startsAt === null) comparison = 'NO_RECORD';
  else comparison = callGridRecordCovers(startsAt, window.comparisonStart!) ? 'VALID' : 'BEFORE_RECORD';

  let note: string | null = null;
  if (currentPartial && startsAt !== null && startsAt.getTime() >= window.end.getTime()) {
    note = `No data: Loop’s call record starts ${day}, after this period.`;
  } else if (currentPartial) {
    note = hasComparison
      ? `Partial period: Loop’s call record starts ${day}, so there is no valid comparison.`
      : `Partial period: Loop’s call record starts ${day}.`;
  } else if (comparison === 'BEFORE_RECORD') {
    note = `Not compared: Loop’s call record starts ${day}, after the comparison period began.`;
  } else if (comparison === 'NO_RECORD') {
    note = 'Not compared: Loop has no calls recorded yet.';
  } else if (comparison === 'UNKNOWN') {
    note = 'Not compared: Loop could not confirm when its call record starts.';
  }
  return { recordStartsAt: startsAt, comparison, currentPartial, note };
}

/**
 * The window every read uses: the selected window, with its comparison removed when
 * the record does not cover it. The report, the KPIs, the series, the engine and
 * the entity pages then compare against nothing, instead of each one checking.
 */
export function effectiveCallGridWindow(window: CallGridWindow, coverage: CallGridCoverage): CallGridWindow {
  if (coverage.comparison === 'VALID' || coverage.comparison === 'NONE') return window;
  return { ...window, comparisonStart: null, comparisonEnd: null, comparisonBasis: 'none', comparisonLabel: null };
}

// --- The brief -----------------------------------------------------------------------------------

export type BriefBasis = 'MEASURED' | 'ARITHMETIC' | 'READING' | 'UNKNOWN';

export const BRIEF_BASIS_LABELS: Readonly<Record<BriefBasis, string>> = Object.freeze({
  MEASURED: 'Measured',
  ARITHMETIC: 'Arithmetic on measured values',
  READING: 'Loop’s reading',
  UNKNOWN: 'Not known',
});

export interface BriefSentence {
  readonly text: string;
  readonly basis: BriefBasis;
  /** The numbers behind it, for the detail view. */
  readonly detail: string | null;
}

export interface CallGridBrief {
  readonly band: HealthBand;
  /** Why the band, in a few words ("profit and revenue improved despite lower call volume"). Null when there is none to give. */
  readonly reason: string | null;
  /** What is shown: what materially changed, then what to review first. At most two. */
  readonly sentences: readonly BriefSentence[];
  /** Behind "View details": the money, where revenue sits, the health model's own words, what is not known. */
  readonly details: readonly BriefSentence[];
}

/** The visible brief's word budget: band line and sentences together. */
export const BRIEF_MAX_WORDS = 45;

export function briefWordCount(brief: Pick<CallGridBrief, 'band' | 'reason' | 'sentences'>): number {
  const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const line = `Business health: ${HEALTH_BAND_LABEL[brief.band]}${brief.reason ? ` ${brief.reason}` : ''}`;
  return words(line) + brief.sentences.reduce((n, s) => n + words(s.text), 0);
}

export interface BriefShare {
  readonly label: string;
  readonly revenueCents: number | null;
}

function money(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString('en-US')}`;
}
function comparisonPhrase(window: CallGridWindow): string | null {
  const label = window.comparisonLabel;
  if (!label) return null;
  return label.charAt(0).toLowerCase() + label.slice(1);
}
function topShare(rows: readonly BriefShare[], total: number | null): { label: string; pct: number } | null {
  if (total === null || total <= 0) return null;
  const top = rows.find((r) => r.revenueCents !== null);
  if (!top || top.revenueCents === null || top.revenueCents <= 0) return null;
  return { label: top.label, pct: Math.round((top.revenueCents / total) * 100) };
}

// What counts as a material movement: 5% on a count or an amount, 1 point on a rate.
const MATERIAL_PCT = 5;
const MATERIAL_PTS = 1;

type Movement = { readonly metric: 'profit' | 'margin' | 'revenue' | 'billableRate' | 'totalCalls'; readonly up: boolean };

const MOVEMENT_NOUN: Readonly<Record<Movement['metric'], string>> = {
  profit: 'profit', margin: 'margin', revenue: 'revenue', billableRate: 'billable rate', totalCalls: 'call volume',
};
const MOVEMENT_LOWER: Readonly<Record<Movement['metric'], string>> = {
  profit: 'lower profit', margin: 'a lower margin', revenue: 'lower revenue', billableRate: 'a lower billable rate', totalCalls: 'lower call volume',
};

function billableRate(m: CommandMetrics): number | null {
  return m.billableCalls !== null && m.totalCalls !== null && m.totalCalls > 0 ? (m.billableCalls / m.totalCalls) * 100 : null;
}

/** Material movements against a comparison Loop's record covers, in a fixed order: the outcome first, volume last. */
function movementsOf(m: CommandMetrics, c: CommandMetrics | null): Movement[] {
  if (!m.available || !c || !c.available) return [];
  const out: Movement[] = [];
  const pct = (metric: Movement['metric'], a: number | null, b: number | null) => {
    if (a === null || b === null || b === 0) return;
    const p = pctChange(a, b);
    if (Math.abs(p) >= MATERIAL_PCT) out.push({ metric, up: a > b });
  };
  const pts = (metric: Movement['metric'], a: number | null, b: number | null) => {
    if (a === null || b === null) return;
    if (Math.abs(a - b) >= MATERIAL_PTS) out.push({ metric, up: a > b });
  };
  pct('profit', m.profitCents, c.profitCents);
  pts('margin', marginOf(m.profitCents, m.revenueCents), marginOf(c.profitCents, c.revenueCents));
  pct('revenue', m.revenueCents, c.revenueCents);
  pts('billableRate', billableRate(m), billableRate(c));
  pct('totalCalls', m.totalCalls, c.totalCalls);
  return out;
}

function andJoin(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The few words beside the band. The band stays the health model's; the reason
 * never contradicts it:
 *
 *   • HEALTHY names what improved, and at most one thing that fell ("profit and
 *     revenue improved despite lower call volume"). With nothing material, it says
 *     the measured signals are sound.
 *   • WATCH, RISK and CRITICAL name what pulls the band down: the model's weakest
 *     measured signal, in words no stronger than the model's own ("revenue leans on
 *     one buyer", or "vendor mix is the weakest area"), then one thing that fell --
 *     or, when nothing fell, what improved beside it.
 *   • UNKNOWN says too little was measured.
 *
 * Movements count only against a comparison Loop's record covers. The caller passes
 * the report's comparison, which is null when the comparison was withheld.
 */
export function callGridHealthReason(input: {
  readonly band: HealthBand;
  /** The health model's weakest measured signal (`weakestHealthSignal`) and its words (`healthSignalReason`). */
  readonly weakest: { readonly id: string; readonly reason: string | null } | null;
  readonly metrics: CommandMetrics;
  readonly comparison: CommandMetrics | null;
}): string | null {
  const { band } = input;
  if (band === 'UNKNOWN') return 'too little was measured to judge';
  const moves = movementsOf(input.metrics, input.comparison);
  const good = moves.filter((x) => x.up).slice(0, 2).map((x) => MOVEMENT_NOUN[x.metric]);
  const bad = moves.filter((x) => !x.up);
  if (band === 'HEALTHY') {
    if (good.length > 0) return `${andJoin(good)} improved${bad[0] ? ` despite ${MOVEMENT_LOWER[bad[0].metric]}` : ''}`;
    if (bad[0]) return `the measured signals are sound, though ${MOVEMENT_NOUN[bad[0].metric]} fell`;
    return input.comparison ? 'the measured signals are sound and little changed' : 'the measured signals are sound';
  }
  const weak = input.weakest?.reason ?? null;
  if (weak) {
    // Never set a movement beside a weakness in the same measure ("call volume has
    // been trending down, though call volume improved").
    const same = SIGNAL_METRIC[input.weakest!.id] ?? null;
    const fell = bad.find((x) => x.metric !== same);
    const rose = moves.filter((x) => x.up && x.metric !== same).slice(0, 2).map((x) => MOVEMENT_NOUN[x.metric]);
    if (fell) return `${weak}, and ${MOVEMENT_NOUN[fell.metric]} fell`;
    if (rose.length > 0) return `${weak}, though ${andJoin(rose)} improved`;
    return weak;
  }
  return bad[0] ? `${MOVEMENT_NOUN[bad[0].metric]} fell` : null;
}

// The movement a health signal measures, where it measures one.
const SIGNAL_METRIC: Readonly<Record<string, Movement['metric']>> = {
  'revenue-trend': 'revenue', 'revenue-stability': 'revenue', 'revenue-coverage': 'revenue',
  'profit-trend': 'profit', 'profit-stability': 'profit', 'profit-coverage': 'profit',
  'traffic-trend': 'totalCalls', 'traffic-stability': 'totalCalls', 'billable-efficiency': 'billableRate',
};

/** The first priority, as the brief points at it. */
export interface BriefPriority {
  readonly title: string;
  /** The metric its voice finding measures, e.g. "totalCalls". */
  readonly metric: string | null;
  readonly direction: 'up' | 'down' | null;
}

// Metrics the change sentence can state. When the first priority is about one of
// them, the brief points at it by name instead of repeating its headline.
const POINTER_NOUN: Readonly<Record<string, string>> = { totalCalls: 'call', billableRate: 'billable-rate' };

/**
 * Today's Brief: a band with its reason, then at most two short sentences -- what
 * materially changed, and what to review first -- within `BRIEF_MAX_WORDS` words.
 * It repeats no KPI figure: the change sentence is about total calls and the
 * billable rate, which the KPI tiles do not headline. The money, where revenue sits,
 * the health model's own explanation and what is not known move behind "View
 * details", each with its basis. It names no cause.
 *
 * When the comparison is withheld (see `assessCallGridCoverage`), the change sentence
 * is that line instead. A +305% built on a half-covered month is never stated.
 */
export function composeCallGridBrief(input: {
  readonly window: CallGridWindow;
  readonly metrics: CommandMetrics;
  readonly comparison: CommandMetrics | null;
  readonly coverage: CallGridCoverage;
  readonly buyers: readonly BriefShare[];
  readonly campaigns: readonly BriefShare[];
  readonly health: {
    readonly band: HealthBand;
    readonly reason: string | null;
    /** The health model's own explanation, for the details. */
    readonly explanation: string | null;
    /** Share of the model's weight that was measured. */
    readonly determinacy: number;
  };
  readonly firstPriority: BriefPriority | null;
}): CallGridBrief {
  const { window, metrics: m, coverage } = input;
  const c = input.comparison && input.comparison.available ? input.comparison : null;
  if (!m.available) {
    return {
      band: 'UNKNOWN', reason: null,
      sentences: [{ text: 'Loop could not read CallGrid data for this period.', basis: 'UNKNOWN', detail: null }],
      details: [],
    };
  }
  const band = input.health.band;
  const reason = input.health.reason;
  const calls = m.totalCalls;
  const details: BriefSentence[] = [];
  let change: BriefSentence | null = null;
  const stated = new Set<string>();

  // 1. What materially changed -- or why nothing can be compared.
  const phrase = comparisonPhrase(window);
  if (calls === 0) {
    change = { text: `No calls were recorded ${window.includesLiveData ? 'so far' : 'in this period'}.`, basis: 'MEASURED', detail: null };
  } else if (coverage.note) {
    change = { text: coverage.note, basis: 'UNKNOWN', detail: 'Loop does not compare against days before its record starts; they were not observed, so they are not zeros.' };
  } else if (c && phrase && calls !== null && c.totalCalls !== null && c.totalCalls > 0) {
    const callPct = pctChange(calls, c.totalCalls);
    const rate = billableRate(m);
    const prior = billableRate(c);
    const rateMoved = rate !== null && prior !== null && Math.abs(Math.round(rate) - Math.round(prior)) >= MATERIAL_PTS;
    const callsMoved = Math.abs(callPct) >= MATERIAL_PCT;
    const callText = callsMoved ? `Total calls are ${callPct > 0 ? 'up' : 'down'} ${Math.abs(callPct)}% versus ${phrase}` : null;
    const rateText = rateMoved ? `the billable rate ${rate! > prior! ? 'rose' : 'fell'} from ${Math.round(prior!)}% to ${Math.round(rate!)}%` : null;
    let text: string;
    if (callText && rateText) text = `${callText}, while ${rateText}.`;
    else if (callText) text = `${callText}.`;
    else if (rateText) text = `Total calls held level versus ${phrase}, while ${rateText}.`;
    else text = `Total calls and the billable rate held level versus ${phrase}.`;
    if (callsMoved) stated.add('totalCalls');
    if (rateMoved) stated.add('billableRate');
    change = {
      text,
      basis: 'ARITHMETIC',
      detail: `${calls.toLocaleString('en-US')} total calls against ${c.totalCalls.toLocaleString('en-US')}` +
        (m.billableCalls !== null && c.billableCalls !== null ? `; billable ${m.billableCalls.toLocaleString('en-US')} of ${calls.toLocaleString('en-US')} against ${c.billableCalls.toLocaleString('en-US')} of ${c.totalCalls.toLocaleString('en-US')}.` : '.'),
    };
  } else if (calls !== null) {
    const rate = billableRate(m);
    change = {
      text: `${calls.toLocaleString('en-US')} total calls ${window.includesLiveData ? 'so far' : 'in this period'}${rate !== null ? `, ${Math.round(rate)}% billable` : ''}; there is no comparison period.`,
      basis: 'MEASURED',
      detail: null,
    };
  }

  // 2. What to review first -- the first of the priorities below, named once.
  let attention: BriefSentence | null = null;
  const p = input.firstPriority;
  if (p) {
    const noun = p.metric ? POINTER_NOUN[p.metric] : undefined;
    const text = noun && stated.has(p.metric!) && p.direction
      ? `Review the ${noun} ${p.direction === 'down' ? 'decline' : 'increase'} first.`
      : `Review first: ${p.title}.`;
    attention = { text, basis: 'READING', detail: 'The first of the priorities below, in the order Loop ranked them.' };
  } else if (calls !== null && calls > 0) {
    attention = { text: 'Nothing undecided needs review.', basis: 'READING', detail: null };
  }

  // The details: what the tiles and the band summarize, each with its basis.
  if (m.revenueCents !== null) {
    const margin = marginOf(m.profitCents, m.revenueCents);
    details.push({
      text: `Revenue ${money(m.revenueCents)}${m.profitCents !== null ? `, net profit ${money(m.profitCents)}${margin !== null ? ` (${margin.toFixed(1)}% margin)` : ''}` : ''}.`,
      basis: margin === null ? 'MEASURED' : 'ARITHMETIC',
      detail: m.profitCents !== null ? 'Net profit is revenue minus payout minus telco cost.' : null,
    });
  }
  const buyer = topShare(input.buyers, m.revenueCents);
  const campaign = topShare(input.campaigns, m.revenueCents);
  if (buyer || campaign) {
    const parts: string[] = [];
    if (buyer) parts.push(`${buyer.label} accounts for ${buyer.pct}% of buyer revenue`);
    if (campaign) parts.push(`${campaign.label} carries ${campaign.pct}% by campaign`);
    details.push({ text: `${parts.join('; ')}.`, basis: 'ARITHMETIC', detail: 'Shares of the period’s total revenue.' });
  }
  if (input.health.explanation) {
    details.push({ text: input.health.explanation, basis: 'READING', detail: 'From Loop’s health model over the measured signals.' });
  }
  if (input.health.determinacy < 1 && band !== 'UNKNOWN') {
    details.push({ text: `The health model measured ${Math.round(input.health.determinacy * 100)}% of its weight; the rest had no data.`, basis: 'UNKNOWN', detail: null });
  }
  if (m.revenueCoverage !== null && m.revenueCoverage < 1) {
    details.push({
      text: `Only ${Math.round(m.revenueCoverage * 100)}% of calls carried a revenue value, so revenue and profit are incomplete.`,
      basis: 'UNKNOWN',
      detail: null,
    });
  }

  // Hold the budget: drop the pointer's headline first, then the pointer.
  const sentences = [change, attention].filter((x): x is BriefSentence => x !== null);
  const brief = { band, reason, sentences, details };
  if (briefWordCount(brief) <= BRIEF_MAX_WORDS || !attention) return brief;
  const shorter = [change, { ...attention, text: 'Review the first priority below.' }].filter((x): x is BriefSentence => x !== null);
  if (briefWordCount({ band, reason, sentences: shorter }) <= BRIEF_MAX_WORDS) return { ...brief, sentences: shorter };
  return { ...brief, sentences: change ? [change] : [] };
}

// --- Priorities -------------------------------------------------------------------------------

export type SituationKind = 'RISK' | 'OPPORTUNITY' | 'NEEDS_INVESTIGATION' | 'WATCH';

export const SITUATION_KIND_LABELS: Readonly<Record<SituationKind, string>> = Object.freeze({
  RISK: 'Risk',
  OPPORTUNITY: 'Opportunity',
  NEEDS_INVESTIGATION: 'Needs investigation',
  WATCH: 'Watch',
});

/** Findings that are a risk whichever way anything moved. */
const ALWAYS_RISK: ReadonlySet<FindingType> = new Set(['RISK', 'CONCENTRATION', 'BID_REJECTION', 'BID_DESTINATION', 'OPERATIONAL']);

/**
 * Which way is good for a metric the engine names. Only metrics whose direction is
 * unambiguous are listed; a share, a rank or a contribution is good or bad only in
 * context, so it is absent and never guessed.
 */
export const METRIC_GOOD_DIRECTION: Readonly<Record<string, 'up' | 'down'>> = Object.freeze({
  revenue: 'up',
  profit: 'up',
  billableCalls: 'up',
  totalCalls: 'up',
  billableRate: 'up',
  revenuePerBillableCall: 'up',
  sourceWinRate: 'up',
  destinationAccepted: 'up',
  bidOpportunities: 'up',
  cost: 'down',
  costCents: 'down',
});

/**
 * A Situation's kind, read off the finding that raised it — never a score.
 *
 * Concentration, rejections and stated risks are RISK. A movement is an OPPORTUNITY
 * when it went the metric's good way (worth confirming it holds) and NEEDS
 * INVESTIGATION when it went the other way; a metric whose good direction is not
 * stated, or a movement without a measured sign, NEEDS INVESTIGATION.
 */
export function situationKind(situation: Situation): SituationKind {
  if (situation.opportunity) return 'OPPORTUNITY';
  // The kind of the finding the Situation speaks for, so the label matches its headline.
  const lead = voiceOf(situation) ?? situation.observations[0];
  if (!lead) return 'WATCH';
  if (ALWAYS_RISK.has(lead.findingType)) return 'RISK';
  if (lead.findingType === 'OPPORTUNITY') return 'OPPORTUNITY';
  if (lead.findingType === 'UNKNOWN') return 'WATCH';
  const change = lead.percentageChange ?? lead.absoluteChange;
  const good = METRIC_GOOD_DIRECTION[lead.primaryMetric];
  if (change === null || change === 0 || !good) return 'NEEDS_INVESTIGATION';
  const favorable = (change > 0) === (good === 'up');
  if (favorable) return 'OPPORTUNITY';
  return lead.findingType === 'MARGIN' || lead.findingType === 'QUALITY' ? 'RISK' : 'NEEDS_INVESTIGATION';
}

/**
 * The executive surface's priorities: the engine's own order, undecided items only,
 * at most `limit`. Fewer when fewer are undecided — an empty slot is never filled
 * with something a person already owns or closed.
 */
export function selectTopPriorities<T>(items: readonly T[], isUndecided: (item: T) => boolean, limit = 3): T[] {
  return items.filter(isUndecided).slice(0, Math.max(0, Math.min(limit, 3)));
}

// --- Funnels -----------------------------------------------------------------------------------

export interface FunnelStage {
  readonly key: string;
  readonly label: string;
  /** Null when the stage's data does not exist or was not reported — shown as unknown, never 0. */
  readonly value: number | null;
  /** How many of the stage's rows reported the value, when that is partial. */
  readonly note: string | null;
  /** Which grain this stage comes from, when the funnel crosses grains. */
  readonly grain: 'calls' | 'bid_snapshot' | 'money';
}

export interface CallOutcomeFacts {
  readonly calls: number;
  readonly completed: number;
  readonly completedReported: number;
  readonly monetized: number;
  readonly noRoute: number;
  readonly noRouteReported: number;
}

/**
 * CALLS → COMPLETED → BILLABLE → REVENUE → NET PROFIT, as far as the calls say.
 * Completed is shown only when calls reported it, with how many did.
 */
export function callFunnel(outcomes: CallOutcomeFacts, economics: { readonly revenueCents: number | null; readonly profitCents: number | null }): FunnelStage[] {
  const completedKnown = outcomes.completedReported > 0;
  return [
    { key: 'calls', label: 'Calls', value: outcomes.calls, note: null, grain: 'calls' },
    {
      key: 'completed',
      label: 'Completed',
      value: completedKnown ? outcomes.completed : null,
      note: !completedKnown ? 'CallGrid did not report completion for these calls.'
        : outcomes.completedReported < outcomes.calls ? `${outcomes.completedReported} of ${outcomes.calls} calls reported completion.` : null,
      grain: 'calls',
    },
    { key: 'billable', label: 'Billable', value: outcomes.monetized, note: null, grain: 'calls' },
    { key: 'revenue', label: 'Revenue', value: economics.revenueCents, note: null, grain: 'money' },
    { key: 'profit', label: 'Net Profit', value: economics.profitCents, note: null, grain: 'money' },
  ];
}

/** The bid-snapshot stages for one source, when a snapshot row exists for it. */
export interface BidSnapshotFacts {
  readonly total: number | null;
  readonly bids: number | null;
  readonly won: number | null;
  readonly rejected: number | null;
}

/**
 * BID OPPORTUNITIES → BIDS → WON, from the provider's bid snapshot. These stages are
 * a different grain from the calls (a provider reporting day in UTC, not the selected
 * Eastern period), and a surface must show them fenced, never as one continuous funnel.
 */
export function bidFunnel(snapshot: BidSnapshotFacts | null): FunnelStage[] {
  return [
    { key: 'opportunities', label: 'Bid opportunities', value: snapshot?.total ?? null, note: null, grain: 'bid_snapshot' },
    { key: 'bids', label: 'Bids submitted', value: snapshot?.bids ?? null, note: null, grain: 'bid_snapshot' },
    { key: 'won', label: 'Bids won', value: snapshot?.won ?? null, note: null, grain: 'bid_snapshot' },
    { key: 'rejected', label: 'Rejected', value: snapshot?.rejected ?? null, note: null, grain: 'bid_snapshot' },
  ];
}

// --- Labels ------------------------------------------------------------------------------------

/**
 * A reporting span's own name in CallGrid's Eastern calendar: "Sep 10" for one day,
 * "Sep 1 – 7" or "Aug 31 – Sep 6" for several. `end` is exclusive.
 */
export function easternSpanLabel(start: Date, end: Date): string {
  const a = easternYmd(start);
  const b = easternYmd(new Date(end.getTime() - 1));
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${MONTHS_SHORT[a.month - 1]} ${a.day}`;
  if (a.year === b.year && a.month === b.month) return `${MONTHS_SHORT[a.month - 1]} ${a.day} – ${b.day}`;
  return `${MONTHS_SHORT[a.month - 1]} ${a.day} – ${MONTHS_SHORT[b.month - 1]} ${b.day}`;
}

// --- Metric values, as a person reads them -------------------------------------------------------

/** Metrics the engine states in cents. */
const MONEY_METRICS: ReadonlySet<string> = new Set(['revenue', 'profit', 'cost', 'costCents', 'payout', 'revenuePerBillableCall', 'contributionToChange']);
/** Metrics the engine states as a fraction (0–1). */
const RATE_METRICS: ReadonlySet<string> = new Set(['billableRate', 'sourceWinRate', 'revenueShare', 'rejectRate', 'margin']);

/** A finding's value in its metric's own unit: dollars for cents, a percentage for a fraction, else a count. */
export function formatMetricValue(metric: string, value: number | null): string {
  if (value === null) return 'Unknown';
  if (MONEY_METRICS.has(metric)) {
    const sign = value < 0 ? '−' : '';
    return `${sign}$${Math.round(Math.abs(value) / 100).toLocaleString('en-US')}`;
  }
  if (RATE_METRICS.has(metric)) return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A relative change stated as a fraction (the engine's `percentageChange`), as a signed percentage. */
export function formatRelativeChange(fraction: number | null): string {
  if (fraction === null) return '—';
  const pct = Math.round(fraction * 1000) / 10;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`;
}
