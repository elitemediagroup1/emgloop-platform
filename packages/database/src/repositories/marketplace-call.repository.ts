// MarketplaceCallRepository — persistence + read model for the sensor-neutral
// call projection.
//
// Write path (idempotent): a projection of one observation → `observe`, which
// creates the one row on (provider, externalId) or MERGES into it by the shared
// convergence rule. It never duplicates a call and never overwrites one.
//
// Read path: aggregateWindow returns per-window, per-dimension economics the
// Intelligence module consumes — reading first-class, indexed columns instead of
// parsing Interaction.metadata JSON at request time. Null economics are summed
// null-aware and coverage counts record how many rows actually carried a value,
// so the module stays honest about what it could see.
//
// Backfill: projectWindow reads existing Interactions and merges their
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
  convergeCallObservation,
  projectInteractionToMarketplaceCall,
  type CallFactDecision,
  type MarketplaceCallProjection,
  type StoredCallFacts,
} from './marketplace-call-projection';

/** What one observation did to the stored call. */
export interface CallObservationOutcome {
  /**
   * CREATED   the first observation to arrive; the row is exactly what it stated.
   * MERGED    an existing row was strengthened by the shared rule.
   * UNCHANGED an existing row already held everything this observation could say.
   * FOREIGN   the key is held by another organization; nothing was touched.
   * CONTENDED every attempt lost a race; nothing was written, and a later
   *           observation (or reconciliation) will converge it.
   */
  readonly outcome: 'CREATED' | 'MERGED' | 'UNCHANGED' | 'FOREIGN' | 'CONTENDED';
  /** Each provider fact's decision against the stored row -- for the revision record. */
  readonly decisions: readonly CallFactDecision[];
}

/** How many times a merge re-reads after losing a race. Three webhooks per call. */
const OBSERVE_ATTEMPTS = 6;

const STORED_FACTS = {
  id: true,
  organizationId: true,
  interactionId: true,
  revenueCents: true,
  payoutCents: true,
  billable: true,
  paid: true,
  converted: true,
  monetized: true,
} as const;

/** Postgres refused a second row for a unique key (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

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

/** One bound member and how many calls it contributed across the compared windows. */
export interface PopulationPartitionRow {
  dimension: BindingDimension;
  memberExternalId: string;
  /** A WINDOW-WIDE TOTAL. Whether a member participated ON A GIVEN DATE is read
      from that date's reconciliation member fact, never from this number. */
  localCalls: number;
}

