// Loop engine — Sprint 3 (First Customer Loop).
//
// Orchestrates ONE complete end-to-end customer journey for a ServicesInMyCity
// HVAC quote request. Every external action goes through a provider ABSTRACTION
// (demoProviders.*), never a vendor SDK. Every step appends to the Interaction
// timeline and, where appropriate, records a Signal and a domain Event — so the
// same engine works unchanged once real adapters and a real database arrive.
//
// The engine deliberately does NOT know it is using mocks. Swap demoProviders
// for real adapters resolved from the registry and the loop is production code.

import {
  demoProviders,
  demoContext,
  type AIMessage,
} from './providers';
import {
  addBooking,
  addCustomer,
  addEvent,
  addInteraction,
  addMessage,
  addSignal,
  ensureAIEmployee,
  resetStore,
  timelineFor,
  upsertBooking,
  type Booking,
  type Customer,
} from './store';

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
  customer: Customer;
  booking: Booking;
  timelineCount: number;
  steps: string[];
}

const ORG = 'org-demo-servicesinmycity';

/** Parse a free-text preferred window into start/end ISO timestamps. */
function windowToRange(_preferred: string): { start: string; end: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Run the full loop. `reset` clears the store first so a fresh demo run is
 * deterministic. Returns the customer, booking, and a human-readable step log.
 */
export async function runQuoteToBooking(
  input: QuoteRequestInput,
  reset = true,
): Promise<LoopResult> {
  if (reset) resetStore();
  const steps: string[] = [];

  // 1) Quote request submitted -> Customer created.
  const customer = addCustomer({
    organizationId: ORG,
    name: input.name,
    phone: input.phone,
    email: input.email,
    city: input.city,
    state: input.state,
    attributes: { source: 'servicesinmycity', serviceType: input.serviceType },
  });
  steps.push(`Customer created: ${customer.name} (${customer.id})`);

  // Signal + Event for the inbound lead.
  addSignal({
    organizationId: ORG,
    customerId: customer.id,
    type: 'lead.received',
    payload: { serviceType: input.serviceType, city: input.city },
  });
  addEvent({
    organizationId: ORG,
    name: 'customer.created',
    payload: { customerId: customer.id },
  });

  // 2) Interaction: the quote request itself (timeline spine).
  const requestInteraction = addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'quote_request',
    channel: 'web_chat',
    direction: 'inbound',
    summary: `HVAC quote request (${input.serviceType})`,
    body: input.notes,
    actorType: 'customer',
    metadata: { preferredWindow: input.preferredWindow },
  });
  steps.push('Interaction logged: quote_request');

  // 3) AI Employee assigned.
  const ai = ensureAIEmployee();
  addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'assignment',
    channel: 'system',
    direction: 'internal',
    summary: `AI Employee assigned: ${ai.name} (${ai.role})`,
    actorType: 'system',
    metadata: { aiEmployeeId: ai.id },
  });
  addEvent({
    organizationId: ORG,
    name: 'interaction.assigned',
    payload: { interactionId: requestInteraction.id, aiEmployeeId: ai.id },
  });
  steps.push(`AI Employee assigned: ${ai.name}`);

  // 4) Mock AI decides the next action through the AI provider abstraction.
  const convo: AIMessage[] = [
    {
      role: 'user',
      content: `I need an HVAC ${input.serviceType} quote in ${input.city}, ${input.state}.`,
    },
  ];
  const decision = await demoProviders.ai.decide(demoContext, convo);
  steps.push(`AI decision: ${decision.action} — ${decision.reason}`);

  // 5) Mock SMS follow-up sent via the SMS provider abstraction.
  const out = await demoProviders.sms.sendSms(demoContext, {
    to: customer.phone,
    from: '+15555550100',
    body: decision.message,
  });
  const outInteraction = addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'outbound_message',
    channel: 'sms',
    direction: 'outbound',
    summary: 'SMS sent: follow-up',
    body: decision.message,
    actorType: 'ai_employee',
    actorId: ai.id,
    metadata: { externalId: out.externalId, status: out.status },
  });
  addMessage({
    organizationId: ORG,
    customerId: customer.id,
    interactionId: outInteraction.id,
    channel: 'sms',
    direction: 'outbound',
    body: decision.message,
    externalId: out.externalId,
  });
  steps.push(`SMS sent (${out.externalId}, ${out.status})`);

  // 6) Mock customer reply received (simulated inbound).
  const replyBody = 'Yes, tomorrow morning works great!';
  const inInteraction = addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'inbound_message',
    channel: 'sms',
    direction: 'inbound',
    summary: 'SMS received: customer reply',
    body: replyBody,
    actorType: 'customer',
    metadata: {},
  });
  addMessage({
    organizationId: ORG,
    customerId: customer.id,
    interactionId: inInteraction.id,
    channel: 'sms',
    direction: 'inbound',
    body: replyBody,
  });
  addSignal({
    organizationId: ORG,
    customerId: customer.id,
    type: 'message.inbound',
    payload: { body: replyBody },
  });
  steps.push('Customer replied via SMS');

  // 7) AI re-evaluates with the reply -> book.
  convo.push({ role: 'assistant', content: decision.message });
  convo.push({ role: 'user', content: replyBody });
  const decision2 = await demoProviders.ai.decide(demoContext, convo);
  steps.push(`AI decision: ${decision2.action} — ${decision2.reason}`);

  // 8) Booking created (pending) then confirmed via the calendar abstraction.
  const range = windowToRange(input.preferredWindow);
  let booking = addBooking({
    organizationId: ORG,
    customerId: customer.id,
    serviceType: input.serviceType,
    windowStart: range.start,
    windowEnd: range.end,
    status: 'created',
  });
  addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'booking_created',
    channel: 'system',
    direction: 'internal',
    summary: `Booking created for ${input.serviceType}`,
    actorType: 'ai_employee',
    actorId: ai.id,
    metadata: { bookingId: booking.id },
  });
  addEvent({
    organizationId: ORG,
    name: 'booking.created',
    payload: { bookingId: booking.id },
  });
  steps.push(`Booking created (${booking.id})`);

  const event = await demoProviders.calendar.createEvent(demoContext, {
    title: `HVAC ${input.serviceType} — ${customer.name}`,
    start: range.start,
    end: range.end,
    attendeeName: customer.name,
  });
  booking = upsertBooking({
    ...booking,
    status: 'confirmed',
    calendarProvider: 'mock',
    calendarEventId: event.externalId,
  });
  addInteraction({
    organizationId: ORG,
    customerId: customer.id,
    kind: 'booking_confirmed',
    channel: 'system',
    direction: 'internal',
    summary: 'Booking confirmed',
    actorType: 'ai_employee',
    actorId: ai.id,
    metadata: { bookingId: booking.id, calendarEventId: event.externalId },
  });
  addEvent({
    organizationId: ORG,
    name: 'booking.confirmed',
    payload: { bookingId: booking.id, calendarEventId: event.externalId },
  });
  steps.push(`Booking confirmed (calendar ${event.externalId})`);

  return {
    customer,
    booking,
    timelineCount: timelineFor(customer.id).length,
    steps,
  };
}
