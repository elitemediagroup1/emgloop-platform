// How a CallGrid metric reads to a person -- its name, its unit, and, for a finding,
// what its comparison value actually is. PRESENTATION ONLY: nothing here measures,
// ranks or decides, and no finding, evidence row or calculation is changed by it.
//
// ONE SOURCE FOR EACH FACT
//   • Names come from the metric contract (`metricDefinition`), and for bid outcomes
//     from their classification's display name. The few keys the engines use
//     without a contract entry are named here, once.
//   • Units live here and nowhere else. A key the engine records in cents is money,
//     a 0–1 fraction is a rate, a tally is a count.
//   • What a finding's comparison value IS belongs to the rule that produced it: the
//     same metric in the comparison period, an average of earlier complete periods,
//     or the whole period across every entity. `RULE_COMPARISONS` records that per
//     rule, read from each rule's code; a test holds every rule to an entry.
//
// FAIL CLOSED. A sentence names an entity only when the finding's own evidence ties
// the value to it, claims a comparison only as far as the rule's comparison is
// known, and never shows an internal key. When any of that cannot be established,
// it says only what it can.

import { metricDefinition } from './callgrid-metric-contract';
import { BID_REJECTION_CLASSIFICATIONS } from './callgrid-bid-intelligence';
import type { CallGridEvidenceReference, CallGridFinding } from './callgrid-intelligence';

export type MetricUnit = 'money' | 'rate' | 'count' | 'rank';

/** Keys whose recorded values are cents. */
const MONEY: ReadonlySet<string> = new Set([
  'revenue', 'profit', 'cost', 'costCents', 'payout', 'revenuePerBillableCall', 'profitPerBillableCall', 'vendorCost',
]);
/** Keys whose recorded values are a 0–1 fraction. */
const RATE: ReadonlySet<string> = new Set([
  'billableRate', 'sourceWinRate', 'sourceRejectRate', 'rejectRate', 'revenueShare', 'callShare', 'margin',
  'percentageChange', 'shareOfGrain', 'volatility',
]);
/** Keys whose recorded values are tallies. */
const COUNT: ReadonlySet<string> = new Set([
  'totalCalls', 'billableCalls', 'bidsWon', 'bidsSubmitted', 'bidOpportunities', 'destinationAccepted', 'consecutiveDirectionDays',
]);

const BID_OUTCOMES = BID_REJECTION_CLASSIFICATIONS;
const BID_KEYS: ReadonlySet<string> = new Set(BID_OUTCOMES.flatMap((c) => [c.key, c.providerField]));

/**
 * Names for keys the engines use that the metric contract does not define, or whose
 * contract name does not read as a noun in a sentence ("Accepted").
 */
const LOCAL_NAMES: Readonly<Record<string, string>> = {
  bidOpportunities: 'Bid opportunities',
  bidsWon: 'Bids won',
  bidsSubmitted: 'Bids submitted',
  destinationAccepted: 'Accepted pings',
  shareOfGrain: 'Share of outcomes',
  cost: 'Telco cost',
  costCents: 'Telco cost',
  payout: 'Payout',
  margin: 'Margin',
  rejectRate: 'Reject rate',
};

/** "Billable Rate" → "Billable rate"; acronyms ("Caller ID") keep their capitals. */
function sentenceCase(name: string): string {
  return name
    .split(' ')
    .map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/** A camelCase identifier as words: "comparisonRank" → "comparison rank". The last resort for a key with no name. */
export function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function bidOutcome(key: string) {
  return BID_OUTCOMES.find((c) => c.key === key || c.providerField === key) ?? null;
}

/** A metric key's name, never the key itself. */
export function metricLabel(key: string): string {
  // A bid outcome reads by CallGrid's own name for it, as a tally of outcomes.
  const bid = bidOutcome(key);
  if (bid) return `“${bid.displayName}” outcomes`;
  if (LOCAL_NAMES[key]) return LOCAL_NAMES[key]!;
  const def = metricDefinition(key);
  if (def) return sentenceCase(def.displayName);
  return humanizeKey(key);
}

function unitOf(key: string): MetricUnit | null {
  if (MONEY.has(key)) return 'money';
  if (RATE.has(key)) return 'rate';
  if (COUNT.has(key) || BID_KEYS.has(key)) return 'count';
  return null;
}

// --- Formatting ---------------------------------------------------------------------------

function dollars(cents: number, withCents: boolean): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents) / 100;
  const text = withCents
    ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(abs).toLocaleString('en-US');
  return `${sign}$${text}`;
}
function percent(fraction: number, digits: number): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * A value in its unit. `pair` is the other side of a comparison: when both round to
 * the same whole figure but differ, one more digit is shown, so "25% to 25%" never
 * hides a real move.
 */
