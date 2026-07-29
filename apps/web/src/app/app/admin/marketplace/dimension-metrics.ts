// Shared CallGrid dimension metrics — summary numbers, trend, share and sort for
// the call-projection dimensions.
//
// Every business formula here DELEGATES to the canonical metric contract in
// @emgloop/shared. This module owns presentation-adjacent concerns (summarising a
// row set, sorting, building URLs); it does not own arithmetic. If you need a new
// number, declare it in the contract first.
//
// Absence is preserved throughout: a row with unknown revenue contributes nothing
// to a total AND is counted as uncovered, so a partial dimension can say so.

import {
  revenuePerBillableCall, share as shareOf, percentageChange, sumReported, coverage,
} from '@emgloop/shared';
import type { CallGridDimRow } from './callgrid-report';

export interface DimSummary {
  /** Entities observed in this period. CallGrid exposes no roster, so this is
   *  never "entities configured on the account". */
  observed: number;
  /** Observed entities that produced revenue or a billable call. */
  active: number;
  revenueCents: number | null;
  billableCalls: number;
  totalCalls: number;
  avgRevPerBillableCents: number | null;
  /** Fraction of rows that reported revenue — below 1 the total is a lower bound. */
  revenueCoverage: number | null;
}

/** Revenue per billable call — the contract's formula, not a local one. */
export function revPerBillable(revenueCents: number | null, billable: number): number | null {
  return revenuePerBillableCall(revenueCents, billable);
}

export function summarizeRows(rows: readonly CallGridDimRow[]): DimSummary {
  const revenue = sumReported(rows, (r) => r.revenueCents);
  const billableCalls = rows.reduce((s, r) => s + r.monetized, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  return {
    observed: rows.length,
    // "Active" means economic activity, not merely a call — otherwise it would be
    // identical to `observed` for every row and tell the operator nothing.
    active: rows.filter((r) => r.monetized > 0 || (r.revenueCents !== null && r.revenueCents > 0)).length,
    revenueCents: revenue.total,
    billableCalls,
    totalCalls,
    avgRevPerBillableCents: revenuePerBillableCall(revenue.total, billableCalls),
    revenueCoverage: coverage(revenue.reported, rows.length),
  };
}

export interface Trend {
  text: string;
  dir: 'up' | 'down' | 'flat' | 'na';
}

/** A value's trend vs its prior-window self. Never a percentage when the prior
 *  denominator is zero/absent — that reads as "No comparable prior data". */
export function trend(current: number | null, prior: number | null | undefined): Trend {
  const pct = percentageChange(current ?? null, prior ?? null);
  if (pct === null) return { text: 'No comparable prior data', dir: 'na' };
  const change = Math.round(pct * 100);
  if (change === 0) return { text: '0%', dir: 'flat' };
  return { text: (change > 0 ? '+' : '') + change + '%', dir: change > 0 ? 'up' : 'down' };
}

/** An entity's share of revenue, as a percentage. Null when there is no
 *  denominator or the entity's own revenue is unknown. */
export function shareOfRevenue(row: CallGridDimRow, totalRevenueCents: number | null): number | null {
  const s = shareOf(row.revenueCents, totalRevenueCents);
  return s === null ? null : Math.round(s * 100);
}
export function shareOfVolume(row: CallGridDimRow, totalCalls: number): number | null {
  const s = shareOf(row.calls, totalCalls);
  return s === null ? null : Math.round(s * 100);
}

// --- Sorting (server-side, URL-driven) ---------------------------------------
export type DimSortKey = 'revenue' | 'billable' | 'calls' | 'revPerBillable' | 'profit';
export type SortDir = 'asc' | 'desc';
export const DIM_SORT_KEYS: readonly DimSortKey[] = ['revenue', 'billable', 'calls', 'revPerBillable', 'profit'];

/** The sort value for a row, or null when the metric is unknown for it. */
function sortValue(r: CallGridDimRow, key: DimSortKey): number | null {
  switch (key) {
    case 'revenue': return r.revenueCents;
    case 'billable': return r.monetized;
    case 'calls': return r.calls;
    case 'revPerBillable': return revenuePerBillableCall(r.revenueCents, r.monetized);
    case 'profit': return r.marginCents;
    default: return r.revenueCents;
  }
}

export function parseDimSort(raw: string | undefined, dirRaw: string | undefined): { key: DimSortKey; dir: SortDir } {
  const key = (DIM_SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as DimSortKey) : 'revenue';
  const dir: SortDir = dirRaw === 'asc' ? 'asc' : 'desc';
  return { key, dir };
}

/**
 * Sort rows by a metric. Rows whose value is UNKNOWN always sink to the bottom,
 * in both directions — an unmeasured entity must never be presented as the best
 * or the worst performer, which is what treating its absence as 0 would do.
 */
export function sortRows(rows: readonly CallGridDimRow[], key: DimSortKey, dir: SortDir): CallGridDimRow[] {
  const known: CallGridDimRow[] = [];
  const unknown: CallGridDimRow[] = [];
  for (const r of rows) (sortValue(r, key) === null ? unknown : known).push(r);
  known.sort((a, b) => {
    const av = sortValue(a, key)!;
    const bv = sortValue(b, key)!;
    return dir === 'desc' ? bv - av : av - bv;
  });
  return [...known, ...unknown];
}

/** Build a `?`-less query string, dropping empty/undefined params. Used to keep
 *  the range + selection + sort on every link so navigation preserves them. */
export function buildDimQuery(params: Record<string, string | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
}
