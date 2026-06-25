// IntegrationRepository — Sprint 10 (Loop Intelligence Foundation).
//
// Persistence for the integration layer: ProviderConnection (how we connect to
// external sources) and IntegrationEvent (raw inbound payloads before
// normalization). Both are org-scoped, written through Prisma into Neon, never
// mocked. No real API calls happen here — this is the storage layer only.


import type {
  PrismaClient,
  ProviderConnection,
  IntegrationEvent,
} from '@prisma/client';


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
  category: string;  // 'ingestion' | 'analytics'
  provider: string;  // e.g. 'callgrid', 'ga4', 'google_ads'
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
    category: c.category,
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
    provider: e.provider,
    externalId: e.externalId ?? null,
    eventType: e.eventType ?? null,
    status: e.status,
    occurredAt: e.occurredAt?.toISOString() ?? null,
    receivedAt: e.receivedAt.toISOString(),
    errorMessage: e.processingErrors ?? null,
  };
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
        category: input.category as Parameters<typeof this.prisma.providerConnection.create>[0]['data']['category'],
        provider: input.provider,
        displayName: input.displayName ?? input.provider,
        status: 'PENDING',
        config: input.config ?? {},
      },
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
        ...(input.status !== undefined && {
          status: input.status as Parameters<typeof this.prisma.providerConnection.update>[0]['data']['status'],
        }),
        ...(input.config !== undefined && { config: input.config }),
        ...(input.connectedAt !== undefined && { connectedAt: input.connectedAt }),
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
        eventType: input.eventType,
        status: (input.status ?? 'RECEIVED') as Parameters<typeof this.prisma.integrationEvent.create>[0]['data']['status'],
        occurredAt: input.occurredAt,
        payload: input.payload ?? {},
        processingErrors: input.processingErrors,
        metadata: input.metadata ?? {},
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
        ...(processingErrors !== undefined && { processingErrors }),
      },
    });
    return toEventView(row);
  }

  async listRecentEvents(
    organizationId: string,
    options: { provider?: string; status?: string; limit?: number } = {},
  ): Promise<IntegrationEventView[]> {
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        ...(options.provider && { provider: options.provider }),
        ...(options.status && {
          status: options.status as Parameters<typeof this.prisma.integrationEvent.findMany>[0]['where'] extends { status?: infer S } ? S : never,
        }),
      },
      orderBy: { receivedAt: 'desc' },
      take: options.limit ?? 50,
    });
    return rows.map(toEventView);
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
