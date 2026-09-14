// InteractionRepository — Sprint 4 (Real Data Layer).
//
// Interaction is the canonical customer-timeline spine. Rich detail (body,
// actor, external ids) lives in the JSON `payload`/`metadata` columns, since
// the schema interaction has no first-class `body` column.

import type { PrismaClient, Interaction } from '@prisma/client';
import type { CreateInteractionInput } from './types';

// ---------------------------------------------------------------------------
// Actor provenance
//
// Interaction has no actor column; the actor lives in `payload`. A person's note
// is written, and every interaction's actor is read back, only through these
// functions — so an actor can never be taken from a client, and a row that
// carries a client-claimed actor is never displayed as that actor.
// ---------------------------------------------------------------------------

/** The signed-in principal, resolved from the session. Never from a form. */
export interface AuthenticatedActor {
  userId: string;
  name: string;
  systemRole: string;
}

/** A machine principal is recorded as AI. Every other signed-in user is a person. */
function actorTypeForRole(systemRole: string): 'AI_AGENT' | 'HUMAN_AGENT' {
  return systemRole === 'AI_EMPLOYEE' ? 'AI_AGENT' : 'HUMAN_AGENT';
}

/** Payload for a CRM note. Actor type, id and name all come from the session. */
export function crmNotePayload(actor: AuthenticatedActor, body: string) {
  return {
    loopKind: 'crm_note',
    actorType: actorTypeForRole(actor.systemRole),
    actorUserId: actor.userId,
    actorName: actor.name,
    body,
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The actor type an interaction may be displayed with.
 *
 * Notes written by the CRM note form before its actor was server-derived carry
 * loopKind 'human_note' and no actorUserId, and their actorType is whatever the
 * submitter picked — including AI_AGENT or SYSTEM. That form was only reachable
 * by a signed-in user through the CRM, so the claim is discarded and the row is
 * shown as a person's note.
 */
export function interactionActorType(payload: unknown): string | undefined {
  const p = payloadRecord(payload);
  if (p.loopKind === 'human_note' && typeof p.actorUserId !== 'string') return 'HUMAN_AGENT';
  return typeof p.actorType === 'string' ? p.actorType : undefined;
}

/** The actor's recorded name, only when it was written with an authenticated user id. */
export function interactionActorName(payload: unknown): string | undefined {
  const p = payloadRecord(payload);
  return typeof p.actorUserId === 'string' && typeof p.actorName === 'string' ? p.actorName : undefined;
}

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
