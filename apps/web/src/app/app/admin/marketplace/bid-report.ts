import 'server-only';

// The canonical bid-snapshot reader — the ONE place Sources and the Bids workspace
// read provider bid/ping data. Bid reporting is snapshot-based: the provider's
// three report endpoints accept no arbitrary range, so ingestion stores the LATEST
// synchronized window and this reads exactly that. It therefore does NOT honor the
// calendar range (call-based metrics do; these do not) — the surfaces label it as
// such and never fabricate historical bid reporting.
//
// Reads STORED SNAPSHOTS ONLY; it never calls CallGrid at render time.

import { MarketplaceAuctionRepository, prisma } from '@emgloop/database';
import { easternYmd, type CallGridWindow } from '@emgloop/shared';

const PROVIDER = 'callgrid';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BidSnapshotMeta {
  windowStart: Date;
  windowEnd: Date;
  reportTimezone: string | null;
  /** Last time this snapshot was synchronized from the provider. */
  fetchedAt: Date;
}

export interface BidSourceRow {
  key: string;
  name: string;
  total: number | null;
  bids: number | null;
  won: number | null;
  rejected: number | null;
  /** Win rate = won / bids (per spec — NOT won / total). Null when bids is 0/absent. */
  winRatePct: number | null;
  /** Provider-native reject rate, stored verbatim (proven denominator). */
  rejectRatePct: number | null;
  rejections: {
    failedAcceptance: number | null;
    duplicateBids: number | null;
    closed: number | null;
    paused: number | null;
    failedTagRules: number | null;
    duplicateCaller: number | null;
    callerIdRejected: number | null;
  };
}

export interface PingDestinationRow {
  key: string;
  name: string;
  accepted: number | null;
  rateLimited: number | null;
  pingTimeout: number | null;
  minRevenue: number | null;
  failedTagRules: number | null;
  failedAcceptance: number | null;
  apiFailed: number | null;
  suppressed: number | null;
}

export interface BidReport {
  ok: boolean;
  hasData: boolean;
  meta: BidSnapshotMeta | null;
  sources: BidSourceRow[];
  destinations: PingDestinationRow[];
}

const EMPTY: BidReport = { ok: true, hasData: false, meta: null, sources: [], destinations: [] };

function winRate(won: number | null, bids: number | null): number | null {
  if (won === null || bids === null || bids <= 0) return null;
  return Math.round((won / bids) * 100);
}

/** Load the latest synchronized bid snapshot (metadata + source + destination
 *  rows). A failed read degrades to ok:false; no data ever renders as a fake zero. */
export async function loadBidReport(organizationId: string): Promise<BidReport> {
  try {
    const repo = new MarketplaceAuctionRepository(prisma);
    const runs = await repo.latestRuns(organizationId, PROVIDER, 12);
    if (runs.length === 0) return EMPTY;

    const head = runs[0]!;
    const windowStart = head.reportWindowStart;
    const windowEnd = head.reportWindowEnd;
    const windowRuns = runs.filter(
      (r) => r.reportWindowStart.getTime() === windowStart.getTime() && r.reportWindowEnd.getTime() === windowEnd.getTime(),
    );
    const fetchedAt = windowRuns.reduce((m, r) => (r.fetchedAt > m ? r.fetchedAt : m), windowRuns[0]!.fetchedAt);

    const [sourceSnaps, destSnaps] = await Promise.all([
      repo.listBidSourceSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
      repo.listPingDestinationSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
    ]);

    const sources: BidSourceRow[] = sourceSnaps.map((s) => ({
      key: s.sourceExternalId,
      name: s.sourceName || 'Unnamed Source',
      total: s.total,
      bids: s.bids,
      won: s.won,
      rejected: s.rejected,
      winRatePct: winRate(s.won, s.bids),
      rejectRatePct: s.rejectRatePercent,
      rejections: {
        failedAcceptance: s.failedAcceptance,
        duplicateBids: s.duplicateBids,
        closed: s.closed,
        paused: s.paused,
        failedTagRules: s.failedTagRules,
        duplicateCaller: s.duplicateCaller,
        callerIdRejected: s.callerIdRejected,
      },
    }));

    const destinations: PingDestinationRow[] = destSnaps.map((d) => ({
      key: d.destinationExternalId,
      name: d.destinationName || 'Unnamed Destination',
      accepted: d.accepted,
      rateLimited: d.rateLimited,
      pingTimeout: d.pingTimeout,
      minRevenue: d.minRevenue,
      failedTagRules: d.failedTagRules,
      failedAcceptance: d.failedAcceptance,
      apiFailed: d.apiFailed,
      suppressed: d.suppressed,
    }));

    const reportTimezone = (sourceSnaps[0]?.reportTimezone ?? destSnaps[0]?.reportTimezone) ?? null;

    return {
      ok: true,
      hasData: sources.length > 0 || destinations.length > 0,
      meta: { windowStart, windowEnd, reportTimezone, fetchedAt },
      sources,
      destinations,
    };
  } catch {
    return { ...EMPTY, ok: false };
  }
}

/**
 * Whether the latest bid snapshot genuinely coincides with the selected CallGrid
 * period. Deliberately conservative: bid snapshots are the provider's own
 * (UTC-requested) window and call reporting is Eastern, so the two grains rarely
 * line up. We only claim a match when BOTH are a single calendar day and that day
 * is the same — never fabricating agreement the data does not support.
 */
export function bidSnapshotMatches(meta: BidSnapshotMeta | null, window: CallGridWindow): boolean {
  if (!meta) return false;
  const snapSpansOneDay = meta.windowEnd.getTime() - meta.windowStart.getTime() <= DAY_MS + 1000;
  if (!snapSpansOneDay) return false;

  const selStart = easternYmd(window.start);
  const selLast = easternYmd(new Date(window.end.getTime() - 1));
  const selSingleDay = selStart.year === selLast.year && selStart.month === selLast.month && selStart.day === selLast.day;
  if (!selSingleDay) return false;

  const snap = meta.windowStart; // provider window start (UTC calendar date)
  return (
    snap.getUTCFullYear() === selStart.year &&
    snap.getUTCMonth() + 1 === selStart.month &&
    snap.getUTCDate() === selStart.day
  );
}

/** Sum a numeric field across rows, null when NO row reported it (never a coerced 0). */
export function sumBid<T>(rows: readonly T[], pick: (r: T) => number | null): number | null {
  let total = 0;
  let counted = 0;
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; counted += 1; }
  }
  return counted > 0 ? total : null;
}
