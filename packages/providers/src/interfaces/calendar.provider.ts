// Calendar provider interface.
//
// Abstracts calendaring providers (Google Calendar first, others later).
// Pairs with Booking.calendarProvider / calendarEventId in the schema.

import type { BaseProvider, ProviderContext } from '../types';

export interface CalendarRef {
  calendarId: string;
  name?: string;
}

export interface TimeWindow {
  start: string; // ISO
  end: string;   // ISO
}

export interface AvailabilitySlot extends TimeWindow {
  available: boolean;
}

export interface CalendarEventInput {
  calendarId: string;
  title: string;
  description?: string;
  start: string; // ISO
  end: string;   // ISO
  timezone?: string;
  attendees?: { email: string; name?: string }[];
  location?: string;
  metadata?: Record<string, unknown>;
}

export interface CalendarEvent extends CalendarEventInput {
  externalId: string;
  status: 'confirmed' | 'tentative' | 'canceled';
}

export interface CalendarProvider extends BaseProvider {
  listCalendars(ctx: ProviderContext): Promise<CalendarRef[]>;
  getAvailability(
    ctx: ProviderContext,
    calendarId: string,
    window: TimeWindow,
  ): Promise<AvailabilitySlot[]>;
  createEvent(ctx: ProviderContext, input: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(
    ctx: ProviderContext,
    externalId: string,
    input: Partial<CalendarEventInput>,
  ): Promise<CalendarEvent>;
  cancelEvent(ctx: ProviderContext, externalId: string): Promise<void>;
}
