// Auction report projection — provider report rows → canonical snapshots.
//
// Pure functions only. No Prisma, no clock, no I/O. Timestamps are passed in.
// This is the one place provider decimals become integer cents and the one
// place the two source-grain reports are joined, so it is also the one place
// those decisions can be tested without a database.
//
// THE MONEY QUESTION, HANDLED HONESTLY
//
// CallGrid documents `avgBid: number` with no unit. Whether that is dollars or
// cents decides whether every marketplace figure in Loop is off by 100x, and
// this repo has already been burned once by inferring a money unit instead of
// anchoring it.
//
// `anchorMoneyUnit` answers it from the data, in one direction only:
//   • a money field with a fractional part PROVES dollars. Cents are integers
//     by construction, so 11.09 cannot be cents.
//   • all-integer money is CONSISTENT with dollars and equally consistent with
//     cents. It proves nothing.
//
// So the projection converts as dollars either way — matching MarketplaceCall's
// established boundary — and records which of those two it was. Money-derived
// findings are gated on the proven case downstream. An unproven unit is a
// visible caveat on the run record, not a silent premise in the numbers.

import type {
  BidStatsRow,
  BidRejectionsRow,
  PingStatsRow,
  FooterTotals,
} from '@emgloop/providers';

/** Which side of the marketplace a report describes. Never merged. */
export type AuctionGrain = 'source' | 'destination';

export type MoneyUnitEvidence = 'proven-dollars' | 'assumed-dollars' | 'no-money-observed';

/** Money fields on the bid report, in the order the anchor examines them. */
export const BID_MONEY_FIELDS = [
  'totalBidAmount',
  'totalWonAmount',
  'avgBid',
  'avgWinningBid',
] as const;

/**
 * Decide what the observed values prove about the money unit.
 *
 * Deliberately asymmetric: this can prove dollars and can never prove cents.
 * A function that returned 'cents' on all-integer input would be guessing, and
 * guessing is the failure mode it exists to prevent.
 */
export function anchorMoneyUnit(
  rows: ReadonlyArray<Partial<Record<(typeof BID_MONEY_FIELDS)[number], number | null>>>,
  footerTotals: FooterTotals | null,
): MoneyUnitEvidence {
  let sawMoney = false;
  const consider = (v: number | null | undefined): boolean => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    sawMoney = true;
    return !Number.isInteger(v);
  };

  for (const row of rows) {
    for (const f of BID_MONEY_FIELDS) if (consider(row[f])) return 'proven-dollars';
  }
  if (footerTotals) {
    for (const f of BID_MONEY_FIELDS) if (consider(footerTotals[f])) return 'proven-dollars';
  }
  return sawMoney ? 'assumed-dollars' : 'no-money-observed';
}

/**
 * Decimal dollars → integer cents, or null when the provider said nothing.
 *
 * Mirrors `centsOrNull` in marketplace-call-projection.ts deliberately. Two
 * different rounding rules for the same currency in the same product would be a
 * reconciliation bug waiting to happen.
 */
