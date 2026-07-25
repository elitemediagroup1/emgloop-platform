// LoopEventConsumer — reuses the EXISTING LoopEvent ingress seam.
//
// The public ingress is unchanged: producers still POST to /api/v1/events, which
// authenticates (LOOP_EVENT_SECRET) and stores raw LoopEvents with processed=false.
// This consumer is the missing half the gateway was built for — it drains
// unprocessed LoopEvents, maps each (provider adapter, below) into a canonical
// ProcessEventInput, runs it through the CognitiveEventProcessor, and only then
// flips the row's `processed` flag (via the previously zero-caller
// markLoopEventProcessed). NO new public receiver, NO parallel event store.
//
// Tenancy: the organization is resolved from LoopEvent.platform via an INJECTED
// server-side resolver — never taken from the event body. If the platform does
// not resolve to an org, the event is skipped (not processed cross-tenant).

import type { LoopEvent, PrismaClient, MemoryEventType, DataPurpose } from '@prisma/client';
import { LoopEventRepository } from '../../repositories/loop-event.repository';
import type { CognitiveEventProcessor } from './cognitive-event-processor';
import type { IdentityDescriptor, ProcessEventInput } from './types';

// ---- Provider adapter (pure): LoopEvent dotted type -> MemoryEventType -------

function mapEventType(loopType: string, payload: Record<string, unknown>): MemoryEventType {
  const hasProduct = typeof payload['productId'] === 'string' || typeof payload['product'] === 'string';
  switch (loopType) {
    case 'web.page_view':
    case 'web.guide_view':
      return 'PAGE_VIEWED';
    case 'web.search':
    case 'web.search_zip':
    case 'web.search_city':
    case 'web.search_category':
      return 'SEARCH_PERFORMED';
    case 'web.cta_click':
    case 'web.affiliate_click':
    case 'web.external_link':
      return hasProduct ? 'PRODUCT_CLICKED' : 'LINK_CLICKED';
    case 'web.form_submit':
      return 'FORM_SUBMITTED';
    case 'web.appointment_request':
      return 'APPOINTMENT_REQUESTED';
    case 'call.inbound':
    case 'call.outbound':
      return 'CALL_STARTED';
    case 'call.completed':
      return 'CALL_COMPLETED';
    case 'sms.inbound':
      return 'SMS_RECEIVED';
    case 'sms.outbound':
      return 'SMS_SENT';
    case 'email.sent':
    case 'email.delivered':
      return 'EMAIL_SENT';
    case 'payment.succeeded':
      return 'PURCHASE_COMPLETED';
    default:
      return 'OTHER';
  }
}

function channelFor(loopType: string): string | null {
  const prefix = loopType.split('.')[0];
  switch (prefix) {
    case 'web':
    case 'ads':
    case 'search':
      return 'web';
    case 'call':
      return 'phone';
    case 'sms':
      return 'sms';
    case 'email':
      return 'email';
    default:
      return prefix ?? null;
  }
}

function purposesFor(eventType: MemoryEventType): DataPurpose[] {
  if (eventType === 'CONSENT_CHANGED') return ['SERVICE_DELIVERY'];
  if (eventType === 'CAMPAIGN_STATUS_CHANGED' || eventType === 'WORK_STEP_COMPLETED') return ['OPERATIONS'];
  return ['PERSONALIZATION'];
}

/**
 * Map a stored LoopEvent to a processor input for a resolved org. The subject is
 * derived from the producer's user/session identifiers as a PSEUDONYMOUS key or
 * session — never authenticated as one of our cognitive identities directly.
 */
export function adaptLoopEvent(loopEvent: LoopEvent, organizationId: string): ProcessEventInput {
  const payload = (loopEvent.payload ?? {}) as Record<string, unknown>;
  const eventType = mapEventType(loopEvent.eventType, payload);
  const subject: IdentityDescriptor = {
    entityType: 'PERSON',
    ...(loopEvent.userId ? { canonicalKey: `user:${loopEvent.userId}` } : {}),
    ...(loopEvent.sessionId ? { sessionId: loopEvent.sessionId } : {}),
    ...(!loopEvent.userId && !loopEvent.sessionId && loopEvent.anonymousId
      ? { canonicalKey: `anon:${loopEvent.anonymousId}` }
      : {}),
    roleType: loopEvent.userId ? 'KNOWN_VISITOR' : 'ANONYMOUS_VISITOR',
  };
  return {
    organizationId,
    sourceSystem: 'loop-event',
    sourceEventId: loopEvent.eventId,
    eventType,
    occurredAt: loopEvent.occurredAt,
    channel: channelFor(loopEvent.eventType),
    subject,
    payload,
    context: { loopEventId: loopEvent.id, platform: loopEvent.platform, loopEventType: loopEvent.eventType },
    requestedPurposes: purposesFor(eventType),
  };
}

// ---- Consumer --------------------------------------------------------------

export interface LoopEventConsumerOptions {
  /** Server-side platform -> organizationId resolver. NEVER from the event body. */
  resolveOrganizationId: (platform: string) => Promise<string | null>;
  processingVersion?: string;
}

export interface DrainResult {
  seen: number;
  processed: number;
  skipped: number;
  failed: number;
}

export class LoopEventConsumer {
  private readonly loopEvents: LoopEventRepository;
  private readonly processingVersion: string;

  constructor(
    prisma: PrismaClient,
    private readonly processor: CognitiveEventProcessor,
    private readonly options: LoopEventConsumerOptions,
  ) {
    this.loopEvents = new LoopEventRepository(prisma);
    this.processingVersion = options.processingVersion ?? 'cognitive.v1';
  }

  /**
   * Drain a batch of unprocessed LoopEvents through the processor. A row is
   * marked processed ONLY when the processor durably accepted it (accepted=true,
   * including a governed-off event). A non-accepted (failed) event is left
   * unprocessed so the next drain retries it.
   */
  async drain(opts: { platform?: string; take?: number } = {}): Promise<DrainResult> {
    const events = await this.loopEvents.listLoopEvents({
      processed: false,
      ...(opts.platform ? { platform: opts.platform } : {}),
      take: opts.take ?? 100,
    });
    const result: DrainResult = { seen: events.length, processed: 0, skipped: 0, failed: 0 };
    for (const le of events) {
      const organizationId = await this.options.resolveOrganizationId(le.platform);
      if (!organizationId) {
        result.skipped += 1; // unknown tenant — never process cross-org
        continue;
      }
      const outcome = await this.processor.processEvent(adaptLoopEvent(le, organizationId));
      if (outcome.accepted) {
        await this.loopEvents.markLoopEventProcessed(le.id, this.processingVersion);
        result.processed += 1;
      } else {
        result.failed += 1; // stays unprocessed → retried next drain
      }
    }
    return result;
  }
}
