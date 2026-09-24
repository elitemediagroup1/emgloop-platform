// TikTok Login Kit connection: the contract. PURE -- no I/O, no environment, no clock.
//
// A managed creator connects their OWN TikTok account to their Creator Hub profile, from a Loop
// session they already hold, as a separate, declinable act. CONNECTING IS NOT SIGNING IN:
// nothing here proves who a Loop user is.
//
// EXACTLY FOUR SCOPES, AND NO WIDER THAN THIS FILE. They are the scopes registered on the
// TikTok app "EMG Loop" (Login Kit, Web). A token response that reports any other scope is
// refused whole (`parseTikTokGrantedScopes`), so a broader grant can never be stored. TikTok
// lets a person untick a scope on its consent screen, so a NARROWER grant is a real thing and is
// stored as granted -- never as what Loop asked for.
//
// WHAT LOOP DOES WITH THE GRANT (and all it does): reads the account's public profile facts and
// counts, and the metadata of up to ten of its most recent public videos, when the creator opens
// their Profile page and the last read is older than TIKTOK_READ_MIN_INTERVAL_MS. The counts and
// the video summaries are recorded on the creator's profile as last read; follower counts also
// become audience observations labelled as coming from the platform. Loop posts nothing, reads no
// private video, and reads no other account.

/** The four scopes, in the order TikTok's consent screen lists them. Nothing else, ever. */
export const TIKTOK_SCOPES = Object.freeze(['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'] as const);
export type TikTokScope = (typeof TIKTOK_SCOPES)[number];

/** The one callback route. Registered on the TikTok app as `<APP_URL>` + this path, exactly. */
export const TIKTOK_CALLBACK_PATH = '/api/integrations/tiktok/callback';

export const TIKTOK_SCOPE_LABELS: Readonly<Record<TikTokScope, string>> = Object.freeze({
  'user.info.basic': 'Basic account info',
  'user.info.profile': 'Public profile',
  'user.info.stats': 'Account counts',
  'video.list': 'Public video list',
});

/** What each scope lets Loop read -- and what it never can. Shown before consent. */
export const TIKTOK_SCOPE_READS: Readonly<Record<TikTokScope, string>> = Object.freeze({
  'user.info.basic': 'Your TikTok account id and display name, so Loop can tell which account is connected.',
  'user.info.profile': 'Your username, whether the account is verified, and the link to your public profile.',
  'user.info.stats': 'Your follower, following, likes and video counts, recorded as audience observations.',
  'video.list': 'The titles, links, posting dates and public counts of up to ten of your most recent public videos. Private videos are never returned by TikTok and are never read.',
});

export function isTikTokScope(value: unknown): value is TikTokScope {
  return typeof value === 'string' && (TIKTOK_SCOPES as readonly string[]).includes(value);
}

/** Canonical order, no duplicates. */
function scopesInOrder(scopes: Iterable<string>): TikTokScope[] {
  const wanted = new Set(scopes);
  return TIKTOK_SCOPES.filter((s) => wanted.has(s));
}

export type TikTokGrantedScopes =
  | { readonly ok: true; readonly scopes: readonly TikTokScope[] }
  | { readonly ok: false; readonly reason: 'MISSING' | 'UNEXPECTED_SCOPE' };

/**
 * What TikTok actually granted, read from a token response's COMMA-separated `scope`.
 *
 * Loop reads the GRANTED set, never what it asked for. Anything outside the four scopes refuses
 * the whole grant, so a wider token is never stored.
 */
export function parseTikTokGrantedScopes(scope: unknown): TikTokGrantedScopes {
  if (typeof scope !== 'string' || scope.trim() === '') return { ok: false, reason: 'MISSING' };
  const granted = [...new Set(scope.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s !== ''))];
  if (granted.length === 0) return { ok: false, reason: 'MISSING' };
  for (const entry of granted) if (!isTikTokScope(entry)) return { ok: false, reason: 'UNEXPECTED_SCOPE' };
  return { ok: true, scopes: scopesInOrder(granted) };
}

/** The scopes of the four a stored grant does NOT cover, in canonical order. */
export function tiktokMissingScopes(granted: readonly string[]): TikTokScope[] {
  return TIKTOK_SCOPES.filter((s) => !granted.includes(s));
}

