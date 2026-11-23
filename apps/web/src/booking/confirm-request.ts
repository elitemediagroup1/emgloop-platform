import 'server-only';
import { setTimeout } from 'node:timers/promises';
import { sendBookingHostConfirmation } from '../lib/email/email-service';
import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '@emgloop/database';
import { googleWorkspace } from '../google/google-runtime';
import { jointAvailability, withinManagerHours } from './joint-availability';
import { bookingOverlapWhere } from './reservations';
import { prepareBookingTranscription } from './notetaker';
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
  const request = await prisma.booking.findFirst({ where: { ...where, status: { in: ['REQUESTED', 'CONFIRMED'] } } });
  if (request?.status === 'CONFIRMED') return 'confirmed';
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
      const hostIds = [principal.userId];
      if (typeof attributes.cohostUserId === 'string') {
        const joint = await jointAvailability(principal.organizationId, principal.userId, slot);
        if (!joint || joint.manager.userId !== attributes.cohostUserId) return 'connect';
        if (joint.busy.length || !withinManagerHours(slot, joint.hours)) return 'busy';
        hostIds.push(joint.manager.userId);
      }
      const reserved = await prisma.$transaction(async (tx) => {
        for (const hostId of hostIds.sort()) await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${hostId}, 0))`;
        const collision = await tx.booking.findFirst({
          where: {
            id: { not: request.id },
            ...bookingOverlapWhere(principal.organizationId, hostIds, request.startAt, new Date(slot.end)),
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
          calendarId: 'primary', eventId, introduction: typeof attributes.introduction === 'string' ? attributes.introduction : undefined, title: request.title ?? 'EMG meeting', slot,
        });
      } catch {
        // An ambiguous provider response can still mean the event was created.
        event = await findGoogleMeetEvent(token, eventId);
      }
    }
    for (const delay of [250, 500, 1000]) {
      if (!event || event.hangoutLink || event.status === 'cancelled') break;
      await setTimeout(delay);
      event = await findGoogleMeetEvent(token, eventId);
    }
    if (event?.status === 'cancelled') return 'unavailable';
    if (!event?.hangoutLink?.startsWith('https://meet.google.com/')) return 'pending';
    const notetaker = await prepareBookingTranscription(principal, attributes.eventTypeId, attendeeEmails, event.hangoutLink, request.startAt)
      .catch(() => 'transcription-unavailable');
    if (!(await inviteGoogleMeetAttendees(token, eventId, event, attendeeEmails))) return 'pending';
    const host = await prisma.user.findFirst({
      where: { id: principal.userId, organizationId: principal.organizationId },
      select: { email: true, employeeBookingProfile: { select: { timeZone: true } } },
    });
    if (!host) return 'pending';
    const when = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full', timeStyle: 'long', timeZone: host.employeeBookingProfile?.timeZone ?? 'UTC',
    }).format(request.startAt);
    await sendBookingHostConfirmation({
      to: host.email, when, bookingId: request.id, title: request.title ?? 'EMG meeting', meetUrl: event.hangoutLink,
    });
    await prisma.booking.updateMany({
      where,
      data: {
        status: 'CONFIRMED',
        calendarProvider: 'GOOGLE_BOOKING',
        calendarEventId: eventId,
        attributes: { ...attributes, meetUrl: event.hangoutLink, notetaker },
      },
    });
    return 'confirmed';
  } catch {
    return 'pending';
  }
}
