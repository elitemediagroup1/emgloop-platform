// TikTok Login Kit: OAuth request shapes, failure classes and the two Display API reads, against
// a recording network double. No live call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIKTOK_OAUTH_ENDPOINTS,
  exchangeTikTokAuthorizationCode,
  refreshTikTokAccessToken,
  revokeTikTokToken,
  tiktokAuthorizationUrl,
} from '../src/tiktok/oauth';
import {
  TIKTOK_API_ENDPOINTS,
  TIKTOK_USER_INFO_FIELDS,
  TIKTOK_VIDEO_FIELDS,
  readTikTokUserInfo,
  readTikTokVideoList,
  tiktokUserInfoFields,
} from '../src/tiktok/api';

const CLIENT = { clientKey: 'awtestclientkey123', clientSecret: 'client-secret-for-tests' };
const REDIRECT = 'https://app.emgloop.com/api/integrations/tiktok/callback';
const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function network(responses: Array<{ status: number; body?: unknown } | 'throw' | 'hang'>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: Call['init'] & { signal?: AbortSignal }) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500 };
    if (next === 'throw') throw new Error('socket hang up with secret client-secret-for-tests');
    if (next === 'hang') {
      return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return {
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new Error('not json');
        return next.body;
      },
    };
  };
  return { calls, fetchImpl };
}

const GRANT = {
  access_token: 'act.access',
  expires_in: 86400,
  open_id: 'open-id-1',
  refresh_expires_in: 31536000,
  refresh_token: 'rft.refresh',
  scope: 'user.info.basic,user.info.profile,user.info.stats,video.list',
  token_type: 'Bearer',
};

test('the authorization URL is exactly what Login Kit for Web documents: client_key, comma-separated scope, code, redirect_uri, state -- and no PKCE, no secret', () => {
  const url = new URL(tiktokAuthorizationUrl({ clientKey: CLIENT.clientKey, redirectUri: REDIRECT, scopes: SCOPES, state: 'state-value' }));
  assert.equal(`${url.origin}${url.pathname}`, TIKTOK_OAUTH_ENDPOINTS.authorize);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_key: CLIENT.clientKey,
    scope: 'user.info.basic,user.info.profile,user.info.stats,video.list',
    response_type: 'code',
    redirect_uri: REDIRECT,
    state: 'state-value',
  });
  assert.equal(url.searchParams.has('code_challenge'), false, 'PKCE is for TikTok’s mobile/desktop flows, not Web');
  assert.equal(url.searchParams.has('client_secret'), false, 'the secret never goes to the browser');
});

test('the code is exchanged server-side, form-encoded, with the client key, secret and the exact redirect URI; the grant carries open_id and the rotating refresh token', async () => {
  const { calls, fetchImpl } = network([{ status: 200, body: GRANT }]);
  const result = await exchangeTikTokAuthorizationCode({ fetchImpl, client: CLIENT, redirectUri: REDIRECT, code: 'auth-code-1' });
  assert.deepEqual(result, {
    ok: true,
    grant: { accessToken: 'act.access', expiresInSeconds: 86400, openId: 'open-id-1', scope: GRANT.scope, refreshToken: 'rft.refresh', refreshExpiresInSeconds: 31536000 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, TIKTOK_OAUTH_ENDPOINTS.token);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.init.body)), {
    client_key: CLIENT.clientKey,
    client_secret: CLIENT.clientSecret,
    code: 'auth-code-1',
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
  });
});

