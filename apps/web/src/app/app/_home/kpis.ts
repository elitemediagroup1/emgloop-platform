// The executive KPI row on Loop Home: ONE pure projection of the CallGrid command context
// (admin/marketplace/command-data.ts) -- the same read the Command Center's own KPI row draws.
//
// NOTHING IS COMPUTED HERE. Every value, change, coverage note and "no comparison" reason is the
// contract's own (`callGridKpis`, @emgloop/shared); this module chooses which figures to show, puts
// them into words, and carries the window's OWN comparison label. It never compares a partial day
// against a complete one: the context's Today selection is cut at the same wall-clock time
// yesterday ("Yesterday to the same time"), and when Loop's record does not cover that comparison
// the context withholds it and says why. A figure Loop does not have is a word, never a zero.
//
// PURE. No loader, no clock, no I/O: the server hands the context in and reads the strip back.

import { metricDefinition, type CallGridKpi } from '@emgloop/shared';
import { money as dollars, num } from '../_loop-os/format';

/** The Command Center's context, named structurally so this module imports no loader. */
export interface HomeKpiInput {
  readonly kpis: readonly CallGridKpi[];
  readonly window: {
    readonly label: string;
    readonly includesLiveData: boolean;
    /** The window's own words for what it is compared against, e.g. "Yesterday to the same time". */
    readonly comparisonLabel: string | null;
  };
  readonly coverage: { readonly note: string | null };
  readonly freshness: { readonly state: string; readonly word: string; readonly detail: string };
  readonly report: {
    readonly ok: boolean;
    readonly metrics: { readonly available: boolean; readonly totalCalls: number | null; readonly billableCalls: number | null };
    /** The report's own dimension rows, in its own order (by revenue). Only the fields Home reads are named. */
    readonly dimensions: { readonly campaigns: readonly { readonly label: string; readonly monetized: number; readonly revenueCents: number | null }[] };
  };
  /** The selection's query, carried on every CallGrid link so the drill-down opens the same period. */
  readonly query: string;
}

export type HomeKpiState = CallGridKpi['state'];

export interface HomeKpi {
  readonly key: 'revenue' | 'netProfit' | 'billableCalls' | 'totalCalls' | 'activeCampaigns';
  readonly label: string;
  readonly state: HomeKpiState;
  /** The figure in words: a formatted value, or the state's own word. Never "0" for a figure Loop does not have. */
  readonly value: string;
  readonly change: { readonly direction: 'up' | 'down' | 'flat'; readonly text: string; readonly favorable: boolean | null } | null;
  /** The contract's reason there is no change line; null when there is one. */
  readonly noChangeReason: string | null;
  readonly subline: string | null;
  /** Below full coverage the figure is incomplete, and the contract says so. */
  readonly coverageNote: string | null;
  /** The measure's completeness rule, verbatim from the metric contract, where one applies. */
  readonly note: string | null;
  readonly href: string;
}

export interface HomeKpiStrip {
  /** OK: the report read. UNAVAILABLE: it could not be read. NO_DATA: Loop has never received anything from CallGrid. */
  readonly state: 'OK' | 'UNAVAILABLE' | 'NO_DATA';
  readonly kpis: readonly HomeKpi[];
  /** "Today so far" for a live window, otherwise the window's own label. */
  readonly periodLabel: string;
  /** The window's comparison label, or null when the context withheld or has no comparison. */
  readonly comparisonLabel: string | null;
  readonly coverageNote: string | null;
  readonly freshness: { readonly state: string; readonly word: string; readonly detail: string };
  /** For the CallGrid tile: billable calls in the window, when the report stated them. */
  readonly billableCalls: number | null;
  readonly totalCalls: number | null;
  /** Campaigns OBSERVED with a billable call or revenue in the window; null when the report could not be read. */
  readonly activeCampaigns: number | null;
  /** The campaign the report ranks first by revenue in the window, when one earned any; never computed here. */
  readonly leadingCampaign: { readonly label: string; readonly revenueCents: number } | null;
}

export const HOME_KPI_PATHS = Object.freeze({
  overview: '/app/admin/marketplace',
  money: '/app/admin/marketplace/money',
  campaigns: '/app/admin/marketplace/campaigns',
});

/**
 * The executive row, in the order the front door reads it: money first, then the calls behind it. Margin
 * and Telco Cost are components of net profit and stay on the Command Center; Total Calls is a declared
 * contract metric the Command Center shows only as the billable subline, built here by the same rule.
 */
