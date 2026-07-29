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
import { type CallGridWindow, profitCents, coverage } from '@emgloop/shared';

/** The four call-projection dimensions. */
export type Dimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

export interface CallGridMetrics {
  available: boolean;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
  /** Fraction of calls that carried a revenue value — below 1 the economic
   *  totals are lower bounds and every surface must say so. Null when unknowable. */
  revenueCoverage: number | null;
  /** Profit is only as complete as its weakest input; partial payout or cost
   *  coverage OVERSTATES profit, so it is tracked separately from revenue. */
  profitCoverage: number | null;
}

/**
 * One entity's economics for a window.
 *
 * The economic fields are NULLABLE on purpose. An entity whose calls carried no
 * revenue value has unknown revenue — not zero revenue — and the two must not
 * render the same, rank the same, or feed a contribution analysis the same. The
 * type makes that unavoidable rather than asking each caller to remember it.
 */
export interface CallGridDimRow {
  key: string;
  label: string;
  calls: number;
  monetized: number; // billable calls
  converted: number;
  /** Null when NO call for this entity reported revenue. */
  revenueCents: number | null;
  payoutCents: number | null;
  costCents: number | null;
  /** Revenue − payout − cost. Null when revenue is unknown. */
  marginCents: number | null;
  /** Fraction of this entity's calls that carried a revenue value (null when it
   *  has no calls). Below 1, the revenue total is a lower bound. */
  revenueCoverage: number | null;
}

type Agg = Awaited<ReturnType<typeof crmRepos.marketplaceCalls.aggregateWindow>>;

const UNAVAILABLE: CallGridMetrics = {
  available: false, totalCalls: null, billableCalls: null,
  revenueCents: null, profitCents: null, revenueCoverage: null, profitCoverage: null,
};

function metricsOf(agg: Agg | null): CallGridMetrics {
  if (!agg) return UNAVAILABLE;
  // A window that was read and genuinely contained no calls is a real zero.
  // A window WITH calls but no economics is Unknown — never dressed up as $0.
  const noCalls = agg.calls === 0;
  const revKnown = agg.callsWithRevenue > 0;
  const revenue = noCalls ? 0 : revKnown ? agg.revenueCents : null;
  return {
    available: true,
    totalCalls: agg.calls,
    billableCalls: agg.monetized,
    revenueCents: revenue,
    profitCents: noCalls ? 0 : profitCents(revenue, agg.payoutCents, agg.costCents),
    revenueCoverage: coverage(agg.callsWithRevenue, agg.calls),
    // The weakest of the three inputs — profit cannot be more complete than the
    // component with the least coverage.
    profitCoverage: noCalls
      ? null
      : Math.min(
          coverage(agg.callsWithRevenue, agg.calls) ?? 1,
          coverage(agg.callsWithPayout, agg.calls) ?? 1,
          coverage(agg.callsWithCost, agg.calls) ?? 1,
        ),
  };
}

function rowsOf(agg: Agg | null, dim: Dimension): CallGridDimRow[] {
  if (!agg) return [];
  return agg[dim]
    .map((d) => {
      // Coverage decides knowledge: a value nobody reported stays absent.
      const revenueCents = d.callsWithRevenue > 0 ? d.revenueCents : null;
      const payoutCents = d.callsWithPayout > 0 ? d.payoutCents : null;
      const costCents = d.callsWithCost > 0 ? d.costCents : null;
      return {
        key: d.key,
        label: d.label,
        calls: d.calls,
        monetized: d.monetized,
        converted: d.converted,
        revenueCents,
        payoutCents,
        costCents,
        marginCents: profitCents(revenueCents, d.payoutCents, d.costCents),
        revenueCoverage: coverage(d.callsWithRevenue, d.calls),
      };
    })
    .sort(byRevenueDesc);
}

/** Rank by revenue, with unknown revenue always last — an unpriced entity is not
 *  a zero-revenue entity and must never outrank one that reported a number. */
export function byRevenueDesc(a: CallGridDimRow, b: CallGridDimRow): number {
  if (a.revenueCents === null && b.revenueCents === null) return b.calls - a.calls;
  if (a.revenueCents === null) return 1;
  if (b.revenueCents === null) return -1;
  return b.revenueCents - a.revenueCents;
}

export interface CallGridReport {
  ok: boolean;
  window: CallGridWindow;
  metrics: CallGridMetrics;
  comparison: CallGridMetrics | null;
  /** Current-window rows per dimension, revenue-desc. THE ranked collection —
   *  Overview's "Top Buyer" is `dimensions.buyers[0]`, which is by construction
   *  the first row of the Buyers table. There is no second ranking path. */
  dimensions: Record<Dimension, CallGridDimRow[]>;
  /** Comparison-window rows per dimension, same ranking, so rank movement is
   *  measured between two identically-sorted collections. */
  comparisonDimensions: Record<Dimension, CallGridDimRow[]>;
  /** Comparison-window rows keyed by entity key (for per-row trend lookups). */
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
  const comparisonDimensions = {} as Record<Dimension, CallGridDimRow[]>;
  const comparisonByKey = {} as Record<Dimension, Map<string, CallGridDimRow>>;
  for (const d of DIMS) {
    dimensions[d] = rowsOf(cur, d);
    comparisonDimensions[d] = rowsOf(cmp, d);
    comparisonByKey[d] = new Map(comparisonDimensions[d].map((r) => [r.key, r] as const));
  }

  return {
    ok: curR.ok,
    window,
    metrics: metricsOf(cur),
    comparison: window.comparisonStart ? metricsOf(cmp) : null,
    dimensions,
    comparisonDimensions,
    comparisonByKey,
  };
}
