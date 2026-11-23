import 'server-only';

const endpoint = 'https://us-west-2.recall.ai/api/v1/bot/';

export function captureConfigured() {
  return Boolean(process.env.RECALL_API_KEY);
}

export function validBotId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export async function recallRequest(path: string, method: 'GET' | 'POST', payload?: object) {
  const key = process.env.RECALL_API_KEY;
  if (!key) throw new Error('Meeting capture is unavailable.');
  const response = await fetch(endpoint + path, {
    method, redirect: 'error', cache: 'no-store',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Meeting capture provider request failed.');
  return response.status === 204 ? {} : response.json();
}

export const audioRecording = {
  start_recording_on: 'call_join',
  audio_mixed_mp3: {},
  video_mixed_mp4: null,
  participant_events: {},
  meeting_metadata: null,
};
