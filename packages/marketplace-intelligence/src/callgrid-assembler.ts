// @emgloop/marketplace-intelligence — CallGrid Assembler (pure, unwired).
//
// PR #44 (Marketplace Intelligence CallGrid Assembler). A deterministic function
// that projects ALREADY-RECONCILED CallGrid report facts (from callgrid-input.ts:
// /api/reports/bidStats, /api/reports/bidStats/rejections, /api/reports/stats)
// into the canonical, provider-neutral Marketplace Intelligence model authored in
// PR #43. It mirrors the exact non-invasive precedent set by
// packages/brain/src/call-handling-metrics-assembler.ts:
//
//   Reconciled CallGrid report rows (already fetched)
//        │ (this file: pure, read-only projection)
//        ▼
//   MarketplaceIntelligence  (PR #43 canonical snapshot)
//
// STRICTLY READ-ONLY AND NON-INVASIVE. This assembler:
//   • reads a caller-supplied CallGridReportInput — it NEVER reads the DB, calls
//     CallGrid, or touches ingestion; the caller passes in rows it already has.
//   • performs pure aggregation/renaming (counts + passthrough) with no I/O, no
//     clock, no RNG, no persistence, and no mutation of its inputs.
//   • changes NO runtime behavior and is wired into NO live path. It is a helper
//     a test or a future, separately-decided caller may use.
//   • uses NO LLM and generates NO recommendations or insights. Those come from
//     the Brain, which is NOT wired to this model yet — so recommendations,
//     insights, diagnostics, and unknowns/missingEvidence are honestly EMPTY,
//     annotated via BRAIN_NOT_WIRED below.
//
// It introduces NO new decision logic: it only translates CallGrid's own numbers
// into EMG's business vocabulary. Where CallGrid exposes a metric the canonical
// model does not name as a first-class field, that metric is preserved in
// 'metadata' rather than by changing the PR #43 model.

import type { Confidence } from '@emgloop/brain';
import type {
  MarketplaceIntelligence,
} from './marketplace-intelligence';
import type {
  MarketplaceTimeWindow,
  MarketplaceEntityIntelligence,
  MarketplaceHealth,
  MarketplaceRejectReason,
} from './common';
import type { CampaignIntelligence } from './campaign-intelligence';
import type { BuyerIntelligence } from './buyer-intelligence';
import type { SourceIntelligence } from './source-intelligence';
import type { VendorIntelligence } from './vendor-intelligence';
import type { MarketplaceFunnel, MarketplaceFunnelStage } from './marketplace-funnel';
import type { MarketplaceProfitability } from './profitability';
import type {
  CallGridReportInput,
  CallGridReportWindow,
  CallGridBidStatsRow,
  CallGridRejectionRow,
  CallGridStatsRow,
  CallGridStatsMetrics,
} from './callgrid-input';

// ---------------------------------------------------------------------------
// Honesty constants.
// ---------------------------------------------------------------------------

/** The Brain (diagnostics + recommendations + Brain Activity) is NOT wired to
 * Marketplace Intelligence yet. Until it is, this assembler must never fabricate
 * insight: recommendations/insights stay empty and every subject records this
 * note in missingEvidence so consumers see WHY, honestly, rather than a silent
 * gap. Removing this note is a deliberate future PR, not a side effect. */
export const BRAIN_NOT_WIRED =
  'brain_diagnostics_not_wired: recommendations/insights intentionally empty until the Brain is connected to Marketplace Intelligence';

/** Sensor id stamped on every entity this assembler produces. */
const SENSOR = 'callgrid' as const;

/** Confidence this assembler asserts. It projects raw sensor facts and runs no
 * diagnosis, so it claims no interpretive confidence: 0 is the honest value
 * until the Brain grades the snapshot. */
const NO_DIAGNOSIS_CONFIDENCE: Confidence = 0;

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

/** Percentage (CallGrid 0–100) → ratio (0–1). Undefined stays undefined so an
 * absent metric never becomes a fabricated 0. */
function pctToRatio(pct?: number): number | undefined {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return undefined;
  return pct / 100;
}

/** Pass a finite number through; map anything else to undefined (honest absence). */
function num(n?: number): number | undefined {
  if (typeof n !== 'number' || Number.isNaN(n)) return undefined;
  return n;
}

/** Project the CallGrid report window onto the canonical time window. */
function toTimeWindow(w: CallGridReportWindow): MarketplaceTimeWindow {
  return { startAt: w.startAt, endAt: w.endAt, label: w.label };
}

/** The empty-by-design envelope fields every entity carries until the Brain is
 * wired: no trends, no recommendations, no unknowns, and a single honest
 * missingEvidence note. Factored out so every entity reports ignorance the
 * same way. */
