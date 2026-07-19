// @emgloop/intelligence — CallGrid input boundary.
//
// This is the ONLY file in the module allowed to speak in terms of the concrete
// CallGrid shape (calls, buyers, vendors, sources, campaigns, bids, rejections,
// transcripts). Everything the analyzer and the module output emit is
// sensor-neutral. A future sensor (Ringba, Invoca, an internal auction) can
// populate the SAME analyzer by producing these window facts — CallGrid earns no
// special status downstream.
//
// CRITICAL — these are ALREADY-AGGREGATED, REAL facts. The loader that builds
// them reads persisted values only (per-call revenue/payout/cost/attribution
// live in `Interaction.metadata`; see the audit in the PR). This boundary
// carries no estimates: a metric that was never observed is simply absent, and
// coverage counts record HOW MANY calls actually carried each economic value so
// the analyzer can be honest about what it could and could not see.

import type { IntelligenceTimeWindow } from '../module';

/** One marketplace participant's aggregated economics for a single window. All
 * cents are summed from real per-call values; a participant with no observed
 * revenue has `revenueCents: 0` because it genuinely earned nothing in-window —
 * distinct from a metric that was never measured, which the coverage counts on
 * `CallGridWindow` track separately. */
export interface CallGridDimensionWindow {
  /** Machine key (the CallGrid id or normalized name). */
  key: string;
  /** Display label. */
  label: string;
  calls: number;
  /** Calls flagged monetized (billable|converted|paid) by the sensor. */
  /** Calls with a positive commercial outcome (billable OR converted OR paid).
   *  Loop-derived — CallGrid exposes no such metric. Renamed from `monetized`
   *  in Sprint 36 so it can never read as a CallGrid quality measure. */
  monetized: number;
  /** Calls flagged converted by the sensor. */
  converted: number;
  /** Downstream bookings attributed to this participant, when known. */
  bookings?: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
}

/** Everything the analyzer needs about one window of CallGrid activity. */
export interface CallGridWindow {
  calls: number;
  monetized: number;
  converted: number;
  // `bookings` was removed in Sprint 34: it is a CRM concept, it was hardcoded
  // to 0 in the only producer, and no analyzer ever read it. A permanently-zero
  // field in a CallGrid contract is a mixed metric, not a measurement.
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  /** Economics coverage: how many calls actually carried each value. When these
   * are well below `calls`, margin/derived reads are low-confidence, and the
   * analyzer says so rather than treating absence as 0. */
  callsWithRevenue: number;
  callsWithPayout: number;
  callsWithCost: number;
  buyers: CallGridDimensionWindow[];
  vendors: CallGridDimensionWindow[];
  sources: CallGridDimensionWindow[];
  campaigns: CallGridDimensionWindow[];
}

/** Per-source bid facts from CallGrid's bid report, when the caller supplied it. */
export interface CallGridSourceBidFacts {
  key: string;
  label: string;
  bidsSent?: number;
  bidsAccepted?: number;
  bidsWon?: number;
  /** Win rate in [0,1] as reported. */
  winRate?: number;
  /** Bid (ping-to-bid) rate in [0,1] as reported. */
  bidRate?: number;
  /** Reject rate in [0,1] as reported. */
  rejectRate?: number;
  /** Average winning bid, cents, as reported. */
  avgWinningBidCents?: number;
}

/**
 * Bid/auction facts from CallGrid's `/api/reports/bidStats` +
 * `/bidStats/rejections`. OPTIONAL: these are report-API facts, not per-call
 * ingested data, so they are frequently unavailable. When absent, the analyzer
 * emits "Not enough data" for every bid/auction/acceptance conclusion rather
 * than inventing one.
 */
export interface CallGridBidFacts {
  bidsSent?: number;
  bidsAccepted?: number;
  bidsWon?: number;
  winRate?: number;
  bidRate?: number;
  rejectRate?: number;
  avgWinningBidCents?: number;
  /** Rejection reason breakdown, neutral reason strings + counts. */
  rejections: { reason: string; count: number }[];
  bySource: CallGridSourceBidFacts[];
}

/**
 * A single transcript to extract intelligence FROM (never to summarize). CallGrid
 * does not reliably deliver transcripts today (see the ingestion audit), so this
 * array is usually empty and transcript intelligence honestly reports
 * "Not enough data". When a transcript IS present, only deterministic,
 * keyword/marker extraction runs over it — no model, no fabricated intent.
 */
export interface CallGridTranscriptSample {
  callId: string;
  text: string;
  /** The buyer the call was routed to, when known (for mismatch extraction). */
  buyerLabel?: string;
}

/** The complete, sensor-neutral-once-consumed input for one CallGrid run. */
export interface CallGridIntelligenceInput {
  organizationId: string;
  locationId?: string;
  window: IntelligenceTimeWindow;
  /** The current window's real, aggregated facts. */
  current: CallGridWindow;
  /** The prior comparison window, or null when none is available (then
   * "what changed" is honestly "Not enough data"). */
  prior: CallGridWindow | null;
  /** Bid/auction report facts, when supplied. */
  bids?: CallGridBidFacts;
  /** Transcripts to extract from, when any exist. */
  transcripts?: CallGridTranscriptSample[];
}

/** Margin (cents) for a window or dimension: revenue − payout − cost. Real, not
 * estimated — every term is a summed observed value. */
export function marginCentsOf(w: {
  revenueCents: number;
  payoutCents: number;
  costCents: number;
}): number {
  return w.revenueCents - w.payoutCents - w.costCents;
}
