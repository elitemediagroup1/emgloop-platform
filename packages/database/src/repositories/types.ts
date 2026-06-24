// Repository input/DTO types — Sprint 4 (Real Data Layer).
//
// These types describe the *intent* of a write at the loop level. Each
// repository maps them onto the canonical Prisma schema (firstName/lastName,
// occurredAt, enum kinds, etc.) so the loop engine never touches Prisma types
// directly. The shapes intentionally mirror the Sprint 3 demo records so the
// swap from the in-memory store to real persistence is mechanical.

import type {
  ChannelType,
  InteractionKind,
  InteractionDirection,
  ActorType,
  BookingStatus,
  SignalType,
} from '@prisma/client';

export type {
  ChannelType,
  InteractionKind,
  InteractionDirection,
  ActorType,
  BookingStatus,
  SignalType,
};

/** Create-shape for a Customer. Name is split into first/last for the schema. */
export interface CreateCustomerInput {
  organizationId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  tags?: string[];
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreateInteractionInput {
  organizationId: string;
  customerId?: string | null;
  conversationId?: string | null;
  channel: ChannelType;
  kind: InteractionKind;
  direction: InteractionDirection;
  summary?: string | null;
  provider?: string | null;
  externalId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface CreateBookingInput {
  organizationId: string;
  customerId?: string | null;
  locationId?: string | null;
  status?: BookingStatus;
  title?: string | null;
  startAt: Date;
  endAt?: Date | null;
  calendarProvider?: string | null;
  calendarEventId?: string | null;
  items?: unknown[];
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateBookingInput {
  status?: BookingStatus;
  calendarProvider?: string | null;
  calendarEventId?: string | null;
  startAt?: Date;
  endAt?: Date | null;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreateSignalInput {
  organizationId: string;
  customerId?: string | null;
  conversationId?: string | null;
  type: SignalType;
  key: string;
  label?: string | null;
  valueNumber?: number | null;
  valueString?: string | null;
  confidence?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Domain events are the platform's internal, append-only fact log
 * (e.g. "customer.created", "booking.confirmed"). Distinct from
 * IntegrationEvent, which records *external* provider webhooks.
 */
export interface CreateDomainEventInput {
  organizationId: string;
  name: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
