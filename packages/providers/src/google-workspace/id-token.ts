// Verifying a Google ID token: the signature first, against Google's published keys, and
// only then the claims.
//
// Architecture: docs/architecture/google-workspace-connection.md §12.3. Re-read against
// Google's documentation on 2026-09-17:
//   - OpenID Connect, "Validating an ID token": developers.google.com/identity/openid-connect/openid-connect
//   - the discovery document, accounts.google.com/.well-known/openid-configuration, which
//     names `jwks_uri` https://www.googleapis.com/oauth2/v3/certs and lists exactly one
//     `id_token_signing_alg_values_supported`: RS256.
//
// THE SIGNATURE IS VERIFIED EVEN THOUGH THE TOKEN CAME FROM GOOGLE'S TOKEN ENDPOINT. Google
// says that channel alone can be trusted; Loop links an employee's Google account on the
// strength of `sub`, so it does not rest that on the transport. Nothing in the payload --
// not `sub`, `email`, `hd` or any other claim -- is read until the signature has verified.
// The claim checks are private to this file: there is no way to check claims without
// verifying first.
//
// ONE ALGORITHM. The header must say RS256. `none`, HS256 (the "public key as HMAC secret"
// confusion), any other RSA or EC algorithm, and a missing `alg` are refused before a key
// is looked up. A key is taken only from Google's key set, never from the token's own
// header (`jwk`, `jku`, `x5u` and `x5c` are ignored), and only if it is an RSA signing key
// of at least 2048 bits that does not name another algorithm.
//
// KEYS ARE CACHED THE WAY GOOGLE SAYS. Google rotates its keys and publishes a new one
// before signing with it; the key set carries `Cache-Control: public, max-age=N,
// must-revalidate`. A key set is kept for max-age less the response's `Age`, capped at a
// day, and never used past that: once it is stale it is fetched again, and if that fetch
// fails the token is refused (must-revalidate: no stale keys). A response without max-age,
// or marked no-store / no-cache, is used for the one verification that fetched it.
// A `kid` the cached set does not hold means Google may have rotated since the set was
// fetched, so the set is fetched again -- at most once a minute, so a stream of invented
// key ids cannot turn into a stream of requests to Google.
//
// FAIL CLOSED, AND SAY NOTHING. A network error, a timeout, a non-200 answer, a body that
// is not a key set, an unknown key and a bad signature each refuse the token with a class.
// No token, key-set body or error text is returned, thrown or logged.

import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'crypto';

import { GOOGLE_OAUTH_TIMEOUT_MS } from './oauth';

/** Google's published signing keys: the discovery document's `jwks_uri`. */
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

/** The one algorithm accepted: the only one Google's discovery document lists. */
export const GOOGLE_ID_TOKEN_ALGORITHM = 'RS256';

/** Google's documented issuers for an ID token. */
export const GOOGLE_ID_TOKEN_ISSUERS: readonly string[] = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

/** A small allowance for clock skew when checking an ID token's times. */
export const GOOGLE_ID_TOKEN_SKEW_SECONDS = 60;

/** The longest a key set is kept, whatever its headers say. */
export const GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS = 24 * 60 * 60;

/** A key id the cached set does not hold refetches the set at most this often. */
export const GOOGLE_SIGNING_KEYS_REFRESH_INTERVAL_MS = 60_000;

const MIN_RSA_MODULUS_BITS = 2048;
const MAX_ID_TOKEN_LENGTH = 16_384;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export type GoogleSigningKeysFetch = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GoogleSigningKeysOptions {
  readonly fetchImpl: GoogleSigningKeysFetch;
  /** Milliseconds since the epoch. */
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly refreshIntervalMs?: number;
  readonly maxAgeSeconds?: number;
}

export type GoogleSigningKeyLookup =
  | { readonly ok: true; readonly key: KeyObject }
  | { readonly ok: false; readonly refusal: 'UNKNOWN_KEY' | 'KEYS_UNAVAILABLE' };

interface KeySet {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly expiresAtMs: number;
}

/** Seconds a key-set response may be used for, from its Cache-Control and Age headers. */
export function googleSigningKeysLifetimeSeconds(cacheControl: string | null, age: string | null, maxAgeSeconds = GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS): number {
  if (!cacheControl) return 0;
  const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
  if (directives.includes('no-store') || directives.includes('no-cache')) return 0;
  const maxAge = directives.map((d) => /^max-age=(\d{1,10})$/.exec(d)).find((m) => m !== null);
  if (!maxAge) return 0;
  const ageSeconds = age !== null && /^\d{1,10}$/.test(age.trim()) ? Number(age.trim()) : 0;
  return Math.max(0, Math.min(Number(maxAge[1]) - ageSeconds, maxAgeSeconds));
}

