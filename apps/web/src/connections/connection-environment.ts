// The ONE module in the web application that reads the Teams/Telegram connection environment.
// SERVER ONLY, and fenced like `google-environment.ts`: no other file in `apps/web` reads these
// names, none is ever NEXT_PUBLIC_, and no client component can reach this module. Values never
// leave it except into the connection secret sealer.
//
// OFF UNTIL CONFIGURED, AND HONESTLY SO. With none of the names set the state is NOT_CONFIGURED and
// every connect attempt is refused before anything is written -- which is the truthful state until a
// deployment holds the connection secret key AND names the providers whose durable worker + app
// credentials exist. A provider is "configured" here only when the deployment has declared it; the
// web tier holds no provider app secret (those live with the worker), only the key that seals the
// per-person credential the worker returns.
//
// A malformed key is treated as absent: fail closed to NOT_CONFIGURED rather than seal with a key
// that cannot round-trip.

import 'server-only';

import { CONNECTION_PROVIDERS, isConnectionProvider, type ConnectionProvider } from '@emgloop/shared';

export const CONNECTION_ENVIRONMENT = Object.freeze({
  /** 32 bytes, base64. The key that seals each person's connection credential. */
  secretKey: 'LOOP_CONNECTION_SECRET_KEY',
  /** Comma-separated CONNECTION_PROVIDERS the deployment has enabled (worker + app creds exist). */
  providers: 'LOOP_CONNECTION_PROVIDERS',
} as const);

export type ConnectionEnvironmentSource = Partial<Record<string, string | undefined>>;

export type ConnectionEnvironment =
  | { readonly state: 'NOT_CONFIGURED' }
  | { readonly state: 'CONFIGURED'; readonly secretKey: Uint8Array; readonly providers: ReadonlySet<ConnectionProvider> };

function decodeKey(raw: string | undefined): Uint8Array | null {
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw.trim(), 'base64');
    return bytes.length === 32 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

function parseProviders(raw: string | undefined): ReadonlySet<ConnectionProvider> {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const set = new Set<ConnectionProvider>();
  for (const name of names) if (isConnectionProvider(name)) set.add(name);
  return set;
}

/**
 * This runtime's connection configuration. CONFIGURED requires a valid key AND at least one
 * enabled provider; anything short of that is NOT_CONFIGURED, and every provider absent from the
 * enabled set stays NOT_CONFIGURED even when the key is present.
 */
export function readConnectionEnvironment(source: ConnectionEnvironmentSource = process.env): ConnectionEnvironment {
  const secretKey = decodeKey(source[CONNECTION_ENVIRONMENT.secretKey]);
  const providers = parseProviders(source[CONNECTION_ENVIRONMENT.providers]);
  if (!secretKey || providers.size === 0) return { state: 'NOT_CONFIGURED' };
  return { state: 'CONFIGURED', secretKey, providers };
}

/** The full provider list, for a surface that renders every tile regardless of configuration. */
export function allConnectionProviders(): readonly ConnectionProvider[] {
  return CONNECTION_PROVIDERS;
}