export const HOME_KPI_KEYS: readonly CallGridKpi['key'][] = Object.freeze(['revenue', 'netProfit', 'billableCalls', 'totalCalls']);
const SHOWN = HOME_KPI_KEYS;

const ACTIVE_CAMPAIGNS = metricDefinition('activeCampaigns');

function withQuery(path: string, query: string, hash?: string): string {
  return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

/** Money with its sign in front of the dollar sign: a negative net profit reads as −$1,240, never $-1,240. */
export function kpiMoney(cents: number): string {
  return `${cents < 0 ? '−' : ''}${dollars(Math.abs(cents))}`;
}

/** The figure in words. The state's word wins over the value: an UNAVAILABLE KPI is never "$0". */
export function kpiWords(kpi: Pick<CallGridKpi, 'state' | 'value' | 'kind'>): string {
  if (kpi.state === 'UNAVAILABLE') return 'Unavailable';
  if (kpi.state === 'UNKNOWN' || kpi.value === null) return 'Unknown';
  if (kpi.kind === 'money') return kpiMoney(kpi.value);
  if (kpi.kind === 'percent') return `${kpi.value.toFixed(1)}%`;
  return num(kpi.value);
}

function projectKpi(kpi: CallGridKpi, query: string): HomeKpi {
  return {
    key: kpi.key as HomeKpi['key'],
    label: kpi.label,
    state: kpi.state,
    value: kpiWords(kpi),
    change: kpi.change,
    noChangeReason: kpi.noChangeReason,
    subline: kpi.subline,
    coverageNote: kpi.coverageNote,
    note: null,
    href: withQuery(HOME_KPI_PATHS.money, query, `kpi-${kpi.key}`),
  };
}

/** Campaigns observed with economic activity in the window. Observed, not a roster: CallGrid exposes none. */
function activeCampaignsOf(input: HomeKpiInput): number | null {
  if (!input.report.ok || !input.report.metrics.available) return null;
  return input.report.dimensions.campaigns.filter((r) => r.monetized > 0 || (r.revenueCents !== null && r.revenueCents > 0)).length;
}

function campaignsKpi(input: HomeKpiInput, active: number | null): HomeKpi {
  const unavailable = active === null;
  return {
    key: 'activeCampaigns',
    label: ACTIVE_CAMPAIGNS?.displayName ?? 'Active campaigns',
    state: unavailable ? 'UNAVAILABLE' : 'VALUE',
    value: unavailable ? 'Unavailable' : num(active),
    change: null,
    noChangeReason: unavailable ? 'CallGrid data could not be read.' : 'Observed in this period; not compared.',
    subline: ACTIVE_CAMPAIGNS?.description ?? null,
    coverageNote: null,
    note: ACTIVE_CAMPAIGNS?.completenessRule ?? null,
    href: withQuery(HOME_KPI_PATHS.campaigns, input.query),
  };
}

export function projectHomeKpis(input: HomeKpiInput): HomeKpiStrip {
  const ok = input.report.ok && input.report.metrics.available;
  const active = activeCampaignsOf(input);
  const kpis: HomeKpi[] = [
    ...SHOWN.map((key) => input.kpis.find((k) => k.key === key)).filter((k): k is CallGridKpi => k !== undefined).map((k) => projectKpi(k, input.query)),
    campaignsKpi(input, active),
  ];
  return {
    // The report read but CallGrid has never delivered anything: not a failure, and not figures either.
    state: !ok ? 'UNAVAILABLE' : input.freshness.state === 'UNAVAILABLE' ? 'NO_DATA' : 'OK',
    kpis,
    periodLabel: input.window.includesLiveData ? 'Today so far' : input.window.label,
    comparisonLabel: input.window.comparisonLabel,
    coverageNote: input.coverage.note,
    freshness: input.freshness,
    billableCalls: ok ? input.report.metrics.billableCalls : null,
    totalCalls: ok ? input.report.metrics.totalCalls : null,
    activeCampaigns: active,
    leadingCampaign: leadingCampaignOf(input, ok),
  };
}

/** The report's first campaign row with revenue: its ordering is the authority's, so this only reads the head. */
function leadingCampaignOf(input: HomeKpiInput, ok: boolean): HomeKpiStrip['leadingCampaign'] {
  if (!ok) return null;
  const first = input.report.dimensions.campaigns.find((r) => r.revenueCents !== null && r.revenueCents > 0);
  return first ? { label: first.label, revenueCents: first.revenueCents! } : null;
}
