// Auction report snapshots — persistence.
//
// Every method takes `organizationId` as its first argument and resolves rows
// WITHIN that organization. There is no method on this class that can read or
// write a row without naming an organization, because a signature like
// `update(id, fields)` on a tenant-owned model is a vulnerability waiting for a
// caller. Sprint 29A learned that the expensive way.

import type { PrismaClient, Prisma, MarketplaceReportRunStatus } from '@prisma/client';
import type {
  BidSourceSnapshot,
  PingDestinationSnapshot,
} from './marketplace-auction-projection';

export interface UpsertCounts {
  inserted: number;
  updated: number;
  failed: number;
}

export interface ReportRunRecord {
  organizationId: string;
  provider: string;
  endpoint: string;
  sourceEndpoint: string;
  reportWindowStart: Date;
  reportWindowEnd: Date;
  reportTimezone: string;
  status: MarketplaceReportRunStatus;
  errorClassification: string | null;
  errorDetail: string | null;
  fetchedAt: Date;
  pagesFetched: number | null;
  sourceTotalPages: number | null;
  rowCount: number | null;
  truncated: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  providerFooterTotals: Prisma.InputJsonValue | null;
  recomputedTotals: Prisma.InputJsonValue | null;
  moneyUnitEvidence: string | null;
  observedRowKeys: Prisma.InputJsonValue | null;
  providerPayloadHash: string | null;
}

export class MarketplaceAuctionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert bid source snapshots on the compound identity.
   *
   * Re-fetching the same window UPDATES; it never duplicates. The identity is
   * (organization, provider, window start, window end, sourceExternalId) — the
   * provider's own id, so a source rename between syncs updates one row rather
   * than creating a second one under the new name.
   *
   * A single row failing does not abort the batch. A report is more useful
   * partially stored with an honest `failed` count than discarded whole,
   * provided the count reaches the run record — which it does.
   */
  async upsertBidSourceSnapshots(
    organizationId: string,
    snapshots: readonly BidSourceSnapshot[],
  ): Promise<UpsertCounts> {
    const counts: UpsertCounts = { inserted: 0, updated: 0, failed: 0 };
    for (const s of snapshots) {
      // Refuse a snapshot that claims a different tenant than the caller's.
      // The projection builds these from the caller's own scope, so this can
      // only fire on a programming error — which is exactly when it matters.
      if (s.organizationId !== organizationId) {
        counts.failed += 1;
        continue;
      }
      const identity = {
        organizationId,
        provider: s.provider,
        reportWindowStart: s.reportWindowStart,
        reportWindowEnd: s.reportWindowEnd,
        sourceExternalId: s.sourceExternalId,
      };
      try {
        const existing = await this.prisma.marketplaceBidSourceSnapshot.findUnique({
          where: { bid_source_snapshot_identity: identity },
          select: { id: true },
        });
        const data: Prisma.MarketplaceBidSourceSnapshotUncheckedCreateInput = { ...s };
        await this.prisma.marketplaceBidSourceSnapshot.upsert({
          where: { bid_source_snapshot_identity: identity },
          create: data,
          update: data,
        });
        if (existing) counts.updated += 1;
        else counts.inserted += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  }

  async upsertPingDestinationSnapshots(
    organizationId: string,
    snapshots: readonly PingDestinationSnapshot[],
  ): Promise<UpsertCounts> {
    const counts: UpsertCounts = { inserted: 0, updated: 0, failed: 0 };
    for (const s of snapshots) {
      if (s.organizationId !== organizationId) {
        counts.failed += 1;
        continue;
      }
      const identity = {
        organizationId,
        provider: s.provider,
        reportWindowStart: s.reportWindowStart,
        reportWindowEnd: s.reportWindowEnd,
        destinationExternalId: s.destinationExternalId,
      };
      try {
        const existing = await this.prisma.marketplacePingDestinationSnapshot.findUnique({
          where: { ping_destination_snapshot_identity: identity },
          select: { id: true },
        });
        const data: Prisma.MarketplacePingDestinationSnapshotUncheckedCreateInput = { ...s };
        await this.prisma.marketplacePingDestinationSnapshot.upsert({
          where: { ping_destination_snapshot_identity: identity },
          create: data,
          update: data,
        });
        if (existing) counts.updated += 1;
        else counts.inserted += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  }

  /** Record one ingestion attempt. Re-running a window overwrites its run record. */
  async recordRun(organizationId: string, run: ReportRunRecord): Promise<void> {
    if (run.organizationId !== organizationId) return; // no write, no record
    const data = {
      ...run,
      providerFooterTotals: run.providerFooterTotals ?? undefined,
      recomputedTotals: run.recomputedTotals ?? undefined,
      observedRowKeys: run.observedRowKeys ?? undefined,
    };
    await this.prisma.marketplaceReportRun.upsert({
      where: {
        report_run_identity: {
          organizationId,
          provider: run.provider,
          endpoint: run.endpoint,
          reportWindowStart: run.reportWindowStart,
          reportWindowEnd: run.reportWindowEnd,
        },
      },
      create: data,
      update: data,
    });
  }

  async listBidSourceSnapshots(
    organizationId: string,
    provider: string,
    windowStart: Date,
    windowEnd: Date,
  ) {
    return this.prisma.marketplaceBidSourceSnapshot.findMany({
      where: { organizationId, provider, reportWindowStart: windowStart, reportWindowEnd: windowEnd },
      orderBy: { sourceExternalId: 'asc' },
    });
  }

  async listPingDestinationSnapshots(
    organizationId: string,
    provider: string,
    windowStart: Date,
    windowEnd: Date,
  ) {
    return this.prisma.marketplacePingDestinationSnapshot.findMany({
      where: { organizationId, provider, reportWindowStart: windowStart, reportWindowEnd: windowEnd },
      orderBy: { destinationExternalId: 'asc' },
    });
  }

  async listRuns(organizationId: string, provider: string, windowStart: Date, windowEnd: Date) {
    return this.prisma.marketplaceReportRun.findMany({
      where: { organizationId, provider, reportWindowStart: windowStart, reportWindowEnd: windowEnd },
      orderBy: { endpoint: 'asc' },
    });
  }

  /** Most recent run per endpoint, for the operator surface's sync status. */
  async latestRuns(organizationId: string, provider: string, limit = 12) {
    return this.prisma.marketplaceReportRun.findMany({
      where: { organizationId, provider },
      orderBy: { fetchedAt: 'desc' },
      take: Math.max(1, Math.min(limit, 50)),
    });
  }
}
