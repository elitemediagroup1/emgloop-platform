import 'server-only';

const meetApi = 'https://meet.googleapis.com/v2';

async function meetRequest(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${meetApi}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Google Meet request failed (${response.status}).`);
  return response.json() as Promise<unknown>;
}

export async function setAutomaticTranscription(token: string, meetingCode: string, enabled: boolean) {
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingCode)) throw new Error('Invalid Google Meet code.');
  const space = await meetRequest(`spaces/${meetingCode}`, token) as { name?: string };
  if (!space.name || !/^spaces\/[A-Za-z0-9_-]+$/.test(space.name)) {
    throw new Error('Google Meet did not return a meeting space.');
  }
  return meetRequest(`${space.name}?updateMask=config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      name: space.name,
      config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: enabled ? 'ON' : 'OFF' } } },
    }),
  });
}

interface TranscriptEntry {
  name: string;
  participant: string;
  text: string;
  startTime: string;
  endTime: string;
}

export async function readMeetTranscript(token: string, transcriptName: string): Promise<TranscriptEntry[]> {
  if (!/^conferenceRecords\/[A-Za-z0-9_-]+\/transcripts\/[A-Za-z0-9_-]+$/.test(transcriptName)) {
    throw new Error('Invalid Google Meet transcript reference.');
  }
  const entries: TranscriptEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ pageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await meetRequest(`${transcriptName}/entries?${query}`, token) as {
      transcriptEntries?: TranscriptEntry[];
      nextPageToken?: string;
    };
    entries.push(...(result.transcriptEntries ?? []));
    pageToken = result.nextPageToken;
    if (!pageToken) return entries;
  }
  throw new Error('Google Meet transcript pagination exceeded the supported limit.');
}
