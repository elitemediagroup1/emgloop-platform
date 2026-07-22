import 'server-only';

// The canonical CallGrid reporting service — the ONE place every CallGrid page
// turns a date window into metrics + dimension rows. It reads the single economics
// source (MarketplaceCall projection via marketplaceCalls.aggregateWindow) for the
// selected window AND its comparison window, so every tab that renders the same
// range shows internally consistent numbers (Overview Top Buyer == Buyers row).
//
// Metric definitions live here, once (Truth-honest): a failed read is Unavailable,
// a window with calls but no economics is Unknown (null), a genuine no-activity
// window is a real $0. Nothing is coerced to zero.

import { crmRepos } from '../../../../crm/crm-data';
import { loadOrFallback } from '../../../../demo/db-health';
import type { CallGridWindow } from '@emgloop/shared';
import type { Dimension } from './callgrid-dimensions';

export type { Dimension } from './callgrid-dimensions';

export interface CallGridMetrics {
  available: boolean;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
}

export interface CallGridDimRow {
  key: string;
  label: string;
  calls: number;
  monetized: number; // billable calls
  converted: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  marginCents: number;
}

type Agg = Awaited<ReturnType<typeof crmRepos.marketplaceCalls.aggregateWindow>>;

const UNAVAILABLE: CallGridMetrics = { available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null };

function metricsOf(agg: Agg | null): CallGridMetrics {
  if (!agg) return UNAVAILABLE;
  const noCalls = agg.calls === 0;
  const revKnown = agg.callsWithRevenue > 0;
  return {
    available: true,
    totalCalls: agg.calls,
    billableCalls: agg.monetized,
    revenueCents: noCalls ? 0 : revKnown ? agg.revenueCents : null,
    profitCents: noCalls ? 0 : revKnown ? agg.revenueCents - agg.payoutCents - agg.costCents : null,
  };
}

function rowsOf(agg: Agg | null, dim: Dimension): CallGridDimRow[] {
  if (!agg) return [];
  return agg[dim]
    .map((d) => ({
      key: d.key,
      label: d.label,
      calls: d.calls,
      monetized: d.monetized,
      converted: d.converted,
      revenueCents: d.revenueCents,
      payoutCents: d.payoutCents,
      costCents: d.costCents,
      marginCents: d.revenueCents - d.payoutCents - d.costCents,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

export interface CallGridReport {
  ok: boolean;
  window: CallGridWindow;
  metrics: CallGridMetrics;
  comparison: CallGridMetrics | null;
  /** Current-window rows per dimension, revenue-desc. */
  dimensions: Record<Dimension, CallGridDimRow[]>;
  /** Comparison-window rows per dimension, keyed by entity key (for trend). */
  comparisonByKey: Record<Dimension, Map<string, CallGridDimRow>>;
}

const DIMS: Dimension[] = ['buyers', 'vendors', 'sources', 'campaigns'];

/**
 * Load the canonical report for a window. `organizationId` is the signed session
 * org (never from the client). A failed read degrades to Unavailable, never a
 * healthy-looking zero.
 */
export async function loadCallGridReport(organizationId: string, window: CallGridWindow): Promise<CallGridReport> {
  const curR = await loadOrFallback(async () =>
    crmRepos.marketplaceCalls.aggregateWindow(organizationId, window.start, window.end),
  );
  const cur = curR.ok ? curR.data : null;

  let cmp: Agg | null = null;
  if (window.comparisonStart && window.comparisonEnd) {
    const cmpR = await loadOrFallback(async () =>
      crmRepos.marketplaceCalls.aggregateWindow(organizationId, window.comparisonStart!, window.comparisonEnd!),
    );
    cmp = cmpR.ok ? cmpR.data : null;
  }

  const dimensions = {} as Record<Dimension, CallGridDimRow[]>;
  const comparisonByKey = {} as Record<Dimension, Map<string, CallGridDimRow>>;
  for (const d of DIMS) {
    dimensions[d] = rowsOf(cur, d);
    comparisonByKey[d] = new Map(rowsOf(cmp, d).map((r) => [r.key, r] as const));
  }

  return {
    ok: curR.ok,
    window,
    metrics: metricsOf(cur),
    comparison: window.comparisonStart ? metricsOf(cmp) : null,
    dimensions,
    comparisonByKey,
  };
}
