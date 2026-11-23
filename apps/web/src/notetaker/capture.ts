import 'server-only';

import { randomUUID } from 'node:crypto';
import { prisma } from '@emgloop/database';
import { supportedMeetingUrl } from './meeting-link';
import { recallRequest, validBotId } from './recall';

interface Principal {
  organizationId: string;
  userId: string;
}

export function ownCaptures(principal: Principal) {
  return { organizationId: principal.organizationId, requestedById: principal.userId };
}

export async function scheduleCapture(principal: Principal, input: string, joinAt?: Date) {
  const meetingUrl = supportedMeetingUrl(input);
  if (!meetingUrl) return 'invalid';
  const id = randomUUID();
  const inserted = await prisma.meetingCapture.createMany({
    data: { ...ownCaptures(principal), id, meetingUrl, status: 'submitting' },
    skipDuplicates: true,
  });
  if (!inserted.count) return 'duplicate';

  try {
    const bot = await recallRequest('', 'POST', {
      meeting_url: meetingUrl,
      bot_name: 'EMG Loop Notetaker',
      recording_config: null,
      ...(joinAt ? { join_at: joinAt.toISOString() } : {}),
      metadata: { loop_capture_id: id },
    });
    if (!validBotId(bot.id)) return 'unknown';
    await prisma.meetingCapture.update({
      where: { id }, data: { providerBotId: bot.id, status: 'scheduled' },
    });
    return 'scheduled';
  } catch {
    // A timed-out create may have succeeded remotely. Keep the reservation to avoid a second bot.
    return 'unknown';
  }
}
