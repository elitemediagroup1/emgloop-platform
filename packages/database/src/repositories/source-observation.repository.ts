// Content-free observations from background sources (Teams, Telegram): persistence + governed
// retention. This is where the worker's normalized ConversationEvents land, so the who/when signal
// survives for a future intelligence step -- minimized and governed, never a message mirror.
//
// EMPLOYEE-PRIVATE, ORG-FIRST. Reads take (organizationId, userId); there is no org-only read path.
// CONTENT-FREE BY SHAPE: the row has no column for text, subject, media or names, and this file only
// ever writes the allowlisted metadata keys of a ConversationEvent.
//
// IDEMPOTENT: append skips duplicates on (org, user, provider, providerEventId), so the worker can
// re-observe after a failure without duplicating -- which is what lets the cursor stay behind the
// sink. GOVERNED: purgeOlderThan enforces a retention horizon across all tenants (a minimization
// sweep the worker runs, not a tenant read).

import type { PrismaClient } from '@prisma/client';
import type { ConnectionProvider, ConversationEvent } from '@emgloop/shared';
import { assertConversationEventContentFree } from '@emgloop/shared';

export interface SourceObservationRow {
  readonly providerEventId: string;
  readonly conversationKey: string;
  readonly senderKey: string | null;
  readonly participantKeys: readonly string[];
  readonly direction: string;
  readonly hadText: boolean;
  readonly occurredAt: Date;
  readonly observedAt: Date;
}

export class SourceObservationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Append a batch of content-free observations for one connection, idempotently. Re-appending an
   * already-stored providerEventId is a no-op (skipDuplicates), so a re-observed batch never
   * duplicates. Returns how many rows were newly inserted.
   *
   * Each event is fenced as content-free before it is written: a shape that somehow carried content
   * is rejected here rather than persisted.
   */
  async append(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    events: readonly ConversationEvent[],
  ): Promise<{ inserted: number }> {
    if (events.length === 0) return { inserted: 0 };
    const data = events.map((e) => {
      assertConversationEventContentFree(e as unknown as Record<string, unknown>);
      return {
        organizationId,
        userId,
        provider,
        providerEventId: e.providerEventId,
        conversationKey: e.conversationKey,
        senderKey: e.senderKey,
        participantKeys: [...e.participantKeys],
        direction: e.direction,
        hadText: e.hadText,
        occurredAt: new Date(e.occurredAt),
        observedAt: new Date(e.observedAt),
      };
    });
    const result = await this.prisma.sourceObservation.createMany({ data, skipDuplicates: true });
    return { inserted: result.count };
  }

  /** This person's most recent observations for one provider, newest first. Metadata only. */
  async recent(organizationId: string, userId: string, provider: ConnectionProvider, limit = 100): Promise<SourceObservationRow[]> {
    const rows = await this.prisma.sourceObservation.findMany({
      where: { organizationId, userId, provider },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.max(1, Math.min(limit, 1000)),
      select: { providerEventId: true, conversationKey: true, senderKey: true, participantKeys: true, direction: true, hadText: true, occurredAt: true, observedAt: true },
    });
    return rows.map((r) => ({ ...r, senderKey: r.senderKey ?? null, participantKeys: [...r.participantKeys] }));
  }

  /**
   * This person's activity in one provider since a moment, as content-free COUNTS: how many messages
   * Loop observed, across how many conversations. The one read a personal domain summary needs. It
   * selects nothing but the conversation key it groups by; no event id, no sender, no text.
   */
  async activitySince(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    since: Date,
  ): Promise<{ readonly messages: number; readonly conversations: number }> {
    const where = { organizationId, userId, provider, occurredAt: { gte: since } };
    const [messages, grouped] = await Promise.all([
      this.prisma.sourceObservation.count({ where }),
      this.prisma.sourceObservation.groupBy({ by: ['conversationKey'], where }),
    ]);
    return { messages, conversations: grouped.length };
  }

  /**
   * RETENTION MINIMIZATION, ACROSS ALL TENANTS. Delete observations Loop observed before `cutoff`.
   * The worker runs this on a horizon so the store stays a recent-signal window, not an archive.
   * Cross-tenant by time on purpose -- it is a minimization sweep, not a tenant read.
   */
  async purgeOlderThan(cutoff: Date): Promise<{ purged: number }> {
    const result = await this.prisma.sourceObservation.deleteMany({ where: { observedAt: { lt: cutoff } } });
    return { purged: result.count };
  }
}
