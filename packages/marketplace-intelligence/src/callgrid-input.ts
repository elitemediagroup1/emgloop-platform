// paste-test-line-1
// paste-test-line-2
// @emgloop/marketplace-intelligence — CallGrid input boundary (sensor edge).
//
// PR #44 (Marketplace Intelligence CallGrid Assembler). This is the ONLY file in
// the package that is allowed to speak CallGrid's vocabulary. It defines a small,
// read-only VIEW of the CallGrid report rows the platform has ALREADY fetched and
// reconciled elsewhere:
//
//   • /api/reports/bidStats            — per-source bid/win/reject totals
//   • /api/reports/bidStats/rejections — per-source rejection reason breakdown
//   • /api/reports/stats               — pivoted revenue/payout/cost/telco rows
//
// It is contracts-only and additive: no HTTP client, no DB, no CallGrid SDK, no
// clock, no RNG, no persistence, no UI, no LLM. Nothing here CALLS CallGrid — the
// caller passes in rows it already holds. Keeping every CallGrid-specific name
// (sourceId, winRate, totalWonAmount, failedTagRules, pivot keys, …) confined to
// THIS file is deliberate: the canonical Marketplace Intelligence model in the
// rest of the package stays sensor-agnostic, so swapping CallGrid for Ringba,
// Invoca, Twilio, or an internal bidding system only ever touches this boundary.
//
// The field names below mirror the CallGrid report responses verbatim so a
// reviewer can line them up 1:1 with the API. Every field the reports mark as
// optional stays optional here and is handled honestly downstream (absent →
// undefined metric, never a fabricated 0).

// ---------------------------------------------------------------------------
// /api/reports/bidStats — one row per traffic source.
// ---------------------------------------------------------------------------

/** A single row of the CallGrid bidStats report. Names match the API response
 * exactly. All numeric rates are CallGrid's own (percentages, 0–100). */
export interface CallGridBidStatsRow {
  /** CallGrid source id, e.g. 'clxnzl3ip000b2hxagccxr83i'. */
  sourceId: string;
  /** CallGrid source display name, e.g. 'Acme Traffic'. */
  sourceName?: string;
  /** Total bids received. */
  bids?: number;
  /** Bids won. */
  won?: number;
  /** Total ping attempts. */
  total?: number;
  /** Rated bids. */
  rated?: number;
  /** Rejected bids. */
  rejected?: number;
  /** Sum of all bid amounts. */
  totalBidAmount?: number;
  /** Sum of winning bid amounts. */
  totalWonAmount?: number;
  /** Average bid amount. */
  avgBid?: number;
  /** Average winning bid amount. */
  avgWinningBid?: number;
  /** CallGrid's won / bids * 100. */
  winRate?: number;
  /** CallGrid's bids / total * 100. */
  bidRate?: number;
  /** CallGrid's rejected / total * 100. */
  rejectRate?: number;
}

// ---------------------------------------------------------------------------
// /api/reports/bidStats/rejections — one row per source, reasons broken out.
// ---------------------------------------------------------------------------

/** A single row of the CallGrid bidStats/rejections report. Each numeric field
 * is a count of bids rejected for that specific CallGrid reason. */
export interface CallGridRejectionRow {
  /** CallGrid source id. */
  sourceId: string;
  /** Nested source object, when the report includes it. */
  source?: { id?: string; name?: string };
  /** Total rejected bids for this source. */
  rejected?: number;
  /** Rejected: caller id / blocklist. */
  callerId?: number;
  /** Rejected: destination closed. */
  closed?: number;
  /** Rejected: source/destination paused. */
  paused?: number;
  /** Rejected: duplicate caller. */
  duplicate?: number;
  /** Rejected: duplicate bids. */
  duplicateBids?: number;
  /** Rejected: failed acceptance parsing. */
  failedAcceptance?: number;
  /** Rejected: failed tag rules. */
  failedTagRules?: number;
}

// ---------------------------------------------------------------------------
// /api/reports/stats — pivoted revenue/payout/cost/telco rows.
//
// The stats report is a flexible pivot: the caller chooses the group-by
// dimension (CampaignName, BuyerName, SourceName, VendorName, …) and CallGrid
// returns rows whose metric columns (total_revenue, total_payout, telco, …)
// arrive as a name→value map. We model that faithfully: a row carries the
// dimension it was pivoted on plus an open metrics bag, so new metric columns
// never require a type change here.
// ---------------------------------------------------------------------------

/** Which CallGrid pivot dimension a stats row was grouped by. Open string so a
 * new pivot never forces a code change. */
export type CallGridStatsPivot =
  | 'CampaignName'
  | 'BuyerName'
  | 'SourceName'
  | 'VendorName'
  | (string & {});

/** The metric columns CallGrid returns per stats row, as a name→value map. Known
 * keys are documented for autocomplete; the index signature keeps it open. */
export interface CallGridStatsMetrics {
  total_revenue?: number;
  total_payout?: number;
  total_cost?: number;
  telco?: number;
  gross_profit?: number;
  net_profit?: number;
  margin?: number;
  calls?: number;
  completed?: number;
  billable?: number;
  converted?: number;
  [metric: string]: number | undefined;
}

/** A single pivoted row of the CallGrid stats report. */
export interface CallGridStatsRow {
  /** The dimension this row was grouped by, e.g. 'CampaignName'. */
  pivot: CallGridStatsPivot;
  /** The pivot key's value, e.g. the campaign name or buyer name. */
  key: string;
  /** Optional stable id for the pivot key, when CallGrid supplies one. */
  keyId?: string;
  /** The metric columns for this row. */
  metrics: CallGridStatsMetrics;
}

// ---------------------------------------------------------------------------
// The window: everything the caller already fetched, for one org + time range.
// ---------------------------------------------------------------------------

/** The time range the CallGrid rows describe. Kept as plain Dates so this file
 * needs no date library and no clock. */
export interface CallGridReportWindow {
  startAt: Date;
  endAt: Date;
  /** Optional human label echoed onto the canonical window, e.g. 'last_7_days'. */
  label?: string;
}

/**
 * The complete, read-only CallGrid input for one assembler run. The caller has
 * ALREADY fetched and reconciled these rows; the assembler never fetches them.
 * Tenant scope lives here (not on the rows) because CallGrid reports are already
 * scoped by the request that produced them.
 */
export interface CallGridReportInput {
  /** EMG organization id this data belongs to. */
  organizationId: string;
  /** Optional EMG location id. */
  locationId?: string;
  /** The window these rows cover. */
  window: CallGridReportWindow;
  /** Rows from /api/reports/bidStats. */
  bidStats?: ReadonlyArray<CallGridBidStatsRow>;
  /** Rows from /api/reports/bidStats/rejections. */
  rejections?: ReadonlyArray<CallGridRejectionRow>;
  /** Rows from /api/reports/stats (any pivot). */
  stats?: ReadonlyArray<CallGridStatsRow>;
}
