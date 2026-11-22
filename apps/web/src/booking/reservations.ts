import 'server-only';
import { prisma, type Prisma } from '@emgloop/database';
import type { BusyPeriod } from './availability';

export function bookingOverlapWhere(
  organizationId: string, hostIds: readonly string[], start: Date, end: Date,
): Prisma.BookingWhereInput {
  return {
    organizationId,
    status: { in: ['REQUESTED', 'CONFIRMED', 'RESCHEDULED'] },
    calendarProvider: 'GOOGLE_BOOKING',
    startAt: { lt: end },
    endAt: { gt: start },
    OR: hostIds.flatMap(id => [
      { attributes: { path: ['profileUserId'], equals: id } },
      { attributes: { path: ['cohostUserId'], equals: id } },
    ]),
  };
}

export async function reservedBookingPeriods(
  organizationId: string, hostIds: readonly string[], start: Date, end: Date,
): Promise<BusyPeriod[]> {
  const bookings = await prisma.booking.findMany({
    where: bookingOverlapWhere(organizationId, hostIds, start, end),
    select: { startAt: true, endAt: true },
  });
  return bookings.flatMap(booking => booking.endAt
    ? [{ start: booking.startAt.valueOf(), end: booking.endAt.valueOf() }]
    : []);
}
