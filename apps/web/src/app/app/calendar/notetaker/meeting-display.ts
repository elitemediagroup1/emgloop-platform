import 'server-only';

import { redirect } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { requirePermission } from '../../../../auth/guard';
import { bookingBookerName } from '../../../../booking/booker-name';

export const notetakerPath = '/app/calendar/notetaker';

export async function requireNotetaker(action: 'view' | 'update') {
  const session = await requirePermission('employeeIntelligence', action);
  if (!['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'].includes(session.systemRole)) redirect('/crm/unauthorized');
  return session;
}

export function captureTitle(capture: { title: string | null; meetingUrl: string }, bookerName?: string) {
  if (bookerName) return bookerName;
  if (capture.title) return capture.title;
  const platform = new URL(capture.meetingUrl).hostname;
  if (platform === 'meet.google.com') return 'Google Meet call';
  return 'Meeting on ' + platform;
}

export async function notetakerBookerNames(
  session: { organizationId: string; userId: string },
  captures: readonly { id: string; meetingUrl: string; meetingAt: Date | null }[],
) {
  const booked = captures.filter(capture => capture.meetingAt !== null);
  if (!booked.length) return new Map<string, string>();
  const bookings = await prisma.booking.findMany({
    where: {
      organizationId: session.organizationId,
      calendarProvider: 'GOOGLE_BOOKING',
      AND: [
        { attributes: { path: ['profileUserId'], equals: session.userId } },
        { attributes: { path: ['source'], equals: 'employee-booking-request' } },
      ],
      OR: booked.map(capture => ({
        startAt: capture.meetingAt!,
        attributes: { path: ['meetUrl'], equals: capture.meetingUrl },
      })),
    },
    select: { attributes: true, startAt: true },
  });
  const captureIds = new Map(booked.map(capture => [
    capture.meetingUrl + ' ' + capture.meetingAt!.toISOString(), capture.id,
  ]));
  const names = new Map<string, string>();
  for (const booking of bookings) {
    const attrs = booking.attributes as { meetUrl?: unknown } | null;
    const name = bookingBookerName(attrs);
    if (!name || typeof attrs?.meetUrl !== 'string') continue;
    const captureId = captureIds.get(attrs.meetUrl + ' ' + booking.startAt.toISOString());
    if (captureId) names.set(captureId, name);
  }
  return names;
}

export function captureDate(capture: { meetingAt: Date | null; createdAt: Date }, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone })
    .format(capture.meetingAt ?? capture.createdAt) + ` (${timeZone.replaceAll('_', ' ')})`;
}

export async function notetakerTimeZone(session: { organizationId: string; userId: string }) {
  const user = await prisma.user.findFirst({
    where: { id: session.userId, organizationId: session.organizationId },
    select: { employeeBookingProfile: { select: { timeZone: true } } },
  });
  return user?.employeeBookingProfile?.timeZone ?? 'America/New_York';
}
