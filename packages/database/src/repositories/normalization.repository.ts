// NormalizationEngine — Sprint 10 (Loop Intelligence Foundation).
//
// Converts raw IntegrationEvent payloads into Loop-native primitives:
// Interaction, Signal, and DomainEvent. Every external source routes through
// this engine. No vendor-specific logic lives here — the engine receives a
// NormalizedEvent (already mapped by the provider adapter) and writes the
// three primitives through the existing repository layer into Neon.
//
// Idempotency: externalId on Interaction prevents duplicate records
// if the same event is replayed.
//
// Sprint 14 (Website Intelligence) extends the lookup tables below with the
// web.* event family so EMG-owned website activity becomes Interactions,
// Signals, and DomainEvents through this SAME engine — the Brain's second
// sense, with no new architecture. These are additive table entries only.

import type { PrismaClient } from '@prisma/client';
import {
  ChannelType,
  InteractionDirection,
  InteractionKind,
  SignalType,
} from '@prisma/client';
import type { NormalizedEvent, LoopEventType } from '@emgloop/shared';
import type { WorkflowsRepository } from './workflows.repository';

export interface NormalizationResult {
  interactionId: string | null;
  signalIds: string[];
  domainEventId: string | null;
  wasIdempotent: boolean;
}

const EVENT_CHANNEL: Partial<Record<LoopEventType, ChannelType>> = {
  'call.inbound': ChannelType.PHONE,
  'call.outbound': ChannelType.PHONE,
  'call.answered': ChannelType.PHONE,
  'call.missed': ChannelType.PHONE,
  'call.completed': ChannelType.PHONE,
  'call.voicemail': ChannelType.PHONE,
  'call.transferred': ChannelType.PHONE,
  'sms.inbound': ChannelType.SMS,
  'sms.outbound': ChannelType.SMS,
  'email.sent': ChannelType.EMAIL,
  'email.delivered': ChannelType.EMAIL,
  'email.opened': ChannelType.EMAIL,
  'email.clicked': ChannelType.EMAIL,
  'email.bounced': ChannelType.EMAIL,
  'email.unsubscribed': ChannelType.EMAIL,
  'ai.conversation_start': ChannelType.WEB_CHAT,
  'ai.conversation_end': ChannelType.WEB_CHAT,
  'ai.escalation': ChannelType.WEB_CHAT,
  'ads.lead_form_submit': ChannelType.SOCIAL,
  // Sprint 14 — website events. Chat maps to WEB_CHAT; everything else OTHER
  // (website is its own channel and is disambiguated by eventType in metadata).
  'web.chat_start': ChannelType.WEB_CHAT,
  'web.chat_complete': ChannelType.WEB_CHAT,
  'web.session_start': ChannelType.OTHER,
  'web.session_end': ChannelType.OTHER,
  'web.page_view': ChannelType.OTHER,
  'web.guide_view': ChannelType.OTHER,
  'web.search': ChannelType.OTHER,
  'web.search_zip': ChannelType.OTHER,
  'web.search_city': ChannelType.OTHER,
  'web.search_category': ChannelType.OTHER,
  'web.cta_click': ChannelType.OTHER,
  'web.phone_click': ChannelType.OTHER,
  'web.email_click': ChannelType.OTHER,
  'web.external_link': ChannelType.OTHER,
  'web.affiliate_click': ChannelType.OTHER,
  'web.form_start': ChannelType.OTHER,
  'web.form_submit': ChannelType.OTHER,
  'web.appointment_request': ChannelType.OTHER,
  'web.newsletter_signup': ChannelType.OTHER,
  'web.download': ChannelType.OTHER,
  'web.quiz_start': ChannelType.OTHER,
  'web.quiz_complete': ChannelType.OTHER,
  'web.planner_start': ChannelType.OTHER,
  'web.planner_save': ChannelType.OTHER,
  'web.planner_print': ChannelType.OTHER,
  'web.video_play': ChannelType.OTHER,
  'web.error': ChannelType.OTHER,
  'web.goal_conversion': ChannelType.OTHER,
};

const EVENT_KIND: Partial<Record<LoopEventType, InteractionKind>> = {
  'call.inbound': InteractionKind.PHONE_CALL,
  'call.outbound': InteractionKind.PHONE_CALL,
  'call.answered': InteractionKind.PHONE_CALL,
  'call.missed': InteractionKind.PHONE_CALL,
  'call.completed': InteractionKind.PHONE_CALL,
  'call.voicemail': InteractionKind.PHONE_CALL,
  'call.transferred': InteractionKind.PHONE_CALL,
  'sms.inbound': InteractionKind.SMS,
  'sms.outbound': InteractionKind.SMS,
  'email.sent': InteractionKind.EMAIL,
  'email.delivered': InteractionKind.EMAIL,
  'email.opened': InteractionKind.EMAIL,
  'email.clicked': InteractionKind.EMAIL,
  'email.bounced': InteractionKind.EMAIL,
  'email.unsubscribed': InteractionKind.EMAIL,
  'ai.conversation_start': InteractionKind.CHAT,
  'ai.conversation_end': InteractionKind.CHAT,
  'ai.escalation': InteractionKind.CHAT,
  'ads.lead_form_submit': InteractionKind.FORM_SUBMISSION,
  // Sprint 14 — website events to the closest existing InteractionKind.
  'web.chat_start': InteractionKind.CHAT,
  'web.chat_complete': InteractionKind.CHAT,
  'web.form_start': InteractionKind.FORM_SUBMISSION,
  'web.form_submit': InteractionKind.FORM_SUBMISSION,
  'web.newsletter_signup': InteractionKind.FORM_SUBMISSION,
  'web.appointment_request': InteractionKind.APPOINTMENT,
  'web.session_start': InteractionKind.OTHER,
  'web.session_end': InteractionKind.OTHER,
  'web.page_view': InteractionKind.OTHER,
  'web.guide_view': InteractionKind.OTHER,
  'web.search': InteractionKind.OTHER,
  'web.search_zip': InteractionKind.OTHER,
  'web.search_city': InteractionKind.OTHER,
  'web.search_category': InteractionKind.OTHER,
  'web.cta_click': InteractionKind.OTHER,
  'web.phone_click': InteractionKind.OTHER,
  'web.email_click': InteractionKind.OTHER,
  'web.external_link': InteractionKind.OTHER,
  'web.affiliate_click': InteractionKind.OTHER,
  'web.download': InteractionKind.OTHER,
  'web.quiz_start': InteractionKind.OTHER,
  'web.quiz_complete': InteractionKind.OTHER,
  'web.planner_start': InteractionKind.OTHER,
  'web.planner_save': InteractionKind.OTHER,
  'web.planner_print': InteractionKind.OTHER,
  'web.video_play': InteractionKind.OTHER,
  'web.error': InteractionKind.OTHER,
  'web.goal_conversion': InteractionKind.OTHER,
};

