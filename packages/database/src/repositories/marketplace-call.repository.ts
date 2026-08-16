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
  measure,
  measuredCount,
  truthFromSum,
  success,
  hasValue,
  type BindingDimension,
  type PopulationWindowAggregate,
  type Truth,
  type TruthMeta,
} from '@emgloop/shared';
import {
  projectInteractionToMarketplaceCall,
  type MarketplaceCallProjection,
} from './marketplace-call-projection';

/**
 * One observed dimension member, offered for binding selection.
 *
 * `externalId` is non-nullable: a member with no stable provider id is never
 * returned, because it cannot be bound safely.
 */
export interface PopulationCandidateRow {
  dimension: BindingDimension;
  externalId: string;
  /** Most recent observed label. DISPLAY ONLY — never identity. */
  label: string | null;
  observedCalls: number;
}

/** One participant's aggregated economics for a window (matches the Intelligence
 * CallGridDimensionWindow shape structurally). */
export interface CallDimensionAggregate {
  key: string;
  label: string;
  calls: number;
  monetized: number;
  converted: number;
  /** Sum of REPORTED values only. With partial coverage this is a lower bound —
   *  read it together with the matching callsWith* count, never on its own. */
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  /** How many of this entity's calls actually carried each economic value.
   *  Zero means the value is UNKNOWN for this entity, not that it earned zero —
   *  without these counters a buyer nobody priced is indistinguishable from a
   *  buyer that genuinely produced $0, and every ranking built on it is wrong. */
  callsWithRevenue: number;
  callsWithPayout: number;
  callsWithCost: number;
}

/** A window of aggregated call economics (matches CallGridWindow structurally,
 * so the Intelligence layer can consume it directly). */
