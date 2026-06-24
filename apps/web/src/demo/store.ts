// In-memory demo store — Sprint 3 (First Customer Loop).
//
// Models the platform's REAL record shapes (Customer, Interaction, Signal,
// Event, Message, Booking) in a process-local store so the loop can be run and
// visualized without a database. The field names mirror the Prisma schema so
// swapping this for @emgloop/database is a mechanical change, not a redesign.
//
// Interaction is the canonical customer-timeline spine: every step of the loop
// appends an Interaction (and, where appropriate, a Signal and an Event).

import { ISO } from './providers';

export type InteractionKind =
  | 'quote_request'
  | 'system_note'
  | 'assignment'
  | 'outbound_message'
  | 'inbound_message'
  | 'booking_created'
  | 'booking_confirmed';

export type Channel =
  | 'web_chat'
  | 'sms'
  | 'email'
  | 'phone'
  | 'in_person'
  | 'system';

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  createdAt: string;
  attributes: Record<string, unknown>;
}

export interface Interaction {
  id: string;
  organizationId: string;
  customerId: string;
  kind: InteractionKind;
  channel: Channel;
  direction: 'inbound' | 'outbound' | 'internal';
  summary: string;
  body?: string;
  actorType: 'human' | 'ai_employee' | 'system' | 'customer';
  actorId?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface Signal {
  id: string;
  organizationId: string;
  customerId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DomainEvent {
  id: string;
  organizationId: string;
  name: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Message {
  id: string;
  organizationId: string;
  customerId: string;
  interactionId: string;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  body: string;
  externalId?: string;
  createdAt: string;
}

export interface Booking {
  id: string;
  organizationId: string;
  customerId: string;
  serviceType: string;
  windowStart: string;
  windowEnd: string;
  status: 'pending' | 'created' | 'confirmed' | 'canceled';
  calendarProvider?: string;
  calendarEventId?: string;
  createdAt: string;
}

export interface AIEmployeeRef {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  status: 'active' | 'paused';
}

export interface DemoStore {
  customers: Customer[];
  interactions: Interaction[];
  signals: Signal[];
  events: DomainEvent[];
  messages: Message[];
  bookings: Booking[];
  aiEmployees: AIEmployeeRef[];
}

// Process-local singleton. Reset via resetStore() for repeatable demo runs.
function emptyStore(): DemoStore {
  return {
    customers: [],
    interactions: [],
    signals: [],
    events: [],
    messages: [],
    bookings: [],
    aiEmployees: [],
  };
}

let store: DemoStore = emptyStore();
let counter = 0;
export const id = (prefix: string) => `${prefix}_${++counter}`;

export function getStore(): DemoStore {
  return store;
}

export function resetStore(): void {
  store = emptyStore();
  counter = 0;
}

// --- Record helpers (each returns the created record) -----------------------
export function addCustomer(
  data: Omit<Customer, 'id' | 'createdAt'>,
): Customer {
  const rec: Customer = { ...data, id: id('cust'), createdAt: ISO() };
  store.customers.push(rec);
  return rec;
}

export function addInteraction(
  data: Omit<Interaction, 'id' | 'createdAt'>,
): Interaction {
  const rec: Interaction = { ...data, id: id('int'), createdAt: ISO() };
  store.interactions.push(rec);
  return rec;
}

export function addSignal(data: Omit<Signal, 'id' | 'createdAt'>): Signal {
  const rec: Signal = { ...data, id: id('sig'), createdAt: ISO() };
  store.signals.push(rec);
  return rec;
}

export function addEvent(
  data: Omit<DomainEvent, 'id' | 'createdAt'>,
): DomainEvent {
  const rec: DomainEvent = { ...data, id: id('evt'), createdAt: ISO() };
  store.events.push(rec);
  return rec;
}

export function addMessage(data: Omit<Message, 'id' | 'createdAt'>): Message {
  const rec: Message = { ...data, id: id('msg'), createdAt: ISO() };
  store.messages.push(rec);
  return rec;
}

export function addBooking(
  data: Omit<Booking, 'id' | 'createdAt'>,
): Booking {
  const rec: Booking = { ...data, id: id('book'), createdAt: ISO() };
  store.bookings.push(rec);
  return rec;
}

export function upsertBooking(booking: Booking): Booking {
  const idx = store.bookings.findIndex((b) => b.id === booking.id);
  if (idx >= 0) store.bookings[idx] = booking;
  return booking;
}

export function ensureAIEmployee(): AIEmployeeRef {
  if (store.aiEmployees.length === 0) {
    store.aiEmployees.push({
      id: id('aiemp'),
      organizationId: 'org-demo-servicesinmycity',
      name: 'Ava',
      role: 'Front Desk AI Employee',
      status: 'active',
    });
  }
  return store.aiEmployees[0];
}

export function timelineFor(customerId: string): Interaction[] {
  return store.interactions
    .filter((i) => i.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