export function centsOrNull(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/**
 * A count, or null.
 *
 * Fractional counts are rejected to null rather than rounded. If CallGrid ever
 * returns `bids: 3.5`, that means the field is not the count we think it is,
 * and rounding it to 4 would bury the evidence.
 */
export function countOrNull(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Number.isInteger(v) ? v : null;
}

/**
 * A provider rate, kept in percentage POINTS exactly as sent.
 *
 * 14.473684 stays 14.473684. Never divided by 100, never recomputed from counts
 * — a provider rate is the provider's claim, and overwriting it with our own
 * arithmetic would destroy the disagreement that reconciliation exists to find.
 */
export function percentOrNull(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

// --- Bid source snapshots -----------------------------------------------------

export interface AuctionWindow {
  organizationId: string;
  provider: string;
  reportWindowStart: Date;
  reportWindowEnd: Date;
  /** The timezone the window was REQUESTED in. Not a claim about the provider's bucketing. */
  reportTimezone: string;
  fetchedAt: Date;
}

export interface BidSourceSnapshotInput extends AuctionWindow {
  sourceEndpoint: string;
  sourcePage: number | null;
  sourceTotalPages: number | null;
  providerPayloadHash: string;
}

export interface BidSourceSnapshot {
  organizationId: string;
  provider: string;
  reportWindowStart: Date;
  reportWindowEnd: Date;
  reportTimezone: string;
  sourceExternalId: string;
  sourceName: string | null;
  sourceEndpoint: string;
  sourcePage: number | null;
  sourceTotalPages: number | null;
  providerPayloadHash: string;
  fetchedAt: Date;
  total: number | null;
  bids: number | null;
  rated: number | null;
  won: number | null;
  rejected: number | null;
  totalBidAmountCents: number | null;
  totalWonAmountCents: number | null;
  avgBidCents: number | null;
  avgWinningBidCents: number | null;
  winRatePercent: number | null;
  bidRatePercent: number | null;
  rejectRatePercent: number | null;
  rejectedDetail: number | null;
  callerIdRejected: number | null;
  closed: number | null;
  paused: number | null;
  duplicateCaller: number | null;
  duplicateBids: number | null;
  failedAcceptance: number | null;
  failedTagRules: number | null;
}

/**
 * Join bidStats with bidStats/rejections into one snapshot per source.
 *
 * THE JOIN KEY IS `sourceExternalId`, WITHIN ONE WINDOW. Never the name.
 * Source names are provider-editable display strings; two sources can share one,
 * and one source can be renamed between two syncs. A name join would silently
 * merge two businesses' bid economics into one row, and the result would look
 * entirely plausible.
 *
 * A source present in only one of the two reports still produces a snapshot, with
 * the other report's fields left null. Null here means "the rejections report did
 * not describe this source", which is a different fact from "zero rejections" —
 * and the difference is exactly what a rejection-rate rule must not get wrong.
 */
export function projectBidSourceSnapshots(
  bidRows: readonly BidStatsRow[],
  rejectionRows: readonly BidRejectionsRow[],
  input: BidSourceSnapshotInput,
): BidSourceSnapshot[] {
  const rejectionsById = new Map<string, BidRejectionsRow>();
  for (const r of rejectionRows) rejectionsById.set(r.sourceExternalId, r);

  const seen = new Set<string>();
  const out: BidSourceSnapshot[] = [];

  const base = (sourceExternalId: string, sourceName: string | null) => ({
    organizationId: input.organizationId,
    provider: input.provider,
    reportWindowStart: input.reportWindowStart,
    reportWindowEnd: input.reportWindowEnd,
    reportTimezone: input.reportTimezone,
    sourceExternalId,
    sourceName,
    sourceEndpoint: input.sourceEndpoint,
    sourcePage: input.sourcePage,
    sourceTotalPages: input.sourceTotalPages,
    providerPayloadHash: input.providerPayloadHash,
    fetchedAt: input.fetchedAt,
  });

  const rejectionFields = (r: BidRejectionsRow | undefined) => ({
    rejectedDetail: countOrNull(r?.rejected),
    callerIdRejected: countOrNull(r?.callerIdRejected),
    closed: countOrNull(r?.closed),
    paused: countOrNull(r?.paused),
    duplicateCaller: countOrNull(r?.duplicateCaller),
    duplicateBids: countOrNull(r?.duplicateBids),
    failedAcceptance: countOrNull(r?.failedAcceptance),
    failedTagRules: countOrNull(r?.failedTagRules),
  });

  for (const row of bidRows) {
    if (seen.has(row.sourceExternalId)) continue; // a duplicate id is one source
    seen.add(row.sourceExternalId);
    const r = rejectionsById.get(row.sourceExternalId);
    out.push({
      ...base(row.sourceExternalId, row.sourceName ?? r?.sourceName ?? null),
      total: countOrNull(row.total),
      bids: countOrNull(row.bids),
      rated: countOrNull(row.rated),
      won: countOrNull(row.won),
      rejected: countOrNull(row.rejected),
      totalBidAmountCents: centsOrNull(row.totalBidAmount),
      totalWonAmountCents: centsOrNull(row.totalWonAmount),
      avgBidCents: centsOrNull(row.avgBid),
      avgWinningBidCents: centsOrNull(row.avgWinningBid),
      winRatePercent: percentOrNull(row.winRate),
      bidRatePercent: percentOrNull(row.bidRate),
      rejectRatePercent: percentOrNull(row.rejectRate),
      ...rejectionFields(r),
    });
  }

  // Sources the rejections report knows about but bidStats did not return.
  // Dropping them would silently discard rejection volume; keeping them with
  // null bid metrics states exactly what is and is not known.
  for (const r of rejectionRows) {
    if (seen.has(r.sourceExternalId)) continue;
    seen.add(r.sourceExternalId);
    out.push({
      ...base(r.sourceExternalId, r.sourceName),
      total: null,
      bids: null,
      rated: null,
      won: null,
      rejected: null,
      totalBidAmountCents: null,
      totalWonAmountCents: null,
      avgBidCents: null,
      avgWinningBidCents: null,
      winRatePercent: null,
      bidRatePercent: null,
      rejectRatePercent: null,
      ...rejectionFields(r),
    });
  }

  return out;
}

// --- Ping destination snapshots -----------------------------------------------

export interface PingDestinationSnapshotInput extends AuctionWindow {
  sourceEndpoint: string;
  sourcePage: number | null;
  sourceTotalPages: number | null;
  providerPayloadHash: string;
}

export interface PingDestinationSnapshot {
  organizationId: string;
  provider: string;
  reportWindowStart: Date;
  reportWindowEnd: Date;
  reportTimezone: string;
  destinationExternalId: string;
  destinationName: string | null;
  providerRowDate: Date | null;
  sourceEndpoint: string;
  sourcePage: number | null;
  sourceTotalPages: number | null;
  providerPayloadHash: string;
  fetchedAt: Date;
  accepted: number | null;
  agents: number | null;
  failedAcceptance: number | null;
  failedTagRules: number | null;
  minRevenue: number | null;
  missingAmount: number | null;
  invalidNumber: number | null;
  durationElapsed: number | null;
  pingTimeout: number | null;
  apiFailed: number | null;
  rateLimited: number | null;
  suppressed: number | null;
}

/**
 * Rows whose `destinationId` repeats within one window.
 *
 * pingStats buckets per day, so a multi-day window returns one row per
 * destination per day and the snapshot identity would collide. Ingestion is
 * single-day, and this is how it PROVES that rather than trusting it: a
 * non-empty result means the window was wider than the grain and the sync must
 * refuse rather than silently keep whichever row upserted last.
 */
export function collidingDestinations(rows: readonly PingStatsRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.destinationExternalId, (counts.get(r.destinationExternalId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}

export function projectPingDestinationSnapshots(
  rows: readonly PingStatsRow[],
  input: PingDestinationSnapshotInput,
): PingDestinationSnapshot[] {
  return rows.map((row) => {
    const parsed = row.rowDate ? new Date(row.rowDate) : null;
    return {
      organizationId: input.organizationId,
      provider: input.provider,
      reportWindowStart: input.reportWindowStart,
      reportWindowEnd: input.reportWindowEnd,
      reportTimezone: input.reportTimezone,
      destinationExternalId: row.destinationExternalId,
      destinationName: row.destinationName,
      providerRowDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
      sourceEndpoint: input.sourceEndpoint,
      sourcePage: input.sourcePage,
      sourceTotalPages: input.sourceTotalPages,
      providerPayloadHash: input.providerPayloadHash,
      fetchedAt: input.fetchedAt,
      accepted: countOrNull(row.accepted),
      agents: countOrNull(row.agents),
      failedAcceptance: countOrNull(row.failedAcceptance),
      failedTagRules: countOrNull(row.failedTagRules),
      minRevenue: countOrNull(row.minRevenue),
      missingAmount: countOrNull(row.missingAmount),
      invalidNumber: countOrNull(row.invalidNumber),
      durationElapsed: countOrNull(row.durationElapsed),
      pingTimeout: countOrNull(row.pingTimeout),
      apiFailed: countOrNull(row.apiFailed),
      rateLimited: countOrNull(row.rateLimited),
      suppressed: countOrNull(row.suppressed),
    };
  });
}

// --- Recomputed totals --------------------------------------------------------

/**
 * Sum a field across rows, null-aware.
 *
 * Returns null when NO row reported the field. Summing nulls as zero is the
 * fabrication the Truth model exists to prevent: it turns "we never measured
 * this" into a confident 0 that reconciles against the provider's real total
 * and reports a false mismatch — or worse, a false match.
 */
export function sumOrNull(
  rows: ReadonlyArray<Record<string, unknown>>,
  field: string,
): { value: number | null; counted: number; missing: number } {
  let total = 0;
  let counted = 0;
  let missing = 0;
  for (const row of rows) {
    const v = row[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      counted += 1;
    } else {
      missing += 1;
    }
  }
  return { value: counted > 0 ? total : null, counted, missing };
}

/** Recompute totals Loop can verify, keyed by field. Provider footers stay separate. */
export function recomputeTotals(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, { value: number | null; counted: number; missing: number }> {
  const out: Record<string, { value: number | null; counted: number; missing: number }> = {};
  for (const f of fields) out[f] = sumOrNull(rows, f);
  return out;
}