test('failures are classes only: no body, code, token or secret is ever returned -- and an error body is an error even with a 200', async () => {
  const cases: Array<[Parameters<typeof network>[0][number], string]> = [
    [{ status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code auth-code-1 is expired', log_id: '2026' } }, 'INVALID_GRANT'],
    [{ status: 200, body: { error: 'invalid_grant', error_description: 'reused' } }, 'INVALID_GRANT'],
    [{ status: 401, body: { error: 'invalid_client', error_description: 'client-secret-for-tests' } }, 'INVALID_CLIENT'],
    [{ status: 400, body: { error: 'unauthorized_client' } }, 'INVALID_CLIENT'],
    [{ status: 400, body: { error: 'invalid_request', error_description: 'redirect_uri mismatch' } }, 'REJECTED'],
    [{ status: 502 }, 'REJECTED'],
    [{ status: 200, body: { token_type: 'Bearer' } }, 'MALFORMED'],
    [{ status: 200, body: { ...GRANT, open_id: '' } }, 'MALFORMED'],
    [{ status: 200 }, 'MALFORMED'],
    ['throw', 'NETWORK'],
    ['hang', 'TIMEOUT'],
  ];
  for (const [response, failure] of cases) {
    const { fetchImpl } = network([response]);
    const result = await exchangeTikTokAuthorizationCode({ fetchImpl, client: CLIENT, redirectUri: REDIRECT, code: 'auth-code-1', timeoutMs: 30 });
    assert.deepEqual(result, { ok: false, failure }, JSON.stringify(response));
    const text = JSON.stringify(result);
    for (const secret of ['auth-code-1', CLIENT.clientSecret, 'expired', 'mismatch', 'log_id']) assert.equal(text.includes(secret), false);
  }
});

test('refresh sends the stored refresh token with the client credentials and returns the ROTATED one; a dead grant is INVALID_GRANT', async () => {
  const ok = network([{ status: 200, body: { ...GRANT, access_token: 'act.fresh', refresh_token: 'rft.rotated' } }]);
  const refreshed = await refreshTikTokAccessToken({ fetchImpl: ok.fetchImpl, client: CLIENT, refreshToken: 'rft.refresh' });
  assert.ok(refreshed.ok);
  assert.equal(refreshed.grant.accessToken, 'act.fresh');
  assert.equal(refreshed.grant.refreshToken, 'rft.rotated', 'the caller must store the new refresh token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ok.calls[0]!.init.body)), {
    client_key: CLIENT.clientKey,
    client_secret: CLIENT.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: 'rft.refresh',
  });
  const dead = network([{ status: 400, body: { error: 'invalid_grant' } }]);
  assert.deepEqual(await refreshTikTokAccessToken({ fetchImpl: dead.fetchImpl, client: CLIENT, refreshToken: 'rft.refresh' }), { ok: false, failure: 'INVALID_GRANT' });
});

test('revoke posts client_key, client_secret and the token; an empty 200 is success, an already-invalid token counts as revoked', async () => {
  const ok = network([{ status: 200, body: {} }]);
  assert.deepEqual(await revokeTikTokToken({ fetchImpl: ok.fetchImpl, client: CLIENT, token: 'act.access' }), { ok: true });
  assert.equal(ok.calls[0]!.url, TIKTOK_OAUTH_ENDPOINTS.revoke);
  assert.equal(ok.calls[0]!.init.method, 'POST');
  assert.equal(ok.calls[0]!.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ok.calls[0]!.init.body)), { client_key: CLIENT.clientKey, client_secret: CLIENT.clientSecret, token: 'act.access' });
  const empty = network([{ status: 200 }]);
  assert.deepEqual(await revokeTikTokToken({ fetchImpl: empty.fetchImpl, client: CLIENT, token: 't' }), { ok: true }, 'an empty body is the documented success');
  const gone = network([{ status: 400, body: { error: 'invalid_grant' } }]);
  assert.deepEqual(await revokeTikTokToken({ fetchImpl: gone.fetchImpl, client: CLIENT, token: 't' }), { ok: true });
  const failed = network([{ status: 503 }]);
  assert.deepEqual(await revokeTikTokToken({ fetchImpl: failed.fetchImpl, client: CLIENT, token: 't' }), { ok: false, failure: 'REJECTED' });
  const down = network(['throw']);
  assert.deepEqual(await revokeTikTokToken({ fetchImpl: down.fetchImpl, client: CLIENT, token: 't' }), { ok: false, failure: 'NETWORK' });
});

// --- Display API -------------------------------------------------------------------------------

