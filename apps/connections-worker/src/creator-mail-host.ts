// AWS owns the durable refresh loop. The existing web runtime retains Google grants and executes the
// governed read/model call. This channel carries only a signed fixed-purpose trigger and count results.
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
// Scan the due queue every minute; each authorized source is due only once per five minutes.
export const CREATOR_MAIL_TICK_MS = 60_000;
const ENDPOINTS = new Set(['https://app.emgloop.com/api/internal/creator-brand-updates', 'https://staging--emgloop2.netlify.app/api/internal/creator-brand-updates']);
export function readCreatorMailHostConfig(env: Record<string, string | undefined>) {
  const url = env.LOOP_CREATOR_MAIL_REFRESH_URL?.trim();
  if (!url) return null;
  if (!ENDPOINTS.has(url)) throw new Error('INVALID_CREATOR_MAIL_REFRESH_URL');
  const secret = env.LOOP_CONNECTIONS_WORKER_SECRET;
  if (!secret) throw new Error('MISSING_CREATOR_MAIL_REFRESH_SECRET');
  return { url, secret };
}
export function creatorMailHost(config: ReturnType<typeof readCreatorMailHostConfig>, ports: { fetch: typeof fetch; now: () => Date; log: (event: string, fields?: Record<string, unknown>) => void }) {
  let active: Promise<void> | null = null;
  let stopped = false;
  const pass = (): Promise<void> => {
    if (!config || stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      const body = '{"purpose":"creator-brand-updates","version":1}';
      try {
        const started = ports.now().getTime();
        for (let batch = 0; batch < 100 && !stopped && ports.now().getTime() - started < 4 * 60_000; batch++) {
          const signed = signWorkerRequest(config.secret, body, ports.now());
          const response = await ports.fetch(config.url, { method: 'POST', body, redirect: 'error', headers: { 'content-type': 'application/json', [WORKER_SIGNATURE_HEADER]: signed.signature, [WORKER_TIMESTAMP_HEADER]: signed.timestamp }, signal: AbortSignal.timeout(60_000) });
          if (!response.ok) { ports.log('creator_mail_refresh', { state: 'HTTP_FAILURE', status: response.status }); break; }
          const value: unknown = await response.json();
          if (!value || typeof value !== 'object') break;
          const result = value as { enabled?: unknown; outcomes?: unknown };
          if (result.enabled === false || !result.outcomes || typeof result.outcomes !== 'object') break;
          // Fixed result keys, counts only. Never relay arbitrary server output into CloudWatch.
          const allowed = ['PUBLISHED', 'UNCHANGED', 'WITHHELD', 'WITHDRAWN', 'SOURCE_UNAVAILABLE', 'NOT_PUBLISHED', 'FAILED'];
          const counts = Object.fromEntries(Object.entries(result.outcomes).filter(([key, n]) => allowed.includes(key) && Number.isInteger(n) && Number(n) >= 0));
          ports.log('creator_mail_refresh', counts);
          if (!Object.keys(counts).length) break;
        }
      } catch { ports.log('creator_mail_refresh', { state: 'FAILED' }); }
    })().finally(() => { active = null; });
    return active;
  };
  return { scheduled: !!config, pass, stop: async () => { stopped = true; await active; } };
}
