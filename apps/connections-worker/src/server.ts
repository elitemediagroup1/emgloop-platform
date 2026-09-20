// The worker's control surface: the few endpoints the Loop web tier calls to drive an interactive
// Telegram login and to disconnect. Every call is signature-verified (verifyWorkerRequest) against
// the shared control secret, so only the Loop web tier is honoured. `handleControlRequest` is the
// pure router (testable without a socket); `createControlServer` wires Node http to it.
//
// The organization and user arrive in the SIGNED body (the web tier resolved them from the session).
// The worker still re-checks the membership before it writes a credential (storeCredential), so a
// signed-but-wrong pair cannot mint one. No secret, code, password or session string is ever logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';

import type { TelegramLoginBinding, TelegramLoginStatus } from './telegram/telegram-login';

export interface ControlHandlers {
  startLogin(binding: TelegramLoginBinding, phone: string): Promise<TelegramLoginStatus>;
  submitCode(binding: TelegramLoginBinding, code: string): Promise<TelegramLoginStatus>;
  submitPassword(binding: TelegramLoginBinding, password: string): Promise<TelegramLoginStatus>;
  cancelLogin(binding: TelegramLoginBinding): Promise<void>;
  disconnect(binding: TelegramLoginBinding): Promise<'DISCONNECTED' | 'NOTHING_TO_DO'>;
}

export interface ControlDeps {
  readonly secret: string;
  readonly handlers: ControlHandlers;
  readonly now?: () => Date;
}

export interface ControlResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function bindingOf(payload: Record<string, unknown>): TelegramLoginBinding | null {
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId : '';
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  return organizationId && userId ? { organizationId, userId } : null;
}

/** Route one signed control request. Never throws; unknown/bad requests are plain status codes. */
export async function handleControlRequest(
  input: { method: string; path: string; body: string; headers: Record<string, unknown> },
  deps: ControlDeps,
): Promise<ControlResponse> {
  if (input.method === 'GET' && input.path === '/healthz') return { status: 200, body: { ok: true } };
  if (input.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };

  const signature = input.headers[WORKER_SIGNATURE_HEADER];
  const timestamp = input.headers[WORKER_TIMESTAMP_HEADER];
  if (!verifyWorkerRequest(deps.secret, { body: input.body, signature, timestamp, now: deps.now?.() })) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.body || '{}');
  } catch {
    return { status: 400, body: { error: 'bad_json' } };
  }
  const binding = bindingOf(payload);
  if (!binding) return { status: 400, body: { error: 'binding_required' } };

  try {
    switch (input.path) {
      case '/telegram/login/start':
        return { status: 200, body: { status: await deps.handlers.startLogin(binding, String(payload.phone ?? '')) } };
      case '/telegram/login/code':
        return { status: 200, body: { status: await deps.handlers.submitCode(binding, String(payload.code ?? '')) } };
      case '/telegram/login/password':
        return { status: 200, body: { status: await deps.handlers.submitPassword(binding, String(payload.password ?? '')) } };
      case '/telegram/login/cancel':
        await deps.handlers.cancelLogin(binding);
        return { status: 200, body: { ok: true } };
      case '/telegram/disconnect':
        return { status: 200, body: { outcome: await deps.handlers.disconnect(binding) } };
      default:
        return { status: 404, body: { error: 'not_found' } };
    }
  } catch {
    // Never leak an internal error (which could carry a code/session in a message).
    return { status: 500, body: { error: 'worker_error' } };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) return; // control payloads are tiny; ignore anything larger
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

export function createControlServer(deps: ControlDeps): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const result = await handleControlRequest({ method: req.method ?? 'GET', path, body, headers }, deps);
    res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result.body));
  });
}
