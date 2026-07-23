// MemoryEventRepository — durable memory (Loop Cognitive Architecture).
//
// WHAT HAPPENED, as immutable historical fact. The repository deliberately
// exposes NO method that mutates eventType, payload, occurredAt, context, or
// the identity references — that immutability is the whole point of durable
// memory. The only permitted post-creation write is advancing processingStatus,
// which is pipeline metadata, not the recorded fact.
//
// Idempotency is enforced by the (organizationId, sourceSystem, sourceEventId)
// unique constraint: the same provider event, redelivered, resolves to the same
// row rather than a duplicate. The unique key is org-scoped, so two tenants may
// legitimately use the same sourceEventId without collision.

import type {
  PrismaClient,
  MemoryEvent,
  MemoryEventType,
  MemoryProcessingStatus,
  DataSensitivity,
  ConsentBasis,
  DataPurpose,
  Prisma,
} from '@prisma/client';

const MAX_TAKE = 200;

export interface AppendMemoryInput {
  eventType: MemoryEventType;
  occurredAt: Date;
  sourceSystem: string;
  sourceEventId: string;
  actorIdentityId?: string | null;
  subjectIdentityId?: string | null;
  objectIdentityId?: string | null;
  channel?: string | null;
  context?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  sensitivity?: DataSensitivity;
  consentBasis?: ConsentBasis;
  permittedPurposes?: DataPurpose[];
  retentionPolicy?: string | null;
  aggregationEligibility?: boolean;
}

export class MemoryEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Idempotency probe — the row for a given provider event, or null. */
  findBySource(
    organizationId: string,
    sourceSystem: string,
    sourceEventId: string,
  ): Promise<MemoryEvent | null> {
    return this.prisma.memoryEvent.findFirst({
      where: { organizationId, sourceSystem, sourceEventId },
    });
  }

  findById(organizationId: string, id: string): Promise<MemoryEvent | null> {
    return this.prisma.memoryEvent.findFirst({ where: { id, organizationId } });
  }

  /**
   * Append a durable memory event. If the (org, sourceSystem, sourceEventId)
   * tuple already exists, returns the existing row instead of creating a
   * duplicate — the persistence-layer half of processor idempotency.
   */
  async append(organizationId: string, input: AppendMemoryInput): Promise<MemoryEvent> {
    const existing = await this.findBySource(
      organizationId,
      input.sourceSystem,
      input.sourceEventId,
    );
    if (existing) return existing;
    return this.prisma.memoryEvent.create({
      data: {
        organizationId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        sourceSystem: input.sourceSystem,
        sourceEventId: input.sourceEventId,
        actorIdentityId: input.actorIdentityId ?? null,
        subjectIdentityId: input.subjectIdentityId ?? null,
        objectIdentityId: input.objectIdentityId ?? null,
        channel: input.channel ?? null,
        context: (input.context ?? {}) as Prisma.InputJsonValue,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        sensitivity: input.sensitivity ?? 'INTERNAL',
        consentBasis: input.consentBasis ?? 'NONE',
        permittedPurposes: input.permittedPurposes ?? [],
        retentionPolicy: input.retentionPolicy ?? null,
        aggregationEligibility: input.aggregationEligibility ?? false,
        processingStatus: 'RECEIVED',
      },
    });
  }

  /** Advance pipeline status. The ONLY permitted post-creation mutation. */
  async setProcessingStatus(
    organizationId: string,
    id: string,
    status: MemoryProcessingStatus,
  ): Promise<MemoryEvent | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.memoryEvent.update({
      where: { id: found.id },
      data: { processingStatus: status },
    });
  }

  /** Bounded, indexed recent-history read for a subject identity. */
  recentForSubject(
    organizationId: string,
    subjectIdentityId: string,
    opts: { take?: number; eventType?: MemoryEventType } = {},
  ): Promise<MemoryEvent[]> {
    return this.prisma.memoryEvent.findMany({
      where: {
        organizationId,
        subjectIdentityId,
        ...(opts.eventType ? { eventType: opts.eventType } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(MAX_TAKE, Math.max(1, opts.take ?? 50)),
    });
  }
}
