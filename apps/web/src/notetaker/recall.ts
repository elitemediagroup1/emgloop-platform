import 'server-only';

const endpoint = 'https://us-east-1.recall.ai/api/v1/';

export function captureConfigured() {
  return Boolean(process.env.RECALL_US_EAST_API_KEY);
}

export function validBotId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export async function recallRequest(path: string, method: 'GET' | 'POST', payload?: object) {
  return recallApiRequest('bot/' + path, method, payload);
}

export async function recallApiRequest(path: string, method: 'GET' | 'POST', payload?: object) {
  const key = process.env.RECALL_US_EAST_API_KEY;
  if (!key) throw new Error('Meeting capture is unavailable.');
  const response = await fetch(endpoint + path, {
    method, redirect: 'error', cache: 'no-store',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Meeting capture provider request failed.');
  const body = await response.text();
  return body ? JSON.parse(body) : {};
}

export const audioRecording = {
  start_recording_on: 'call_join',
  audio_mixed_mp3: {},
  video_mixed_mp4: null,
  participant_events: {},
  meeting_metadata: null,
};


const botStatuses = new Set([
  'joining_call', 'in_waiting_room', 'in_call_not_recording',
  'in_call_recording', 'call_ended', 'done', 'fatal',
]);

export function recallBotStatus(bot: { status_changes?: { code?: string }[] }): string | undefined {
  return bot.status_changes?.filter(({ code }) => typeof code === 'string' && botStatuses.has(code)).at(-1)?.code;
}
