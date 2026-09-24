// TikTok Display API reads for the Login Kit connection: the account's public facts and its
// recent public videos, in Loop's own shape. OBSERVES; DECIDES NOTHING.
//
// Verified against developers.tiktok.com on 2026-09-23:
//   - Get user info:  GET  /v2/user/info/?fields=...        (/doc/tiktok-api-v2-get-user-info)
//   - List videos:    POST /v2/video/list/?fields=...       (/doc/tiktok-api-v2-video-list)
//
// ONLY THE FIELDS LOOP USES ARE ASKED FOR, so only they arrive. No avatar, no bio, no cover
// image, no embed markup, no duration or dimensions: nothing Loop would store or show is left
// out, and nothing it would not is requested. `video.list` returns PUBLIC videos only, by
// TikTok's own rule.
//
// The network is injected, the access token is held for one call and never logged, and every
// failure is a class. TikTok answers `{ data, error: { code, message, log_id } }` with
// `error.code === 'ok'` on success -- sometimes with a 200 status on an error -- so the code is
// read before the status is trusted.

import type { TikTokScope, TikTokUserInfo, TikTokVideoSummary } from '@emgloop/shared';

import { TIKTOK_OAUTH_TIMEOUT_MS, type TikTokFetch } from './oauth';

export const TIKTOK_API_ENDPOINTS = Object.freeze({
  userInfo: 'https://open.tiktokapis.com/v2/user/info/',
  videoList: 'https://open.tiktokapis.com/v2/video/list/',
});

/** The user-info fields each scope unlocks, limited to the ones Loop reads. */
export const TIKTOK_USER_INFO_FIELDS: Readonly<Record<Exclude<TikTokScope, 'video.list'>, readonly string[]>> = Object.freeze({
  'user.info.basic': Object.freeze(['open_id', 'display_name']),
  'user.info.profile': Object.freeze(['username', 'profile_deep_link', 'is_verified']),
  'user.info.stats': Object.freeze(['follower_count', 'following_count', 'likes_count', 'video_count']),
});

/** The video fields Loop reads. Exactly these, and nothing about the media itself. */
export const TIKTOK_VIDEO_FIELDS: readonly string[] = Object.freeze([
  'id',
  'title',
  'video_description',
  'share_url',
  'create_time',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
]);

/** TikTok's own maximum for a video page is 20. */
export const TIKTOK_VIDEO_LIST_MAX_COUNT = 20;

/**
 * Why a read did not produce what was asked.
 *
 *   AUTH          the access token was refused.
 *   FORBIDDEN     the grant does not cover this read (a scope was declined or withdrawn).
 *   RATE_LIMITED  TikTok asked Loop to slow down.
 *   UNAVAILABLE   any other error answer.
 *   MALFORMED     a success answer that is not what TikTok documents.
 *   NETWORK / TIMEOUT  no answer.
 */
export type TikTokReadFailure = 'AUTH' | 'FORBIDDEN' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'MALFORMED' | 'NETWORK' | 'TIMEOUT';

export interface TikTokReadOptions {
  readonly fetchImpl: TikTokFetch;
  /** An access token for THIS creator's connection. Never stored, never logged. */
  readonly accessToken: string;
  readonly timeoutMs?: number;
}

/** The user-info fields the granted scopes allow Loop to ask for. `open_id` is always among them. */
export function tiktokUserInfoFields(grantedScopes: readonly string[]): string[] {
  const fields = new Set<string>(['open_id']);
  for (const scope of Object.keys(TIKTOK_USER_INFO_FIELDS) as (keyof typeof TIKTOK_USER_INFO_FIELDS)[]) {
    if (grantedScopes.includes(scope)) for (const f of TIKTOK_USER_INFO_FIELDS[scope]) fields.add(f);
  }
  return [...fields];
}

type Envelope = { readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false; readonly failure: TikTokReadFailure };

