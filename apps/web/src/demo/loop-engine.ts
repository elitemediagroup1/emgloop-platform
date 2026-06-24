// Loop engine — Sprint 4 (Real Data Layer).
//
// Orchestrates ONE complete end-to-end customer journey for a ServicesInMyCity
// HVAC quote request. Two things are unchanged from Sprint 3 by design:
//   1) Every external action goes through a provider ABSTRACTION
//      (demoProviders.*), never a vendor SDK. Providers stay mocked.
//   2) Every step appends to the Interaction timeline and, where appropriate,
//      records a Signal and a domain Event.
//
// What changed in Sprint 4: persistence is REAL. Customers, interactions,
// signals, domain events, conversations, messages, and bookings are written to
// PostgreSQL through the @emgloop/database repository layer instead of an
// in-memory store. The orchestration logic is otherwise identical.

import { customerDisplayName } from '@emgloop/database';
import {
  demoProviders,
  demoContext,
  type AIMessage,
} from './providers';
import {
  store,
  ensureDemoOrganization,
  ensureAIEmployee,
  loopKindToEnum,
  channelToEnum,
  directionFor,
} from './repository-store';

export interface QuoteRequestInput {
  name: string;
  phone: string;
  email: string;
  serviceType: string;
  city: string;
  state: string;
  preferredWindow: string;
  notes?: string;
}

export interface LoopResult {
  customerId: string;
  customerName: string;
  bookingId: string;
  timelineCount: number;
  steps: string[];
}

/** Parse a free-text preferred window into start/end timestamps. */
function windowToRange(_preferred: string): { start: Date; end: Date } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11, 0, 0, 0);
  return { start, end };
}

/**
 * Run the full loop, persisting every record to the database. Returns the
 * created customer/booking ids and a human-readable step log. Unlike Sprint 3,
 * there is no store reset — every run appends a new customer journey.
 */
