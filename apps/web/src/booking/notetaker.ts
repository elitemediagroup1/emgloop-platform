import 'server-only';
import { prisma } from '@emgloop/database';
import { googleWorkspace } from '../google/google-runtime';
import { captureConfigured } from '../notetaker/recall';
import { scheduleCapture } from '../notetaker/capture';
import { setAutomaticTranscription } from './google-meet';

export async function prepareBookingTranscription(
  principal: { organizationId: string; userId: string },
  eventTypeId: unknown,
  attendeeEmails: readonly string[],
  meetUrl: string,
  startAt: Date,
) {
  if (typeof eventTypeId !== 'string') return 'off';
  const eventType = await prisma.employeeBookingEventType.findFirst({
    where: { id: eventTypeId, profileUserId: principal.userId, profile: { user: { organizationId: principal.organizationId } } },
    select: { notetakerPolicy: true, profile: { select: { notetakerDefault: true } } },
  });
  if (!eventType) return 'off';
  const policy = eventType.notetakerPolicy ?? eventType.profile.notetakerDefault;
  if (policy === 'OFF') return 'off';
  if (policy === 'EXTERNAL_ONLY') {
    const colleagues = await prisma.user.findMany({
      where: {
        organizationId: principal.organizationId, status: 'ACTIVE',
        memberships: { some: { organizationId: principal.organizationId, status: 'ACTIVE', systemRole: { in: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] } } },
        email: { in: [...attendeeEmails], mode: 'insensitive' },
      },
      select: { email: true },
    });
    const internal = new Set(colleagues.map(({ email }) => email.toLowerCase()));
    if (attendeeEmails.every(email => internal.has(email.toLowerCase()))) return 'off';
  }

  if (captureConfigured()) {
    return scheduleCapture(principal, meetUrl, startAt);
  }
  const connection = await googleWorkspace().accessToken(principal, 'meet');
  if (!connection.ok) return 'connection-required';
  const code = new URL(meetUrl).pathname.slice(1);
  await setAutomaticTranscription(connection.accessToken, code, true);
  return 'transcription-enabled';
}
