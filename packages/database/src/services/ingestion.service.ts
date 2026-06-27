// IngestionService — Sprint 11 (First Live Integration, Phases 2-4 + 7).
//
// The orchestration spine for live events. Given verified InboundEvents from a
// provider adapter, this service runs the full Loop pipeline for each one:
//
//  1. Record the raw event as an IntegrationEvent FIRST, in RECEIVED state
//     (idempotent on provider + externalId). This durably captures the
//     delivery before any processing, so a crash mid-pipeline leaves a
//     retryable row rather than a lost event.
//  2. Transition the event to PROCESSING, then resolve or create the Customer
//     (so they appear immediately in the CRM).
//  3. Build a provider-agnostic NormalizedEvent and run it through the
//     NormalizationEngine -> Interaction + Signal + DomainEvent + Workflow.
//  4. Enrich the Brain via the SignalRegistry (Phase 4 signals).
//  5. Run the rules-based NextBestActionService (Phase 7).
//  6. Mark the IntegrationEvent PROCESSED, or FAILED with the error so the
//     admin retry queue can replay it.
//
// Status lifecycle: RECEIVED -> PROCESSING -> PROCESSED | FAILED. A FAILED (or
// orphaned RECEIVED) row is retryable: re-delivering the same externalId reuses
// the row and re-runs from PROCESSING. Only PROCESSED short-circuits as a
// duplicate.
//
// NO provider-specific logic lives here. The adapter already translated the wire
// format into InboundEvent; everything below is generic. A different provider
// produces InboundEvents the same way and flows through this identical pipeline.
//
// Sprint 14 (Website Intelligence) makes this same spine carry the web.* event
// family — the Brain's second sense — by recognizing web.* canonical types and
// resolving anonymous website visitors. No new pipeline; just more event types.

import type { PrismaClient } from '@prisma/client';
import type { NormalizedEvent, LoopEventType } from '@emgloop/shared';
import type { InboundEvent } from '@emgloop/providers';
import { NormalizationEngine } from '../repositories/normalization.repository';
import { WorkflowsRepository } from '../repositories/workflows.repository';
import { deriveSignals } from './signal-registry';
import { NextBestActionService } from './next-best-action.service';

const LOOP_EVENT_TYPES_SET = new Set<string>([
  'call.inbound', 'call.outbound', 'call.answered', 'call.missed',
  'call.completed', 'call.voicemail', 'call.transferred',
  // Web / website intelligence (Sprint 10 baseline + Sprint 14 additions).
  'web.session_start', 'web.session_end', 'web.page_view', 'web.guide_view',
  'web.search', 'web.search_zip', 'web.search_city', 'web.search_category',
  'web.cta_click', 'web.phone_click', 'web.email_click',
  'web.external_link', 'web.affiliate_click',
  'web.form_start', 'web.form_submit', 'web.appointment_request', 'web.newsletter_signup',
  'web.chat_start', 'web.chat_complete',
  'web.download', 'web.quiz_start', 'web.quiz_complete',
  'web.planner_start', 'web.planner_save', 'web.planner_print',
  'web.video_play', 'web.error', 'web.goal_conversion',
  'sms.inbound', 'sms.outbound',
  'email.sent', 'email.delivered', 'email.opened', 'email.clicked',
  'ai.conversation_start', 'ai.conversation_end', 'ai.escalation',
  'ads.lead_form_submit',
]);

export interface IngestResult {
  externalId: string;
  status: 'processed' | 'duplicate' | 'failed';
  integrationEventId: string | null;
  customerId: string | null;
  interactionId: string | null;
  signalIds: string[];
  domainEventId: string | null;
  nextBestActions: string[];
  error?: string;
}

export interface IngestInput {
  organizationId: string;
  provider: string; // e.g. 'callgrid', 'website'
  /** Maps the adapter's rawEventType string to a canonical LoopEventType. */
  mapEventType: (rawEventType: string) => string;
  events: InboundEvent[];
  providerConnectionId?: string | null;
}

function digits(s?: string): string | undefined {
  if (!s) return undefined;
  const d = s.replace(/[^0-9]/g, '');
  return d.length >= 7 ? d : undefined;
}