const EVENT_DIRECTION: Partial<Record<LoopEventType, InteractionDirection>> = {
  'call.inbound': InteractionDirection.INBOUND,
  'call.outbound': InteractionDirection.OUTBOUND,
  'call.missed': InteractionDirection.INBOUND,
  'call.completed': InteractionDirection.INBOUND,
  'sms.inbound': InteractionDirection.INBOUND,
  'sms.outbound': InteractionDirection.OUTBOUND,
  'email.sent': InteractionDirection.OUTBOUND,
  'email.delivered': InteractionDirection.OUTBOUND,
  'email.opened': InteractionDirection.INBOUND,
  'ai.conversation_start': InteractionDirection.INBOUND,
  'ai.conversation_end': InteractionDirection.INBOUND,
  'ads.lead_form_submit': InteractionDirection.INBOUND,
  // Sprint 14 — all website activity is the customer reaching in: INBOUND.
};

// Website events that should become a first-class Interaction on the timeline.
// High-signal touchpoints only — low-level page views and session lifecycle are
// captured as IntegrationEvents/Signals but do not flood the timeline. This
// keeps the customer dossier readable while the Brain still sees everything.
const WEB_INTERACTION_EVENTS = new Set<LoopEventType>([
  'web.guide_view',
  'web.search', 'web.search_zip', 'web.search_city', 'web.search_category',
  'web.cta_click', 'web.phone_click', 'web.email_click',
  'web.form_start', 'web.form_submit', 'web.appointment_request', 'web.newsletter_signup',
  'web.chat_start', 'web.chat_complete',
  'web.download', 'web.quiz_complete',
  'web.planner_save', 'web.affiliate_click', 'web.goal_conversion',
]);

const INTERACTION_EVENTS = new Set<LoopEventType>([
  'call.inbound', 'call.outbound', 'call.answered', 'call.missed', 'call.completed',
  'call.voicemail', 'call.transferred',
  'sms.inbound', 'sms.outbound',
  'email.sent', 'email.delivered', 'email.opened', 'email.clicked',
  'email.bounced', 'email.unsubscribed',
  'ai.conversation_start', 'ai.conversation_end', 'ai.escalation',
  'ads.lead_form_submit',
  ...WEB_INTERACTION_EVENTS,
]);

const SIGNAL_MAP: Partial<Record<LoopEventType, SignalType>> = {
  'call.inbound': SignalType.INTENT,
  'ads.lead_form_submit': SignalType.INTENT,
  'web.form_submit': SignalType.INTENT,
  'ai.intent_detected': SignalType.INTENT,
  'ai.escalation': SignalType.SENTIMENT,
  'call.missed': SignalType.CHURN_RISK,
  'email.unsubscribed': SignalType.CHURN_RISK,
  'call.completed': SignalType.CUSTOM,
  'ai.conversation_end': SignalType.CUSTOM,
  // Sprint 14 — website intent signals.
  'web.appointment_request': SignalType.INTENT,
  'web.phone_click': SignalType.INTENT,
  'web.cta_click': SignalType.INTENT,
  'web.search': SignalType.INTENT,
  'web.guide_view': SignalType.TOPIC,
  'web.download': SignalType.INTENT,
  'web.newsletter_signup': SignalType.UPSELL_OPPORTUNITY,
  'web.error': SignalType.CHURN_RISK,
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

    // 1. Create Interaction (idempotent by externalId)
    if (INTERACTION_EVENTS.has(event.eventType)) {
      const channel = EVENT_CHANNEL[event.eventType] ?? ChannelType.OTHER;
      const kind = EVENT_KIND[event.eventType] ?? InteractionKind.NOTE;
      const direction = EVENT_DIRECTION[event.eventType] ?? InteractionDirection.INBOUND;

      const existing = await this.prisma.interaction.findFirst({
        where: {
          organizationId: event.organizationId,
          externalId: event.externalId,
          provider: event.source,
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
            kind,
            direction,
            summary: event.summary,
            provider: event.source,
            externalId: event.externalId,
            occurredAt: event.occurredAt,
            metadata: {
              eventType: event.eventType,
              durationSeconds: event.durationSeconds,
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
