// NormalizationEngine — Sprint 10 (Loop Intelligence Foundation).
//
// Converts raw IntegrationEvent payloads into Loop-native primitives:
// Interaction, Signal, and DomainEvent. Every external source routes through
// this engine. No vendor-specific logic lives here — the engine receives a
// NormalizedEvent (already mapped by the provider adapter) and writes the
// three primitives through the existing repository layer into Neon.
//
// Idempotency: externalId in Interaction metadata prevents duplicate records
// if the same event is replayed.


import type { PrismaClient } from '@prisma/client';
import { ChannelType, InteractionDirection, SignalType } from '@prisma/client';
import type { NormalizedEvent, LoopEventType } from '@emgloop/shared';
import type { WorkflowsRepository } from './workflows.repository';


export interface NormalizationResult {
  interactionId: string | null;
  signalIds: string[];
  domainEventId: string | null;
  wasIdempotent: boolean;
}


const EVENT_CHANNEL: Partial<Record<LoopEventType, ChannelType>> = {
  'call.inbound':          ChannelType.PHONE,
  'call.outbound':         ChannelType.PHONE,
  'call.answered':         ChannelType.PHONE,
  'call.missed':           ChannelType.PHONE,
  'call.completed':        ChannelType.PHONE,
  'call.voicemail':        ChannelType.PHONE,
  'call.transferred':      ChannelType.PHONE,
  'sms.inbound':           ChannelType.SMS,
  'sms.outbound':          ChannelType.SMS,
  'email.sent':            ChannelType.EMAIL,
  'email.delivered':       ChannelType.EMAIL,
  'email.opened':          ChannelType.EMAIL,
  'email.clicked':         ChannelType.EMAIL,
  'email.bounced':         ChannelType.EMAIL,
  'email.unsubscribed':    ChannelType.EMAIL,
  'ai.conversation_start': ChannelType.WEB_CHAT,
  'ai.conversation_end':   ChannelType.WEB_CHAT,
  'ai.escalation':         ChannelType.WEB_CHAT,
  'ads.lead_form_submit':  ChannelType.SOCIAL,
};

const EVENT_DIRECTION: Partial<Record<LoopEventType, InteractionDirection>> = {
  'call.inbound':          InteractionDirection.INBOUND,
  'call.outbound':         InteractionDirection.OUTBOUND,
  'call.missed':           InteractionDirection.INBOUND,
  'call.completed':        InteractionDirection.INBOUND,
  'sms.inbound':           InteractionDirection.INBOUND,
  'sms.outbound':          InteractionDirection.OUTBOUND,
  'email.sent':            InteractionDirection.OUTBOUND,
  'email.delivered':       InteractionDirection.OUTBOUND,
  'email.opened':          InteractionDirection.INBOUND,
  'ai.conversation_start': InteractionDirection.INBOUND,
  'ai.conversation_end':   InteractionDirection.INBOUND,
  'ads.lead_form_submit':  InteractionDirection.INBOUND,
};

const INTERACTION_EVENTS = new Set<LoopEventType>([
  'call.inbound', 'call.outbound', 'call.answered', 'call.missed', 'call.completed',
  'call.voicemail', 'call.transferred',
  'sms.inbound', 'sms.outbound',
  'email.sent', 'email.delivered', 'email.opened', 'email.clicked',
  'email.bounced', 'email.unsubscribed',
  'ai.conversation_start', 'ai.conversation_end', 'ai.escalation',
  'ads.lead_form_submit',
]);

const SIGNAL_MAP: Partial<Record<LoopEventType, SignalType>> = {
  'call.inbound':         SignalType.INTENT,
  'ads.lead_form_submit': SignalType.INTENT,
  'web.form_submit':      SignalType.INTENT,
  'ai.intent_detected':   SignalType.INTENT,
  'ai.escalation':        SignalType.SENTIMENT,
  'call.missed':          SignalType.CHURN_RISK,
  'email.unsubscribed':   SignalType.CHURN_RISK,
  'call.completed':       SignalType.RESPONSE_TIME,
  'ai.conversation_end':  SignalType.RESPONSE_TIME,
};


export class NormalizationEngine {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workflows: WorkflowsRepository,
  ) {}

  async normalize(event: NormalizedEvent): Promise<NormalizationResult> {
    const result: NormalizationResult = {
      interactionId: null,
      signalIds: [],
      domainEventId: null,
      wasIdempotent: false,
    };

    // Resolve customer from email/phone if not directly provided
    let customerId: string | null = event.customerId ?? null;
    if (!customerId && (event.customerEmail || event.customerPhone)) {
      const customer = await this.prisma.customer.findFirst({
        where: {
          organizationId: event.organizationId,
          OR: [
            ...(event.customerEmail ? [{ email: event.customerEmail }] : []),
            ...(event.customerPhone ? [{ phone: event.customerPhone }] : []),
          ],
        },
      });
      if (customer) customerId = customer.id;
    }

    // 1. Create Interaction (idempotent by externalId in metadata)
    if (INTERACTION_EVENTS.has(event.eventType)) {
      const channel = EVENT_CHANNEL[event.eventType] ?? ChannelType.OTHER;
      const direction = EVENT_DIRECTION[event.eventType] ?? InteractionDirection.INBOUND;

      const existing = await this.prisma.interaction.findFirst({
        where: {
          organizationId: event.organizationId,
          metadata: { path: ['externalId'], equals: event.externalId },
        },
      });

      if (existing) {
        result.interactionId = existing.id;
        result.wasIdempotent = true;
      } else {
        const interaction = await this.prisma.interaction.create({
          data: {
            organizationId: event.organizationId,
            customerId: customerId ?? undefined,
            channel,
            direction,
            startedAt: event.occurredAt,
            durationSeconds: event.durationSeconds,
            summary: event.summary,
            metadata: {
              source: event.source,
              externalId: event.externalId,
              eventType: event.eventType,
              ...event.metadata,
            },
          },
        });
        result.interactionId = interaction.id;
      }
    }

    // 2. Create Signal (if event maps to a signal type)
    const signalType = SIGNAL_MAP[event.eventType];
    if (signalType && !result.wasIdempotent) {
      const signal = await this.prisma.signal.create({
        data: {
          organizationId: event.organizationId,
          customerId: customerId ?? undefined,
          type: signalType,
          key: event.eventType,
          source: event.source,
          valueNumber: 1,
          metadata: {
            source: event.source,
            externalId: event.externalId,
            eventType: event.eventType,
            interactionId: result.interactionId,
            ...event.metadata,
          },
        },
      });
      result.signalIds.push(signal.id);
    }

    // 3. Create DomainEvent and fire workflow trigger
    if (!result.wasIdempotent) {
      const domainEventName = 'integration.' + event.eventType;
      const domainEvent = await this.prisma.domainEvent.create({
        data: {
          organizationId: event.organizationId,
          name: domainEventName,
          payload: {
            source: event.source,
            externalId: event.externalId,
            eventType: event.eventType,
            customerId,
            interactionId: result.interactionId,
            signalIds: result.signalIds,
            ...event.metadata,
          },
        },
      });
      result.domainEventId = domainEvent.id;

      // Fire any EVENT-triggered workflows
      try {
        await this.workflows.runWorkflowsForEvent({
          organizationId: event.organizationId,
          eventName: domainEventName,
          context: { customerId: customerId ?? undefined },
          triggeredBy: 'normalization-engine',
        });
      } catch {
        // Workflow failures are isolated — normalization always succeeds
      }
    }

    return result;
  }
}
