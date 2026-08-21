// IntegrationRepository — Sprint 10 (Loop Intelligence Foundation).
//
// Persistence for the integration layer: ProviderConnection (how we connect to
// external sources) and IntegrationEvent (raw inbound payloads before
// normalization). Both are org-scoped, written through Prisma into Neon, never
// mocked. No real API calls happen here — this is the storage layer only.
//
// Note: ProviderCategory Prisma enum is uppercase (AI, VOICE, INGESTION, ...).
// The shared @emgloop/shared ProviderCategory is lowercase ('ingestion', ...).
// This repository converts between them. All input category values are lowercase
// from the shared package; they are uppercased before Prisma calls.


import type { PrismaClient, ProviderConnection, IntegrationEvent, ProviderCategory as PrismaProviderCategory } from '@prisma/client';


function toUpperCategory(cat: string): PrismaProviderCategory {
  return cat.toUpperCase() as PrismaProviderCategory;
}


// ---- View models ----------------------------------------------------------

export interface IntegrationConnectionView {
  id: string;
  organizationId: string;
  category: string;
  provider: string;
  displayName: string;
  status: string;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationEventView {
  id: string;
  organizationId: string;
  provider: string;
  externalId: string | null;
  eventType: string | null;
  status: string;
  occurredAt: string | null;
  receivedAt: string;
  errorMessage: string | null;
}

export interface CreateConnectionInput {
  organizationId: string;
  category: string;  // 'ingestion' | 'analytics' (lowercase, from shared package)
  provider: string;
  displayName?: string;
  config?: Record<string, unknown>;
}

export interface UpdateConnectionInput {
  displayName?: string;
  status?: string;
  config?: Record<string, unknown>;
  connectedAt?: Date;
  lastSyncedAt?: Date;
}

export interface CreateIntegrationEventInput {
  organizationId: string;
  provider: string;
  externalId?: string;
  eventType?: string;
  status?: string;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  processingErrors?: string;
  metadata?: Record<string, unknown>;
}


// ---- Helper ---------------------------------------------------------------

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toConnectionView(c: ProviderConnection): IntegrationConnectionView {
  return {
    id: c.id,
    organizationId: c.organizationId,
    category: c.category.toLowerCase(),
    provider: c.provider,
    displayName: c.displayName ?? c.provider,
    status: c.status,
    connectedAt: c.connectedAt?.toISOString() ?? null,
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
    config: jsonObj(c.config),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toEventView(e: IntegrationEvent): IntegrationEventView {
  return {
    id: e.id,
    organizationId: e.organizationId,
    provider: e.provider ?? '',    externalId: e.externalId ?? null,
    eventType: e.eventType ?? null,
    status: e.status,
    occurredAt: e.processedAt?.toISOString() ?? null,    receivedAt: e.receivedAt.toISOString(),
    errorMessage: e.error ?? null,  };
}


// ---- Repository -----------------------------------------------------------

export class IntegrationRepository {
  constructor(private readonly prisma: PrismaClient) {}


  // -- Connections -----------------------------------------------------------

  async listConnections(organizationId: string): Promise<IntegrationConnectionView[]> {
    const rows = await this.prisma.providerConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toConnectionView);
  }

  async getConnection(
    organizationId: string,
    id: string,
  ): Promise<IntegrationConnectionView | null> {
    const row = await this.prisma.providerConnection.findFirst({
      where: { id, organizationId },
    });
    return row ? toConnectionView(row) : null;
  }

  async createConnection(
    input: CreateConnectionInput,
  ): Promise<IntegrationConnectionView> {
    const row = await this.prisma.providerConnection.create({
      data: {
        organizationId: input.organizationId,
        category: toUpperCategory(input.category),
        provider: input.provider,
        displayName: input.displayName ?? input.provider,
        status: 'PENDING',
        config: (input.config ?? {}) as any,      },
    });
    return toConnectionView(row);
  }

  async updateConnection(
    organizationId: string,
    id: string,
    input: UpdateConnectionInput,
  ): Promise<IntegrationConnectionView | null> {
    const existing = await this.prisma.providerConnection.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return null;

    const row = await this.prisma.providerConnection.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.config !== undefined && { config: input.config as any }),        ...(input.connectedAt !== undefined && { connectedAt: input.connectedAt }),
        ...(input.lastSyncedAt !== undefined && { lastSyncedAt: input.lastSyncedAt }),
      },
    });
    return toConnectionView(row);
  }

  async deleteConnection(
    organizationId: string,
    id: string,
  ): Promise<boolean> {
    const existing = await this.prisma.providerConnection.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return false;
    await this.prisma.providerConnection.delete({ where: { id } });
    return true;
  }


  // -- Integration Events ---------------------------------------------------

  async recordEvent(
    input: CreateIntegrationEventInput,
  ): Promise<IntegrationEventView> {
    const row = await this.prisma.integrationEvent.create({
      data: {
        organizationId: input.organizationId,
        provider: input.provider,
        externalId: input.externalId,
                eventType: input.eventType ?? '',
                status: (input.status ?? 'RECEIVED') as Parameters<typeof this.prisma.integrationEvent.create>[0]['data']['status'],
                payload: (input.payload ?? {}) as any,
                error: input.processingErrors ?? null,
      },
    });
    return toEventView(row);
  }

  async updateEventStatus(
    organizationId: string,
    id: string,
    status: string,
    processingErrors?: string,
  ): Promise<IntegrationEventView | null> {
    const existing = await this.prisma.integrationEvent.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return null;
    const row = await this.prisma.integrationEvent.update({
      where: { id },
      data: {
        status: status as Parameters<typeof this.prisma.integrationEvent.update>[0]['data']['status'],
      ...(processingErrors !== undefined && { error: processingErrors }),      },
    });
    return toEventView(row);
  }

  /**
   * The stored status of one provider delivery, or null if this organization has
   * never held it.
   *
   * EXISTS FOR A DRY RUN, AND FOR NOTHING ELSE. A caller that wants to say what
   * ingestion WOULD do without ingesting needs the one column ingestion branches
   * on. It is a read: there is no sibling that writes, and the answer is fed to
   * `isDuplicateObservation` rather than compared against a status literal here.
   *
   * ORGANIZATION-SCOPED, and that has a consequence worth knowing. Ingestion's
   * own duplicate lookup is not scoped -- `(provider, externalId)` is unique
   * GLOBALLY rather than per organization (CLAUDE.md, known tenancy debt), so a
   * delivery held by a DIFFERENT tenant answers null here and is still recognised
   * as an existing row by ingestion. The scoped read is the correct one to write;
   * the divergence belongs to the unique key and is the caller's to disclose.
   */
  async statusOfEvent(
    organizationId: string,
    provider: string,
    externalId: string,
  ): Promise<string | null> {
    const row = await this.prisma.integrationEvent.findFirst({
      where: { organizationId, provider, externalId },
      select: { status: true },
    });
    return row ? String(row.status) : null;
  }

  async listRecentEvents(
    organizationId: string,
    options: { provider?: string; limit?: number } = {},
  ): Promise<IntegrationEventView[]> {
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        ...(options.provider && { provider: options.provider }),
      },
      orderBy: { receivedAt: 'desc' },
      take: options.limit ?? 50,
    });
    return rows.map(toEventView);
  }

  /**
   * Read raw integration events whose DELIVERY time falls inside a window, in
   * batches, for reconciliation.
   *
   * WHY DELIVERY TIME AND NOT OCCURRENCE TIME. `integration_events.occurredAt`
   * exists as of PR #180 -- this comment claimed it did not, and said so for as
   * long as it took someone to read the schema -- but it is populated only for
   * rows written since, so a window filtered on it would silently omit every
   * earlier row. Delivery time is the column every row has. The caller reads a
   * DELIBERATELY WIDER delivery window and applies the canonical resolver in
   * memory, so local and provider occurrence semantics are identical by
   * construction rather than by care. Narrowing this to `occurredAt` is a
   * decision that waits on a backfill, not a one-line change.
   *
   * READ-ONLY, ORGANIZATION-SCOPED, BATCHED. The organization is the first
   * argument because this is a tenant-owned row (see CLAUDE.md §Multi-Tenant
   * Rules), and the id cursor keeps a busy window from being loaded at once.
   */
  /**
   * Read raw integration events whose PROVIDER OCCURRENCE falls inside a window,
   * plus the legacy rows that cannot answer that question.
   *
   * WHY THIS EXISTS, AND WHY THE SIBLING BELOW IS NOT ENOUGH. Selecting by
   * `receivedAt` and filtering by occurrence in memory works for live traffic,
   * where a call is delivered seconds after it happens. It breaks completely for
   * a RECOVERED call: one ingested today for an interval in August has
   * `receivedAt` today and `occurredAt` in August, so a delivery-bounded scan
   * around the August day never fetches it. Reconciliation would keep reporting
   * it missing after it had been recovered -- which would make recovery
   * unprovable, and would leave a stored verdict that is now false.
   *
   * TWO WINDOWS, DELIBERATELY. `since/until` bound the OCCURRENCE and are the
   * real question. `legacySince/legacyUntil` bound the DELIVERY of rows written
   * before PR #180 added the column, whose occurrence lives only inside `payload`
   * and cannot be filtered in SQL without hand-writing a JSON expression that
   * duplicates `resolveCallOccurrence`'s field precedence. Those rows stay
   * discoverable through the delivery window they were always found by, and the
   * caller resolves their occurrence in memory exactly as before.
   *
   * A NULL-OCCURRENCE ROW IS NEVER EXCLUDED BY THIS QUERY. It is fetched and
   * handed up, so the caller can count it and let it impeach a day rather than
   * having it silently vanish from both sides of a comparison.
   *
   * READ-ONLY, ORGANIZATION-SCOPED, BATCHED, and served by the
   * `(organizationId, provider, occurredAt)` index PR #180 already created.
   */
  async listEventsForOccurrenceWindow(
    organizationId: string,
    options: {
      provider: string;
      since: Date;
      until: Date;
      legacySince: Date;
      legacyUntil: Date;
      batchSize?: number;
      afterId?: string;
    },
  ): Promise<
    Array<{
      id: string;
      externalId: string | null;
      status: string;
      receivedAt: Date;
      occurredAt: Date | null;
      /** How this delivery FIRST reached Loop. Written once, never rewritten. */
      firstIngestionSource: string | null;
      /** Every transport that has since confirmed it. A set, not a history. */
      observedSources: string[];
      payload: unknown;
    }>
  > {
    const take = options.batchSize && options.batchSize > 0 ? Math.min(options.batchSize, 1000) : 500;
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        provider: options.provider,
        OR: [
          { occurredAt: { gte: options.since, lt: options.until } },
          {
            occurredAt: null,
            receivedAt: { gte: options.legacySince, lt: options.legacyUntil },
          },
        ],
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        externalId: true,
        status: true,
        receivedAt: true,
        occurredAt: true,
        // Provenance travels with the row because the question "did the recovery
        // land" is answered by WHICH transport observed a call, not only by
        // whether some row exists. Two extra columns on a read that already runs.
        firstIngestionSource: true,
        observedSources: true,
        payload: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      status: String(r.status),
      receivedAt: r.receivedAt,
      occurredAt: r.occurredAt,
      firstIngestionSource: r.firstIngestionSource ?? null,
      observedSources: r.observedSources ?? [],
      payload: r.payload,
    }));
  }

  async listEventsReceivedBetween(
    organizationId: string,
    options: { provider: string; since: Date; until: Date; batchSize?: number; afterId?: string },
  ): Promise<Array<{ id: string; externalId: string | null; status: string; receivedAt: Date; payload: unknown }>> {
    const take = options.batchSize && options.batchSize > 0 ? Math.min(options.batchSize, 1000) : 500;
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        provider: options.provider,
        receivedAt: { gte: options.since, lt: options.until },
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, externalId: true, status: true, receivedAt: true, payload: true },
    });
    return rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      status: String(r.status),
      receivedAt: r.receivedAt,
      payload: r.payload as unknown,
    }));
  }

  async countEventsByStatus(
    organizationId: string,
  ): Promise<Record<string, number>> {
    const grouped = await this.prisma.integrationEvent.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) {
      counts[g.status] = g._count._all;
    }
    return counts;
  }
}