function formatIn(unit: MetricUnit, value: number, pair: number | null = null): string {
  switch (unit) {
    case 'money': {
      const same = pair !== null && pair !== value && Math.round(pair / 100) === Math.round(value / 100);
      return dollars(value, same);
    }
    case 'rate': {
      const same = pair !== null && pair !== value && Math.round(pair * 100) === Math.round(value * 100);
      const tiny = value !== 0 && Math.abs(value) < 0.01;
      return percent(value, same || tiny ? 1 : 0);
    }
    case 'rank':
      return `#${Math.round(value)}`;
    case 'count':
      return Math.round(value).toLocaleString('en-US');
  }
}

/** The value an evidence row recorded, in its unit. A standardized score reads as one. */
export function formatEvidenceValue(e: Pick<CallGridEvidenceReference, 'metricKey' | 'formula'> & {
  readonly derivedValue?: number | null;
  readonly normalizedValue?: number | null;
  readonly rawValue?: number | null;
}): string {
  const v = e.derivedValue ?? e.normalizedValue ?? e.rawValue ?? null;
  if (v === null) return 'Unknown';
  if (e.formula && /standard deviation/i.test(e.formula)) return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} standard deviations`;
  if (e.metricKey === 'rankChange') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} place${Math.abs(v) === 1 ? '' : 's'}`;
  const unit = unitOf(e.metricKey);
  if (unit === 'money') return dollars(v, Math.abs(v) < 10_000 && !Number.isInteger(v / 100));
  if (unit === 'rate') return percent(v, 1);
  if (unit === 'count') return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  // An unnamed unit: a fraction reads as a percentage, anything else as a number.
  if (Math.abs(v) <= 1 && !Number.isInteger(v)) return percent(v, 1);
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A formula with its metric identifiers in words: "billableCalls / totalCalls" → "billable calls / total calls". */
export function humanizeFormula(formula: string): string {
  return formula.replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, (token) => metricLabel(token).toLowerCase());
}

// --- What a finding's comparison value is -----------------------------------------------------

/**
 * PERIOD: the same measure in the finding's comparison window.
 * HISTORY_AVERAGE: an average over earlier complete periods.
 * PERIOD_ALL: the whole selected period across every entity of the kind.
 * NOT_A_MEASURE: the finding's value is not an amount of its metric (a count of reversals).
 */
export type ComparisonBasis = 'PERIOD' | 'HISTORY_AVERAGE' | 'PERIOD_ALL' | 'NONE' | 'NOT_A_MEASURE';

export const RULE_COMPARISONS: Readonly<Record<string, ComparisonBasis>> = Object.freeze({
  'revenue-change': 'PERIOD',
  'profit-change': 'PERIOD',
  'volume-change': 'PERIOD',
  'billable-efficiency': 'PERIOD',
  'value-per-call': 'PERIOD',
  'entity-contribution': 'PERIOD',
  'revenue-concentration': 'PERIOD',
  'entity-inactive': 'PERIOD',
  'rank-movement': 'PERIOD',
  'anomaly-divergence': 'PERIOD',
  'anomaly-profit-divergence': 'PERIOD',
  'opportunity-value-improving': 'PERIOD',
  'bid-outcome-volume': 'PERIOD',
  'anomaly-revenue-outlier': 'HISTORY_AVERAGE',
  'anomaly-volume-outlier': 'HISTORY_AVERAGE',
  'anomaly-entity-disappeared': 'HISTORY_AVERAGE',
  'entity-record-period': 'HISTORY_AVERAGE',
  'entity-dormant': 'HISTORY_AVERAGE',
  'entity-consistency': 'HISTORY_AVERAGE',
  'entity-rising-dominance': 'HISTORY_AVERAGE',
  'opportunity-returning-entity': 'HISTORY_AVERAGE',
  'opportunity-efficiency-gap': 'PERIOD_ALL',
  'entity-emerging': 'NONE',
  'opportunity-diversification': 'NONE',
  'bid-win-rate': 'NONE',
  'anomaly-oscillation': 'NOT_A_MEASURE',
});

