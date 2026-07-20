// DomainEventRepository — Sprint 4 (Real Data Layer).
//
// Domain events are the platform's INTERNAL, append-only fact log:
// "customer.created", "interaction.assigned", "booking.created",
// "booking.confirmed", etc. They are the seed of the future event bus
// (see docs/EVENT_BUS.md) and are deliberately distinct from IntegrationEvent,
// which records EXTERNAL provider webhooks.
//
// Backed by the DomainEvent model added to the Prisma schema in Sprint 4.

import type { PrismaClient, DomainEvent } from '@prisma/client';
import type { CreateDomainEventInput } from './types';

export class DomainEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Append a domain event. Events are immutable once written. */
  emit(input: CreateDomainEventInput): Promise<DomainEvent> {
    return this.prisma.domainEvent.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        aggregateType: input.aggregateType ?? null,
        aggregateId: input.aggregateId ?? null,
        payload: (input.payload ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  listForOrganization(
    organizationId: string,
    take = 50,
  ): Promise<DomainEvent[]> {
    return this.prisma.domainEvent.findMany({
      where: { organizationId },
      orderBy: { occurredAt: 'desc' },
      take,
    });
  }

  listByName(organizationId: string, name: string): Promise<DomainEvent[]> {
    return this.prisma.domainEvent.findMany({
      where: { organizationId, name },
      orderBy: { occurredAt: 'desc' },
    });
  }

  /**
   * Count org-scoped domain events in a half-open window `[since, until)`.
   * A COUNT only — never hydrates rows — so it feeds the Executive Brain's Loop
   * Activity sensor cheaply. `mostRecentAt` lets the sensor judge freshness.
   */
  async windowActivity(
    organizationId: string,
    since: Date,
    until: Date,
  ): Promise<{ events: number; mostRecentAt: Date | null }> {
    const window = { organizationId, occurredAt: { gte: since, lt: until } };
    const [events, latest] = await Promise.all([
      this.prisma.domainEvent.count({ where: window }),
      this.prisma.domainEvent.findFirst({
        where: window,
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
    ]);
    return { events, mostRecentAt: latest?.occurredAt ?? null };
  }
}