export interface CallWindowAggregate {
  calls: number;
  monetized: number;
  converted: number;
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
  monetized: boolean | null;
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
        revenueCents: true, payoutCents: true, costCents: true, monetized: true, converted: true,
      },
    })) as CallRow[];
    return aggregateRows(rows);
  }

  /**
   * Read-only window listing for live reconciliation against CallGrid.
   *
   * Selects only the columns the comparison needs — no caller phone, no raw
   * payload — so a reconciliation response cannot carry PII it never loaded.
   */
  async listWindowForReconciliation(
    organizationId: string,
    since: Date,
    until: Date,
    take: number,
  ): Promise<
    Array<{
      externalId: string;
      sourceOccurredAt: Date;
      connectedDurationSeconds: number | null;
      revenueCents: number | null;
      payoutCents: number | null;
      costCents: number | null;
      buyerLabel: string | null;
      campaignLabel: string | null;
      sourceLabel: string | null;
      monetized: boolean | null;
      converted: boolean | null;
      duplicate: boolean | null;
    }>
  > {
    return this.prisma.marketplaceCall.findMany({
      where: { organizationId, sourceOccurredAt: { gte: since, lt: until } },
      orderBy: { sourceOccurredAt: 'asc' },
      take,
      select: {
        externalId: true,
        sourceOccurredAt: true,
        connectedDurationSeconds: true,
        revenueCents: true,
        payoutCents: true,
        costCents: true,
        buyerLabel: true,
        campaignLabel: true,
        sourceLabel: true,
        monetized: true,
        converted: true,
        duplicate: true,
      },
    });
  }

  /**
   * Read-only window listing of the descriptive fields on a call.
   *
   * ADDED FOR, BUT NOT OWNED BY, A CONSUMER. Commercial Intelligence needs to
   * READ calls in order to evaluate them against a Performance Objective, and
   * this is how it does that: through the repository that owns the table, not by
   * reaching into `prisma.marketplaceCall` from another module. Nothing about
   * the call record changes, no write path is affected, and no existing method
   * or caller is altered.
   *
   * Selects only identity, source time and the LABELS the provider already
   * supplied. No caller phone, no economics, no raw payload -- a consumer that
   * only needs to know what a call was about must not be handed money or PII on
   * the way past.
   *
   * `provider` is included because it is the sensor's own name and a consumer
   * must be able to record WHERE a fact came from without hardcoding 'callgrid'.
   */
  async listWindowSummaries(
    organizationId: string,
    since: Date,
    until: Date,
    take: number,
  ): Promise<
    Array<{
      id: string;
      provider: string;
      externalId: string;
      sourceOccurredAt: Date;
      buyerLabel: string | null;
      vendorLabel: string | null;
      sourceLabel: string | null;
      campaignLabel: string | null;
      callerState: string | null;
      status: string | null;
    }>
  > {
    return this.prisma.marketplaceCall.findMany({
      where: { organizationId, sourceOccurredAt: { gte: since, lt: until } },
      orderBy: { sourceOccurredAt: 'desc' },
      take,
      select: {
        id: true,
        provider: true,
        externalId: true,
        sourceOccurredAt: true,
        buyerLabel: true,
        vendorLabel: true,
        sourceLabel: true,
        campaignLabel: true,
        callerState: true,
        status: true,
      },
    });
  }

  // --- Commercial Intelligence Stage 3: the aggregate read boundary ----------
  //
  // AGGREGATES ONLY, AND THAT IS THE POINT. Stage 3 measures a bound population
  // over a window; it does not need to see a call, so it is not handed one. No
  // row leaves this method: no caller phone, no caller zip, no per-call revenue,
  // no external id, no label. Only counts and one sum, which is the narrowest
  // thing that can answer "what was this measure, over this population, in this
  // period" -- the same boundary `listWindowSummaries` drew when it selected
  // labels and refused economics.
  //
  // NULL IS NEVER ZERO. Every nullable field is returned as a (true, reported)
  // pair so the caller can compute a rate over the calls that actually CARRIED
  // the flag, and can state coverage rather than implying full reporting. A call
  // whose `converted` the provider never sent has not been observed as false, and
  // counting it as false would manufacture the outcome the rate measures.

  /**
   * One window's aggregate facts about an explicitly selected population.
   *
   * THE POPULATION IS AN EXPLICIT SELECTION AND NOTHING ELSE. The caller supplies
   * the provider's own external ids per dimension. No label is parsed, no vertical
   * is inferred, no geography is derived, and no Commercial Signal is consulted --
   * a signal is a lexical relevance determination and using one as a measurement
   * denominator would turn a documented limitation into a percentage.
   *
   * Members across dimensions are ORed: a call belongs to the population if it
   * matches any selected campaign, source, buyer or vendor. `callerStates` is a
   * separate AND-ed restriction, and an EMPTY array means no restriction at all
   * rather than a filter that matches nothing.
   *
   * Returns null when no dimension member was supplied. An empty population is a
   * caller error, not an empty result -- returning zeros for it would report the
   * whole tenant as having measured nothing.
   */
  async aggregatePopulationWindow(
    organizationId: string,
    population: {
      campaignExternalIds?: readonly string[];
      sourceExternalIds?: readonly string[];
      buyerExternalIds?: readonly string[];
      vendorExternalIds?: readonly string[];
      callerStates?: readonly string[];
    },
    window: { start: Date; end: Date },
  ): Promise<PopulationWindowAggregate | null> {
    const any: Prisma.MarketplaceCallWhereInput[] = [];
    if (population.campaignExternalIds?.length) {
      any.push({ campaignExternalId: { in: [...population.campaignExternalIds] } });
    }
    if (population.sourceExternalIds?.length) {
      any.push({ sourceExternalId: { in: [...population.sourceExternalIds] } });
    }
    if (population.buyerExternalIds?.length) {
      any.push({ buyerExternalId: { in: [...population.buyerExternalIds] } });
    }
    if (population.vendorExternalIds?.length) {
      any.push({ vendorExternalId: { in: [...population.vendorExternalIds] } });
    }
    // FAIL CLOSED. No selection means no population, and no population means
    // there is nothing to measure -- never "measure everything".
    if (any.length === 0) return null;

    // Tenant first, always. Both sides of every comparison load org-scoped, so no
    // cross-organization row can enter an aggregate even if a caller supplies
    // another tenant's external id -- that id simply matches nothing here.
    const where: Prisma.MarketplaceCallWhereInput = {
      organizationId,
      sourceOccurredAt: { gte: window.start, lt: window.end },
      OR: any,
    };
    if (population.callerStates?.length) {
      where.callerState = { in: population.callerStates.map((s) => s.trim().toUpperCase()) };
    }

    const [
      totalCalls,
      revenue,
      revenueReported,
      monetizedTrue,
      monetizedReported,
      convertedTrue,
      convertedReported,
      noRouteTrue,
      noRouteReported,
    ] = await Promise.all([
      this.prisma.marketplaceCall.count({ where }),
      this.prisma.marketplaceCall.aggregate({ where, _sum: { revenueCents: true } }),
      this.prisma.marketplaceCall.count({ where: { ...where, revenueCents: { not: null } } }),
      this.prisma.marketplaceCall.count({ where: { ...where, monetized: true } }),
      this.prisma.marketplaceCall.count({ where: { ...where, monetized: { not: null } } }),
      this.prisma.marketplaceCall.count({ where: { ...where, converted: true } }),
      this.prisma.marketplaceCall.count({ where: { ...where, converted: { not: null } } }),
      this.prisma.marketplaceCall.count({ where: { ...where, noRoute: true } }),
      this.prisma.marketplaceCall.count({ where: { ...where, noRoute: { not: null } } }),
    ]);

    return {
      totalCalls,
      // Prisma returns null for _sum over an empty set AND for a set where every
      // row is null. Both mean the same thing here -- nobody told us -- and both
      // must stay null rather than becoming a confident $0.
      revenueCents: revenueReported > 0 ? (revenue._sum.revenueCents ?? null) : null,
      revenueReported,
      monetizedTrue,
      monetizedReported,
      convertedTrue,
      convertedReported,
      noRouteTrue,
      noRouteReported,
    };
  }

  /**
   * Dimension members Loop has ACTUALLY OBSERVED, offered for binding selection.
   *
   * Only members carrying a stable external id are returned. A member the
   * provider labelled but never identified cannot be bound, because a population
   * keyed on a label changes shape the day somebody renames a campaign upstream --
   * and the surface should say so rather than silently offering it.
   *
   * The label is returned for display only. It is the most recent one observed in
   * the offer window and it is never identity.
   */
  async listPopulationCandidates(
    organizationId: string,
    since: Date,
    limitPerDimension = 100,
  ): Promise<PopulationCandidateRow[]> {
    // Four explicit groupBy calls rather than one loop over field names. Prisma's
    // generated groupBy types are keyed on the literal `by` fields, and a dynamic
    // key degrades them to an error string — recoverable only with a cast, and a
    // cast here would silence the exact check that proves these columns exist.
    // Verbose and typed beats terse and `any`.
    const base = { organizationId, sourceOccurredAt: { gte: since } };
    const out: PopulationCandidateRow[] = [];

    const campaigns = await this.prisma.marketplaceCall.groupBy({
      by: ['campaignExternalId', 'campaignLabel'],
      where: { ...base, campaignExternalId: { not: null } },
      _count: { _all: true },
      // Prisma requires an orderBy alongside take, and it must name a field in
      // `by`. The meaningful ordering (most observed first) is applied once at
      // the end over all four dimensions, so this one only has to be stable.
      orderBy: { campaignExternalId: 'asc' },
      take: limitPerDimension,
    });
    for (const r of campaigns) {
      if (!r.campaignExternalId) continue;
      out.push({
        dimension: 'CAMPAIGN',
        externalId: r.campaignExternalId,
        label: r.campaignLabel,
        observedCalls: r._count._all,
      });
    }

    const sources = await this.prisma.marketplaceCall.groupBy({
      by: ['sourceExternalId', 'sourceLabel'],
      where: { ...base, sourceExternalId: { not: null } },
      _count: { _all: true },
      // Prisma requires an orderBy alongside take, and it must name a field in
      // `by`. The meaningful ordering (most observed first) is applied once at
      // the end over all four dimensions, so this one only has to be stable.
      orderBy: { sourceExternalId: 'asc' },
      take: limitPerDimension,
    });
    for (const r of sources) {
      if (!r.sourceExternalId) continue;
      out.push({
        dimension: 'SOURCE',
        externalId: r.sourceExternalId,
        label: r.sourceLabel,
        observedCalls: r._count._all,
      });
    }

    const buyers = await this.prisma.marketplaceCall.groupBy({
      by: ['buyerExternalId', 'buyerLabel'],
      where: { ...base, buyerExternalId: { not: null } },
      _count: { _all: true },
      // Prisma requires an orderBy alongside take, and it must name a field in
      // `by`. The meaningful ordering (most observed first) is applied once at
      // the end over all four dimensions, so this one only has to be stable.
      orderBy: { buyerExternalId: 'asc' },
      take: limitPerDimension,
    });
    for (const r of buyers) {
      if (!r.buyerExternalId) continue;
      out.push({
        dimension: 'BUYER',
        externalId: r.buyerExternalId,
        label: r.buyerLabel,
        observedCalls: r._count._all,
      });
    }

    const vendors = await this.prisma.marketplaceCall.groupBy({
      by: ['vendorExternalId', 'vendorLabel'],
      where: { ...base, vendorExternalId: { not: null } },
      _count: { _all: true },
      // Prisma requires an orderBy alongside take, and it must name a field in
      // `by`. The meaningful ordering (most observed first) is applied once at
      // the end over all four dimensions, so this one only has to be stable.
      orderBy: { vendorExternalId: 'asc' },
      take: limitPerDimension,
    });
    for (const r of vendors) {
      if (!r.vendorExternalId) continue;
      out.push({
        dimension: 'VENDOR',
        externalId: r.vendorExternalId,
        label: r.vendorLabel,
        observedCalls: r._count._all,
      });
    }

    // Most-observed first, so the picker leads with the members a human is most
    // likely to recognise. Ties break on external id for a stable order.
    return out.sort((a, b) => b.observedCalls - a.observedCalls || a.externalId.localeCompare(b.externalId));
  }

  /**
   * The canonical CallGrid window metrics, each as Truth.
   *
   * This is the authoritative operational read for the Marketplace. It reads
   * MarketplaceCall — the sensor-neutral projection — and NOTHING else. No CRM
   * Order, no CRM Booking, no Interaction.metadata string-probing.
   *
   * Coverage drives the state honestly: an economic total over a window where
   * only some calls carried that value is a LOWER BOUND, so it is PARTIAL with
   * the real ratio attached. A window with calls but no economics at all is
   * UNKNOWN, not zero.
   */
  async windowMetrics(
    organizationId: string,
    since: Date,
    until: Date,
    now: Date = new Date(),
  ): Promise<{
    calls: Truth<number>;
    revenueCents: Truth<number>;
    payoutCents: Truth<number>;
    costCents: Truth<number>;
    monetized: Truth<number>;
    converted: Truth<number>;
  }> {
    const meta: TruthMeta = { measuredAt: now.toISOString(), subject: 'marketplace.window' };

    return measure(
      () => this.aggregateWindow(organizationId, since, until),
      (agg, m) => success(agg, m),
      meta,
    ).then((t) => {
      // A failed read propagates to every figure — none may render as zero.
      if (!hasValue(t)) {
        const f = t as Truth<never>;
        return {
          calls: f as unknown as Truth<number>,
          revenueCents: f as unknown as Truth<number>,
          payoutCents: f as unknown as Truth<number>,
          costCents: f as unknown as Truth<number>,
          monetized: f as unknown as Truth<number>,
          converted: f as unknown as Truth<number>,
        };
      }
      const agg = t.value;

      /** An economic total is only as complete as the calls that carried it. */
      const economic = (total: number, withValue: number, label: string, subject: string): Truth<number> =>
        truthFromSum(
          { total, counted: withValue, missing: Math.max(0, agg.calls - withValue) },
          {
            code: 'callgrid-economics-partial',
            summary: `${label} is reported by the sensor on some calls only.`,
            provider: 'CallGrid',
            unblockedBy: `Confirm with CallGrid why ${label.toLowerCase()} is absent on the remaining calls.`,
          },
          { ...meta, subject },
        );

      return {
        calls: measuredCount(agg.calls, { ...meta, subject: 'marketplace.calls' }),
        revenueCents: economic(agg.revenueCents, agg.callsWithRevenue, 'Revenue', 'marketplace.revenue'),
        payoutCents: economic(agg.payoutCents, agg.callsWithPayout, 'Payout', 'marketplace.payout'),
        costCents: economic(agg.costCents, agg.callsWithCost, 'Cost', 'marketplace.cost'),
        // Outcome flags are counted from calls whose flag the sensor set; a null
        // flag is not a false, so the denominator is total calls.
        monetized: measuredCount(agg.monetized, { ...meta, subject: 'marketplace.monetized' }),
        converted: measuredCount(agg.converted, { ...meta, subject: 'marketplace.converted' }),
      };
    });
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
  key: string; label: string; calls: number; monetized: number; converted: number;
  revenueCents: number; payoutCents: number; costCents: number;
  callsWithRevenue: number; callsWithPayout: number; callsWithCost: number;
}