function emptyBrainFields(): Pick<
  MarketplaceEntityIntelligence,
  'confidence' | 'trends' | 'recommendations' | 'unknowns' | 'missingEvidence'
> {
  return {
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    trends: [],
    recommendations: [],
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
  };
}

// ---------------------------------------------------------------------------
// Source Intelligence — from /api/reports/bidStats (+ rejection reasons).
// ---------------------------------------------------------------------------

/** Map one CallGrid rejection row into canonical, open-string reject reasons. A
 * mapping table keeps CallGrid's reason names on the INPUT side; the canonical
 * reasons are plain, sensor-neutral strings. */
function rejectReasonsFor(rej?: CallGridRejectionRow): ReadonlyArray<MarketplaceRejectReason> {
  if (!rej) return [];
  const pairs: Array<[string, number | undefined]> = [
    ['caller_id_blocked', rej.callerId],
    ['destination_closed', rej.closed],
    ['paused', rej.paused],
    ['duplicate_caller', rej.duplicate],
    ['duplicate_bid', rej.duplicateBids],
    ['failed_acceptance', rej.failedAcceptance],
    ['failed_tag_rules', rej.failedTagRules],
  ];
  return pairs
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Build Source Intelligence from bidStats rows. Each source becomes one
 * SourceIntelligence. CallGrid metrics that the canonical SourceIntelligence
 * does not name as first-class (totalBidAmount, avgBid, avgWinningBid, bidRate,
 * winRate, rated, total pings) are preserved in metadata — the model is NOT
 * changed to accommodate them.
 */
export function toSourceIntelligence(
  input: CallGridReportInput,
): ReadonlyArray<SourceIntelligence> {
  const rows = input.bidStats ?? [];
  const rejBySource = new Map<string, CallGridRejectionRow>();
  (input.rejections ?? []).forEach((r) => rejBySource.set(r.sourceId, r));
  const timeWindow = toTimeWindow(input.window);

  return rows.map((row: CallGridBidStatsRow): SourceIntelligence => {
    const rej = rejBySource.get(row.sourceId);
    return {
      organizationId: input.organizationId,
      locationId: input.locationId,
      id: row.sourceId,
      name: row.sourceName ?? row.sourceId,
      sensor: SENSOR,
      timeWindow,
      ...emptyBrainFields(),

      sourceId: row.sourceId,
      sourceName: row.sourceName ?? row.sourceId,

      bidsSent: num(row.bids),
      bidsAccepted: num(row.rated),
      bidsWon: num(row.won),

      rejectReasons: rejectReasonsFor(rej),

      // fulfillment/callQuality/revenueGenerated/profit are unknown from bidStats
      // alone — left honestly undefined rather than guessed.
      fulfillment: undefined,
      callQuality: 'unknown' as MarketplaceHealth,
      revenueGenerated: undefined,
      profit: undefined,

      // CallGrid metrics with no first-class home in the canonical model are
      // preserved here rather than changing the model (task rule).
      metadata: {
        callgrid: {
          total: num(row.total),
          rated: num(row.rated),
          rejected: num(row.rejected),
          totalBidAmount: num(row.totalBidAmount),
          totalWonAmount: num(row.totalWonAmount),
          avgBid: num(row.avgBid),
          avgWinningBid: num(row.avgWinningBid),
          winRate: num(row.winRate),
          bidRate: num(row.bidRate),
          rejectRate: num(row.rejectRate),
          rejectionBreakdown: rej,
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Stats-pivot projections — Campaign / Buyer / Vendor Intelligence.
//
// /api/reports/stats returns rows pivoted by a chosen dimension. We route rows
// to the matching canonical entity by their pivot, mapping the metric columns
// the canonical field names cover and stashing the rest in metadata.
// ---------------------------------------------------------------------------

/** Common metric extraction shared by campaign/buyer/vendor projections. */
function money(m: CallGridStatsMetrics): {
  revenue?: number;
  payout?: number;
  cost?: number;
  profit?: number;
  margin?: number;
} {
  const revenue = num(m.total_revenue);
  const payout = num(m.total_payout);
  const cost = num(m.total_cost);
  // net_profit preferred; fall back to gross_profit; never COMPUTE one here —
  // deriving profit is a later decision outside this canonical projection.
  const profit = num(m.net_profit) ?? num(m.gross_profit);
  const margin = num(m.margin);
  return { revenue, payout, cost, profit, margin };
}

/** Rows whose pivot names campaigns → CampaignIntelligence. */
export function toCampaignIntelligence(
  input: CallGridReportInput,
): ReadonlyArray<CampaignIntelligence> {
  const timeWindow = toTimeWindow(input.window);
  return (input.stats ?? [])
    .filter((r) => r.pivot === 'CampaignName')
    .map((row: CallGridStatsRow): CampaignIntelligence => {
      const mo = money(row.metrics);
      return {
        organizationId: input.organizationId,
        locationId: input.locationId,
        id: row.keyId ?? row.key,
        name: row.key,
        sensor: SENSOR,
        timeWindow,
        ...emptyBrainFields(),

        campaignId: row.keyId ?? row.key,
        campaignName: row.key,

        bidsReceived: undefined,
        bidsAccepted: undefined,
        bidsWon: undefined,

        completedCalls: num(row.metrics.completed),
        billableCalls: num(row.metrics.billable),
        convertedCalls: num(row.metrics.converted),

        revenue: mo.revenue,
        payout: mo.payout,
        cost: mo.cost,
        profit: mo.profit,
        margin: mo.margin,

        metadata: { callgrid: { pivot: row.pivot, metrics: row.metrics } },
      };
    });
}

/** Rows whose pivot names buyers → BuyerIntelligence. */
export function toBuyerIntelligence(
  input: CallGridReportInput,
): ReadonlyArray<BuyerIntelligence> {
  const timeWindow = toTimeWindow(input.window);
  return (input.stats ?? [])
    .filter((r) => r.pivot === 'BuyerName')
    .map((row: CallGridStatsRow): BuyerIntelligence => {
      const mo = money(row.metrics);
      const calls = num(row.metrics.calls);
      const billable = num(row.metrics.billable);
      const converted = num(row.metrics.converted);
      return {
        organizationId: input.organizationId,
        locationId: input.locationId,
        id: row.keyId ?? row.key,
        name: row.key,
        sensor: SENSOR,
        timeWindow,
        ...emptyBrainFields(),

        buyerId: row.keyId ?? row.key,
        buyerName: row.key,
        // health is a Brain judgement, not a sensor fact → honest 'unknown'.
        health: 'unknown',

        acceptanceRate: undefined,
        completionRate: undefined,
        // Ratios computable purely from this row's own counts are allowed
        // (arithmetic, not diagnosis); absent denominators stay undefined.
        billableRate:
          typeof calls === 'number' && calls > 0 && typeof billable === 'number'
            ? billable / calls
            : undefined,
        conversionRate:
          typeof calls === 'number' && calls > 0 && typeof converted === 'number'
            ? converted / calls
            : undefined,

        revenue: mo.revenue,
        payout: mo.payout,
        profit: mo.profit,

        routingPerformance: undefined,
        // diagnostics come from the Brain, which is not wired → omit (undefined).
        diagnostics: undefined,

        metadata: { callgrid: { pivot: row.pivot, metrics: row.metrics } },
      };
    });
}

/** Rows whose pivot names vendors → VendorIntelligence. */
export function toVendorIntelligence(
  input: CallGridReportInput,
): ReadonlyArray<VendorIntelligence> {
  const timeWindow = toTimeWindow(input.window);
  return (input.stats ?? [])
    .filter((r) => r.pivot === 'VendorName')
    .map((row: CallGridStatsRow): VendorIntelligence => {
      const mo = money(row.metrics);
      return {
        organizationId: input.organizationId,
        locationId: input.locationId,
        id: row.keyId ?? row.key,
        name: row.key,
        sensor: SENSOR,
        timeWindow,
        ...emptyBrainFields(),

        vendorId: row.keyId ?? row.key,
        vendorName: row.key,

        trafficContribution: undefined,
        routingPerformance: undefined,

        revenue: mo.revenue,
        profit: mo.profit,
        quality: 'unknown',

        metadata: { callgrid: { pivot: row.pivot, metrics: row.metrics } },
      };
    });
}

// ---------------------------------------------------------------------------
// Funnel — an ordered, open-ended set of stages from aggregate totals.
// ---------------------------------------------------------------------------

/** Sum a numeric field across bidStats rows; undefined when no row supplies it. */
function sumBid(rows: ReadonlyArray<CallGridBidStatsRow>, pick: (r: CallGridBidStatsRow) => number | undefined): number | undefined {
  let sum = 0;
  let seen = false;
  rows.forEach((r) => {
    const v = pick(r);
    if (typeof v === 'number' && !Number.isNaN(v)) { sum += v; seen = true; }
  });
  return seen ? sum : undefined;
}

/** Sum a stats metric across all stats rows (any pivot). */
function sumStat(rows: ReadonlyArray<CallGridStatsRow>, key: keyof CallGridStatsMetrics): number | undefined {
  let sum = 0;
  let seen = false;
  rows.forEach((r) => {
    const v = r.metrics[key];
    if (typeof v === 'number' && !Number.isNaN(v)) { sum += v; seen = true; }
  });
  return seen ? sum : undefined;
}

/**
 * Build the default pay-per-call funnel (bids → accepted → won → calls →
 * completed → billable → revenue → profit) from aggregate totals. Stages whose
 * count is unknown are OMITTED (count stays undefined per the model), never
 * zero-filled. 'order' is dense over the stages actually present.
 */
export function toFunnel(input: CallGridReportInput): MarketplaceFunnel {
  const bids = input.bidStats ?? [];
  const stats = input.stats ?? [];
  const candidates: Array<{ key: string; label: string; count?: number }> = [
    { key: 'bids_received', label: 'Bids Received', count: sumBid(bids, (r) => r.bids) },
    { key: 'accepted', label: 'Accepted', count: sumBid(bids, (r) => r.rated) },
    { key: 'won', label: 'Won', count: sumBid(bids, (r) => r.won) },
    { key: 'calls', label: 'Calls', count: sumStat(stats, 'calls') },
    { key: 'completed', label: 'Completed', count: sumStat(stats, 'completed') },
    { key: 'billable', label: 'Billable', count: sumStat(stats, 'billable') },
    { key: 'revenue', label: 'Revenue', count: sumStat(stats, 'total_revenue') },
    { key: 'profit', label: 'Profit', count: sumStat(stats, 'net_profit') ?? sumStat(stats, 'gross_profit') },
  ];
  const stages: MarketplaceFunnelStage[] = candidates
    .filter((c) => typeof c.count === 'number')
    .map((c, i) => ({ key: c.key, label: c.label, count: c.count, order: i }));

  return {
    organizationId: input.organizationId,
    locationId: input.locationId,
    timeWindow: toTimeWindow(input.window),
    stages,
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    unknowns: [],
  };
}

// ---------------------------------------------------------------------------
// Profitability — pure passthrough of stats totals (no calculations).
// ---------------------------------------------------------------------------

/**
 * Build the marketplace profitability snapshot by SUMMING the stats totals the
 * report already states. It performs no derivation beyond addition of values
 * CallGrid supplies; where a value is absent it stays undefined. grossProfit /
 * netProfit / margin are passed through only if CallGrid stated them.
 */
export function toProfitability(input: CallGridReportInput): MarketplaceProfitability {
  const stats = input.stats ?? [];
  return {
    organizationId: input.organizationId,
    locationId: input.locationId,
    timeWindow: toTimeWindow(input.window),

    revenue: sumStat(stats, 'total_revenue'),
    payout: sumStat(stats, 'total_payout'),
    cost: sumStat(stats, 'total_cost'),
    telco: sumStat(stats, 'telco'),
    grossProfit: sumStat(stats, 'gross_profit'),
    netProfit: sumStat(stats, 'net_profit'),
    margin: sumStat(stats, 'margin'),

    confidence: NO_DIAGNOSIS_CONFIDENCE,
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
  };
}

// ---------------------------------------------------------------------------
// Top-level assembler.
// ---------------------------------------------------------------------------

/**
 * Project a caller-supplied window of reconciled CallGrid report rows into the
 * canonical MarketplaceIntelligence snapshot. PURE and READ-ONLY: no I/O, no
 * clock, no RNG, no persistence, no mutation of inputs, no LLM. Every
 * interpretive field the Brain owns (recommendations, insights, health,
 * confidence) is left EMPTY/'unknown' and annotated with BRAIN_NOT_WIRED, so
 * the snapshot is honest about what it does and does not yet know.
 *
 * 'generatedAt' is supplied by the caller (not read from a clock) so the
 * function stays deterministic and reproducible, exactly as the precedent
 * assembler keeps identity/time caller-supplied.
 */
export function assembleMarketplaceIntelligence(
  input: CallGridReportInput,
  generatedAt: Date,
): MarketplaceIntelligence {
  return {
    organizationId: input.organizationId,
    locationId: input.locationId,
    generatedAt,
    timeWindow: toTimeWindow(input.window),

    // health/confidence are Brain judgements; honest defaults until wired.
    health: 'unknown',
    confidence: NO_DIAGNOSIS_CONFIDENCE,

    // The Brain is the sole author of these — empty until wired, never faked.
    recommendations: [],
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],

    campaigns: toCampaignIntelligence(input),
    buyers: toBuyerIntelligence(input),
    sources: toSourceIntelligence(input),
    vendors: toVendorIntelligence(input),

    profitability: toProfitability(input),
    funnel: toFunnel(input),

    // Insights alias BrainActivity; the Brain publishes them, so none yet.
    insights: [],

    metadata: {
      sensor: SENSOR,
      note: BRAIN_NOT_WIRED,
    },
  };
}
