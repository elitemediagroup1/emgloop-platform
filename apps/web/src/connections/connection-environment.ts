// The ONE module in the web application that reads the Teams/Telegram connection environment.
// SERVER ONLY, fenced like google-environment.ts: no other file reads these names, none is ever
// NEXT_PUBLIC_, and no client component can reach this module.
//
// THE WEB TIER HOLDS NO SESSION-SEALING KEY. Sealing and opening a per-person session belongs to
// the durable worker; this tier only needs to know which providers are enabled and how to reach the
// worker that runs their authentication. The worker control secret authenticates the web tier to
// the worker (a class credential); it is server-only and never leaves this module except into a
// signed request.
//
// OFF UNTIL CONNECTABLE, HONESTLY. A provider is connectable only when it is enabled AND the worker
// is reachable (URL + control secret set). Short of that the state is NOT_CONFIGURED and every
// connect attempt is refused before anything happens.

import 'server-only';

import { CONNECTION_PROVIDERS, isConnectionProvider, type ConnectionProvider } from '@emgloop/shared';

export const CONNECTION_ENVIRONMENT = Object.freeze({
  /** Comma-separated CONNECTION_PROVIDERS the deployment has enabled. */
  providers: 'LOOP_CONNECTION_PROVIDERS',
  /** Base URL of the durable connections worker (its control endpoints). */
  workerUrl: 'LOOP_CONNECTIONS_WORKER_URL',
  /** Shared secret for signing web -> worker control calls (matches the worker's own). */
  workerSecret: 'LOOP_CONNECTIONS_WORKER_SECRET',
} as const);

export type ConnectionEnvironmentSource = Partial<Record<string, string | undefined>>;

export interface ConnectionWorkerEndpoint {
  readonly url: string;
  readonly secret: string;
}

export type ConnectionEnvironment =
  | { readonly state: 'NOT_CONFIGURED' }
  | { readonly state: 'CONFIGURED'; readonly providers: ReadonlySet<ConnectionProvider>; readonly worker: ConnectionWorkerEndpoint };

function parseProviders(raw: string | undefined): ReadonlySet<ConnectionProvider> {
  const set = new Set<ConnectionProvider>();
  for (const name of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (isConnectionProvider(name)) set.add(name);
  return set;
}

function validUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * This runtime's connection configuration. CONFIGURED requires at least one enabled provider AND a
 * reachable worker (valid URL + a control secret); anything short is NOT_CONFIGURED.
 */
export function readConnectionEnvironment(source: ConnectionEnvironmentSource = process.env): ConnectionEnvironment {
  const providers = parseProviders(source[CONNECTION_ENVIRONMENT.providers]);
  const url = validUrl(source[CONNECTION_ENVIRONMENT.workerUrl]);
  const secret = source[CONNECTION_ENVIRONMENT.workerSecret]?.trim() ?? '';
  if (providers.size === 0 || !url || secret === '') return { state: 'NOT_CONFIGURED' };
  return { state: 'CONFIGURED', providers, worker: { url, secret } };
}

/** The full provider list, for a surface that renders every tile regardless of configuration. */
export function allConnectionProviders(): readonly ConnectionProvider[] {
  return CONNECTION_PROVIDERS;
}