interface Measure {
  readonly label: string;
  readonly unit: MetricUnit;
  readonly plural: boolean;
  /** The evidence key its current and comparison values are recorded under. */
  readonly evidenceKeys: readonly string[];
}

/** How a finding's primary metric reads, in the unit of its current and comparison values. */
function measureOf(metric: string): Measure | null {
  // A contribution finding carries the entity's revenue in each period; the share
  // of the change is in its evidence.
  if (metric === 'contributionToChange') return { label: 'Revenue', unit: 'money', plural: false, evidenceKeys: ['revenue'] };
  if (metric === 'rankChange') return { label: 'Revenue rank', unit: 'rank', plural: false, evidenceKeys: ['rankChange'] };
  const unit = unitOf(metric);
  if (unit === null) return null;
  const bid = bidOutcome(metric);
  const keys = bid ? BID_OUTCOMES.filter((c) => c.providerField === metric || c.key === metric).map((c) => c.key) : [metric];
  return { label: metricLabel(metric), unit, plural: unit === 'count', evidenceKeys: keys };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(b) * 0.001, 0.0005);
}
function valueOf(e: CallGridEvidenceReference): number | null {
  return e.derivedValue ?? e.normalizedValue ?? e.rawValue ?? null;
}

/**
 * The evidence row that records one of the finding's values, so its entity can be
 * named. For a rank, the row records the move (comparison rank − current rank).
 */
function evidenceFor(f: CallGridFinding, m: Measure): CallGridEvidenceReference | null {
  const rows = f.supportingEvidence.filter((e) => m.evidenceKeys.includes(e.metricKey));
  if (m.unit === 'rank') {
    if (f.currentValue === null || f.comparisonValue === null) return null;
    const moved = f.comparisonValue - f.currentValue;
    return rows.find((e) => valueOf(e) === moved) ?? null;
  }
  const match = (value: number | null, window: string | null) =>
    value === null ? null : rows.find((e) => { const v = valueOf(e); return v !== null && near(v, value) && (window === null || e.window === window); }) ?? null;
  return match(f.currentValue, f.currentWindow) ?? match(f.comparisonValue, f.comparisonWindow) ?? null;
}

// --- Period wording ------------------------------------------------------------------------