function asString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class IngestionService {
  private readonly normalizer: NormalizationEngine;
  private readonly nextBestAction: NextBestActionService;

  constructor(private readonly prisma: PrismaClient) {
    this.normalizer = new NormalizationEngine(prisma, new WorkflowsRepository(prisma));
    this.nextBestAction = new NextBestActionService(prisma);
  }

  /** Process a batch of inbound events. Each event is isolated: one failure
      does not abort the others. Returns a per-event result for the caller. */
  async ingest(input: IngestInput): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const ev of input.events) {
      results.push(await this.ingestOne(input, ev));
    }
    return results;
  }

  private async ingestOne(input: IngestInput, ev: InboundEvent): Promise<IngestResult> {
    const { organizationId, provider } = input;
    const eventType = input.mapEventType(ev.rawEventType);

    const base: IngestResult = {
      externalId: ev.externalId,
      status: 'failed',
      integrationEventId: null,
      customerId: null,
      interactionId: null,
      signalIds: [],
      domainEventId: null,
      nextBestActions: [],
    };

    // 1. Idempotency: provider + externalId is unique in the schema. If we have
    //    already PROCESSED this delivery, short-circuit as a duplicate.
    const existing = await this.prisma.integrationEvent.findFirst({
      where: { provider, externalId: ev.externalId },
    });
    if (existing && existing.status === 'PROCESSED') {
      return { ...base, status: 'duplicate', integrationEventId: existing.id };
    }

    // 2. Persist the raw event FIRST in RECEIVED state (or reuse a prior
    //    RECEIVED/FAILED row). This durably records the delivery before any
    //    processing runs, so failures are always retryable from a known row.
    const record = existing
      ? await this.prisma.integrationEvent.update({
          where: { id: existing.id },
          data: { status: 'RECEIVED', error: null, payload: ev.payload as object },
        })
      : await this.prisma.integrationEvent.create({
          data: {
            organizationId,
            providerConnectionId: input.providerConnectionId ?? null,
            category: 'INGESTION',
            provider,
            eventType,
            externalId: ev.externalId,
            status: 'RECEIVED',
            payload: ev.payload as object,
          },
        });
    base.integrationEventId = record.id;

    // Transition RECEIVED -> PROCESSING now that the raw event is safely stored.
    await this.prisma.integrationEvent.update({
      where: { id: record.id },
      data: { status: 'PROCESSING', error: null },
    });

    try {
      // 3. Resolve or create the Customer so they show up in the CRM at once.
      const customerId = await this.resolveCustomer(organizationId, provider, ev);
      base.customerId = customerId;

      const canonicalType = (LOOP_EVENT_TYPES_SET.has(eventType)
        ? eventType
        : (provider === 'website' ? 'web.page_view' : 'call.inbound')) as LoopEventType;

      // 4. Build the provider-agnostic NormalizedEvent and normalize it.
      const normalized: NormalizedEvent = {
        organizationId,
        source: provider,
        externalId: ev.externalId,
        eventType: canonicalType,
        occurredAt: ev.occurredAt,
        customerId: customerId ?? undefined,
        customerEmail: ev.customerEmail,
        customerPhone: ev.customerPhone,
        durationSeconds: numberFrom(ev.payload, ['duration', 'duration_seconds', 'billable_duration']),
        summary: summaryFor(canonicalType, ev.payload),
        metadata: { ...ev.payload, eventType: canonicalType },
      };
      const normResult = await this.normalizer.normalize(normalized);
      base.interactionId = normResult.interactionId;
      base.domainEventId = normResult.domainEventId;
      base.signalIds = [...normResult.signalIds];

      // 5. SignalRegistry enrichment (Phase 4). Append-only, advisory.
      if (customerId && !normResult.wasIdempotent) {
        const derived = deriveSignals(normalized);
        for (const d of derived) {
          try {
            const s = await this.prisma.signal.create({
              data: {
                organizationId,
                customerId,
                type: d.type,
                key: d.key,
                label: d.label,
                valueString: d.valueString ?? null,
                valueNumber: d.valueNumber ?? null,
                confidence: d.confidence ?? null,
                source: 'signal-registry',
                metadata: { externalId: ev.externalId, eventType: canonicalType } as object,
              },
            });
            base.signalIds.push(s.id);
          } catch {
            // enrichment is advisory
          }
        }
      }

      // 6. Next Best Action (Phase 7) — rules-based recommendations.
      if (base.interactionId) {
        const allSignals = customerId
          ? await this.prisma.signal.findMany({
              where: { organizationId, customerId },
              select: { type: true, key: true, label: true },
              take: 100,
            })
          : [];
        const nba = await this.nextBestAction.run({
          organizationId,
          customerId,
          interaction: {
            id: base.interactionId,
            channel: channelFor(canonicalType),
            kind: kindFor(canonicalType),
            direction: directionFor(canonicalType),
            summary: normalized.summary ?? null,
            occurredAt: normalized.occurredAt,
            metadata: { eventType: canonicalType },
          },
          signals: allSignals,
        });
        base.nextBestActions = nba.actions.map((a) => a.kind);
      }

      // 7. Done — mark PROCESSED.
      await this.prisma.integrationEvent.update({
        where: { id: record.id },
        data: { status: 'PROCESSED', processedAt: new Date(), error: null },
      });
      return { ...base, status: 'processed' };
    } catch (err) {
      // Mark FAILED with the error message; the row stays retryable (re-delivery
      // of the same externalId reuses it and re-runs the pipeline).
      const message = err instanceof Error ? err.message : 'Unknown ingestion error';
      await this.prisma.integrationEvent.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: message },
      });
      return { ...base, status: 'failed', error: message };
    }
  }

  /** Resolve a customer by phone/email within the org, creating one if needed so
      the contact is immediately visible in the CRM. Website events frequently
      arrive without phone/email — those are tracked as anonymous visitor
      profiles keyed on the visitor/session id so later identified interactions
      merge by the same visitor id. */
  private async resolveCustomer(
    organizationId: string,
    provider: string,
    ev: InboundEvent,
  ): Promise<string | null> {
    const phone = ev.customerPhone ?? undefined;
    const email = ev.customerEmail ?? undefined;
    const phoneDigits = digits(phone);

    if (phoneDigits) {
      const found = await this.prisma.customer.findFirst({
        where: { organizationId, phone: { contains: phoneDigits.slice(-7) } },
      });
      if (found) return found.id;
    }
    if (email) {
      const found = await this.prisma.customer.findFirst({
        where: { organizationId, email },
      });
      if (found) return found.id;
    }

    // Website anonymous-visitor resolution: reuse the same visitor profile so a
    // returning anonymous visitor accumulates one continuous journey, and merges
    // automatically once they later identify (phone/email match above wins).
    const payload = ev.payload as Record<string, unknown>;
    const visitorId = asString(payload, 'visitorId') ?? asString(payload, 'sessionId');
    if (!phone && !email && visitorId) {
      const visitorExternalId = 'web-visitor:' + visitorId;
      const existingVisitor = await this.prisma.customer.findFirst({
        where: { organizationId, externalId: visitorExternalId },
      });
      if (existingVisitor) return existingVisitor.id;
      const createdVisitor = await this.prisma.customer.create({
        data: {
          organizationId,
          externalId: visitorExternalId,
          tags: ['anonymous-visitor'],
          attributes: { pipelineStatus: 'New', firstSource: provider, anonymous: true } as object,
          metadata: { createdFrom: provider, visitorId } as object,
        },
      });
      return createdVisitor.id;
    }

    if (!phone && !email) return null;

    const created = await this.prisma.customer.create({
      data: {
        organizationId,
        phone: phone ?? null,
        email: email ?? null,
        tags: ['lead'],
        attributes: { pipelineStatus: 'New', firstSource: provider } as object,
        metadata: { createdFrom: provider } as object,
      },
    });
    return created.id;
  }
}

