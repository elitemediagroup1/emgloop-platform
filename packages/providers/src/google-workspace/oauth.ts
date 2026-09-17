// Google OAuth 2.0 for the Google Workspace connection: the protocol, and nothing else.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.4. Re-read against
// Google's documentation on 2026-09-17:
//   - the web-server (authorization code) flow: developers.google.com/identity/protocols/oauth2/web-server
//   - OpenID Connect: developers.google.com/identity/openid-connect/openid-connect
//
// WHAT THIS FILE DOES NOT DO. It reads no environment variable, holds no key, stores
// nothing and decides nothing about who may connect. The client id, secret and redirect
// URI are handed in by the one server-only module that reads them. The network is handed
// in as `fetchImpl`, so every request shape is tested without a live call.
//
// NOTHING SECRET LEAVES THROUGH A FAILURE. A failure is a CLASS. Google's error text, a
// response body, an authorization code, a token and the client secret never appear in a
// returned value, a thrown error or a log line here.
//
// PKCE. Google's web-server guide documents `state` and the client secret for this flow
// and does not document `code_challenge` for it (checked 2026-09-17), so this flow uses
// state (single-use, session-bound, stored hashed by the caller) plus a `nonce` bound to
// the ID token, rather than an undocumented parameter.

export const GOOGLE_OAUTH_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});

/** Google's documented issuers for an ID token. */
export const GOOGLE_ID_TOKEN_ISSUERS: readonly string[] = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

/** Every Google call gives up after this long. A slow Google never holds a request open. */
export const GOOGLE_OAUTH_TIMEOUT_MS = 10_000;

/** A small allowance for clock skew when checking an ID token's times. */
export const GOOGLE_ID_TOKEN_SKEW_SECONDS = 60;

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface GoogleAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly nonce: string;
  /** The `sub` of the account already connected, so Google offers that account first. */
  readonly loginHint?: string | null;
}

/**
 * The authorization URL for one connect attempt (web-server flow).
 *
 * `access_type=offline` asks for a refresh token so Loop can read later without the
 * person present. `include_granted_scopes=true` makes the grant cumulative, which is
 * how capabilities are added one at a time. `prompt=consent` shows Google's consent
 * screen every time, so each capability is an explicit act and a refresh token is issued.
 * No `hd` hint is sent: the audience is External, and any domain restriction is enforced
 * on the ID token, not suggested in the request.
 */
export function googleAuthorizationUrl(request: GoogleAuthorizationRequest): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: request.state,
    nonce: request.nonce,
  });
  if (request.loginHint) params.set('login_hint', request.loginHint);
  return `${GOOGLE_OAUTH_ENDPOINTS.authorize}?${params.toString()}`;
}

/**
 * Why a Google call did not produce what was asked.
 *
 *   INVALID_GRANT   Google refused the code or refresh token (expired, revoked, reused).
 *   INVALID_CLIENT  the client id or secret was refused: a deployment problem.
 *   REJECTED        any other error response.
 *   MALFORMED       a success status with a body that is not what Google documents.
 *   NETWORK         no response.
 *   TIMEOUT         no response in time.
 */
export type GoogleOAuthFailure = 'INVALID_GRANT' | 'INVALID_CLIENT' | 'REJECTED' | 'MALFORMED' | 'NETWORK' | 'TIMEOUT';

export interface GoogleTokenGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** Present when the request asked for offline access and Google issued one. */
  readonly refreshToken: string | null;
  /** Space-delimited scopes Google granted: the only source of what was granted. */
  readonly scope: string | null;
  /** Present when `openid` was requested. */
  readonly idToken: string | null;
}

export type GoogleTokenResult = { readonly ok: true; readonly grant: GoogleTokenGrant } | { readonly ok: false; readonly failure: GoogleOAuthFailure };

interface CallOptions {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
}

async function post(options: CallOptions, url: string, body: URLSearchParams | null): Promise<{ status: number; payload: unknown } | GoogleOAuthFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body ? body.toString() : '',
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } catch {
    return controller.signal.aborted ? 'TIMEOUT' : 'NETWORK';
  } finally {
    clearTimeout(timer);
  }
}

function errorClass(status: number, payload: unknown): GoogleOAuthFailure {
  const code = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  if (code === 'invalid_grant') return 'INVALID_GRANT';
  if (code === 'invalid_client' || code === 'unauthorized_client' || status === 401) return 'INVALID_CLIENT';
  return 'REJECTED';
}

function tokenGrant(payload: unknown): GoogleTokenGrant | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.access_token !== 'string' || p.access_token === '') return null;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const expires = typeof p.expires_in === 'number' && Number.isFinite(p.expires_in) && p.expires_in > 0 ? Math.floor(p.expires_in) : 0;
  return {
    accessToken: p.access_token,
    expiresInSeconds: expires,
    refreshToken: str(p.refresh_token),
    scope: str(p.scope),
    idToken: str(p.id_token),
  };
}

async function tokenCall(options: CallOptions, body: URLSearchParams): Promise<GoogleTokenResult> {
  const result = await post(options, GOOGLE_OAUTH_ENDPOINTS.token, body);
  if (typeof result === 'string') return { ok: false, failure: result };
  if (result.status !== 200) return { ok: false, failure: errorClass(result.status, result.payload) };
  const grant = tokenGrant(result.payload);
  return grant ? { ok: true, grant } : { ok: false, failure: 'MALFORMED' };
}

