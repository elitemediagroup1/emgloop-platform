// MarketplaceCallRepository — persistence + read model for the sensor-neutral
// call projection.
//
// Write path (idempotent): projectInteractionToMarketplaceCall → upsert on
// (provider, externalId). Re-running the projection over the same or an updated
// Interaction updates the one row; it never duplicates.
//
// Read path: aggregateWindow returns per-window, per-dimension economics the
// Intelligence module consumes — reading first-class, indexed columns instead of
// parsing Interaction.metadata JSON at request time. Null economics are summed
// null-aware and coverage counts record how many rows actually carried a value,
// so the module stays honest about what it could see.
//
// Backfill: projectWindow reads existing Interactions and upserts their
// projections, so the table can be populated for history without waiting for new
// ingestion — and the Intelligence loader can fall back to it.

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  projectInteractionToMarketplaceCall,
  type MarketplaceCallProjection,
} from './marketplace-call-projection';

/** One participant's aggregated economics for a window (matches the Intelligence
 * CallGridDimensionWindow shape structurally). */
export interface CallDimensionAggregate {
  key: string;
  label: string;
  calls: number;
  qualified: number;
  converted: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
}

/** A window of aggregated call economics (matches CallGridWindow structurally,
 * so the Intelligence layer can consume it directly). */
export interface CallWindowAggregate {
  calls: number;
  qualified: number;
  converted: number;
  bookings: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  callsWithRevenue: number;
  callsWithPayout: number;
  callsWithCost: number;
  buyers: CallDimensionAggregate[];
  vendors: CallDimensionAggregate[];
  sources: CallDimensionAggregate[];
  campaigns: CallDimensionAggregate[];
}

export interface BackfillResult {
  scanned: number;
  projected: number;
  skipped: number;
}

// The subset of columns aggregateWindow needs.
type CallRow = {
  buyerExternalId: string | null;
  buyerLabel: string | null;
  vendorExternalId: string | null;
  vendorLabel: string | null;
  sourceExternalId: string | null;
  sourceLabel: string | null;
  campaignExternalId: string | null;
  campaignLabel: string | null;
  revenueCents: number | null;
  payoutCents: number | null;
  costCents: number | null;
  qualified: boolean | null;
  converted: boolean | null;
};

export class MarketplaceCallRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Upsert one projection idempotently on (provider, externalId). */
  async upsertProjection(p: MarketplaceCallProjection): Promise<void> {
    const data: Prisma.MarketplaceCallUncheckedCreateInput = { ...p };
    await this.prisma.marketplaceCall.upsert({
      where: { provider_externalId: { provider: p.provider, externalId: p.externalId } },
      create: data,
      update: data,
    });
  }

  /** Project one raw Interaction (write-through from the ingestion path). Returns
   * true when a projection was written, false when the row was not projectable. */
  async projectInteraction(interaction: Parameters<typeof projectInteractionToMarketplaceCall>[0]): Promise<boolean> {
    const projection = projectInteractionToMarketplaceCall(interaction);
    if (!projection) return false;
    await this.upsertProjection(projection);
    return true;
  }

  /**
   * Backfill/refresh the projection for a window from existing Interactions.
   * Idempotent: re-running upserts the same rows. Org-scoped, demo-filtered by
   * the pure mapper.
   */
  async projectWindow(organizationId: string, since: Date, until: Date): Promise<BackfillResult> {
    const rows = await this.prisma.interaction.findMany({
      where: { organizationId, channel: 'PHONE', occurredAt: { gte: since, lt: until } },
      select: {
        id: true, organizationId: true, provider: true, externalId: true,
        channel: true, occurredAt: true, metadata: true,
        customer: { select: { tags: true, email: true, phone: true, externalId: true, firstName: true, lastName: true } },
      },
    });
    let projected = 0;
    let skipped = 0;
    for (const row of rows) {
      const p = projectInteractionToMarketplaceCall(row);
      if (!p) { skipped += 1; continue; }
      await this.upsertProjection(p);
      projected += 1;
    }
    return { scanned: rows.length, projected, skipped };
  }

  /** How many projected calls exist in a window (lets a caller decide whether to
   * read the projection or fall back). */
  async countWindow(organizationId: string, since: Date, until: Date): Promise<number> {
    return this.prisma.marketplaceCall.count({
      where: { organizationId, sourceOccurredAt: { gte: since, lt: until } },
    });
  }

  /** Aggregate a window into per-dimension economics for the Intelligence layer. */
  async aggregateWindow(organizationId: string, since: Date, until: Date): Promise<CallWindowAggregate> {
    const rows = (await this.prisma.marketplaceCall.findMany({
      where: { organizationId, sourceOccurredAt: { gte: since, lt: until } },
      select: {
        buyerExternalId: true, buyerLabel: true, vendorExternalId: true, vendorLabel: true,
        sourceExternalId: true, sourceLabel: true, campaignExternalId: true, campaignLabel: true,
        revenueCents: true, payoutCents: true, costCents: true, qualified: true, converted: true,
      },
    })) as CallRow[];
    return aggregateRows(rows);
  }

  /**
   * Count how many calls in a window actually carry each capability's data.
   *
   * Feeds the Marketplace Coverage surface, which answers "what does the Brain
   * know, and what does it not". Every field on MarketplaceCall is nullable and
   * never 0-defaulted, so a null genuinely means the sensor did not say — which
   * is what makes this countable rather than guessed.
   *
   * Implemented as COUNTs, not row reads: nothing is hydrated into JS, so this
   * stays cheap however large the tenant grows. Counting is also the only
   * honest primitive here — a sampled read could not distinguish "absent" from
   * "not looked at".
   */
  async coverageObservations(
    organizationId: string,
    since: Date,
    until: Date,
  ): Promise<{ callsIngested: number; populated: Record<string, number> }> {
    const window = { organizationId, sourceOccurredAt: { gte: since, lt: until } };
    const countWhere = (extra: Prisma.MarketplaceCallWhereInput): Promise<number> =>
      this.prisma.marketplaceCall.count({ where: { ...window, ...extra } });

    // An attribution dimension counts as present if EITHER the external id or
    // the human label arrived — either one is enough to reason about it.
    const eitherSet = (idField: string, labelField: string): Prisma.MarketplaceCallWhereInput =>
      ({ OR: [{ [idField]: { not: null } }, { [labelField]: { not: null } }] }) as Prisma.MarketplaceCallWhereInput;

    const [
      callsIngested,
      revenue,
      payout,
      buyers,
      vendors,
      sources,
      campaigns,
      connectivity,
      duplicates,
    ] = await Promise.all([
      this.prisma.marketplaceCall.count({ where: window }),
      countWhere({ revenueCents: { not: null } }),
      countWhere({ payoutCents: { not: null } }),
      countWhere(eitherSet('buyerExternalId', 'buyerLabel')),
      countWhere(eitherSet('vendorExternalId', 'vendorLabel')),
      countWhere(eitherSet('sourceExternalId', 'sourceLabel')),
      countWhere(eitherSet('campaignExternalId', 'campaignLabel')),
      // Connectivity is knowable if the sensor said anything about how the call
      // ended — the canonical status, the provider-native one, or the no-route flag.
      countWhere({
        OR: [{ status: { not: null } }, { rawStatus: { not: null } }, { noRoute: { not: null } }],
      }),
      countWhere({ duplicate: { not: null } }),
    ]);

    return {
      callsIngested,
      populated: {
        // A call always evidences itself; the capability is the denominator.
        calls: callsIngested,
        revenue,
        payout,
        buyers,
        vendors,
        sources,
        campaigns,
        connectivity,
        duplicates,
      },
    };
  }
}

