// Auction report ingestion — bounded, single-window, idempotent.
//
// Fetches the three CallGrid report endpoints that returned live production
// data, projects them into aggregate snapshots, and records exactly what
// happened on a run record per endpoint.
//
// WHAT THIS REFUSES TO DO, AND WHY
//
//   • It will not treat an unreadable response as an empty report. A provider
//     outage and a quiet day are different facts; collapsing them would render
//     a 500 as "no marketplace activity", which is worse than showing nothing.
//   • It will not ingest a window wider than one UTC day. pingStats buckets rows
//     per day, so a two-day window returns two rows per destination and the
//     snapshot identity collides. The sync proves the grain rather than trusting
//     it — see `collidingDestinations`.
//   • It will not log, return, or store the credential, and it never reads
//     `last5Bids` (dropped at the provider boundary).
//   • It does not schedule itself. Recurring ingestion is deliberately not built
//     until a manual run has been reconciled against the provider.
//
// The `partial` outcome is a first-class result, not an error. Two endpoints
// succeeding and one failing is the normal case during provider incidents, and
// the run records make which is which unambiguous.

import type { PrismaClient } from '@prisma/client';
import {
  fetchWholeReport,
  parseBidStatsRow,
  parseBidRejectionsRow,
  parsePingStatsRow,
  CallGridReportError,
  VERIFIED_REPORT_PATHS,
  scrub,
  type VerifiedReportEndpoint,
  type BidStatsRow,
  type BidRejectionsRow,
  type PingStatsRow,
  type PaginatedReport,
  type FooterTotals,
} from '@emgloop/providers';
import { MarketplaceAuctionRepository, type ReportRunRecord } from '../repositories/marketplace-auction.repository';
import {
  projectBidSourceSnapshots,
  projectPingDestinationSnapshots,
  collidingDestinations,
  recomputeTotals,
  anchorMoneyUnit,
  type MoneyUnitEvidence,
} from '../repositories/marketplace-auction-projection';

/** Fields Loop recomputes and compares against the provider's footer. */
export const BID_TOTAL_FIELDS = [
  'total', 'bids', 'rated', 'won', 'rejected',
  'totalBidAmountCents', 'totalWonAmountCents',
] as const;

export const REJECTION_TOTAL_FIELDS = [
  'rejectedDetail', 'callerIdRejected', 'closed', 'paused',
  'duplicateCaller', 'duplicateBids', 'failedAcceptance', 'failedTagRules',
] as const;

export const PING_TOTAL_FIELDS = [
  'accepted', 'agents', 'failedAcceptance', 'failedTagRules', 'minRevenue',
  'missingAmount', 'invalidNumber', 'durationElapsed', 'pingTimeout',
  'apiFailed', 'rateLimited', 'suppressed',
] as const;

