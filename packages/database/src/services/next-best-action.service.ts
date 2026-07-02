// NextBestActionService — Sprint 11 (First Live Integration, Phase 7).
//
// Rules-based "what should happen next" engine. When a new interaction lands,
// this service inspects the interaction + the customer's accumulated signals and
// produces a ranked list of recommended operational actions. NO AI reasoning is
// used in this sprint — every recommendation comes from deterministic rules so
// the behaviour is auditable and provider-agnostic. A later sprint can layer LLM
// reasoning on top of this same contract without changing callers.
//
// Recommendations are advisory: the service persists them as append-only Signals
// (type CUSTOM, key "next_best_action") and a DomainEvent so they appear on the
// timeline and in analytics, but it never mutates customer state on its own.
//
// Sprint 14 (Website Intelligence): the customer's signal pool now also contains
// website-derived signals (appointment_intent, buying_intent, research_intent,
// ...). Because the rules read the SAME shared signal pool, cross-channel
// intelligence emerges without provider-specific branches.
//
// Phase 1 (Brain Boundary): the DECISION logic no longer lives here. It has moved
// into the Brain — the center of the platform — as the pure capability
// `recommendNextBestActions` in @emgloop/brain. This service now INVOKES the
// Brain and remains responsible only for data-layer concerns (reading signals,
// persisting the advisory Signal + DomainEvent). The Brain owns the decision; the
// data layer owns persistence. Public types and behaviour are unchanged, so all
// existing callers observe identical output.

import type { PrismaClient, Interaction, Signal } from '@prisma/client';
import { recommendNextBestActions, type NbaAction } from '@emgloop/brain';

export type NextBestActionKind =
  | 'assign_ai_employee'
  | 'assign_human'
  | 'create_follow_up'
  | 'recommend_workflow'
  | 'recommend_channel'
  | 'operational_recommendation';

export interface NextBestAction {
  kind: NextBestActionKind;
  priority: number; // 1 (highest) .. 5 (lowest)
  title: string;
  detail: string;
  // Optional machine hints for downstream automation (workflow name, channel...).
  hint?: Record<string, unknown>;
}

export interface NextBestActionContext {
  organizationId: string;
  customerId: string | null;
  interaction: Pick<Interaction, 'id' | 'channel' | 'kind' | 'direction' | 'summary' | 'occurredAt'> & {
    metadata?: Record<string, unknown>;
  };
  signals: Pick<Signal, 'type' | 'key' | 'label'>[];
}

export interface NextBestActionResult {
  actions: NextBestAction[];
  signalId: string | null;
  domainEventId: string | null;
}

export class NextBestActionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Compute the ranked recommendations for a context. The DECISION itself is
   * delegated to the Brain (`recommendNextBestActions`); this method only adapts
   * the data-layer context into the Brain's pure input shape and returns the
   * Brain's output. No DB reads happen here, so it remains easy to test.
   */
  recommend(ctx: NextBestActionContext): NextBestAction[] {
    const actions: NbaAction[] = recommendNextBestActions({
      interaction: {
        channel: ctx.interaction.channel ?? null,
        direction: ctx.interaction.direction ?? null,
        summary: ctx.interaction.summary ?? null,
        metadata: ctx.interaction.metadata,
      },
      signalKeys: ctx.signals.map((s) => s.key),
    });
    // NbaAction is structurally identical to NextBestAction (same kinds/fields).
    return actions as NextBestAction[];
  }

  /**
   * Compute recommendations and persist the top action as an append-only Signal
   * plus a DomainEvent, so it surfaces on the timeline and in analytics. Returns
   * the full ranked list along with the created ids. Persistence failures are
   * swallowed (advisory data must never break ingestion).
   */
  async run(ctx: NextBestActionContext): Promise<NextBestActionResult> {
    const actions = this.recommend(ctx);
    const top = actions[0];
    let signalId: string | null = null;
    let domainEventId: string | null = null;

    if (ctx.customerId && top) {
      try {
        const signal = await this.prisma.signal.create({
          data: {
            organizationId: ctx.organizationId,
            customerId: ctx.customerId,
            type: 'CUSTOM',
            key: 'next_best_action',
            label: top.title,
            source: 'next-best-action-service',
            metadata: {
              interactionId: ctx.interaction.id,
              topAction: top.kind,
              priority: top.priority,
              actions,
            } as object,
          },
        });
        signalId = signal.id;
      } catch {
        // advisory only
      }
    }

    try {
      const domainEvent = await this.prisma.domainEvent.create({
        data: {
          organizationId: ctx.organizationId,
          name: 'intelligence.next_best_action',
          aggregateType: ctx.customerId ? 'customer' : 'interaction',
          aggregateId: ctx.customerId ?? ctx.interaction.id,
          payload: {
            interactionId: ctx.interaction.id,
            actions,
          } as object,
        },
      });
      domainEventId = domainEvent.id;
    } catch {
      // advisory only
    }

    return { actions, signalId, domainEventId };
  }
}
