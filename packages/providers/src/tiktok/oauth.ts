// TikTok OAuth 2.0 for the Login Kit connection (Web): the protocol, and nothing else.
//
// Verified against developers.tiktok.com on 2026-09-23:
//   - Login Kit for Web: /doc/login-kit-web
//   - Manage user access tokens: /doc/oauth-user-access-token-management
//
// WHAT THIS FILE DOES NOT DO. It reads no environment variable, holds no key, stores nothing
// and decides nothing about who may connect. The client key, secret and redirect URI are handed
// in by the one server-only module that reads them. The network is handed in as `fetchImpl`,
// so every request shape is tested without a live call.
//
// NOTHING SECRET LEAVES THROUGH A FAILURE. A failure is a CLASS. TikTok's error text, a response
// body, an authorization code, a token and the client secret never appear in a returned value,
// a thrown error or a log line here.
//
// NO PKCE, BY TIKTOK'S OWN RULE. TikTok requires `code_verifier` for its mobile and desktop
// flows and documents the Web flow with `state` and the client secret. The CSRF defence for this
// flow is the single-use, session-bound state the caller stores hashed and consumes once.
//
// THE REFRESH TOKEN ROTATES. Every refresh answers with a NEW refresh token; the caller must
// store the returned one and forget the old. The access token lives 24 hours, the refresh token
// 365 days, as TikTok reports them in `expires_in` and `refresh_expires_in`.

export const TIKTOK_OAUTH_ENDPOINTS = Object.freeze({
  authorize: 'https://www.tiktok.com/v2/auth/authorize/',
  token: 'https://open.tiktokapis.com/v2/oauth/token/',
  revoke: 'https://open.tiktokapis.com/v2/oauth/revoke/',
});

/** Every TikTok call gives up after this long. A slow TikTok never holds a request open. */
export const TIKTOK_OAUTH_TIMEOUT_MS = 10_000;

export type TikTokFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TikTokAuthorizationRequest {
  readonly clientKey: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
}

/**
 * The authorization URL for one connect attempt (Login Kit for Web). The scopes travel
 * comma-separated, as TikTok documents; `state` is required and is the caller's single-use value.
 */
export function tiktokAuthorizationUrl(request: TikTokAuthorizationRequest): string {
  const params = new URLSearchParams({
    client_key: request.clientKey,
    scope: request.scopes.join(','),
    response_type: 'code',
    redirect_uri: request.redirectUri,
    state: request.state,
  });
  return `${TIKTOK_OAUTH_ENDPOINTS.authorize}?${params.toString()}`;
}

/**
 * Why a TikTok call did not produce what was asked.
 *
 *   INVALID_GRANT   TikTok refused the code or refresh token (expired, revoked, reused).
 *   INVALID_CLIENT  the client key or secret was refused: a deployment problem.
 *   REJECTED        any other error response.
 *   MALFORMED       a success status with a body that is not what TikTok documents.
 *   NETWORK         no response.
 *   TIMEOUT         no response in time.
 */
export type TikTokOAuthFailure = 'INVALID_GRANT' | 'INVALID_CLIENT' | 'REJECTED' | 'MALFORMED' | 'NETWORK' | 'TIMEOUT';

export interface TikTokTokenGrant {
  readonly accessToken: string;
  /** TikTok documents 86400 (24 hours). */
  readonly expiresInSeconds: number;
  /** The account's stable id for this app. Never the username. */
  readonly openId: string;
  /** Comma-separated scopes TikTok granted: the only source of what was granted. */
  readonly scope: string | null;
  /** Present on every exchange and every refresh (it rotates). */
  readonly refreshToken: string | null;
  /** TikTok documents 31536000 (365 days). */
  readonly refreshExpiresInSeconds: number;
}

export type TikTokTokenResult = { readonly ok: true; readonly grant: TikTokTokenGrant } | { readonly ok: false; readonly failure: TikTokOAuthFailure };

interface CallOptions {
  readonly fetchImpl: TikTokFetch;
  readonly timeoutMs?: number;
}

