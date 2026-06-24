// Demo seed + metrics — Sprint 3 (First Customer Loop).
//
// Runs the loop engine for a small set of sample HVAC quote requests so the
// dashboard has realistic (but entirely mock) numbers, and derives the demo
// metrics from the in-memory store. All data is synthetic; nothing persists.

import { runQuoteToBooking, type QuoteRequestInput } from './loop-engine';
import { getStore } from './store';

const SAMPLE_REQUESTS: QuoteRequestInput[] = [
  {
    name: 'Maria Gonzalez',
    phone: '+15125550133',
    email: 'maria@example.com',
    serviceType: 'AC repair',
    city: 'Austin',
    state: 'TX',
    preferredWindow: 'Tomorrow morning',
    notes: 'Upstairs unit not cooling.',
  },
  {
    name: 'James Carter',
    phone: '+14155550178',
    email: 'james@example.com',
    serviceType: 'furnace tune-up',
    city: 'San Jose',
    state: 'CA',
    preferredWindow: 'This week, afternoons',
  },
  {
    name: 'Priya Nair',
    phone: '+12065550190',
    email: 'priya@example.com',
    serviceType: 'thermostat install',
    city: 'Seattle',
    state: 'WA',
    preferredWindow: 'Friday',
  },
];

export interface DemoMetrics {
  totalRequests: number;
  activeInteractions: number;
  bookedAppointments: number;
  conversionRate: number; // 0..1
  recentActivity: {
    customerName: string;
    summary: string;
    kind: string;
    createdAt: string;
  }[];
}

let seeded = false;

/** Idempotently seed the store by running the loop for each sample request. */
export async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  // Only the FIRST call resets; subsequent requests append to the same store.
  let first = true;
  for (const req of SAMPLE_REQUESTS) {
    await runQuoteToBooking(req, first);
    first = false;
  }
  seeded = true;
}

/** Derive dashboard metrics from the in-memory store. */
export function getMetrics(): DemoMetrics {
  const store = getStore();
  const totalRequests = store.interactions.filter(
    (i) => i.kind === 'quote_request',
  ).length;
  const bookedAppointments = store.bookings.filter(
    (b) => b.status === 'confirmed',
  ).length;
  // "Active" = customers with an interaction but no confirmed booking yet.
  const confirmedCustomerIds = new Set(
    store.bookings
      .filter((b) => b.status === 'confirmed')
      .map((b) => b.customerId),
  );
  const activeInteractions = store.customers.filter(
    (c) => !confirmedCustomerIds.has(c.id),
  ).length;
  const conversionRate =
    totalRequests === 0 ? 0 : bookedAppointments / totalRequests;

  const recentActivity = [...store.interactions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .map((i) => {
      const customer = store.customers.find((c) => c.id === i.customerId);
      return {
        customerName: customer?.name ?? 'Unknown',
        summary: i.summary,
        kind: i.kind,
        createdAt: i.createdAt,
      };
    });

  return {
    totalRequests,
    activeInteractions,
    bookedAppointments,
    conversionRate,
    recentActivity,
  };
}
