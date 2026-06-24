// Mock calendar provider (placeholder).
//
// Sprint 3 — First Customer Loop.
// Implements the CalendarProvider interface in memory. No Google Calendar.
// createEvent records a confirmed event so a Booking can reference a
// calendarEventId, exactly as a real adapter would.

import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type {
  CalendarProvider,
  CalendarRef,
  TimeWindow,
  AvailabilitySlot,
  CalendarEvent,
  CalendarEventInput,
} from '../interfaces/calendar.provider';

const ISO = () => new Date().toISOString();

export class MockCalendarProvider implements CalendarProvider {
  readonly info = {
    id: 'mock',
    category: 'calendar' as const,
    displayName: 'Mock Calendar (placeholder, no external calls)',
  };

  readonly events = new Map<string, CalendarEvent>();
  private seq = 0;

  async healthCheck(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, message: 'mock calendar online', checkedAt: ISO() };
  }

  async listCalendars(_ctx: ProviderContext): Promise<CalendarRef[]> {
    return [{ calendarId: 'mock-primary', name: 'Demo Primary Calendar' }];
  }

  async getAvailability(
    _ctx: ProviderContext,
    _calendarId: string,
    window: TimeWindow,
  ): Promise<AvailabilitySlot[]> {
    // Always "available" for the demo.
    return [{ start: window.start, end: window.end, available: true }];
  }

  async createEvent(
    _ctx: ProviderContext,
    input: CalendarEventInput,
  ): Promise<CalendarEvent> {
    const externalId = `mock-cal-${++this.seq}`;
    const event: CalendarEvent = { ...input, externalId, status: 'confirmed' };
    this.events.set(externalId, event);
    return event;
  }

  async updateEvent(
    _ctx: ProviderContext,
    externalId: string,
    input: Partial<CalendarEventInput>,
  ): Promise<CalendarEvent> {
    const existing = this.events.get(externalId);
    if (!existing) {
      throw new Error(`No mock calendar event '${externalId}'`);
    }
    const updated: CalendarEvent = { ...existing, ...input };
    this.events.set(externalId, updated);
    return updated;
  }

  async cancelEvent(_ctx: ProviderContext, externalId: string): Promise<void> {
    const existing = this.events.get(externalId);
    if (existing) {
      this.events.set(externalId, { ...existing, status: 'canceled' });
    }
  }
}

export const mockCalendarProvider: BaseProvider = new MockCalendarProvider();