async function post(options: CallOptions, url: string, body: URLSearchParams): Promise<{ status: number; payload: unknown } | TikTokOAuthFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIKTOK_OAUTH_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'cache-control': 'no-cache' },
      body: body.toString(),
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

/** TikTok's `{ error, error_description, log_id }` error body, when the answer is one. */
function errorCode(payload: unknown): string | null {
  const code = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  return typeof code === 'string' && code !== '' ? code : null;
}

function errorClass(status: number, code: string | null): TikTokOAuthFailure {
  if (code === 'invalid_grant') return 'INVALID_GRANT';
  if (code === 'invalid_client' || code === 'unauthorized_client' || status === 401) return 'INVALID_CLIENT';
  return 'REJECTED';
}

function tokenGrant(payload: unknown): TikTokTokenGrant | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.access_token !== 'string' || p.access_token === '') return null;
  if (typeof p.open_id !== 'string' || p.open_id === '') return null;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    accessToken: p.access_token,
    expiresInSeconds: seconds(p.expires_in),
    openId: p.open_id,
    scope: str(p.scope),
    refreshToken: str(p.refresh_token),
    refreshExpiresInSeconds: seconds(p.refresh_expires_in),
  };
}

async function tokenCall(options: CallOptions, body: URLSearchParams): Promise<TikTokTokenResult> {
  const result = await post(options, TIKTOK_OAUTH_ENDPOINTS.token, body);
  if (typeof result === 'string') return { ok: false, failure: result };
  // TikTok answers an error body with a 4xx status; a body that names an error is an error
  // whatever the status, so a 200 that says `invalid_grant` is never read as a grant.
  const code = errorCode(result.payload);
  if (result.status !== 200 || code) return { ok: false, failure: errorClass(result.status, code) };
  const grant = tokenGrant(result.payload);
  return grant ? { ok: true, grant } : { ok: false, failure: 'MALFORMED' };
}

export interface TikTokClientCredentials {
  readonly clientKey: string;
  readonly clientSecret: string;
}

/** Exchange an authorization code at the token endpoint. The redirect URI must be the exact one requested. */
export function exchangeTikTokAuthorizationCode(
  options: CallOptions & { readonly client: TikTokClientCredentials; readonly redirectUri: string; readonly code: string },
): Promise<TikTokTokenResult> {
  return tokenCall(
    options,
    new URLSearchParams({
      client_key: options.client.clientKey,
      client_secret: options.client.clientSecret,
      code: options.code,
      grant_type: 'authorization_code',
      redirect_uri: options.redirectUri,
    }),
  );
}

/**
 * A fresh access token from a stored refresh token. The answer carries a NEW refresh token;
 * the caller stores that one. `INVALID_GRANT` means the grant is gone.
 */
export function refreshTikTokAccessToken(
  options: CallOptions & { readonly client: TikTokClientCredentials; readonly refreshToken: string },
): Promise<TikTokTokenResult> {
  return tokenCall(
    options,
    new URLSearchParams({
      client_key: options.client.clientKey,
      client_secret: options.client.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    }),
  );
}

export type TikTokRevokeResult = { readonly ok: true } | { readonly ok: false; readonly failure: TikTokOAuthFailure };

/**
 * Ask TikTok to revoke an access token (and with it the grant). The client credentials go with
 * it, as TikTok documents. An empty 200 is success. A token TikTok already considers invalid
 * grants nothing, so that answer counts as revoked; anything else is a failure class.
 */
export async function revokeTikTokToken(
  options: CallOptions & { readonly client: TikTokClientCredentials; readonly token: string },
): Promise<TikTokRevokeResult> {
  const result = await post(
    options,
    TIKTOK_OAUTH_ENDPOINTS.revoke,
    new URLSearchParams({ client_key: options.client.clientKey, client_secret: options.client.clientSecret, token: options.token }),
  );
  if (typeof result === 'string') return { ok: false, failure: result };
  const code = errorCode(result.payload);
  if (result.status === 200 && !code) return { ok: true };
  if (code === 'invalid_grant' || code === 'invalid_token') return { ok: true };
  return { ok: false, failure: errorClass(result.status, code) };
}