function numberFrom(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function summaryFor(eventType: string, payload: Record<string, unknown>): string {
  if (eventType.startsWith('web.')) return websiteSummary(eventType, payload);
  const num =
    (typeof payload['caller_number'] === 'string' && payload['caller_number']) ||
    (typeof payload['from'] === 'string' && payload['from']) ||
    '';
  const label: Record<string, string> = {
    'call.inbound': 'Inbound call',
    'call.answered': 'Call answered',
    'call.missed': 'Missed call',
    'call.completed': 'Call completed',
    'call.voicemail': 'Voicemail left',
    'call.transferred': 'Call transferred',
  };
  const base = label[eventType] ?? 'Call event';
  return num ? base + ' from ' + num : base;
}

function pickStr(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function websiteSummary(eventType: string, payload: Record<string, unknown>): string {
  const property = pickStr(payload, 'property') || 'website';
  const page = pickStr(payload, 'page') || pickStr(payload, 'title');
  const query = pickStr(payload, 'query');
  const cta = pickStr(payload, 'cta');
  const category = pickStr(payload, 'category');
  const label: Record<string, string> = {
    'web.session_start': 'Website session started',
    'web.session_end': 'Website session ended',
    'web.page_view': 'Viewed page',
    'web.guide_view': 'Viewed guide',
    'web.search': 'Searched',
    'web.search_zip': 'ZIP search',
    'web.search_city': 'City search',
    'web.search_category': 'Category search',
    'web.cta_click': 'Clicked CTA',
    'web.phone_click': 'Clicked call',
    'web.email_click': 'Clicked email',
    'web.external_link': 'Clicked external link',
    'web.affiliate_click': 'Clicked affiliate link',
    'web.form_start': 'Started a form',
    'web.form_submit': 'Submitted a form',
    'web.appointment_request': 'Requested an appointment',
    'web.newsletter_signup': 'Newsletter signup',
    'web.chat_start': 'Started chat',
    'web.chat_complete': 'Completed chat',
    'web.download': 'Downloaded a resource',
    'web.quiz_start': 'Started a quiz',
    'web.quiz_complete': 'Completed a quiz',
    'web.planner_start': 'Started a planner',
    'web.planner_save': 'Saved a planner',
    'web.planner_print': 'Printed a planner',
    'web.video_play': 'Played a video',
    'web.error': 'Encountered an error',
    'web.goal_conversion': 'Converted a goal',
  };
  const verb = label[eventType] ?? 'Website event';
  const detail = query || cta || page || category;
  const base = verb + ' on ' + property;
  return detail ? base + ' — ' + detail : base;
}

function channelFor(eventType: string): 'PHONE' | 'SMS' | 'EMAIL' | 'WEB_CHAT' | 'OTHER' {
  if (eventType.startsWith('call.')) return 'PHONE';
  if (eventType.startsWith('sms.')) return 'SMS';
  if (eventType.startsWith('email.')) return 'EMAIL';
  if (eventType.startsWith('ai.')) return 'WEB_CHAT';
  if (eventType === 'web.chat_start' || eventType === 'web.chat_complete') return 'WEB_CHAT';
  return 'OTHER';
}

function kindFor(
  eventType: string,
): 'PHONE_CALL' | 'SMS' | 'EMAIL' | 'CHAT' | 'APPOINTMENT' | 'FORM_SUBMISSION' | 'NOTE' | 'OTHER' {
  if (eventType.startsWith('call.')) return 'PHONE_CALL';
  if (eventType.startsWith('sms.')) return 'SMS';
  if (eventType.startsWith('email.')) return 'EMAIL';
  if (eventType === 'web.chat_start' || eventType === 'web.chat_complete' || eventType.startsWith('ai.')) return 'CHAT';
  if (eventType === 'web.appointment_request') return 'APPOINTMENT';
  if (eventType === 'web.form_start' || eventType === 'web.form_submit' || eventType === 'web.newsletter_signup') {
    return 'FORM_SUBMISSION';
  }
  if (eventType.startsWith('web.')) return 'OTHER';
  return 'OTHER';
}

function directionFor(eventType: string): 'INBOUND' | 'OUTBOUND' | 'INTERNAL' {
  if (eventType === 'call.outbound' || eventType === 'sms.outbound' || eventType.startsWith('email.')) {
    return 'OUTBOUND';
  }
  return 'INBOUND';
}
