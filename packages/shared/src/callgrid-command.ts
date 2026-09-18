// The CallGrid command center — what the executive layer says, composed from what
// Loop already measured. PURE: no I/O, no clock (now is passed in), no model.
//
// Five things live here, each a projection over existing contracts rather than a new
// source of truth:
//
//   • BUCKETS — the time buckets a period is charted in (Eastern hours for a day,
//     Eastern days otherwise), and the comparison period's buckets aligned to them.
//   • KPIS — Net Profit, Revenue, Billable Calls, Margin and Telco Cost, from the
//     canonical report's metrics (Net Profit = revenue − payout − cost, exactly as
//     `profitCents` defines it), each with its comparison and a sparkline.
//   • FRESHNESS — Live, Current, Stale, Degraded or Unavailable, from when CallGrid
//     last actually delivered data. Never from the clock the page was rendered by.
//   • THE BRIEF — a handful of sentences, each carrying its basis: a measured fact,
//     arithmetic on measured facts, Loop's reading, or an unknown. No sentence claims
//     a cause.
//   • PRIORITIES AND FUNNELS — the kind of a Situation (risk, opportunity, needs
//     investigation) read off the finding that raised it, and funnels that show a
//     stage only when its data exists.

import { easternWallTimeToUtc, easternYmd, type EasternYmd } from './business-time';
import { profitCents } from './callgrid-metric-contract';
import type { CallGridWindow } from './callgrid-window';
import type { HealthBand } from './callgrid-health';
import type { Situation } from './callgrid-situation';
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
  readonly sentences: readonly BriefSentence[];
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

/**
 * Today's Brief: at most five sentences, each with its basis. Calls and billable
 * rate against the comparison period, revenue and margin, where revenue is
 * concentrated, Loop's health reading, and what is not known. It names no cause —
 * "calls fell while billable rate rose" is two measurements, not an explanation.
 */
export function composeCallGridBrief(input: {
  readonly window: CallGridWindow;
  readonly metrics: CommandMetrics;
  readonly comparison: CommandMetrics | null;
  readonly buyers: readonly BriefShare[];
  readonly campaigns: readonly BriefShare[];
  readonly health: { readonly band: HealthBand; readonly explanation: string | null };
}): CallGridBrief {
  const { window, metrics: m, comparison: c } = input;
  const out: BriefSentence[] = [];
  if (!m.available) {
    return { band: 'UNKNOWN', sentences: [{ text: 'Loop could not read CallGrid data for this period.', basis: 'UNKNOWN', detail: null }] };
  }
  const calls = m.totalCalls ?? 0;
  if (calls === 0) {
    out.push({ text: `No calls were recorded for ${window.includesLiveData ? 'this period so far' : 'this period'}.`, basis: 'MEASURED', detail: null });
    return { band: input.health.band, sentences: out };
  }

  // 1. Calls, and the billable rate, against the comparison period.
  const phrase = comparisonPhrase(window);
  const priorCalls = c && c.available ? c.totalCalls : null;
  const rate = m.billableCalls !== null ? m.billableCalls / calls : null;
  const priorRate = c && c.available && c.billableCalls !== null && priorCalls ? c.billableCalls / priorCalls : null;
  let first: string;
  let firstBasis: BriefBasis = 'MEASURED';
  let firstDetail = `${calls.toLocaleString('en-US')} calls`;
  if (phrase && priorCalls !== null && priorCalls > 0) {
    const pct = pctChange(calls, priorCalls);
    first = pct === 0 ? `Calls are level with ${phrase}` : `Calls are ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% versus ${phrase}`;
    firstBasis = 'ARITHMETIC';
    firstDetail = `${calls.toLocaleString('en-US')} calls against ${priorCalls.toLocaleString('en-US')}`;
  } else {
    first = `${calls.toLocaleString('en-US')} calls ${window.includesLiveData ? 'so far' : 'in this period'}`;
  }
  if (rate !== null && priorRate !== null) {
    const a = Math.round(priorRate * 100);
    const b = Math.round(rate * 100);
    first += b === a ? `, with the billable rate steady at ${b}%.` : `, while the billable rate ${b > a ? 'rose' : 'fell'} from ${a}% to ${b}%.`;
    firstBasis = 'ARITHMETIC';
    firstDetail += `; billable ${m.billableCalls!.toLocaleString('en-US')} of ${calls.toLocaleString('en-US')} against ${c!.billableCalls!.toLocaleString('en-US')} of ${priorCalls!.toLocaleString('en-US')}`;
  } else if (rate !== null) {
    first += `, ${Math.round(rate * 100)}% of them billable.`;
  } else {
    first += '.';
  }
  out.push({ text: first, basis: firstBasis, detail: firstDetail });

  // 2. Revenue, net profit and margin.
  if (m.revenueCents !== null) {
    const margin = marginOf(m.profitCents, m.revenueCents);
    const priorRevenue = c && c.available ? c.revenueCents : null;
    const change = priorRevenue !== null && priorRevenue > 0 ? pctChange(m.revenueCents, priorRevenue) : null;
    const lead = change === null
      ? `Revenue is ${money(m.revenueCents)}`
      : `Revenue is ${change === 0 ? 'level at' : `${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% at`} ${money(m.revenueCents)}`;
    const tail = m.profitCents !== null
      ? `, with net profit of ${money(m.profitCents)}${margin !== null ? ` (${margin.toFixed(1)}% margin)` : ''}.`
      : '.';
    out.push({
      text: lead + tail,
      basis: change === null && margin === null ? 'MEASURED' : 'ARITHMETIC',
      detail: m.profitCents !== null ? 'Net profit is revenue minus payout minus telco cost.' : null,
    });
  }

  // 3. Where the revenue is concentrated.
  const buyer = topShare(input.buyers, m.revenueCents);
  const campaign = topShare(input.campaigns, m.revenueCents);
  if (buyer || campaign) {
    const parts: string[] = [];
    if (buyer) parts.push(`${buyer.label} accounts for ${buyer.pct}% of buyer revenue`);
    if (campaign) parts.push(`${campaign.label} carries ${campaign.pct}% by campaign`);
    out.push({ text: `${parts.join(', and ')}.`.replace(/^./, (ch) => ch.toUpperCase()), basis: 'ARITHMETIC', detail: 'Shares of the period’s total revenue.' });
  }

  // 4. Loop's reading of overall health.
  if (input.health.explanation) {
    out.push({ text: input.health.explanation, basis: 'READING', detail: 'From Loop’s health model over the measured signals.' });
  }

  // 5. What is not known.
  if (m.revenueCoverage !== null && m.revenueCoverage < 1) {
    out.push({
      text: `Only ${Math.round(m.revenueCoverage * 100)}% of calls carried a revenue value, so revenue and profit are incomplete for the period.`,
      basis: 'UNKNOWN',
      detail: null,
    });
  }
  return { band: input.health.band, sentences: out.slice(0, 5) };
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
  const lead = situation.observations[0];
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
