// The server-only client for the durable connections worker. Signs each control call with the
// shared secret (verifyWorkerRequest on the worker side) so the worker honours only the Loop web
// tier. The organization and user are resolved by the caller from the session and travel in the
// signed body; secrets in the body (phone, code, password) are sent over TLS to the worker and are
// never logged here.

import 'server-only';

import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';

import { connectionsWorkerEndpoint } from './source-connection-runtime';

export type WorkerCallResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'UNREACHABLE' | 'REJECTED' };

/** POST a signed control request to the worker. Never throws; never logs the body. */
export async function callWorker(path: string, payload: Record<string, unknown>): Promise<WorkerCallResult> {
  const endpoint = connectionsWorkerEndpoint();
  if (!endpoint) return { ok: false, reason: 'NOT_CONFIGURED' };
  const body = JSON.stringify(payload);
  const { signature, timestamp } = signWorkerRequest(endpoint.secret, body);
  try {
    const res = await fetch(`${endpoint.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: timestamp },
      body,
      cache: 'no-store',
      // A login step should not hang the request forever.
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 400) return { ok: false, reason: 'REJECTED' };
    if (!res.ok) return { ok: false, reason: 'UNREACHABLE' };
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, body: parsed };
  } catch {
    // Timeout, DNS, connection refused: the worker is not reachable. Never leak the error.
    return { ok: false, reason: 'UNREACHABLE' };
  }
}
