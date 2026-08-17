// ProviderObservationRepository -- Commercial Intelligence Stage 3 correctness.
//
// Persistence for "Loop looked at this business date and this is what it saw".
// It stores evidence and reads it back; it never queries a provider, never
// decides whether a day certifies (that rule is pure and lives in
// @emgloop/shared), and never writes an Interaction or a MarketplaceCall.
//
// TENANT-FIRST, LIKE EVERY OTHER REPOSITORY HERE. `organizationId` is the first
// argument of every method and participates in the unique key, so a scoped
// resolve is the only resolve available. Sprint 29A's lesson was that
// caller-enforced isolation cannot be sustained by review, because the safe call
// and the unsafe call look identical at the call site -- so there is no method
// here that can be called without a tenant.
//
// BUSINESS DATES ARE STRINGS AT THE BOUNDARY, DATES IN THE COLUMN. Callers speak
// 'YYYY-MM-DD' because that is what a business date IS -- a calendar day in a
// named zone, not an instant. The column is a bare `DATE`, and the conversion
// pins it to UTC midnight in both directions so a server running in any zone
// stores and reads the same day. The UTC instants the day actually covers are
// stored separately in windowStart/windowEnd; they are the evidence, and this
// key is the identity.

import type { PrismaClient, Prisma } from '@prisma/client';
import type { BusinessDate, ProviderObservationStatus } from '@emgloop/shared';

/** What a certification run observed. Everything here is evidence, not opinion. */
export interface RecordProviderObservationInput {
  provider: string;
  stream: string;
  businessDate: BusinessDate;
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  status: ProviderObservationStatus;
  observedAt: Date;
  /** How the assertion was established. Only 'provider-query' certifies. */
  source: string;
  recordsObserved: number;
  providerStatedTotal?: number | null;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
  /** Why the day did not certify. Never a credential, never a caller identifier. */
  reason?: string | null;
}

/** One stored observation, as a caller sees it. */
export interface ObservationDayView {
  businessDate: BusinessDate;
  timezone: string;
  status: ProviderObservationStatus;
  observedAt: string;
  source: string;
  recordsObserved: number;
  providerStatedTotal: number | null;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
  reason: string | null;
}

/** 'YYYY-MM-DD' -> the UTC-midnight Date a bare DATE column round-trips as. */
export function businessDateToColumn(date: BusinessDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The stored DATE, back to 'YYYY-MM-DD'. */
export function columnToBusinessDate(value: Date): BusinessDate {
  return value.toISOString().slice(0, 10);
}

export class ProviderObservationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record what one certification run saw. Idempotent on the day's identity.
   *
   * RE-CERTIFYING UPDATES, IT DOES NOT ACCUMULATE. A day may legitimately be
   * observed more than once -- a failed read retried, or a re-check after a
   * provider revises history -- and each run should leave one current answer plus
   * a moved `observedAt`, not a pile of rows a reader has to reconcile. The unique
   * key is the tenant's, so two organizations certifying the same calendar day
   * write two independent rows.
   */
  async recordDay(
    organizationId: string,
    input: RecordProviderObservationInput,
  ): Promise<ObservationDayView> {
    const businessDate = businessDateToColumn(input.businessDate);
    const data = {
      timezone: input.timezone,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: input.status as Prisma.ProviderObservationDayCreateInput['status'],
      observedAt: input.observedAt,
      source: input.source,
      recordsObserved: input.recordsObserved,
      providerStatedTotal: input.providerStatedTotal ?? null,
      pagesFetched: input.pagesFetched,
      pageCap: input.pageCap,
      truncated: input.truncated,
      reason: input.reason ?? null,
    };

    const row = await this.prisma.providerObservationDay.upsert({
      where: {
        observation_day_identity: {
          organizationId,
          provider: input.provider,
          stream: input.stream,
          businessDate,
        },
      },
      create: {
        organizationId,
        provider: input.provider,
        stream: input.stream,
        businessDate,
        ...data,
      },
      update: data,
    });
    return toView(row);
  }

  /**
   * The status of each requested business date, for one tenant and stream.
   *
   * RETURNS ONLY WHAT EXISTS. A date with no row is simply absent from the map,
   * and the caller must treat that as "never observed" -- which the pure
   * `assessWindowObservation` does. Returning a default status for a missing row
   * would be the substitution this whole mechanism exists to prevent, so it is not
   * possible to ask this method for one.
   */
  async statusesForDates(
    organizationId: string,
    provider: string,
    stream: string,
    businessDates: readonly BusinessDate[],
  ): Promise<Map<BusinessDate, ProviderObservationStatus>> {
    const out = new Map<BusinessDate, ProviderObservationStatus>();
    if (businessDates.length === 0) return out;

    // Explicit select, following this repository family's drift-safe discipline:
    // migrations here are human-dispatched, so a bare findMany over a column that
    // has drifted from the deployed schema would 500 the caller's whole page.
    const rows = await this.prisma.providerObservationDay.findMany({
      where: {
        organizationId,
        provider,
        stream,
        businessDate: { in: businessDates.map(businessDateToColumn) },
      },
      select: { businessDate: true, status: true },
    });
    for (const row of rows) {
      out.set(columnToBusinessDate(row.businessDate), row.status as ProviderObservationStatus);
    }
    return out;
  }

  /** The stored evidence for a set of dates, for a diagnostic surface. */
  async listForDates(
    organizationId: string,
    provider: string,
    stream: string,
    businessDates: readonly BusinessDate[],
  ): Promise<ObservationDayView[]> {
    if (businessDates.length === 0) return [];
    const rows = await this.prisma.providerObservationDay.findMany({
      where: {
        organizationId,
        provider,
        stream,
        businessDate: { in: businessDates.map(businessDateToColumn) },
      },
      orderBy: { businessDate: 'asc' },
    });
    return rows.map(toView);
  }
}

function toView(row: {
  businessDate: Date;
  timezone: string;
  status: string;
  observedAt: Date;
  source: string;
  recordsObserved: number;
  providerStatedTotal: number | null;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
  reason: string | null;
}): ObservationDayView {
  return {
    businessDate: columnToBusinessDate(row.businessDate),
    timezone: row.timezone,
    status: row.status as ProviderObservationStatus,
    observedAt: row.observedAt.toISOString(),
    source: row.source,
    recordsObserved: row.recordsObserved,
    providerStatedTotal: row.providerStatedTotal,
    pagesFetched: row.pagesFetched,
    pageCap: row.pageCap,
    truncated: row.truncated,
    reason: row.reason,
  };
}