/**
 * Where a connection stands. `REVOKED` keeps an audit trail and no credential; `EXPIRED` means
 * TikTok refused the stored refresh token (or it could not be opened), and Loop stopped calling.
 */
export const TIKTOK_CONNECTION_STATUSES = ['CONNECTED', 'EXPIRED', 'REVOKED'] as const;
export type TikTokConnectionStatus = (typeof TIKTOK_CONNECTION_STATUSES)[number];

/**
 * What the creator's Profile page shows.
 *
 *   NOT_CONFIGURED  this deployment has no TikTok client or token key; nothing can connect.
 *   NOT_CONNECTED   never granted, or disconnected. A permanent, legitimate state.
 *   CONNECTED       a live grant covering all four scopes.
 *   PARTIAL         a live grant with at least one scope declined on TikTok's screen.
 *   EXPIRED         granted, but TikTok no longer honours the connection; reconnect.
 */
export type TikTokConnectionState = 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'CONNECTED' | 'PARTIAL' | 'EXPIRED';

export function tiktokConnectionState(
  configured: boolean,
  connection: { readonly status: TikTokConnectionStatus; readonly grantedScopes: readonly string[] } | null,
): TikTokConnectionState {
  if (!configured) return 'NOT_CONFIGURED';
  if (!connection || connection.status === 'REVOKED') return 'NOT_CONNECTED';
  if (connection.status === 'EXPIRED') return 'EXPIRED';
  return tiktokMissingScopes(connection.grantedScopes).length === 0 ? 'CONNECTED' : 'PARTIAL';
}

/**
 * Every result a connect, callback, read or disconnect can end in. Each is a plain reason the
 * person is shown; none carries TikTok's own text, a token, a code or an account id.
 */
export const TIKTOK_CONNECT_OUTCOMES = [
  'CONNECTED',
  'PARTIAL',
  'ALREADY_CONNECTED',
  'DECLINED',
  'DIFFERENT_ACCOUNT',
  'ACCOUNT_IN_USE',
  'UNEXPECTED_SCOPE',
  'STATE_INVALID',
  'TOO_MANY_ATTEMPTS',
  'NOT_CONFIGURED',
  'NOT_PERMITTED',
  'INVALID_REQUEST',
  'FAILED',
  'DISCONNECTED',
  'DISCONNECTED_UNCONFIRMED',
  'NOT_CONNECTED',
] as const;
export type TikTokConnectOutcome = (typeof TIKTOK_CONNECT_OUTCOMES)[number];