test('user info asks only for the fields the granted scopes unlock, with the bearer token, and maps the documented answer', async () => {
  assert.deepEqual(tiktokUserInfoFields(['user.info.basic']), ['open_id', 'display_name']);
  assert.deepEqual(tiktokUserInfoFields([]), ['open_id'], 'open_id is always asked for: it names the account');
  assert.deepEqual(tiktokUserInfoFields(SCOPES), ['open_id', 'display_name', 'username', 'profile_deep_link', 'is_verified', 'follower_count', 'following_count', 'likes_count', 'video_count']);
  for (const fields of Object.values(TIKTOK_USER_INFO_FIELDS)) {
    for (const f of fields) assert.doesNotMatch(f, /avatar|bio|email/, `${f}: nothing Loop does not use is requested`);
  }

  const { calls, fetchImpl } = network([
    {
      status: 200,
      body: {
        data: { user: { open_id: 'open-id-1', display_name: 'Kona', username: 'konareyes', profile_deep_link: 'https://www.tiktok.com/@konareyes', is_verified: false, follower_count: 18412, following_count: 120, likes_count: 250000, video_count: 88 } },
        error: { code: 'ok', message: '', log_id: '2026' },
      },
    },
  ]);
  const result = await readTikTokUserInfo({ fetchImpl, accessToken: 'act.access', fields: tiktokUserInfoFields(SCOPES) });
  assert.deepEqual(result, {
    ok: true,
    user: { openId: 'open-id-1', displayName: 'Kona', username: 'konareyes', profileDeepLink: 'https://www.tiktok.com/@konareyes', isVerified: false, followerCount: 18412, followingCount: 120, likesCount: 250000, videoCount: 88 },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(`${url.origin}${url.pathname}`, TIKTOK_API_ENDPOINTS.userInfo);
  assert.equal(url.searchParams.get('fields'), 'open_id,display_name,username,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer act.access');

  // A narrower grant: the fields TikTok did not send are null, never zero.
  const partial = network([{ status: 200, body: { data: { user: { open_id: 'open-id-1', display_name: 'Kona' } }, error: { code: 'ok' } } }]);
  const narrow = await readTikTokUserInfo({ fetchImpl: partial.fetchImpl, accessToken: 'act.access', fields: ['open_id', 'display_name'] });
  assert.ok(narrow.ok);
  assert.equal(narrow.user.followerCount, null);
  assert.equal(narrow.user.username, null);
});

test('read failures are classes, read from TikTok’s error code before its status; nothing of the answer leaks', async () => {
  const cases: Array<[Parameters<typeof network>[0][number], string]> = [
    [{ status: 200, body: { data: {}, error: { code: 'access_token_invalid', message: 'The access token act.access is invalid', log_id: 'x' } } }, 'AUTH'],
    [{ status: 401, body: { error: { code: 'access_token_invalid' } } }, 'AUTH'],
    [{ status: 200, body: { data: {}, error: { code: 'scope_not_authorized', message: 'user.info.stats' } } }, 'FORBIDDEN'],
    [{ status: 403 }, 'FORBIDDEN'],
    [{ status: 200, body: { data: {}, error: { code: 'rate_limit_exceeded', message: 'slow down' } } }, 'RATE_LIMITED'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [{ status: 200, body: { data: {}, error: { code: 'internal_error', message: 'oops' } } }, 'UNAVAILABLE'],
    [{ status: 500 }, 'UNAVAILABLE'],
    [{ status: 200, body: { data: { user: {} }, error: { code: 'ok' } } }, 'MALFORMED'],
    [{ status: 200, body: { error: { code: 'ok' } } }, 'MALFORMED'],
    ['throw', 'NETWORK'],
    ['hang', 'TIMEOUT'],
  ];
  for (const [response, failure] of cases) {
    const { fetchImpl } = network([response]);
    const result = await readTikTokUserInfo({ fetchImpl, accessToken: 'act.access', fields: ['open_id'], timeoutMs: 30 });
    assert.deepEqual(result, { ok: false, failure }, JSON.stringify(response));
    assert.equal(JSON.stringify(result).includes('act.access'), false);
  }
});

test('the video list is one bounded POST for public videos with only the fields Loop shows; counts are as TikTok gave them', async () => {
  assert.deepEqual([...TIKTOK_VIDEO_FIELDS], ['id', 'title', 'video_description', 'share_url', 'create_time', 'view_count', 'like_count', 'comment_count', 'share_count']);
  for (const f of TIKTOK_VIDEO_FIELDS) assert.doesNotMatch(f, /cover|embed|duration|height|width/, `${f}: no media field`);

  const { calls, fetchImpl } = network([
    {
      status: 200,
      body: {
        data: {
          videos: [
            { id: '7300000000000000001', title: 'Unboxing', video_description: 'the long caption', share_url: 'https://www.tiktok.com/@konareyes/video/7300000000000000001', create_time: 1758700800, view_count: 12000, like_count: 800, comment_count: 40, share_count: 12 },
            { id: 73002, video_description: 'caption only', create_time: 0 },
            { not: 'a video' },
          ],
          cursor: 1758700000000,
          has_more: true,
        },
        error: { code: 'ok', message: '', log_id: 'y' },
      },
    },
  ]);
  const result = await readTikTokVideoList({ fetchImpl, accessToken: 'act.access', maxCount: 10 });
  assert.deepEqual(result, {
    ok: true,
    page: {
      videos: [
        { id: '7300000000000000001', title: 'Unboxing', shareUrl: 'https://www.tiktok.com/@konareyes/video/7300000000000000001', createdAt: '2025-09-24T08:00:00.000Z', viewCount: 12000, likeCount: 800, commentCount: 40, shareCount: 12 },
        { id: '73002', title: 'caption only', shareUrl: null, createdAt: null, viewCount: null, likeCount: null, commentCount: null, shareCount: null },
      ],
      cursor: 1758700000000,
      hasMore: true,
    },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(`${url.origin}${url.pathname}`, TIKTOK_API_ENDPOINTS.videoList);
  assert.equal(url.searchParams.get('fields'), TIKTOK_VIDEO_FIELDS.join(','));
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers['content-type'], 'application/json');
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer act.access');
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), { max_count: 10 });

  const capped = network([{ status: 200, body: { data: { videos: [], has_more: false }, error: { code: 'ok' } } }]);
  const empty = await readTikTokVideoList({ fetchImpl: capped.fetchImpl, accessToken: 'act.access', maxCount: 50, cursor: 5 });
  assert.deepEqual(empty, { ok: true, page: { videos: [], cursor: null, hasMore: false } });
  assert.deepEqual(JSON.parse(capped.calls[0]!.init.body!), { cursor: 5, max_count: 20 }, 'never more than TikTok’s own maximum');

  const forbidden = network([{ status: 200, body: { data: {}, error: { code: 'scope_not_authorized', message: 'video.list' } } }]);
  assert.deepEqual(await readTikTokVideoList({ fetchImpl: forbidden.fetchImpl, accessToken: 'act.access', maxCount: 10 }), { ok: false, failure: 'FORBIDDEN' });
});