export interface GoogleClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Exchange an authorization code at the token endpoint. The redirect URI must be the exact one requested. */
export function exchangeGoogleAuthorizationCode(
  options: CallOptions & { readonly client: GoogleClientCredentials; readonly redirectUri: string; readonly code: string },
): Promise<GoogleTokenResult> {
  return tokenCall(
    options,
    new URLSearchParams({
      code: options.code,
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }),
  );
}

/** A fresh access token from a stored refresh token. `INVALID_GRANT` means the grant is gone. */
export function refreshGoogleAccessToken(
  options: CallOptions & { readonly client: GoogleClientCredentials; readonly refreshToken: string },
): Promise<GoogleTokenResult> {
  return tokenCall(
    options,
    new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: 'refresh_token',
    }),
  );
}

export type GoogleRevokeResult = { readonly ok: true } | { readonly ok: false; readonly failure: GoogleOAuthFailure };

/**
 * Ask Google to revoke a token (and with it the grant it belongs to). The token goes in the
 * `token` parameter, as Google's web-server guide shows. An already-invalid token answers
 * `invalid_token`, which means there is nothing left to revoke: that counts as revoked.
 */
export async function revokeGoogleToken(options: CallOptions & { readonly token: string }): Promise<GoogleRevokeResult> {
  const url = `${GOOGLE_OAUTH_ENDPOINTS.revoke}?${new URLSearchParams({ token: options.token }).toString()}`;
  const result = await post(options, url, null);
  if (typeof result === 'string') return { ok: false, failure: result };
  if (result.status === 200) return { ok: true };
  const code = result.payload && typeof result.payload === 'object' ? (result.payload as { error?: unknown }).error : undefined;
  if (result.status === 400 && code === 'invalid_token') return { ok: true };
  return { ok: false, failure: errorClass(result.status, result.payload) };
}

export interface GoogleIdentity {
  /** The stable, never-reused account id. The only identifier Loop links by. */
  readonly subject: string;
  /** Display and audit only; reassignable inside a Workspace. */
  readonly email: string;
  /** The Workspace domain, or null for an account outside any Workspace. */
  readonly hostedDomain: string | null;
}

export type GoogleIdTokenRefusal =
  | 'MALFORMED'
  | 'ISSUER'
  | 'AUDIENCE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'NONCE'
  | 'EMAIL_UNVERIFIED'
  | 'DOMAIN_NOT_ALLOWED';

export type GoogleIdTokenResult = { readonly ok: true; readonly identity: GoogleIdentity } | { readonly ok: false; readonly refusal: GoogleIdTokenRefusal };

function base64UrlJson(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Check the claims of an ID token that came DIRECTLY from Google's token endpoint.
 *
 * Google's OpenID Connect guide: a token received over an intermediary-free HTTPS
 * channel, in an exchange authenticated with the client secret, "really comes from
 * Google and is valid" -- so its signature is not re-verified here. That holds ONLY for a
 * token this server just received from the token endpoint; a token from anywhere else
 * must never be passed here. The claims are still checked, as the architecture requires:
 * issuer, audience (and `azp`), expiry, issue time, the nonce this attempt sent, a
 * verified email, and -- only when the organization configured one -- the Workspace domain.
 */
export function checkGoogleIdTokenClaims(
  idToken: string,
  expected: {
    readonly clientId: string;
    /** Whether the token's `nonce` is the one this attempt sent. The caller holds only its hash. */
    readonly nonceMatches: (nonce: string) => boolean;
    readonly nowSeconds: number;
    /** Lower-case domains. Empty: no restriction, and accounts outside any Workspace are allowed. */
    readonly allowedHostedDomains: readonly string[];
    readonly skewSeconds?: number;
  },
): GoogleIdTokenResult {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return { ok: false, refusal: 'MALFORMED' };
  const header = base64UrlJson(parts[0]);
  const claims = base64UrlJson(parts[1]);
  if (!header || !claims || header.alg === 'none') return { ok: false, refusal: 'MALFORMED' };

  const skew = expected.skewSeconds ?? GOOGLE_ID_TOKEN_SKEW_SECONDS;
  if (typeof claims.iss !== 'string' || !GOOGLE_ID_TOKEN_ISSUERS.includes(claims.iss)) return { ok: false, refusal: 'ISSUER' };

  const aud = claims.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
  if (!audiences.includes(expected.clientId)) return { ok: false, refusal: 'AUDIENCE' };
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expected.clientId) return { ok: false, refusal: 'AUDIENCE' };

  if (typeof claims.exp !== 'number' || claims.exp + skew <= expected.nowSeconds) return { ok: false, refusal: 'EXPIRED' };
  if (typeof claims.iat === 'number' && claims.iat - skew > expected.nowSeconds) return { ok: false, refusal: 'NOT_YET_VALID' };

  if (typeof claims.nonce !== 'string' || claims.nonce === '' || !expected.nonceMatches(claims.nonce)) return { ok: false, refusal: 'NONCE' };

  if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) return { ok: false, refusal: 'MALFORMED' };
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return { ok: false, refusal: 'EMAIL_UNVERIFIED' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, refusal: 'EMAIL_UNVERIFIED' };

  const hostedDomain = typeof claims.hd === 'string' && claims.hd !== '' ? claims.hd.toLowerCase() : null;
  if (expected.allowedHostedDomains.length > 0 && (!hostedDomain || !expected.allowedHostedDomains.includes(hostedDomain))) {
    return { ok: false, refusal: 'DOMAIN_NOT_ALLOWED' };
  }

  return { ok: true, identity: { subject: claims.sub, email: claims.email, hostedDomain } };
}
