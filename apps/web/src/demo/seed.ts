// Demo seed + metrics — Sprint 4 (Real Data Layer).
//
// Seeds REAL persisted data by running the loop engine for a small set of
// sample HVAC quote requests, then derives the dashboard metrics from the
// DATABASE via the repository layer. Nothing is held in memory between requests.
//
// ensureSeeded() is idempotent at the org level: it only runs the sample loops
// the first time the demo org has no customers, so repeated page loads (and
// cold serverless instances) don't pile up duplicate journeys.
//
// NOTE: this in-app seed mirrors the canonical Prisma seed
// (packages/database/prisma/seed.ts) but additionally exercises the full loop.

import { runQuoteToBooking, type QuoteRequestInput } from './loop-engine';
import {
  store,
  ensureDemoOrganization,
  toTimelineEntry,
} from './repository-store';

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

/**
 * Idempotently seed the demo org by running the loop for each sample request,
 * but only when the org currently has no customers. Safe to call on every
 * dashboard/timeline render.
 */
export async function ensureSeeded(): Promise<void> {
  const { id: organizationId } = await ensureDemoOrganization();
  const existing = await store.customers.countByOrganization(organizationId);
  if (existing > 0) return;
  for (const req of SAMPLE_REQUESTS) {
    await runQuoteToBooking(req);
  }
}

/** Derive dashboard metrics from the database. */
export async function getMetrics(): Promise<DemoMetrics> {
  const { id: organizationId } = await ensureDemoOrganization();

  const totalRequests = await store.interactions.countByKind(
    organizationId,
    'FORM_SUBMISSION',
  );
  const bookedAppointments = await store.bookings.countConfirmed(organizationId);
  const totalCustomers =
    await store.customers.countByOrganization(organizationId);
  const confirmedIds = await store.bookings.confirmedCustomerIds(organizationId);
  const activeInteractions = Math.max(totalCustomers - confirmedIds.length, 0);
  const conversionRate =
    totalRequests === 0 ? 0 : bookedAppointments / totalRequests;

  const recent = await store.interactions.recentForOrganization(
    organizationId,
    8,
  );
  const customers = await store.customers.listByOrganization(organizationId);
  const nameById = new Map(
    customers.map((c) => [
      c.id,
      [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer',
    ]),
  );

  const recentActivity = recent.map((i) => {
    const e = toTimelineEntry(i);
    return {
      customerName: i.customerId
        ? (nameById.get(i.customerId) ?? 'Unknown')
        : 'Unknown',
      summary: e.summary,
      kind: String(e.loopKind),
      createdAt: e.occurredAt,
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
