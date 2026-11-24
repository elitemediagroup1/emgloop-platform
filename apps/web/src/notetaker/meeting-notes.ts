import 'server-only';

import { prisma, type MeetingCapture } from '@emgloop/database';
import { recallApiRequest, recallBotStatus, recallRequest, validBotId } from './recall';
import { formatRecallTranscript, recallTranscriptDownloadUrl } from './transcript';

type Artifact = {
  status?: { code?: string };
  data?: { download_url?: string | null };
};
type Recording = {
  id: string;
  started_at?: string | null;
  status?: { code?: string };
  media_shortcuts?: { audio_mixed?: Artifact | null; transcript?: Artifact | null };
};
type Bot = Parameters<typeof recallBotStatus>[0] & { recordings?: Recording[] };

async function downloadTranscript(address: string): Promise<string> {
  const url = recallTranscriptDownloadUrl(address);
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Could not read the Recall transcript.');
  return formatRecallTranscript(await response.json());
}

export async function updateMeetingTranscript(
  capture: Pick<MeetingCapture, 'id' | 'providerBotId' | 'transcript' | 'transcriptRequestedAt'>,
  currentBot?: Bot,
) {
  if (capture.transcript !== null || !validBotId(capture.providerBotId)) return;
  const bot = currentBot ?? await recallRequest(capture.providerBotId + '/', 'GET') as Bot;
  if (recallBotStatus(bot) !== 'done') return;
  const recordings = [...(bot.recordings ?? [])].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  const withAudio = recordings.filter(recording => recording.media_shortcuts?.audio_mixed);
  const audioFailed = withAudio.some(recording => ['failed', 'deleted'].includes(recording.media_shortcuts?.audio_mixed?.status?.code ?? ''));
  const ready = withAudio.filter(recording => recording.media_shortcuts?.audio_mixed?.status?.code === 'done');
  if (audioFailed || ready.length !== withAudio.length) {
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, transcript: null }, data: { transcriptState: audioFailed ? 'failed' : 'processing' },
    });
    return;
  }
  if (!ready.length) {
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, transcript: null }, data: { transcriptState: 'unavailable' },
    });
    return;
  }
  const artifacts = ready.map(recording => recording.media_shortcuts?.transcript);
  if (artifacts.every(artifact => artifact?.status?.code === 'done' && artifact.data?.download_url)) {
    const parts = await Promise.all(artifacts.map(artifact => downloadTranscript(artifact!.data!.download_url!)));
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, transcript: null },
      data: { transcript: parts.filter(Boolean).join('\n\n'), transcriptState: 'ready' },
    });
    return;
  }
  const missing = ready.filter(recording => !recording.media_shortcuts?.transcript && validBotId(recording.id));
  const failed = artifacts.some(artifact => ['failed', 'deleted'].includes(artifact?.status?.code ?? ''));
  if (!missing.length) {
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, transcript: null }, data: { transcriptState: failed ? 'failed' : 'processing' },
    });
    return;
  }
  const now = new Date();
  const claimed = await prisma.meetingCapture.updateMany({
    where: {
      id: capture.id, transcript: null,
      OR: [{ transcriptRequestedAt: null }, { transcriptRequestedAt: { lt: new Date(+now - 120_000) } }],
    },
    data: { transcriptRequestedAt: now, transcriptState: 'processing' },
  });
  if (!claimed.count) return;
  try {
    await Promise.all(missing.map(recording => recallApiRequest(
      `recording/${recording.id}/create_transcript/`, 'POST',
      { provider: { recallai_async: { language_code: 'auto' } }, diarization: { use_separate_streams_when_available: true } },
    )));
  } catch {
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, transcript: null, transcriptRequestedAt: now }, data: { transcriptState: 'failed' },
    });
  }
}