function bump(
  map: Map<string, DimAccum>, key: string | null, label: string | null,
  monetized: boolean | null, converted: boolean | null,
  rev: number | null, pay: number | null, cost: number | null,
): void {
  // Only real attribution forms a named dimension; unknown-attributed calls
  // still count in window totals but never become an actionable dimension.
  if (!label) return;
  const k = (key ?? label).toLowerCase();
  const cur = map.get(k) ?? {
    key: k, label, calls: 0, monetized: 0, converted: 0,
    revenueCents: 0, payoutCents: 0, costCents: 0,
    callsWithRevenue: 0, callsWithPayout: 0, callsWithCost: 0,
  };
  cur.calls += 1;
  if (monetized === true) cur.monetized += 1;
  if (converted === true) cur.converted += 1;
  // Track coverage alongside every economic sum. A missing value adds nothing AND
  // counts nothing, so the caller can tell "unpriced" from "priced at zero".
  if (rev !== null) { cur.revenueCents += rev; cur.callsWithRevenue += 1; }
  if (pay !== null) { cur.payoutCents += pay; cur.callsWithPayout += 1; }
  if (cost !== null) { cur.costCents += cost; cur.callsWithCost += 1; }
  map.set(k, cur);
}

function toDims(map: Map<string, DimAccum>): CallDimensionAggregate[] {
  return [...map.values()].sort((a, b) => b.revenueCents - a.revenueCents);
}

