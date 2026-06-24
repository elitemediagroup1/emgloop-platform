// BookingRepository — Sprint 4 (Real Data Layer).
//
// Bookings are created in a REQUESTED/CONFIRMED lifecycle and carry the
// calendar provider abstraction (calendarProvider + calendarEventId) so a real
// Google Calendar adapter can drop in later with no schema change. Service
// type and other industry shape live in the JSON `attributes` column.

import type { PrismaClient, Booking } from '@prisma/client';
import type { CreateBookingInput, UpdateBookingInput } from './types';

export class BookingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: CreateBookingInput): Promise<Booking> {
    return this.prisma.booking.create({
      data: {
        organizationId: input.organizationId,
        customerId: input.customerId ?? null,
        locationId: input.locationId ?? null,
        status: input.status ?? 'REQUESTED',
        title: input.title ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        calendarProvider: input.calendarProvider ?? null,
        calendarEventId: input.calendarEventId ?? null,
        items: (input.items ?? []) as object,
        attributes: (input.attributes ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  /** Update an existing booking (e.g. mark CONFIRMED + attach calendar event). */
  update(id: string, input: UpdateBookingInput): Promise<Booking> {
    return this.prisma.booking.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.calendarProvider !== undefined
          ? { calendarProvider: input.calendarProvider }
          : {}),
        ...(input.calendarEventId !== undefined
          ? { calendarEventId: input.calendarEventId }
          : {}),
        ...(input.startAt ? { startAt: input.startAt } : {}),
        ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
        ...(input.attributes ? { attributes: input.attributes as object } : {}),
        ...(input.metadata ? { metadata: input.metadata as object } : {}),
      },
    });
  }

  findById(id: string): Promise<Booking | null> {
    return this.prisma.booking.findUnique({ where: { id } });
  }

  /** Latest booking for a customer — used by the timeline header. */
  findForCustomer(customerId: string): Promise<Booking | null> {
    return this.prisma.booking.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  countConfirmed(organizationId: string): Promise<number> {
    return this.prisma.booking.count({
      where: { organizationId, status: 'CONFIRMED' },
    });
  }

  /** Customer ids that already have a confirmed booking. */
  async confirmedCustomerIds(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.booking.findMany({
      where: { organizationId, status: 'CONFIRMED', customerId: { not: null } },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    return rows
      .map((r) => r.customerId)
      .filter((id): id is string => id !== null);
  }
}