export function isTikTokConnectOutcome(value: unknown): value is TikTokConnectOutcome {
  return typeof value === 'string' && (TIKTOK_CONNECT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Why Loop gave up a connection. Recorded on the connection and in the audit trail.
 *
 *   SELF_DISCONNECT  the creator disconnected TikTok. The only reason the code writes today.
 *   MEMBER_DISABLED  reserved: an administrator disabled the member (offboarding hook not built).
 *   MEMBER_REMOVED   reserved: an administrator removed the member (offboarding hook not built).
 */
export const TIKTOK_REVOCATION_REASONS = ['SELF_DISCONNECT', 'MEMBER_DISABLED', 'MEMBER_REMOVED'] as const;
export type TikTokRevocationReason = (typeof TIKTOK_REVOCATION_REASONS)[number];

/** Failure classes recorded on a connection. Never TikTok's text. */
export const TIKTOK_CONNECTION_FAILURE_CLASSES = [
  'REFRESH_REFUSED',
  'REVOKE_UNCONFIRMED',
  'REVOKE_SKIPPED_SHARED_GRANT',
  'TOKEN_UNOPENABLE',
  'READ_UNAVAILABLE',
  'READ_FORBIDDEN',
] as const;
export type TikTokConnectionFailureClass = (typeof TIKTOK_CONNECTION_FAILURE_CLASSES)[number];

/** Audit actions for the connection lifecycle. Ids, scopes and reasons only, never content. */
export const TIKTOK_CONNECTION_AUDIT_ACTIONS = Object.freeze({
  granted: 'tiktok.connection.granted',
  reconnected: 'tiktok.connection.reconnected',
  scopeChanged: 'tiktok.connection.scope_changed',
  revoked: 'tiktok.connection.revoked',
  revokeUnconfirmed: 'tiktok.connection.revoke_unconfirmed',
  expired: 'tiktok.connection.expired',
} as const);

/** A visit spends a TikTok call only when the last completed read is older than this. */
export const TIKTOK_READ_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** How many recent public videos one read lists. TikTok's own page maximum is 20; Loop asks for ten. */
export const TIKTOK_VIDEO_LIST_MAX = 10;

/** A stored video title is a label, not a document. */
export const TIKTOK_VIDEO_TITLE_MAX_CHARS = 140;

// --- What TikTok returns, in Loop's own shape --------------------------------------------------

/** The account facts one read yields. A field is null when its scope was not granted or TikTok sent nothing. */
export interface TikTokUserInfo {
  readonly openId: string;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly profileDeepLink: string | null;
  readonly isVerified: boolean | null;
  readonly followerCount: number | null;
  readonly followingCount: number | null;
  readonly likesCount: number | null;
  readonly videoCount: number | null;
}

/** One public video, as listed. Only the fields Loop asks for; no media, no cover image, no embed. */
export interface TikTokVideoSummary {
  readonly id: string;
  readonly title: string | null;
  readonly shareUrl: string | null;
  /** ISO-8601 instant, from TikTok's Unix `create_time`. */
  readonly createdAt: string | null;
  readonly viewCount: number | null;
  readonly likeCount: number | null;
  readonly commentCount: number | null;
  readonly shareCount: number | null;
}

export interface TikTokAudienceStats {
  readonly followers: number | null;
  readonly following: number | null;
  readonly likes: number | null;
  readonly videos: number | null;
}

// --- The creator profile's `socialAccounts` entry --------------------------------------------

/**
 * The TikTok entry of `CreatorProfile.socialAccounts`, as Loop writes it after a connect or a read.
 * `state` follows the vocabulary the creator surfaces already read (`NOT_CONNECTED`, `SEEDED_DEMO`,
 * `CONNECTED`); `audience` mirrors `stats.followers` for readers that predate `stats`.
 */
export interface TikTokSocialAccountEntry {
  readonly platform: 'TIKTOK';
  readonly state: 'CONNECTED' | 'NOT_CONNECTED';
  readonly handle: string | null;
  /** The account's public profile link, as TikTok reported it (`user.info.profile`). */
  readonly profileUrl?: string;
  readonly connectedAt?: string;
  readonly readAt?: string;
  readonly stats?: TikTokAudienceStats;
  readonly recentVideos?: readonly TikTokVideoSummary[];
  readonly audience?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The TikTok entry of a stored `socialAccounts` value, read defensively; null when there is none. */
export function tiktokSocialAccountOf(raw: unknown): (Record<string, unknown> & { readonly platform: 'TIKTOK' }) | null {
  if (!Array.isArray(raw)) return null;
  const entry = raw.find((r) => isRecord(r) && r.platform === 'TIKTOK');
  return entry ? (entry as Record<string, unknown> & { readonly platform: 'TIKTOK' }) : null;
}

/**
 * MERGE, NEVER REPLACE. Returns a new array in which the TikTok entry is `{ ...existing, ...patch }`
 * (a key set to `undefined` in the patch is removed) and every other platform's entry is exactly
 * what it was. A missing TikTok entry is appended. A value that is not an array is treated as empty.
 */
export function mergeTikTokSocialAccount(existing: unknown, patch: Partial<TikTokSocialAccountEntry> & { readonly platform: 'TIKTOK' }): unknown[] {
  const list = Array.isArray(existing) ? [...existing] : [];
  const index = list.findIndex((r) => isRecord(r) && r.platform === 'TIKTOK');
  const current = index >= 0 && isRecord(list[index]) ? (list[index] as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  merged.platform = 'TIKTOK';
  if (index >= 0) list[index] = merged;
  else list.push(merged);
  return list;
}

/** The patch a disconnect applies: the grant is gone, so what was read under it is no longer shown as current. */
export const TIKTOK_DISCONNECTED_PATCH: Partial<TikTokSocialAccountEntry> & { readonly platform: 'TIKTOK' } = Object.freeze({
  platform: 'TIKTOK',
  state: 'NOT_CONNECTED',
  profileUrl: undefined,
  connectedAt: undefined,
  readAt: undefined,
  stats: undefined,
  recentVideos: undefined,
  audience: undefined,
});
