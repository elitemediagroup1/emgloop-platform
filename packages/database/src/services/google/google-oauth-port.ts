// The Google OAuth port, assembled. ONE assembly, for every runtime that holds the connection.
//
// Architecture: docs/architecture/google-workspace-connection.md §11; DL-5.
//
// WHY THIS IS NOT IN THE WEB APP ANY MORE. Two runtimes now refresh Google tokens: the Next.js
// server, serving a person who is looking at Loop, and the scheduled Calendar cycle, running for
// employees who are not. Assembling the port twice would mean two places to keep `redirect:
// 'error'`, the no-store cache and the ID-token verification correct, and the second one would
// drift. So the assembly is here, and each runtime supplies its configuration.
//
// IT HOLDS NOTHING. No environment is read, no key is stored, no token is logged. The caller
// passes a validated configuration (@emgloop/shared `readGoogleEnvironment`) and, where it has
// one, a signing-key set to share across requests.

import {
  GoogleSigningKeys,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  verifyGoogleIdToken,
} from '@emgloop/providers';

import type { GoogleOAuthPort } from './google-workspace.service';

/** Every Google call this platform makes goes through a fetch of this shape. */
export type GoogleFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/** A validated Google client configuration. Never a partial one -- see `readGoogleEnvironment`. */
export interface GoogleClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * The network, hardened the same way in every runtime.
 *
 * `redirect: 'error'` so a redirected token endpoint is a failure rather than a surprise, and
 * `cache: 'no-store'` so no framework caches a token response. Next.js caches server fetches by
 * default; that default must never reach Google.
 */
// `cache` is not in this package's RequestInit types (it has no DOM lib), and is a real,
// spec-valid field at runtime on every platform Loop runs on.
const NO_STORE = { cache: 'no-store' } as RequestInit;

export const googleFetch: GoogleFetch = (input, init) => fetch(input, { ...init, ...NO_STORE, redirect: 'error' });

export interface GoogleOAuthPortDeps {
  /** Injected by tests, and by a runtime that wants its own instrumentation. */
  readonly fetchImpl?: GoogleFetch;
  /**
   * Google's published signing keys. A long-lived server passes one instance so Google's cache
   * headers -- not each request -- decide when they are fetched again.
   */
  readonly signingKeys?: GoogleSigningKeys;
}

export function createGoogleOAuthPort(config: GoogleClientConfig, deps: GoogleOAuthPortDeps = {}): GoogleOAuthPort {
  const fetchImpl = deps.fetchImpl ?? googleFetch;
  const signingKeys = deps.signingKeys ?? new GoogleSigningKeys({ fetchImpl });
  const client = { clientId: config.clientId, clientSecret: config.clientSecret };
  return {
    authorizationUrl: (request) => googleAuthorizationUrl({ clientId: config.clientId, redirectUri: config.redirectUri, ...request }),
    exchangeCode: (code) => exchangeGoogleAuthorizationCode({ fetchImpl, client, redirectUri: config.redirectUri, code }),
    refresh: (refreshToken) => refreshGoogleAccessToken({ fetchImpl, client, refreshToken }),
    revoke: (token) => revokeGoogleToken({ fetchImpl, token }),
    signingKeysReady: () => signingKeys.ready(),
    checkIdToken: (idToken, expected) => verifyGoogleIdToken(idToken, { clientId: config.clientId, signingKeys, ...expected }),
  };
}