function keySetFrom(body: unknown): ReadonlyMap<string, KeyObject> | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown }).keys)) return null;
  const keys = new Map<string, KeyObject>();
  const repeated = new Set<string>();
  for (const entry of (body as { keys: unknown[] }).keys) {
    if (!entry || typeof entry !== 'object') continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !KEY_ID.test(jwk.kid)) continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    if (jwk.alg !== undefined && jwk.alg !== GOOGLE_ID_TOKEN_ALGORITHM) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) continue;
    if (keys.has(jwk.kid)) {
      // Two keys under one id: which one Google meant is unknowable, so neither is used.
      repeated.add(jwk.kid);
      continue;
    }
    try {
      const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) continue;
      keys.set(jwk.kid, key);
    } catch {
      continue;
    }
  }
  for (const kid of repeated) keys.delete(kid);
  return keys.size > 0 ? keys : null;
}

/**
 * Google's signing keys, fetched from GOOGLE_JWKS_URI and cached per Google's headers.
 * Hold one per server process so every request shares the cache.
 */
export class GoogleSigningKeys {
  private current: KeySet | null = null;
  private inFlight: Promise<KeySet | null> | null = null;
  private lastFetchStartedMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GoogleSigningKeysOptions) {}

  private now(): number {
    return this.options.nowMs ? this.options.nowMs() : Date.now();
  }

  /** Whether a usable key set is in hand, fetching one if the cached set is missing or stale. */
  async ready(): Promise<boolean> {
    return (await this.usable()) !== null;
  }

  /** The key Google published under `kid`, refetching once if the cached set may predate a rotation. */
  async keyFor(kid: string): Promise<GoogleSigningKeyLookup> {
    const set = await this.usable();
    if (!set) return { ok: false, refusal: 'KEYS_UNAVAILABLE' };
    const key = set.keys.get(kid);
    if (key) return { ok: true, key };
    if (this.now() - this.lastFetchStartedMs < (this.options.refreshIntervalMs ?? GOOGLE_SIGNING_KEYS_REFRESH_INTERVAL_MS)) {
      return { ok: false, refusal: 'UNKNOWN_KEY' };
    }
    const refreshed = await this.fetchSet();
    if (!refreshed) return { ok: false, refusal: 'KEYS_UNAVAILABLE' };
    const rotated = refreshed.keys.get(kid);
    return rotated ? { ok: true, key: rotated } : { ok: false, refusal: 'UNKNOWN_KEY' };
  }

  private usable(): Promise<KeySet | null> {
    if (this.current && this.now() < this.current.expiresAtMs) return Promise.resolve(this.current);
    return this.fetchSet();
  }

  /** One fetch at a time; callers arriving while it runs share its result. */
  private fetchSet(): Promise<KeySet | null> {
    if (!this.inFlight) {
      this.lastFetchStartedMs = this.now();
      this.inFlight = this.load()
        .then((set) => {
          if (set) this.current = set;
          else if (this.current && this.now() >= this.current.expiresAtMs) this.current = null;
          return set;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async load(): Promise<KeySet | null> {
    const startedMs = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS);
    try {
      const response = await this.options.fetchImpl(GOOGLE_JWKS_URI, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status !== 200) return null;
      const keys = keySetFrom(await response.json());
      if (!keys) return null;
      const lifetime = googleSigningKeysLifetimeSeconds(
        response.headers.get('cache-control'),
        response.headers.get('age'),
        this.options.maxAgeSeconds ?? GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS,
      );
      return { keys, expiresAtMs: startedMs + lifetime * 1000 };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface GoogleIdentity {
  /** The stable, never-reused account id. The only identifier Loop links by. */
  readonly subject: string;
  /** Display and audit only; reassignable inside a Workspace. */
  readonly email: string;
  /** The Workspace domain, or null for an account outside any Workspace. */
  readonly hostedDomain: string | null;
}

/**
 * Why an ID token was refused.
 *
 *   MALFORMED         not a three-part JWS, an unreadable header or payload, no key id,
 *                     a critical header extension, or an unusable `sub`.
 *   ALGORITHM         the header does not say RS256.
 *   KEYS_UNAVAILABLE  Google's keys could not be fetched: nothing could be verified.
 *   UNKNOWN_KEY       Google's current keys do not include the token's key id.
 *   SIGNATURE         the signature does not verify under Google's key.
 *   ISSUER / AUDIENCE / EXPIRED / NOT_YET_VALID / NONCE / EMAIL_UNVERIFIED / DOMAIN_NOT_ALLOWED
 *                     a verified token whose claims are not the ones this attempt expects.
 */
export type GoogleIdTokenRefusal =
  | 'MALFORMED'
  | 'ALGORITHM'
  | 'KEYS_UNAVAILABLE'
  | 'UNKNOWN_KEY'
  | 'SIGNATURE'
  | 'ISSUER'
  | 'AUDIENCE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'NONCE'
  | 'EMAIL_UNVERIFIED'
  | 'DOMAIN_NOT_ALLOWED';

export type GoogleIdTokenResult = { readonly ok: true; readonly identity: GoogleIdentity } | { readonly ok: false; readonly refusal: GoogleIdTokenRefusal };

export interface GoogleIdTokenExpectations {
  readonly clientId: string;
  /** Whether the token's `nonce` is the one this attempt sent. The caller holds only its hash. */
  readonly nonceMatches: (nonce: string) => boolean;
  readonly nowSeconds: number;
  /** Lower-case domains. Empty: no restriction, and accounts outside any Workspace are allowed. */
  readonly allowedHostedDomains: readonly string[];
  readonly skewSeconds?: number;
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const refuse = (refusal: GoogleIdTokenRefusal): GoogleIdTokenResult => ({ ok: false, refusal });

/**
 * Verify an ID token from Google's token endpoint and return the account it names.
 *
 * In order: the token's shape; the algorithm (RS256 only); Google's key for its `kid`;
 * the signature. Only a token whose signature verified has its claims read: issuer,
 * audience (and `azp`), expiry, issue time, the nonce this attempt sent, a verified email,
 * and -- only when the organization configured one -- the Workspace domain.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: GoogleIdTokenExpectations & { readonly signingKeys: GoogleSigningKeys },
): Promise<GoogleIdTokenResult> {
  if (typeof idToken !== 'string' || idToken.length > MAX_ID_TOKEN_LENGTH) return refuse('MALFORMED');
  const parts = idToken.split('.');
  if (parts.length !== 3) return refuse('MALFORMED');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  if (!SEGMENT.test(encodedHeader) || !SEGMENT.test(encodedPayload)) return refuse('MALFORMED');

  const header = base64UrlJson(encodedHeader);
  if (!header) return refuse('MALFORMED');
  if (header.alg !== GOOGLE_ID_TOKEN_ALGORITHM) return refuse('ALGORITHM');
  if (!SEGMENT.test(encodedSignature) || header.crit !== undefined) return refuse('MALFORMED');
  if (typeof header.kid !== 'string' || !KEY_ID.test(header.kid)) return refuse('MALFORMED');

  const lookup = await expected.signingKeys.keyFor(header.kid);
  if (!lookup.ok) return refuse(lookup.refusal);

  let signed = false;
  try {
    signed = verifySignature(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      lookup.key,
      Buffer.from(encodedSignature, 'base64url'),
    );
  } catch {
    signed = false;
  }
  if (!signed) return refuse('SIGNATURE');

  // Only now is anything in the payload read.
  const claims = base64UrlJson(encodedPayload);
  if (!claims) return refuse('MALFORMED');
  return checkVerifiedClaims(claims, expected);
}

function checkVerifiedClaims(claims: Record<string, unknown>, expected: GoogleIdTokenExpectations): GoogleIdTokenResult {
  const skew = expected.skewSeconds ?? GOOGLE_ID_TOKEN_SKEW_SECONDS;
  if (typeof claims.iss !== 'string' || !GOOGLE_ID_TOKEN_ISSUERS.includes(claims.iss)) return refuse('ISSUER');

  const aud = claims.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
  if (!audiences.includes(expected.clientId)) return refuse('AUDIENCE');
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expected.clientId) return refuse('AUDIENCE');

  if (typeof claims.exp !== 'number' || claims.exp + skew <= expected.nowSeconds) return refuse('EXPIRED');
  if (typeof claims.iat === 'number' && claims.iat - skew > expected.nowSeconds) return refuse('NOT_YET_VALID');

  if (typeof claims.nonce !== 'string' || claims.nonce === '' || !expected.nonceMatches(claims.nonce)) return refuse('NONCE');

  if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) return refuse('MALFORMED');
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return refuse('EMAIL_UNVERIFIED');
  if (claims.email_verified !== true && claims.email_verified !== 'true') return refuse('EMAIL_UNVERIFIED');

  const hostedDomain = typeof claims.hd === 'string' && claims.hd !== '' ? claims.hd.toLowerCase() : null;
  if (expected.allowedHostedDomains.length > 0 && (!hostedDomain || !expected.allowedHostedDomains.includes(hostedDomain))) {
    return refuse('DOMAIN_NOT_ALLOWED');
  }

  return { ok: true, identity: { subject: claims.sub, email: claims.email, hostedDomain } };
}