/** The bound population, split by member, with what belonged to no member. */
export interface PopulationPartitionFacts {
  partitions: PopulationPartitionRow[];
  unattributedCalls: number;
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

/** A call as `windowFacts` reads it: CallRow plus time and outcome flags. */
type CallFactRow = CallRow & {
  sourceOccurredAt: Date;
  billable: boolean | null;
  completed: boolean | null;
  noRoute: boolean | null;
};

/** A half-open time bucket [start, end). The caller builds them (Eastern hours or days). */
export interface CallBucket {
  readonly start: Date;
  readonly end: Date;
}

export type CallDimensionName = 'buyers' | 'vendors' | 'sources' | 'campaigns';

/** One entity, by the same key `aggregateWindow` gives it: (externalId ?? label), lower-cased. */
export interface CallEntitySelector {
  readonly dimension: CallDimensionName;
  readonly key: string;
}

export interface CallSeriesPoint {
  start: Date;
  end: Date;
  calls: number;
  monetized: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  callsWithRevenue: number;
  callsWithPayout: number;
  callsWithCost: number;
}

/**
 * How far calls got. Each flag is counted twice: how many calls said TRUE, and how
 * many said anything at all -- a call that reported no `completed` flag is not an
 * incomplete call, and a funnel must not treat it as one.
 */
export interface CallOutcomeCounts {
  calls: number;
  completed: number;
  completedReported: number;
  billable: number;
  billableReported: number;
  monetized: number;
  noRoute: number;
  noRouteReported: number;
}

export interface CallWindowFacts {
  /** The label the entity carried, or null when no call in the window matched it. */
  entityLabel: string | null;
  /** Economics and the four dimension rollups over the (narrowed) calls. */
  aggregate: CallWindowAggregate;
  outcomes: CallOutcomeCounts;
  /** One point per requested bucket, in order. Calls outside every bucket count in totals only. */
  series: CallSeriesPoint[];
}

export interface RecentCallView {
  id: string;
  sourceOccurredAt: Date;
  updatedAt: Date;
  status: string | null;
  buyerLabel: string | null;
  sourceLabel: string | null;
  campaignLabel: string | null;
  vendorLabel: string | null;
  monetized: boolean | null;
  completed: boolean | null;
  noRoute: boolean | null;
  revenueCents: number | null;
}

export class MarketplaceCallRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Bring the one stored call up to date with ONE observation of it -- and never
   * weaken it.
   *
   * CREATE OR MERGE, NEVER OVERWRITE. The first observation to reach the table
   * creates the row exactly as the provider stated it (a zero included). Every
   * later one -- a second webhook for the same call, a poll, a backfill over old
   * Interactions -- is merged by `convergeCallObservation`, which moves only what
   * the shared rule approves and nothing else. A full-row rewrite is how a stale
   * copy erased newer economics, and it no longer exists on any path.
   *
   * SAFE UNDER CONCURRENCY, WITHOUT A LOCK. CallGrid fires Ended, Billable and
   * Payable for one call at essentially the same moment, so three requests race
   * for this row:
   *   * two creates: the unique key `(provider, externalId)` admits one, and the
   *     loser merges into what the winner wrote;
   *   * two merges: each update is conditional on the values it decided from
   *     (compare-and-set). If another observation moved one of them first, the
   *     update matches nothing, and this one re-reads and decides again.
   *
   * ONE ORGANIZATION'S CALL. The unique key is global (known tenancy debt), so a
   * row held by another organization is refused -- never moved, never merged.
   */
  async observe(p: MarketplaceCallProjection): Promise<CallObservationOutcome> {
    const key = { provider_externalId: { provider: p.provider, externalId: p.externalId } };
    for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
      const stored = await this.prisma.marketplaceCall.findUnique({ where: key, select: STORED_FACTS });
      if (!stored) {
        try {
          const data: Prisma.MarketplaceCallUncheckedCreateInput = { ...p };
          await this.prisma.marketplaceCall.create({ data });
          return { outcome: 'CREATED', decisions: [] };
        } catch (error) {
          if (isUniqueViolation(error)) continue; // another observation created it first: merge instead
          throw error;
        }
      }
      if (stored.organizationId !== p.organizationId) return { outcome: 'FOREIGN', decisions: [] };

      const plan = convergeCallObservation(stored, p);
      const columns = Object.keys(plan.update) as (keyof StoredCallFacts)[];
      if (columns.length === 0) return { outcome: 'UNCHANGED', decisions: plan.decisions };

      // Compare-and-set: only if every column being moved still holds the value it
      // was decided from.
      const unchangedSince = Object.fromEntries(columns.map((column) => [column, stored[column]]));
      const moved = await this.prisma.marketplaceCall.updateMany({
        where: { id: stored.id, ...unchangedSince },
        data: plan.update,
      });
      if (moved.count === 1) return { outcome: 'MERGED', decisions: plan.decisions };
    }
    return { outcome: 'CONTENDED', decisions: [] };
  }

  /** Project one raw Interaction (write-through from the ingestion path, and the
   * backfill). Returns true when the call was observed, false when the row was not
   * projectable. It merges; it never overwrites. */
  async projectInteraction(interaction: Parameters<typeof projectInteractionToMarketplaceCall>[0]): Promise<boolean> {
    const projection = projectInteractionToMarketplaceCall(interaction);
    if (!projection) return false;
    await this.observe(projection);
    return true;
  }

  /**
   * Backfill the projection for a window from existing Interactions.
   *
   * Idempotent, org-scoped and demo-filtered by the pure mapper -- and it MERGES.
   * An Interaction holds the FIRST observation of its call, so it is often older
   * than what the call row now says (a later webhook settled the revenue). A
   * backfill used to rebuild each row from that copy and overwrite whatever had
   * been learned since; it now goes through the same convergence as live
   * ingestion, so it can create a missing row or fill what is unknown, and can
   * never erase a newer fact.
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
      await this.observe(p);
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
   * One window's calls as the CallGrid command center reads them: the SAME rows
   * `aggregateWindow` reads (organization, `sourceOccurredAt` in [since, until)),
   * optionally narrowed to one entity, bucketed into the caller's time buckets, and
   * rolled up across the OTHER dimensions -- which campaigns fed this buyer, which
   * sources supplied it.
   *
   * The composition is possible because one projected call carries its source,
   * campaign, buyer and vendor together; nothing here joins across tables or
   * infers a link the call row did not state. Outcome counts (completed, billable,
   * no route) carry how many calls reported each flag, because a flag nobody
   * reported is unknown, not false.
   *
   * An explicit column list: this read depends on exactly the columns it uses.
   */
  async windowFacts(
    organizationId: string,
    since: Date,
    until: Date,
    options: { readonly buckets?: readonly CallBucket[]; readonly entity?: CallEntitySelector } = {},
  ): Promise<CallWindowFacts> {
    const rows = (await this.prisma.marketplaceCall.findMany({
      where: { organizationId, sourceOccurredAt: { gte: since, lt: until } },
      select: {
        sourceOccurredAt: true,
        buyerExternalId: true, buyerLabel: true, vendorExternalId: true, vendorLabel: true,
        sourceExternalId: true, sourceLabel: true, campaignExternalId: true, campaignLabel: true,
        revenueCents: true, payoutCents: true, costCents: true, monetized: true, converted: true,
        billable: true, completed: true, noRoute: true,
      },
    })) as CallFactRow[];
    return windowFactsOf(rows, options);
  }

  /**
   * When this organization's call record begins: the earliest `sourceOccurredAt` Loop
   * holds, or null when it holds none. A period that starts before this was not
   * observed, so it is not a period with zero calls, and the command center
   * does not compare against it. One indexed row.
   */
  async firstCallAt(organizationId: string): Promise<Date | null> {
    const first = await this.prisma.marketplaceCall.findFirst({
      where: { organizationId },
      orderBy: { sourceOccurredAt: 'asc' },
      select: { sourceOccurredAt: true },
    });
    return first?.sourceOccurredAt ?? null;
  }

  /**
   * The most recent projected calls for this organization, newest first -- what
   * CallGrid most recently told Loop, as the projection holds it. Labels, outcome
   * flags and revenue only; no caller number, no zip.
   */
  async recentCalls(organizationId: string, limit = 8): Promise<RecentCallView[]> {
    const rows = await this.prisma.marketplaceCall.findMany({
      where: { organizationId },
      orderBy: { sourceOccurredAt: 'desc' },
      take: Math.max(1, Math.min(limit, 50)),
      select: {
        id: true, sourceOccurredAt: true, updatedAt: true, status: true,
        buyerLabel: true, sourceLabel: true, campaignLabel: true, vendorLabel: true,
        monetized: true, completed: true, noRoute: true, revenueCents: true,
      },
    });
    return rows;
  }

  /**
   * The PROJECTED identity set for a window, batched, and nothing else.
   *
   * WHY IDENTITIES AND NOT ROWS. The question this serves is "was this captured
   * call also projected" -- a set membership test. Loading the row would pull
   * money, labels and attribution a verification report has no business holding,
   * and `listWindowForReconciliation` already exists for callers that legitimately
   * compare values. This one cannot leak what it never selected.
   *
   * Keyed on `sourceOccurredAt`, which is the projection's copy of provider
   * occurrence -- so a recovered call sits in the window it happened in, exactly
   * as it does on the integration_events side.
   */
  async listIdentitiesInWindow(
    organizationId: string,
    since: Date,
    until: Date,
    options: { batchSize?: number; afterId?: string } = {},
  ): Promise<Array<{ id: string; externalId: string }>> {
    const take = options.batchSize && options.batchSize > 0 ? Math.min(options.batchSize, 1000) : 500;
    const rows = await this.prisma.marketplaceCall.findMany({
      where: {
        organizationId,
        sourceOccurredAt: { gte: since, lt: until },
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, externalId: true },
    });
    return rows.map((r) => ({ id: r.id, externalId: r.externalId }));
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
   * Every bound member's call count across the compared windows, plus the calls
   * that belong to no bound member at all.
   *
   * WHAT THE READINESS GATE NEEDS AND `aggregatePopulationWindow` CANNOT GIVE IT.
   * That method returns one total for the whole population, and the gate reasons
   * per member: a campaign's expectation, its reconciliation and its authoritative
   * source are all resolved individually. One summed number cannot be partitioned
   * back into the members it came from.
   *
   * EVERY REQUESTED MEMBER IS RETURNED, INCLUDING ONES THAT CONTRIBUTED NOTHING,
   * and that is the whole reason this lives here rather than in the caller. A
   * `groupBy` returns only members that appear, so a campaign that went completely
   * silent would simply vanish -- and the gate would then find nothing wrong with
   * measuring the survivors. That is precisely the August 2026 shape, where three
   * campaigns accounted for 106 absences and zero rows. Seeding the full member
   * set here means a caller cannot reintroduce that hole by forgetting to.
   *
   * `unattributedCalls` IS COMPUTED, NOT ASSUMED ZERO. Under today's selection
   * every call in the population matched at least one bound id by construction, so
   * this is structurally zero. Asserting that instead of asking would be true only
   * until the day selection widens, and the failure would be silent: calls with no
   * resolvable member being measured as though they had one.
   *
   * FAILS CLOSED exactly as `aggregatePopulationWindow` does: no selection means
   * no population, and null rather than "everything".
   */
  async partitionPopulationWindows(
    organizationId: string,
    population: {
      campaignExternalIds?: readonly string[];
      sourceExternalIds?: readonly string[];
      buyerExternalIds?: readonly string[];
      vendorExternalIds?: readonly string[];
      callerStates?: readonly string[];
    },
    windows: readonly { start: Date; end: Date }[],
  ): Promise<PopulationPartitionFacts | null> {
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
    if (any.length === 0 || windows.length === 0) return null;

    // The SAME predicate `aggregatePopulationWindow` builds, over both windows at
    // once. Written from the one population argument rather than passed in
    // separately, so the calls the gate reasons about and the calls the
    // measurement counts cannot describe different sets.
    const where: Prisma.MarketplaceCallWhereInput = {
      organizationId,
      OR: windows.map((w) => ({
        sourceOccurredAt: { gte: w.start, lt: w.end },
        OR: any,
      })),
    };
    if (population.callerStates?.length) {
      where.callerState = { in: population.callerStates.map((s) => s.trim().toUpperCase()) };
    }

    // Four explicit groupBy calls rather than one loop over field names, for the
    // reason `listPopulationCandidates` already documents: Prisma's generated
    // groupBy types are keyed on the literal `by` fields and a dynamic key
    // degrades them to an error string.
    const [campaigns, sources, buyers, vendors, unattributedCalls] = await Promise.all([
      population.campaignExternalIds?.length
        ? this.prisma.marketplaceCall.groupBy({
            by: ['campaignExternalId'],
            where: { ...where, campaignExternalId: { in: [...population.campaignExternalIds] } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      population.sourceExternalIds?.length
        ? this.prisma.marketplaceCall.groupBy({
            by: ['sourceExternalId'],
            where: { ...where, sourceExternalId: { in: [...population.sourceExternalIds] } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      population.buyerExternalIds?.length
        ? this.prisma.marketplaceCall.groupBy({
            by: ['buyerExternalId'],
            where: { ...where, buyerExternalId: { in: [...population.buyerExternalIds] } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      population.vendorExternalIds?.length
        ? this.prisma.marketplaceCall.groupBy({
            by: ['vendorExternalId'],
            where: { ...where, vendorExternalId: { in: [...population.vendorExternalIds] } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.prisma.marketplaceCall.count({ where: { ...where, NOT: { OR: any } } }),
    ]);

    const counted = new Map<string, number>();
    const key = (dimension: BindingDimension, id: string) => `${dimension}\u0000${id}`;
    for (const r of campaigns) {
      if (r.campaignExternalId) counted.set(key('CAMPAIGN', r.campaignExternalId), r._count._all);
    }
    for (const r of sources) {
      if (r.sourceExternalId) counted.set(key('SOURCE', r.sourceExternalId), r._count._all);
    }
    for (const r of buyers) {
      if (r.buyerExternalId) counted.set(key('BUYER', r.buyerExternalId), r._count._all);
    }
    for (const r of vendors) {
      if (r.vendorExternalId) counted.set(key('VENDOR', r.vendorExternalId), r._count._all);
    }

    // Seeded from the BOUND set, in a fixed dimension order and the order each
    // was supplied. Deterministic, and complete whether or not a member appeared.
    const partitions: PopulationPartitionRow[] = [];
    const seed = (dimension: BindingDimension, ids: readonly string[] | undefined) => {
      for (const id of ids ?? []) {
        partitions.push({
          dimension,
          memberExternalId: id,
          localCalls: counted.get(key(dimension, id)) ?? 0,
        });
      }
    };
    seed('CAMPAIGN', population.campaignExternalIds);
    seed('SOURCE', population.sourceExternalIds);
    seed('BUYER', population.buyerExternalIds);
    seed('VENDOR', population.vendorExternalIds);

    return { partitions, unattributedCalls };
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

// --- The command center's window facts (pure; exported for testing) --------------

const DIMENSION_FIELDS: Record<CallDimensionName, { id: keyof CallRow; label: keyof CallRow }> = {
  buyers: { id: 'buyerExternalId', label: 'buyerLabel' },
  vendors: { id: 'vendorExternalId', label: 'vendorLabel' },
  sources: { id: 'sourceExternalId', label: 'sourceLabel' },
  campaigns: { id: 'campaignExternalId', label: 'campaignLabel' },
};

/** The key `aggregateRows` gives an entity -- one definition, so a detail page and a list row agree. */
export function callDimensionKey(externalId: string | null, label: string | null): string | null {
  if (!label) return null;
  return (externalId ?? label).toLowerCase();
}

/** Pure: narrow, bucket and roll up a window's call rows. */
export function windowFactsOf(
  rows: readonly CallFactRow[],
  options: { readonly buckets?: readonly CallBucket[]; readonly entity?: CallEntitySelector } = {},
): CallWindowFacts {
  let entityLabel: string | null = null;
  let selected: readonly CallFactRow[] = rows;
  if (options.entity) {
    const { id, label } = DIMENSION_FIELDS[options.entity.dimension];
    const wanted = options.entity.key.toLowerCase();
    selected = rows.filter((r) => {
      const key = callDimensionKey(r[id] as string | null, r[label] as string | null);
      if (key !== wanted) return false;
      entityLabel = entityLabel ?? (r[label] as string | null);
      return true;
    });
  }

  const outcomes: CallOutcomeCounts = {
    calls: 0, completed: 0, completedReported: 0, billable: 0, billableReported: 0,
    monetized: 0, noRoute: 0, noRouteReported: 0,
  };
  for (const r of selected) {
    outcomes.calls += 1;
    if (r.completed !== null) { outcomes.completedReported += 1; if (r.completed) outcomes.completed += 1; }
    if (r.billable !== null) { outcomes.billableReported += 1; if (r.billable) outcomes.billable += 1; }
    if (r.noRoute !== null) { outcomes.noRouteReported += 1; if (r.noRoute) outcomes.noRoute += 1; }
    if (r.monetized === true) outcomes.monetized += 1;
  }

  const buckets = options.buckets ?? [];
  const series: CallSeriesPoint[] = buckets.map((b) => ({
    start: b.start, end: b.end, calls: 0, monetized: 0,
    revenueCents: 0, payoutCents: 0, costCents: 0,
    callsWithRevenue: 0, callsWithPayout: 0, callsWithCost: 0,
  }));
  if (series.length > 0) {
    for (const r of selected) {
      const t = r.sourceOccurredAt.getTime();
      // Buckets are ordered and non-overlapping: binary search for the one holding t.
      let lo = 0;
      let hi = series.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = series[mid]!;
        if (t < p.start.getTime()) hi = mid - 1;
        else if (t >= p.end.getTime()) lo = mid + 1;
        else { hit = mid; break; }
      }
      if (hit < 0) continue;
      const p = series[hit]!;
      p.calls += 1;
      if (r.monetized === true) p.monetized += 1;
      if (r.revenueCents !== null) { p.revenueCents += r.revenueCents; p.callsWithRevenue += 1; }
      if (r.payoutCents !== null) { p.payoutCents += r.payoutCents; p.callsWithPayout += 1; }
      if (r.costCents !== null) { p.costCents += r.costCents; p.callsWithCost += 1; }
    }
  }

  return { entityLabel, aggregate: aggregateRows([...selected]), outcomes, series };
}