/** "Today · Live" → "today so far"; "Sep 14, 2026 · Completed" → "on Sep 14, 2026"; "Last 7 Days" → "in the last 7 days". */
export function periodPhrase(label: string): string {
  const [base = '', ...rest] = label.split(' · ');
  const tail = rest.join(' · ');
  if (/^today$/i.test(base)) return /live/i.test(tail) ? 'today so far' : 'today';
  if (/^yesterday$/i.test(base)) return 'yesterday';
  if (/^(this|last) (week|month|year)$/i.test(base)) return base.toLowerCase();
  if (/^last \d+ (days|weeks)$/i.test(base)) return `in the ${base.toLowerCase()}`;
  if (/^year to date$/i.test(base)) return 'this year to date';
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(base)) return `on ${base}`;
  if (/^latest\b/i.test(base)) return `in the ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  return `in ${base}`;
}

/** "Yesterday · through 9:09 PM" → "yesterday through 9:09 PM"; "Prior Week" → "the prior week". */
export function comparisonPhrase(label: string): string {
  const [base = '', ...rest] = label.split(' · ');
  const tail = rest.length > 0 ? ` ${rest.join(' ')}` : '';
  let head: string;
  if (/^(yesterday|last|this|the)\b/i.test(base)) head = base.toLowerCase();
  else if (/^(previous|prior|preceding)\b/i.test(base)) head = `the ${base.toLowerCase()}`;
  else head = base;
  return `${head}${tail}`;
}

const ENTITY_PLURAL: Readonly<Record<string, string>> = {
  buyer: 'buyers', vendor: 'vendors', source: 'sources', campaign: 'campaigns',
  bid_source: 'sources', bid_destination: 'destinations',
};

// --- The observation -----------------------------------------------------------------------

/** A finding's measured values, as a person reads them -- or null when they cannot be stated plainly. */
export interface MeasuredValues {
  /** What was measured, with the entity when the evidence names it: "Revenue for Markytek". */
  readonly subject: string;
  readonly current: { readonly label: string; readonly value: string };
  /** The comparison, labelled by what it is. Null when the finding has none. */
  readonly comparison: { readonly label: string; readonly value: string } | null;
}

interface Resolved {
  readonly measure: Measure;
  readonly subject: string;
  readonly basis: ComparisonBasis | null;
  readonly entityType: string | null;
}

function resolve(f: CallGridFinding): Resolved | null {
  const basis = RULE_COMPARISONS[f.ruleId] ?? null;
  if (basis === 'NOT_A_MEASURE' || f.currentValue === null) return null;
  const measure = measureOf(f.primaryMetric);
  if (!measure) return null;
  const ev = evidenceFor(f, measure);
  // No evidence row records this value: what the number describes cannot be shown.
  if (!ev) return null;
  const entity = ev.entityName ?? null;
  return {
    measure,
    subject: entity ? `${measure.label} for ${entity}` : measure.label,
    basis,
    entityType: entity ? ev.entityType : f.affectedEntities[0]?.entityType ?? null,
  };
}

export function measuredValuesOf(f: CallGridFinding): MeasuredValues | null {
  const r = resolve(f);
  if (!r) return null;
  const cur = f.currentValue!;
  const cmp = f.comparisonValue;
  let comparison: MeasuredValues['comparison'] = null;
  if (cmp !== null) {
    const label =
      r.basis === 'PERIOD' && f.comparisonWindow ? f.comparisonWindow
      : r.basis === 'HISTORY_AVERAGE' ? 'Average of earlier complete periods'
      : r.basis === 'PERIOD_ALL' ? `All ${ENTITY_PLURAL[r.entityType ?? ''] ?? 'entities'}, same period`
      : 'Reference value';
    comparison = { label, value: formatIn(r.measure.unit, cmp, cur) };
  }
  return { subject: r.subject, current: { label: f.currentWindow, value: formatIn(r.measure.unit, cur, cmp) }, comparison };
}

/**
 * What happened, in one sentence built from the finding's structured fields -- the
 * same numbers, in words:
 *
 *   "Billable rate increased from 25% to 33% compared with yesterday through 9:09 PM."
 *   "Revenue for Markytek was $8,949 this week, against an average of $11,126 across earlier complete periods."
 *
 * A comparison is stated only as what the rule compared against. A value no evidence
 * row records, or a metric with no known unit, gets the plain count of evidence
 * instead of a guess.
 */
export function observationSentence(f: CallGridFinding): string {
  const r = resolve(f);
  const when = periodPhrase(f.currentWindow);
  if (!r) {
    const n = f.supportingEvidence.length;
    return `Measured from ${n} evidence ${n === 1 ? 'point' : 'points'} ${when}.`;
  }
  const { measure: m, subject } = r;
  const cur = f.currentValue!;
  const cmp = f.comparisonValue;
  const is = m.plural ? 'were' : 'was';

  if (cmp !== null && r.basis === 'PERIOD' && f.comparisonWindow) {
    const against = `compared with ${comparisonPhrase(f.comparisonWindow)}`;
    const a = formatIn(m.unit, cmp, cur);
    const b = formatIn(m.unit, cur, cmp);
    if (cur === cmp || a === b) return `${subject} held at ${b} ${against}.`;
    const verb = m.unit === 'rank' ? 'moved' : cur > cmp ? 'increased' : 'decreased';
    return `${subject} ${verb} from ${a} to ${b} ${against}.`;
  }
  const b = formatIn(m.unit, cur, cmp);
  if (cmp !== null && r.basis === 'HISTORY_AVERAGE') {
    return `${subject} ${is} ${b} ${when}, against an average of ${formatIn(m.unit, cmp, cur)} across earlier complete periods.`;
  }
  if (cmp !== null && r.basis === 'PERIOD_ALL') {
    const all = ENTITY_PLURAL[r.entityType ?? ''] ?? 'entities';
    return `${subject} ${is} ${b} ${when}, against ${formatIn(m.unit, cmp, cur)} across all ${all}.`;
  }
  return `${subject} ${is} ${b} ${when}.`;
}