export async function runQuoteToBooking(
  input: QuoteRequestInput,
): Promise<LoopResult> {
  const steps: string[] = [];
  const { id: organizationId } = await ensureDemoOrganization();

  // 1) Quote request submitted -> Customer created (persisted).
  const customer = await store.customers.createFromName({
    organizationId,
    name: input.name,
    email: input.email,
    phone: input.phone,
    attributes: {
      source: 'servicesinmycity',
      serviceType: input.serviceType,
      city: input.city,
      state: input.state,
    },
  });
  const customerName = customerDisplayName(customer);
  steps.push(`Customer created: ${customerName} (${customer.id})`);

  // Signal + domain Event for the inbound lead.
  await store.signals.record({
    organizationId,
    customerId: customer.id,
    label: 'lead.received',
    payload: { serviceType: input.serviceType, city: input.city },
  });
  await store.domainEvents.emit({
    organizationId,
    name: 'customer.created',
    aggregateType: 'customer',
    aggregateId: customer.id,
  });

  // 2) Interaction: the quote request itself (timeline spine).
  const requestInteraction = await store.interactions.create({
    organizationId,
    customerId: customer.id,
    channel: channelToEnum('web_chat'),
    kind: loopKindToEnum('quote_request'),
    direction: directionFor('inbound'),
    summary: `HVAC quote request (${input.serviceType})`,
    payload: {
      loopKind: 'quote_request',
      loopChannel: 'web_chat',
      actorType: 'customer',
      body: input.notes ?? null,
      preferredWindow: input.preferredWindow,
    },
  });
  steps.push('Interaction logged: quote_request');

  // 3) AI Employee assigned (persisted assignment interaction + event).
  const ai = await ensureAIEmployee(organizationId);
  await store.interactions.create({
    organizationId,
    customerId: customer.id,
    channel: channelToEnum('system'),
    kind: loopKindToEnum('assignment'),
    direction: directionFor('internal'),
    summary: `AI Employee assigned: ${ai.name} (${ai.title ?? 'AI Employee'})`,
    payload: { loopKind: 'assignment', actorType: 'system', aiEmployeeId: ai.id },
  });
  await store.domainEvents.emit({
    organizationId,
    name: 'interaction.assigned',
    aggregateType: 'interaction',
    aggregateId: requestInteraction.id,
    payload: { aiEmployeeId: ai.id },
  });
  steps.push(`AI Employee assigned: ${ai.name}`);

  // A conversation anchors the SMS thread (messages require a conversation).
  const conversation = await store.conversations.ensureForCustomer({
    organizationId,
    customerId: customer.id,
    channel: channelToEnum('sms'),
    subject: `HVAC ${input.serviceType}`,
  });

  // 4) Mock AI decides the next action through the AI provider abstraction.
  const convo: AIMessage[] = [
    {
      role: 'user',
      content: `I need an HVAC ${input.serviceType} quote in ${input.city}, ${input.state}.`,
    },
  ];
  const decision = await demoProviders.ai.decide(demoContext, convo);
  steps.push(`AI decision: ${decision.action} — ${decision.reason}`);

  // 5) Mock SMS follow-up sent via the SMS provider abstraction (persisted).
  const out = await demoProviders.sms.sendSms(demoContext, {
    to: customer.phone ?? '',
    from: '+15555550100',
    body: decision.message,
  });
  await store.interactions.create({
    organizationId,
    customerId: customer.id,
    conversationId: conversation.id,
    channel: channelToEnum('sms'),
    kind: loopKindToEnum('outbound_message'),
    direction: directionFor('outbound'),
    summary: 'SMS sent: follow-up',
    provider: out.externalId.split('-')[0],
    externalId: out.externalId,
    payload: {
      loopKind: 'outbound_message',
      loopChannel: 'sms',
      actorType: 'ai_employee',
      body: decision.message,
      status: out.status,
    },
  });
  await store.messages.create({
    organizationId,
    conversationId: conversation.id,
    actorType: 'AI_AGENT',
    actorId: ai.id,
    body: decision.message,
    externalId: out.externalId,
  });
  steps.push(`SMS sent (${out.externalId}, ${out.status})`);

  // 6) Mock customer reply received (simulated inbound, persisted).
  const replyBody = 'Yes, tomorrow morning works great!';
  await store.interactions.create({
    organizationId,
    customerId: customer.id,
    conversationId: conversation.id,
    channel: channelToEnum('sms'),
    kind: loopKindToEnum('inbound_message'),
    direction: directionFor('inbound'),
    summary: 'SMS received: customer reply',
    payload: {
      loopKind: 'inbound_message',
      loopChannel: 'sms',
      actorType: 'customer',
      body: replyBody,
    },
  });
  await store.messages.create({
    organizationId,
    conversationId: conversation.id,
    actorType: 'CUSTOMER',
    actorId: customer.id,
    body: replyBody,
  });
  await store.signals.record({
    organizationId,
    customerId: customer.id,
    label: 'message.inbound',
    payload: { body: replyBody },
  });
  steps.push('Customer replied via SMS');

  // 7) AI re-evaluates with the reply -> book.
  convo.push({ role: 'assistant', content: decision.message });
  convo.push({ role: 'user', content: replyBody });
  const decision2 = await demoProviders.ai.decide(demoContext, convo);
  steps.push(`AI decision: ${decision2.action} — ${decision2.reason}`);

  // 8) Booking created (REQUESTED) then CONFIRMED via the calendar abstraction.
  const range = windowToRange(input.preferredWindow);
  let booking = await store.bookings.create({
    organizationId,
    customerId: customer.id,
    status: 'REQUESTED',
    title: `HVAC ${input.serviceType} — ${customerName}`,
    startAt: range.start,
    endAt: range.end,
    attributes: { serviceType: input.serviceType },
  });
  await store.interactions.create({
    organizationId,
    customerId: customer.id,
    channel: channelToEnum('system'),
    kind: loopKindToEnum('booking_created'),
    direction: directionFor('internal'),
    summary: `Booking created for ${input.serviceType}`,
    payload: {
      loopKind: 'booking_created',
      actorType: 'ai_employee',
      bookingId: booking.id,
    },
  });
  await store.domainEvents.emit({
    organizationId,
    name: 'booking.created',
    aggregateType: 'booking',
    aggregateId: booking.id,
  });
  steps.push(`Booking created (${booking.id})`);

  const event = await demoProviders.calendar.createEvent(demoContext, {
    title: `HVAC ${input.serviceType} — ${customerName}`,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    attendeeName: customerName,
  });
  booking = await store.bookings.update(booking.id, {
    status: 'CONFIRMED',
    calendarProvider: 'mock',
    calendarEventId: event.externalId,
  });
  await store.interactions.create({
    organizationId,
    customerId: customer.id,
    channel: channelToEnum('system'),
    kind: loopKindToEnum('booking_confirmed'),
    direction: directionFor('internal'),
    summary: 'Booking confirmed',
    payload: {
      loopKind: 'booking_confirmed',
      actorType: 'ai_employee',
      bookingId: booking.id,
      calendarEventId: event.externalId,
    },
  });
  await store.domainEvents.emit({
    organizationId,
    name: 'booking.confirmed',
    aggregateType: 'booking',
    aggregateId: booking.id,
    payload: { calendarEventId: event.externalId },
  });
  steps.push(`Booking confirmed (calendar ${event.externalId})`);

  const timeline = await store.interactions.timelineFor(customer.id);
  return {
    customerId: customer.id,
    customerName,
    bookingId: booking.id,
    timelineCount: timeline.length,
    steps,
  };
}
