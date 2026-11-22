import 'server-only';
import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '@emgloop/database';
import { googleWorkspace } from '../google/google-runtime';
import { bookingAttendeeEmails } from './attendees';
import { createGoogleMeetEvent, findGoogleMeetEvent, googleBusyPeriods, inviteGoogleMeetAttendees } from './google-calendar';

export async function confirmBookingRequest(
  principal: { organizationId: string; userId: string },
  requestId: string,
): Promise<'confirmed' | 'connect' | 'busy' | 'pending' | 'unavailable'> {
  const where: Prisma.BookingWhereInput = {
    id: requestId,
    organizationId: principal.organizationId,
    status: 'REQUESTED',
    startAt: { gt: new Date() },
    AND: [
      { attributes: { path: ['source'], equals: 'employee-booking-request' } },
      { attributes: { path: ['profileUserId'], equals: principal.userId } },
    ],
  };
  const request = await prisma.booking.findFirst({ where });
  if (!request?.endAt) return 'unavailable';
  const attributes = request.attributes as Prisma.JsonObject;
  const extras = Array.isArray(attributes.attendeeEmails) ? attributes.attendeeEmails : [];
  if (typeof attributes.guestEmail !== 'string' || !extras.every((value) => typeof value === 'string')) {
    return 'unavailable';
  }
  const attendeeEmails = bookingAttendeeEmails(attributes.guestEmail, extras);
  if (!attendeeEmails) return 'unavailable';

  const connection = await googleWorkspace().accessToken(principal, 'booking');
  if (!connection.ok) return 'connect';
  const token = connection.accessToken;
  const eventId = 'emg' + createHash('sha256').update(request.id).digest('hex');
  const slot = { start: request.startAt.valueOf(), end: request.endAt.valueOf() };

  try {
    let event = await findGoogleMeetEvent(token, eventId);
    if (!event) {
      if ((await googleBusyPeriods(token, ['primary'], slot)).length > 0) return 'busy';
      const reserved = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${principal.userId}, 0))`;
        const collision = await tx.booking.findFirst({
          where: {
            id: { not: request.id },
            organizationId: principal.organizationId,
            status: { in: ['REQUESTED', 'CONFIRMED', 'RESCHEDULED'] },
            calendarProvider: 'GOOGLE_BOOKING',
            startAt: { lt: request.endAt! },
            endAt: { gt: request.startAt },
            attributes: { path: ['profileUserId'], equals: principal.userId },
          },
          select: { id: true },
        });
        if (collision) return false;
        const updated = await tx.booking.updateMany({
          where, data: { calendarProvider: 'GOOGLE_BOOKING', calendarEventId: eventId },
        });
        return updated.count === 1;
      });
      if (!reserved) return 'busy';
      try {
        event = await createGoogleMeetEvent(token, {
          calendarId: 'primary', eventId, title: request.title ?? 'EMG meeting', slot,
        });
      } catch {
        // An ambiguous provider response can still mean the event was created.
        event = await findGoogleMeetEvent(token, eventId);
      }
    }
    if (event?.status === 'cancelled') return 'unavailable';
    if (!event?.hangoutLink?.startsWith('https://meet.google.com/')) return 'pending';
    if (!(await inviteGoogleMeetAttendees(token, eventId, event, attendeeEmails))) return 'pending';
    await prisma.booking.updateMany({
      where,
      data: {
        status: 'CONFIRMED',
        calendarProvider: 'GOOGLE_BOOKING',
        calendarEventId: eventId,
        attributes: { ...attributes, meetUrl: event.hangoutLink },
      },
    });
    return 'confirmed';
  } catch {
    return 'pending';
  }
}