function failureFor(status: number, code: string | null): TikTokReadFailure {
  if (code === 'access_token_invalid' || status === 401) return 'AUTH';
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed' || status === 403) return 'FORBIDDEN';
  if (code === 'rate_limit_exceeded' || status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

async function call(options: TikTokReadOptions, url: string, init: { method: 'GET' } | { method: 'POST'; body: string }): Promise<Envelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIKTOK_OAUTH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${options.accessToken}`, accept: 'application/json' };
    if (init.method === 'POST') headers['content-type'] = 'application/json';
    const response = await options.fetchImpl(url, { method: init.method, headers, ...(init.method === 'POST' ? { body: init.body } : {}), signal: controller.signal });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const envelope = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const error = envelope && envelope.error && typeof envelope.error === 'object' ? (envelope.error as Record<string, unknown>) : null;
    const code = error && typeof error.code === 'string' ? error.code : null;
    if (response.status !== 200 || (code !== null && code !== 'ok')) return { ok: false, failure: failureFor(response.status, code) };
    const data = envelope && envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : null;
    return data ? { ok: true, data } : { ok: false, failure: 'MALFORMED' };
  } catch (error) {
    return { ok: false, failure: controller.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** One read of the connected account's own facts, limited to the fields the granted scopes allow. */
export async function readTikTokUserInfo(
  options: TikTokReadOptions & { readonly fields: readonly string[] },
): Promise<{ readonly ok: true; readonly user: TikTokUserInfo } | { readonly ok: false; readonly failure: TikTokReadFailure }> {
  const url = `${TIKTOK_API_ENDPOINTS.userInfo}?${new URLSearchParams({ fields: options.fields.join(',') }).toString()}`;
  const answer = await call(options, url, { method: 'GET' });
  if (!answer.ok) return answer;
  const user = answer.data.user && typeof answer.data.user === 'object' ? (answer.data.user as Record<string, unknown>) : null;
  const openId = user ? str(user.open_id) : null;
  if (!user || !openId) return { ok: false, failure: 'MALFORMED' };
  return {
    ok: true,
    user: {
      openId,
      displayName: str(user.display_name),
      username: str(user.username),
      profileDeepLink: str(user.profile_deep_link),
      isVerified: bool(user.is_verified),
      followerCount: int(user.follower_count),
      followingCount: int(user.following_count),
      likesCount: int(user.likes_count),
      videoCount: int(user.video_count),
    },
  };
}

function videoSummary(raw: unknown): TikTokVideoSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === 'string' && v.id !== '' ? v.id : typeof v.id === 'number' ? String(v.id) : null;
  if (!id) return null;
  const created = int(v.create_time);
  return {
    id,
    title: str(v.title) ?? str(v.video_description),
    shareUrl: str(v.share_url),
    createdAt: created !== null && created > 0 ? new Date(created * 1000).toISOString() : null,
    viewCount: int(v.view_count),
    likeCount: int(v.like_count),
    commentCount: int(v.comment_count),
    shareCount: int(v.share_count),
  };
}

export interface TikTokVideoListResult {
  readonly videos: readonly TikTokVideoSummary[];
  /** The cursor for the next page, when `hasMore`. Loop reads one page and stops. */
  readonly cursor: number | null;
  readonly hasMore: boolean;
}

/** One page of the connected account's PUBLIC videos, newest first, bounded by `maxCount` (at most 20). */
export async function readTikTokVideoList(
  options: TikTokReadOptions & { readonly maxCount: number; readonly cursor?: number | null },
): Promise<{ readonly ok: true; readonly page: TikTokVideoListResult } | { readonly ok: false; readonly failure: TikTokReadFailure }> {
  const maxCount = Math.max(1, Math.min(TIKTOK_VIDEO_LIST_MAX_COUNT, Math.floor(options.maxCount)));
  const url = `${TIKTOK_API_ENDPOINTS.videoList}?${new URLSearchParams({ fields: TIKTOK_VIDEO_FIELDS.join(',') }).toString()}`;
  const body = JSON.stringify(options.cursor != null ? { cursor: options.cursor, max_count: maxCount } : { max_count: maxCount });
  const answer = await call(options, url, { method: 'POST', body });
  if (!answer.ok) return answer;
  const list = Array.isArray(answer.data.videos) ? answer.data.videos : null;
  if (!list) return { ok: false, failure: 'MALFORMED' };
  const videos = list.map(videoSummary).filter((v): v is TikTokVideoSummary => v !== null);
  return { ok: true, page: { videos, cursor: int(answer.data.cursor), hasMore: answer.data.has_more === true } };
}