export interface AuctionIngestInput {
  organizationId: string;
  provider: string;
  /** Exactly one UTC day, `YYYY-MM-DD`. Required — a defaulted window is unreproducible. */
  date: string;
  apiKey: string;
  baseUrl: string;
  /** Passed in. This service does not read a clock. */
  now: Date;
  maxPages?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface EndpointOutcome {
  endpoint: VerifiedReportEndpoint;
  sourceEndpoint: string;
  status: ReportRunRecord['status'];
  rowCount: number | null;
  pagesFetched: number | null;
  totalPages: number | null;
  truncated: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errorClassification: string | null;
  errorDetail: string | null;
  observedRowKeys: string[] | null;
}

export interface AuctionIngestResult {
  organizationId: string;
  provider: string;
  window: { start: string; end: string; timezone: string; note: string };
  outcomes: EndpointOutcome[];
  /** Proven only when a money field carried a fractional part. */
  moneyUnitEvidence: MoneyUnitEvidence | null;
  bidSourcesStored: number;
  pingDestinationsStored: number;
  overall: 'complete' | 'partial' | 'failed';
}

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AuctionReportIngestionService {
  private readonly repo: MarketplaceAuctionRepository;

  constructor(prisma: PrismaClient, repo?: MarketplaceAuctionRepository) {
    this.repo = repo ?? new MarketplaceAuctionRepository(prisma);
  }

  async ingestDay(input: AuctionIngestInput): Promise<AuctionIngestResult> {
    if (!UTC_DAY.test(input.date)) {
      throw new Error('date must be an exact UTC day in YYYY-MM-DD form');
    }
    const startIso = `${input.date}T00:00:00.000Z`;
    const endIso = `${input.date}T23:59:59.999Z`;
    const reportWindowStart = new Date(startIso);
    const reportWindowEnd = new Date(endIso);
    if (Number.isNaN(reportWindowStart.getTime())) throw new Error('date is not a real calendar day');

    const windowBase = {
      organizationId: input.organizationId,
      provider: input.provider,
      reportWindowStart,
      reportWindowEnd,
      // What Loop REQUESTED. The three GET report endpoints accept no
      // reportTimeZone parameter, so the timezone CallGrid buckets in is not
      // ours to state. Recording the request is honest; recording a claim about
      // the provider's bucketing would not be.
      reportTimezone: 'UTC',
      fetchedAt: input.now,
    };

    const fetchOpts = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      startDate: startIso,
      endDate: endIso,
      limit: input.limit ?? 100,
      maxPages: input.maxPages ?? 20,
      fetchImpl: input.fetchImpl,
    };

    const outcomes: EndpointOutcome[] = [];

    // --- Source grain: bidStats + rejections, fetched together because they are
    // joined into one snapshot and a snapshot built from two different windows
    // would be a silent lie about the window.
    const bidRes = await this.attempt('bidStats', fetchOpts, parseBidStatsRow);
    const rejRes = await this.attempt('bidRejections', fetchOpts, parseBidRejectionsRow);

    const moneyUnitEvidence = bidRes.ok
      ? anchorMoneyUnit(
          bidRes.report.rows.map((r) => ({
            totalBidAmount: r.totalBidAmount,
            totalWonAmount: r.totalWonAmount,
            avgBid: r.avgBid,
            avgWinningBid: r.avgWinningBid,
          })),
          bidRes.report.footerTotals,
        )
      : null;

    let bidSourcesStored = 0;
    if (bidRes.ok || rejRes.ok) {
      const bidRows: BidStatsRow[] = bidRes.ok ? bidRes.report.rows : [];
      const rejRows: BidRejectionsRow[] = rejRes.ok ? rejRes.report.rows : [];
      const hashParts = [
        bidRes.ok ? bidRes.report.payloadHash : 'unread',
        rejRes.ok ? rejRes.report.payloadHash : 'unread',
      ].join(':');

      const snapshots = projectBidSourceSnapshots(bidRows, rejRows, {
        ...windowBase,
        sourceEndpoint: VERIFIED_REPORT_PATHS.bidStats,
        sourcePage: null, // whole-report ingest; per-page provenance is the run record's job
        sourceTotalPages: bidRes.ok ? bidRes.report.totalPages : null,
        providerPayloadHash: hashParts,
      });

      const counts = await this.repo.upsertBidSourceSnapshots(input.organizationId, snapshots);
      bidSourcesStored = counts.inserted + counts.updated;

      const recomputed = recomputeTotals(
        snapshots as unknown as Array<Record<string, unknown>>,
        [...BID_TOTAL_FIELDS, ...REJECTION_TOTAL_FIELDS],
      );

      // Both source-grain endpoints share the stored snapshots, so both run
      // records carry the same write counts. Splitting the counts between them
      // would imply two independent writes that did not happen.
      outcomes.push(
        await this.record(input, windowBase, 'bidStats', bidRes, counts, recomputed, moneyUnitEvidence),
        await this.record(input, windowBase, 'bidRejections', rejRes, counts, recomputed, moneyUnitEvidence),
      );
    } else {
      outcomes.push(
        await this.record(input, windowBase, 'bidStats', bidRes, null, null, null),
        await this.record(input, windowBase, 'bidRejections', rejRes, null, null, null),
      );
    }

    // --- Destination grain: pingStats. Never joined to the above.
    const pingRes = await this.attempt('pingStats', fetchOpts, parsePingStatsRow);
    let pingDestinationsStored = 0;

    if (pingRes.ok) {
      const collisions = collidingDestinations(pingRes.report.rows);
      if (collisions.length > 0) {
        // The window was wider than the report's grain. Storing would keep
        // whichever row upserted last and silently discard the rest.
        outcomes.push(
          await this.record(
            input,
            windowBase,
            'pingStats',
            {
              ok: false as const,
              classification: 'grain-collision',
              detail: `${collisions.length} destination(s) returned more than one row for this window — pingStats buckets per day and the window exceeded that grain. Nothing was stored.`,
              status: 'UNKNOWN_ENVELOPE' as const,
            },
            null,
            null,
            null,
          ),
        );
      } else {
        const snapshots = projectPingDestinationSnapshots(pingRes.report.rows, {
          ...windowBase,
          sourceEndpoint: VERIFIED_REPORT_PATHS.pingStats,
          sourcePage: null,
          sourceTotalPages: pingRes.report.totalPages,
          providerPayloadHash: pingRes.report.payloadHash,
        });
        const counts = await this.repo.upsertPingDestinationSnapshots(input.organizationId, snapshots);
        pingDestinationsStored = counts.inserted + counts.updated;
        const recomputed = recomputeTotals(
          snapshots as unknown as Array<Record<string, unknown>>,
          [...PING_TOTAL_FIELDS],
        );
        outcomes.push(
          await this.record(input, windowBase, 'pingStats', pingRes, counts, recomputed, null),
        );
      }
    } else {
      outcomes.push(await this.record(input, windowBase, 'pingStats', pingRes, null, null, null));
    }

    const succeeded = outcomes.filter((o) => o.status === 'SUCCESS' || o.status === 'EMPTY').length;
    const overall =
      succeeded === outcomes.length ? 'complete' : succeeded === 0 ? 'failed' : 'partial';

    return {
      organizationId: input.organizationId,
      provider: input.provider,
      window: {
        start: startIso,
        end: endIso,
        timezone: 'UTC',
        note: 'Window as REQUESTED, in UTC. The three GET report endpoints accept no reportTimeZone parameter, so the timezone CallGrid buckets in is UNVERIFIED.',
      },
      outcomes,
      moneyUnitEvidence,
      bidSourcesStored,
      pingDestinationsStored,
      overall,
    };
  }

