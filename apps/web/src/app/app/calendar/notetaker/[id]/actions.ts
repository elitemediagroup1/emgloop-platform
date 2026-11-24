'use server';

import { prisma } from '@emgloop/database';
import { ownCaptures } from '../../../../../notetaker/capture';
import { updateMeetingTranscript } from '../../../../../notetaker/meeting-notes';
import { summarizeMeeting } from '../../../../../notetaker/summarize-meeting';
import { requireNotetaker } from '../meeting-display';

export async function loadMeetingNotes(id: string) {
  const session = await requireNotetaker('view');
  const where = { id, ...ownCaptures(session), status: 'done' };
  let capture = await prisma.meetingCapture.findFirst({ where });
  if (!capture) return 'unavailable';
  try {
    if (capture.transcript === null) {
      await updateMeetingTranscript(capture);
      capture = await prisma.meetingCapture.findFirst({ where });
      if (!capture) return 'unavailable';
      if (capture.transcriptState === 'failed') return 'failed';
      if (capture.transcriptState === 'unavailable') return 'unavailable';
      if (capture.transcript === null) return 'processing';
    }
    if (!capture.transcript) return 'ready';
    if (capture.summary) return 'ready';
    return await summarizeMeeting(capture);
  } catch {
    return 'failed';
  }
}
