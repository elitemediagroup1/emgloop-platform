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

import type { PrismaClient, Interaction, Signal } from '@prisma/client';

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

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export class NextBestActionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Compute the ranked recommendations for a context. Pure function over the
   * inputs — no DB reads — so it is easy to test and reason about.
   */
  recommend(ctx: NextBestActionContext): NextBestAction[] {
    const actions: NextBestAction[] = [];
    const signalKeys = new Set(ctx.signals.map((s) => s.key));
    const meta = asObject(ctx.interaction.metadata);
    const eventType = typeof meta['eventType'] === 'string' ? meta['eventType'] : '';

    // Rule 1 — a missed inbound call is the highest-urgency operational event.
    if (eventType === 'call.missed' || ctx.interaction.summary?.toLowerCase().includes('missed')) {
      actions.push({
        kind: 'create_follow_up',
        priority: 1,
        title: 'Call back missed caller',
        detail: 'An inbound call was missed. Return the call promptly to avoid losing the lead.',
        hint: { channel: 'phone', dueWithinMinutes: 15 },
      });
      actions.push({
        kind: 'recommend_workflow',
        priority: 2,
        title: 'Run missed-call recovery workflow',
        detail: 'Trigger the missed-call follow-up automation to tag and queue the customer.',
        hint: { eventName: 'integration.call.missed' },
      });
    }

    // Rule 2 — emergency intent should be assigned to a human immediately.
    if (signalKeys.has('emergency_intent')) {
      actions.push({
        kind: 'assign_human',
        priority: 1,
        title: 'Assign to a human agent (emergency)',
        detail: 'Emergency intent detected. Route to a human dispatcher for immediate handling.',
        hint: { reason: 'emergency_intent' },
      });
    }

    // Rule 3 — a new inbound contact with no owner gets an AI Employee first-touch.
    if (
      (ctx.interaction.direction === 'INBOUND') &&
      !signalKeys.has('emergency_intent')
    ) {
      actions.push({
        kind: 'assign_ai_employee',
        priority: 3,
        title: 'Assign default AI Employee for first response',
        detail: 'Let the default AI Employee acknowledge and qualify this new inbound contact.',
        hint: { reason: 'first_touch' },
      });
    }

    // Rule 4 — phone-preferring customers should be reached by phone.
    if (signalKeys.has('phone_preference') || ctx.interaction.channel === 'PHONE') {
      actions.push({
        kind: 'recommend_channel',
        priority: 4,
        title: 'Prefer phone for outreach',
        detail: 'This customer engages by phone. Use a call for the next outreach attempt.',
        hint: { channel: 'phone' },
      });
    }

    // Rule 5 — service interest without a booking is an operational follow-up.
    if (signalKeys.has('service_interest') && !signalKeys.has('booking_created')) {
      actions.push({
        kind: 'operational_recommendation',
        priority: 3,
        title: 'Send a quote / book the service',
        detail: 'Service interest is present but no booking exists. Provide a quote or schedule the job.',
        hint: { reason: 'service_interest_no_booking' },
      });
    }

    // Always provide at least one baseline action.
    if (actions.length === 0) {
      actions.push({
        kind: 'operational_recommendation',
        priority: 5,
        title: 'Review interaction',
        detail: 'No urgent rule matched. Review the interaction and update the pipeline as needed.',
      });
    }

    return actions.sort((a, b) => a.priority - b.priority);
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
