import type { PrismaClient, LoopEvent } from '@prisma/client';
import type { CreateLoopEventInput, ListLoopEventsFilters } from './types';

// Loop Event Gateway — immutable event store repository.
//
// Stores raw inbound events from InMyCity producer sites. This repository only
// persists and reads events; it performs NO downstream processing (no Brain,
// Work OS, CRM, or Marketplace side effects).
export class LoopEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Persist a new raw event. Callers should deduplicate on eventId first; the
  // unique constraint on eventId is the backstop against races (P2002).
  async createLoopEvent(input: CreateLoopEventInput): Promise<LoopEvent> {
    return this.prisma.loopEvent.create({
      data: {
        eventId: input.eventId,
        platform: input.platform,
        site: input.site ?? null,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        anonymousId: input.anonymousId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        pageUrl: input.pageUrl ?? null,
        referrer: input.referrer ?? null,
        payload: (input.payload ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  // Look up an event by its producer-supplied eventId (dedupe key).
  async findLoopEventByEventId(eventId: string): Promise<LoopEvent | null> {
    return this.prisma.loopEvent.findUnique({ where: { eventId } });
  }

  // List stored events with optional filters, most recently received first.
  async listLoopEvents(filters: ListLoopEventsFilters = {}): Promise<LoopEvent[]> {
    const { platform, eventType, processed, anonymousId, userId, take, skip } = filters;
    return this.prisma.loopEvent.findMany({
      where: {
        ...(platform ? { platform } : {}),
        ...(eventType ? { eventType } : {}),
        ...(typeof processed === 'boolean' ? { processed } : {}),
        ...(anonymousId ? { anonymousId } : {}),
        ...(userId ? { userId } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: take ?? 100,
      skip: skip ?? 0,
    });
  }

  // Mark an event as processed by a given processing version. Note: this only
  // flips bookkeeping fields on the event row; it triggers no downstream work.
  async markLoopEventProcessed(id: string, version: string): Promise<LoopEvent> {
    return this.prisma.loopEvent.update({
      where: { id },
      data: { processed: true, processingVersion: version },
    });
  }
}
