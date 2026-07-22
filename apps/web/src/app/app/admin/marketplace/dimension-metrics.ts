// Shared CallGrid dimension metrics — the ONE definition of the summary numbers,
// trend, share, and sort for Buyers / Vendors / Campaigns (all call-projection
// dimensions with the same row shape). Pure; no JSX, no data access. Sources uses
// bid-grain metrics and does not share these.

import type { CallGridDimRow } from './callgrid-report';

export interface DimSummary {
  total: number;
  active: number;
  revenueCents: number;
  billableCalls: number;
  totalCalls: number;
  avgRevPerBillableCents: number | null;
}

/** Revenue per billable call — only when both are real and billable > 0. */
export function revPerBillable(revenueCents: number, billable: number): number | null {
  return billable > 0 ? Math.round(revenueCents / billable) : null;
}

export function summarizeRows(rows: readonly CallGridDimRow[]): DimSummary {
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  const billableCalls = rows.reduce((s, r) => s + r.monetized, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  return {
    total: rows.length,
    active: rows.filter((r) => r.calls > 0 || r.monetized > 0 || r.revenueCents > 0).length,
    revenueCents,
    billableCalls,
    totalCalls,
    avgRevPerBillableCents: revPerBillable(revenueCents, billableCalls),
  };
}

export interface Trend {
  text: string;
  dir: 'up' | 'down' | 'flat' | 'na';
}

/** A value's trend vs its prior-window self. Never a percentage when the prior
 *  denominator is zero/absent — that reads as "No comparable prior data". */
export function trend(current: number, prior: number | undefined): Trend {
  if (prior === undefined || prior <= 0) return { text: 'No comparable prior data', dir: 'na' };
  const change = Math.round(((current - prior) / prior) * 100);
  if (change === 0) return { text: '0%', dir: 'flat' };
  return { text: (change > 0 ? '+' : '') + change + '%', dir: change > 0 ? 'up' : 'down' };
}

export function shareOfRevenue(row: CallGridDimRow, totalRevenueCents: number): number {
  return totalRevenueCents > 0 ? Math.round((row.revenueCents / totalRevenueCents) * 100) : 0;
}
export function shareOfVolume(row: CallGridDimRow, totalCalls: number): number {
  return totalCalls > 0 ? Math.round((row.calls / totalCalls) * 100) : 0;
}

// --- Sorting (server-side, URL-driven) ---------------------------------------
export type DimSortKey = 'revenue' | 'billable' | 'calls' | 'revPerBillable' | 'profit';
export type SortDir = 'asc' | 'desc';
export const DIM_SORT_KEYS: readonly DimSortKey[] = ['revenue', 'billable', 'calls', 'revPerBillable', 'profit'];

function sortValue(r: CallGridDimRow, key: DimSortKey): number {
  switch (key) {
    case 'revenue': return r.revenueCents;
    case 'billable': return r.monetized;
    case 'calls': return r.calls;
    case 'revPerBillable': return revPerBillable(r.revenueCents, r.monetized) ?? -1;
    case 'profit': return r.marginCents;
    default: return r.revenueCents;
  }
}

export function parseDimSort(raw: string | undefined, dirRaw: string | undefined): { key: DimSortKey; dir: SortDir } {
  const key = (DIM_SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as DimSortKey) : 'revenue';
  const dir: SortDir = dirRaw === 'asc' ? 'asc' : 'desc';
  return { key, dir };
}

export function sortRows(rows: readonly CallGridDimRow[], key: DimSortKey, dir: SortDir): CallGridDimRow[] {
  const sorted = [...rows].sort((a, b) => sortValue(a, key) - sortValue(b, key));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

/** Build a `?`-less query string, dropping empty/undefined params. Used to keep
 *  the range + selection + sort on every link so navigation preserves them. */
export function buildDimQuery(params: Record<string, string | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
}
