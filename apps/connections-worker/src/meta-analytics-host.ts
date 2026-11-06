// Reuse the existing allowlisted creator-refresh host and signing key. No Meta tokens in AWS.
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import type { readCreatorMailHostConfig } from './creator-mail-host';
export function metaAnalyticsHost(config: ReturnType<typeof readCreatorMailHostConfig>, ports: { fetch: typeof fetch; now: () => Date; log: (event: string, fields?: Record<string, unknown>) => void }) {
  let active: Promise<void> | null = null;
  let stopped = false;
  const pass = (): Promise<void> => {
    if (!config || stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      const body = '{"purpose":"creator-meta-analytics","version":1}';
      const url = new URL('/api/internal/creator-meta-analytics', config.url).toString();
      try {
        for (let n = 0; n < 3 && !stopped; n++) {
          const signed = signWorkerRequest(config.secret, body, ports.now());
          const response = await ports.fetch(url, { method: 'POST', body, redirect: 'error', headers: { 'content-type': 'application/json', [WORKER_SIGNATURE_HEADER]: signed.signature, [WORKER_TIMESTAMP_HEADER]: signed.timestamp }, signal: AbortSignal.timeout(55_000) });
          if (!response.ok) { ports.log('meta_analytics_refresh', { state: 'HTTP_FAILURE', status: response.status }); break; }
          const result: unknown = await response.json();
          const count = result && typeof result === 'object' ? (result as { processed?: unknown }).processed : undefined;
          if (count !== 1) break;
          ports.log('meta_analytics_refresh', { processed: 1 });
        }
      } catch { ports.log('meta_analytics_refresh', { state: 'FAILED' }); }
    })().finally(() => { active = null; });
    return active;
  };
  return { scheduled: !!config, pass, stop: async () => { stopped = true; await active; } };
}