// --- Pure aggregation (exported for testing without a database) -------------

interface DimAccum {
  key: string; label: string; calls: number; qualified: number; converted: number;
  revenueCents: number; payoutCents: number; costCents: number;
}

function bump(
  map: Map<string, DimAccum>, key: string | null, label: string | null,
  qualified: boolean | null, converted: boolean | null,
  rev: number | null, pay: number | null, cost: number | null,
): void {
  // Only real attribution forms a named dimension; unknown-attributed calls
  // still count in window totals but never become an actionable dimension.
  if (!label) return;
  const k = (key ?? label).toLowerCase();
  const cur = map.get(k) ?? { key: k, label, calls: 0, qualified: 0, converted: 0, revenueCents: 0, payoutCents: 0, costCents: 0 };
  cur.calls += 1;
  if (qualified === true) cur.qualified += 1;
  if (converted === true) cur.converted += 1;
  cur.revenueCents += rev ?? 0;
  cur.payoutCents += pay ?? 0;
  cur.costCents += cost ?? 0;
  map.set(k, cur);
}

function toDims(map: Map<string, DimAccum>): CallDimensionAggregate[] {
  return [...map.values()].sort((a, b) => b.revenueCents - a.revenueCents);
}

/** Pure: aggregate call rows into a CallWindowAggregate. Null-aware summation;
 * coverage counts track how many rows actually carried each economic value. */
export function aggregateRows(rows: CallRow[]): CallWindowAggregate {
  let calls = 0, qualified = 0, converted = 0;
  let revenueCents = 0, payoutCents = 0, costCents = 0;
  let callsWithRevenue = 0, callsWithPayout = 0, callsWithCost = 0;
  const buyers = new Map<string, DimAccum>();
  const vendors = new Map<string, DimAccum>();
  const sources = new Map<string, DimAccum>();
  const campaigns = new Map<string, DimAccum>();

  for (const r of rows) {
    calls += 1;
    if (r.qualified === true) qualified += 1;
    if (r.converted === true) converted += 1;
    if (r.revenueCents !== null) { revenueCents += r.revenueCents; callsWithRevenue += 1; }
    if (r.payoutCents !== null) { payoutCents += r.payoutCents; callsWithPayout += 1; }
    if (r.costCents !== null) { costCents += r.costCents; callsWithCost += 1; }
    bump(buyers, r.buyerExternalId, r.buyerLabel, r.qualified, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(vendors, r.vendorExternalId, r.vendorLabel, r.qualified, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(sources, r.sourceExternalId, r.sourceLabel, r.qualified, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(campaigns, r.campaignExternalId, r.campaignLabel, r.qualified, r.converted, r.revenueCents, r.payoutCents, r.costCents);
  }

  return {
    calls, qualified, converted, bookings: 0,
    revenueCents, payoutCents, costCents,
    callsWithRevenue, callsWithPayout, callsWithCost,
    buyers: toDims(buyers), vendors: toDims(vendors),
    sources: toDims(sources), campaigns: toDims(campaigns),
  };
}
