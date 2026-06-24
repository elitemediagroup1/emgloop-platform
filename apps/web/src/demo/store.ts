// Demo store — Sprint 4 (Real Data Layer).
//
// The Sprint 3 in-memory arrays (customers/interactions/signals/events/
// messages/bookings) and their add*/getStore/resetStore helpers have been
// REMOVED. There is no process-local state anymore: every read and write goes
// to PostgreSQL through the @emgloop/database repository layer.
//
// This module is now a thin READ facade over the repositories, scoped to the
// demo organization, returning UI-ready view models. Writes happen in the loop
// engine (loop-engine.ts) via the repository-store facade. Keeping this file
// preserves the import surface used by the dashboard and timeline pages.

import {
  store,
  ensureDemoOrganization,
  toCustomerView,
  toTimelineEntry,
  type CustomerView,
  type TimelineEntry,
  type BookingView,
} from './repository-store';

export type { CustomerView, TimelineEntry, BookingView };

/** Most recently created customers for the demo org (UI view models). */
export async function listCustomers(): Promise<CustomerView[]> {
  const { id: organizationId } = await ensureDemoOrganization();
  const rows = await store.customers.listByOrganization(organizationId);
  return rows.map(toCustomerView);
}

/** A single customer view, or null if not found. */
export async function getCustomer(
  customerId: string,
): Promise<CustomerView | null> {
  const row = await store.customers.findById(customerId);
  return row ? toCustomerView(row) : null;
}

/** Fallback customer = most recently created in the demo org. */
export async function getLatestCustomer(): Promise<CustomerView | null> {
  const { id: organizationId } = await ensureDemoOrganization();
  const row = await store.customers.findLatest(organizationId);
  return row ? toCustomerView(row) : null;
}

/** Ordered interaction timeline for a customer (oldest first). */
export async function timelineFor(
  customerId: string,
): Promise<TimelineEntry[]> {
  const rows = await store.interactions.timelineFor(customerId);
  return rows.map(toTimelineEntry);
}

/** Latest booking for a customer, mapped to a UI view model. */
export async function bookingFor(
  customerId: string,
): Promise<BookingView | null> {
  const b = await store.bookings.findForCustomer(customerId);
  if (!b) return null;
  const serviceType =
    (b.attributes &&
      typeof b.attributes === 'object' &&
      'serviceType' in b.attributes &&
      String((b.attributes as Record<string, unknown>).serviceType)) ||
    b.title ||
    'Service';
  return {
    id: b.id,
    status: b.status.toLowerCase(),
    serviceType,
    calendarProvider: b.calendarProvider,
    calendarEventId: b.calendarEventId,
  };
}