  /** Fetch and parse one endpoint. Never throws for a provider-side failure. */
  private async attempt<TRow>(
    endpoint: VerifiedReportEndpoint,
    opts: {
      baseUrl: string; apiKey: string; startDate: string; endDate: string;
      limit: number; maxPages: number; fetchImpl?: typeof fetch;
    },
    parse: (row: Record<string, unknown>) => TRow | null,
  ): Promise<AttemptResult<TRow>> {
    try {
      const raw = await fetchWholeReport(endpoint, opts);
      const rows: TRow[] = [];
      let unparseable = 0;
      for (const r of raw.rows) {
        const parsed = parse(r);
        if (parsed === null) unparseable += 1;
        else rows.push(parsed);
      }
      if (unparseable > 0 && rows.length === 0) {
        // Every row lacked its grouping id. That is not an empty report.
        return {
          ok: false,
          classification: 'unknown-envelope',
          detail: `all ${unparseable} row(s) lacked a usable grouping identifier — REJECTED, not treated as empty`,
          status: 'UNKNOWN_ENVELOPE',
        };
      }
      return {
        ok: true,
        report: { ...raw, rows },
        skipped: unparseable,
      };
    } catch (error) {
      if (error instanceof CallGridReportError) {
        return {
          ok: false,
          classification: error.classification,
          detail: scrub(error.message, opts.apiKey),
          status:
            error.classification === 'endpoint-failure' ? 'ENDPOINT_FAILURE'
              : error.classification === 'malformed-response' ? 'MALFORMED_RESPONSE'
              : error.classification === 'partial-pagination' ? 'PARTIAL_PAGINATION'
              : 'UNKNOWN_ENVELOPE',
        };
      }
      const msg = error instanceof Error ? scrub(error.message, opts.apiKey) : 'unknown failure';
      return { ok: false, classification: 'endpoint-failure', detail: msg, status: 'ENDPOINT_FAILURE' };
    }
  }

  private async record<TRow>(
    input: AuctionIngestInput,
    windowBase: {
      organizationId: string; provider: string;
      reportWindowStart: Date; reportWindowEnd: Date;
      reportTimezone: string; fetchedAt: Date;
    },
    endpoint: VerifiedReportEndpoint,
    res: AttemptResult<TRow>,
    counts: { inserted: number; updated: number; failed: number } | null,
    recomputed: Record<string, unknown> | null,
    moneyUnitEvidence: MoneyUnitEvidence | null,
  ): Promise<EndpointOutcome> {
    const sourceEndpoint = VERIFIED_REPORT_PATHS[endpoint];

    const status: ReportRunRecord['status'] = res.ok
      ? res.report.truncated
        ? 'PARTIAL_PAGINATION'
        : res.report.rows.length === 0
          ? 'EMPTY'
          : 'SUCCESS'
      : res.status;

    const run: ReportRunRecord = {
      ...windowBase,
      endpoint,
      sourceEndpoint,
      status,
      errorClassification: res.ok ? null : res.classification,
      errorDetail: res.ok ? null : res.detail,
      pagesFetched: res.ok ? res.report.pagesFetched : null,
      sourceTotalPages: res.ok ? res.report.totalPages : null,
      rowCount: res.ok ? res.report.rows.length : null,
      truncated: res.ok ? res.report.truncated : false,
      inserted: counts?.inserted ?? 0,
      updated: counts?.updated ?? 0,
      skipped: res.ok ? res.skipped : 0,
      failed: counts?.failed ?? 0,
      providerFooterTotals: res.ok && res.report.footerTotals ? (res.report.footerTotals as object) : null,
      recomputedTotals: recomputed ? (recomputed as object) : null,
      moneyUnitEvidence,
      observedRowKeys: res.ok ? res.report.observedRowKeys : null,
      providerPayloadHash: res.ok ? res.report.payloadHash : null,
    };

    await this.repo.recordRun(input.organizationId, run);

    return {
      endpoint,
      sourceEndpoint,
      status,
      rowCount: run.rowCount,
      pagesFetched: run.pagesFetched,
      totalPages: run.sourceTotalPages,
      truncated: run.truncated,
      inserted: run.inserted,
      updated: run.updated,
      skipped: run.skipped,
      failed: run.failed,
      errorClassification: run.errorClassification,
      errorDetail: run.errorDetail,
      observedRowKeys: res.ok ? res.report.observedRowKeys : null,
    };
  }
}

type AttemptResult<TRow> =
  | { ok: true; report: Omit<PaginatedReport<Record<string, unknown>>, 'rows'> & { rows: TRow[]; footerTotals: FooterTotals | null }; skipped: number }
  | {
      ok: false;
      classification: string;
      detail: string;
      status: Exclude<ReportRunRecord['status'], 'SUCCESS' | 'EMPTY'>;
    };

export type { PingStatsRow };
