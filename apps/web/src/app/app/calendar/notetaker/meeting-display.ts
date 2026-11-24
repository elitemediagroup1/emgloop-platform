import 'server-only';

import { redirect } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { requirePermission } from '../../../../auth/guard';

export const notetakerPath = '/app/calendar/notetaker';

export async function requireNotetaker(action: 'view' | 'update') {
  const session = await requirePermission('employeeIntelligence', action);
  if (!['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'].includes(session.systemRole)) redirect('/crm/unauthorized');
  return session;
}

export function captureTitle(capture: { title: string | null; meetingUrl: string }) {
  if (capture.title) return capture.title;
  const platform = new URL(capture.meetingUrl).hostname;
  if (platform === 'meet.google.com') return 'Google Meet call';
  return 'Meeting on ' + platform;
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