/** Pure: aggregate call rows into a CallWindowAggregate. Null-aware summation at
 * BOTH grains — the window totals and every dimension row carry coverage counts
 * for how many calls actually reported each economic value. */
export function aggregateRows(rows: CallRow[]): CallWindowAggregate {
  let calls = 0, monetized = 0, converted = 0;
  let revenueCents = 0, payoutCents = 0, costCents = 0;
  let callsWithRevenue = 0, callsWithPayout = 0, callsWithCost = 0;
  const buyers = new Map<string, DimAccum>();
  const vendors = new Map<string, DimAccum>();
  const sources = new Map<string, DimAccum>();
  const campaigns = new Map<string, DimAccum>();

  for (const r of rows) {
    calls += 1;
    if (r.monetized === true) monetized += 1;
    if (r.converted === true) converted += 1;
    if (r.revenueCents !== null) { revenueCents += r.revenueCents; callsWithRevenue += 1; }
    if (r.payoutCents !== null) { payoutCents += r.payoutCents; callsWithPayout += 1; }
    if (r.costCents !== null) { costCents += r.costCents; callsWithCost += 1; }
    bump(buyers, r.buyerExternalId, r.buyerLabel, r.monetized, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(vendors, r.vendorExternalId, r.vendorLabel, r.monetized, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(sources, r.sourceExternalId, r.sourceLabel, r.monetized, r.converted, r.revenueCents, r.payoutCents, r.costCents);
    bump(campaigns, r.campaignExternalId, r.campaignLabel, r.monetized, r.converted, r.revenueCents, r.payoutCents, r.costCents);
  }

  return {
    calls, monetized, converted,
    revenueCents, payoutCents, costCents,
    callsWithRevenue, callsWithPayout, callsWithCost,
    buyers: toDims(buyers), vendors: toDims(vendors),
    sources: toDims(sources), campaigns: toDims(campaigns),
  };
}
