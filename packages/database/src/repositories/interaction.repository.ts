// InteractionRepository — Sprint 4 (Real Data Layer).
//
// Interaction is the canonical customer-timeline spine. Rich detail (body,
// actor, external ids) lives in the JSON `payload`/`metadata` columns, since
// the schema interaction has no first-class `body` column.

import type { PrismaClient, Interaction } from '@prisma/client';
import type { CreateInteractionInput } from './types';

export class InteractionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: CreateInteractionInput): Promise<Interaction> {
    return this.prisma.interaction.create({
      data: {
        organizationId: input.organizationId,
        customerId: input.customerId ?? null,
        conversationId: input.conversationId ?? null,
        channel: input.channel,
        kind: input.kind,
        direction: input.direction,
        summary: input.summary ?? null,
        provider: input.provider ?? null,
        externalId: input.externalId ?? null,
        payload: (input.payload ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      },
    });
  }

  /** Most recent interactions across an org — powers the dashboard feed. */
  recentForOrganization(
    organizationId: string,
    take = 8,
  ): Promise<Interaction[]> {
    return this.prisma.interaction.findMany({
      where: { organizationId },
      orderBy: { occurredAt: 'desc' },
      take,
    });
  }

  /**
   * PHONE interactions in a window — the middle link of the CallGrid pipeline.
   *
   * Reconciliation uses it to locate where records stop: source > 0 with
   * interactions 0 means ingestion never landed; interactions > 0 with
   * projection 0 means the projection is the gap.
   */
  async countPhoneInWindow(organizationId: string, since: Date, until: Date): Promise<number> {
    return this.prisma.interaction.count({
      where: { organizationId, channel: 'PHONE', occurredAt: { gte: since, lt: until } },
    });
  }
}
