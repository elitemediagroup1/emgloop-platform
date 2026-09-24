// The TikTok Login Kit connection contract: exactly four scopes, nothing broader, honest states,
// and a profile merge that never replaces what another platform recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GOOGLE_CALLBACK_PATH, googleRedirectUri } from '../src/google-environment';
import { oauthRedirectUri } from '../src/oauth-redirect';
import { parseSealingKey } from '../src/sealing-key';
import {
  TIKTOK_CALLBACK_PATH,
  TIKTOK_CONNECT_OUTCOMES,
  TIKTOK_DISCONNECTED_PATCH,
  TIKTOK_SCOPES,
  TIKTOK_SCOPE_READS,
  isTikTokConnectOutcome,
  mergeTikTokSocialAccount,
  parseTikTokGrantedScopes,
  tiktokConnectionState,
  tiktokMissingScopes,
  tiktokSocialAccountOf,
} from '../src/tiktok';

test('exactly the four registered scopes, in order, frozen; one static callback path', () => {
  assert.deepEqual([...TIKTOK_SCOPES], ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list']);
  assert.ok(Object.isFrozen(TIKTOK_SCOPES));
  assert.equal(TIKTOK_CALLBACK_PATH, '/api/integrations/tiktok/callback');
  assert.doesNotMatch(TIKTOK_CALLBACK_PATH, /[?#]/, 'no query, no fragment: the registered URI must match byte for byte');
  for (const scope of TIKTOK_SCOPES) assert.ok(TIKTOK_SCOPE_READS[scope].length > 20, `${scope} says what it reads`);
  assert.match(TIKTOK_SCOPE_READS['video.list'], /Private videos are never returned/);
});

test('granted scopes are read from TikTok’s comma-separated answer; anything broader refuses the whole grant', () => {
  assert.deepEqual(parseTikTokGrantedScopes('user.info.basic,user.info.profile,user.info.stats,video.list'), {
    ok: true,
    scopes: ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'],
  });
  assert.deepEqual(parseTikTokGrantedScopes('video.list,user.info.basic'), { ok: true, scopes: ['user.info.basic', 'video.list'] }, 'canonical order');
  assert.deepEqual(parseTikTokGrantedScopes('user.info.basic, user.info.stats'), { ok: true, scopes: ['user.info.basic', 'user.info.stats'] }, 'a space after the comma is tolerated');
  assert.deepEqual(parseTikTokGrantedScopes('user.info.basic,user.info.basic'), { ok: true, scopes: ['user.info.basic'] }, 'no duplicates');
  for (const broader of ['user.info.basic,video.upload', 'video.publish', 'user.info.basic,user.info.email']) {
    assert.deepEqual(parseTikTokGrantedScopes(broader), { ok: false, reason: 'UNEXPECTED_SCOPE' }, broader);
  }
  for (const missing of ['', '   ', undefined, null, 42]) assert.deepEqual(parseTikTokGrantedScopes(missing), { ok: false, reason: 'MISSING' });
  assert.deepEqual(tiktokMissingScopes(['user.info.basic', 'video.list']), ['user.info.profile', 'user.info.stats']);
  assert.deepEqual(tiktokMissingScopes([...TIKTOK_SCOPES]), []);
});

test('the page state: unconfigured, not connected, connected, partial, expired -- and never "connected" for a revoked row', () => {
  const all = [...TIKTOK_SCOPES];
  assert.equal(tiktokConnectionState(false, null), 'NOT_CONFIGURED');
  assert.equal(tiktokConnectionState(false, { status: 'CONNECTED', grantedScopes: all }), 'NOT_CONFIGURED', 'a deployment without a client cannot use a grant');
  assert.equal(tiktokConnectionState(true, null), 'NOT_CONNECTED');
  assert.equal(tiktokConnectionState(true, { status: 'REVOKED', grantedScopes: all }), 'NOT_CONNECTED');
  assert.equal(tiktokConnectionState(true, { status: 'CONNECTED', grantedScopes: all }), 'CONNECTED');
  assert.equal(tiktokConnectionState(true, { status: 'CONNECTED', grantedScopes: ['user.info.basic'] }), 'PARTIAL');
  assert.equal(tiktokConnectionState(true, { status: 'EXPIRED', grantedScopes: all }), 'EXPIRED');
});

test('every outcome is a closed code with no provider text in it', () => {
  assert.ok(TIKTOK_CONNECT_OUTCOMES.length >= 15);
  for (const outcome of TIKTOK_CONNECT_OUTCOMES) {
    assert.match(outcome, /^[A-Z_]+$/);
    assert.ok(isTikTokConnectOutcome(outcome));
  }
  assert.equal(isTikTokConnectOutcome('<script>'), false);
  assert.equal(isTikTokConnectOutcome(['CONNECTED']), false);
});

test('the profile merge touches only the TikTok entry, keeps every other platform byte for byte, and removes what a disconnect withdraws', () => {
  const instagram = { platform: 'INSTAGRAM', handle: 'kona', state: 'SEEDED_DEMO', audience: 1200 };
  const seeded = { platform: 'TIKTOK', handle: 'kona.tt', state: 'SEEDED_DEMO', audience: 4000, note: 'kept' };
  const existing = [instagram, seeded];

  const connected = mergeTikTokSocialAccount(existing, {
    platform: 'TIKTOK',
    state: 'CONNECTED',
    handle: 'konareyes',
    connectedAt: '2026-09-24T10:00:00.000Z',
    readAt: '2026-09-24T10:00:00.000Z',
    stats: { followers: 18412, following: 120, likes: 250000, videos: 88 },
    audience: 18412,
  });
  assert.equal(connected.length, 2, 'no duplicate entry');
  assert.equal(connected[0], instagram, 'the other platform is the same object');
  assert.deepEqual(connected[1], {
    platform: 'TIKTOK',
    handle: 'konareyes',
    state: 'CONNECTED',
    audience: 18412,
    note: 'kept',
    connectedAt: '2026-09-24T10:00:00.000Z',
    readAt: '2026-09-24T10:00:00.000Z',
    stats: { followers: 18412, following: 120, likes: 250000, videos: 88 },
  });
  assert.deepEqual(existing[1], seeded, 'the input is not mutated');

  const disconnected = mergeTikTokSocialAccount(connected, TIKTOK_DISCONNECTED_PATCH);
  assert.deepEqual(disconnected[1], { platform: 'TIKTOK', handle: 'konareyes', state: 'NOT_CONNECTED', note: 'kept' }, 'stats and read times are withdrawn with the grant; the handle stays');
  assert.equal(disconnected[0], instagram);

  assert.deepEqual(mergeTikTokSocialAccount(undefined, { platform: 'TIKTOK', state: 'CONNECTED', handle: null }), [{ platform: 'TIKTOK', state: 'CONNECTED', handle: null }], 'no list yet: one entry');
  assert.deepEqual(mergeTikTokSocialAccount('not a list', { platform: 'TIKTOK', state: 'CONNECTED', handle: null }), [{ platform: 'TIKTOK', state: 'CONNECTED', handle: null }]);
  assert.deepEqual(mergeTikTokSocialAccount([instagram], { platform: 'TIKTOK', state: 'CONNECTED', handle: 'x' }), [instagram, { platform: 'TIKTOK', state: 'CONNECTED', handle: 'x' }], 'appended after the others');

  assert.deepEqual(tiktokSocialAccountOf(connected), connected[1]);
  assert.equal(tiktokSocialAccountOf([instagram]), null);
  assert.equal(tiktokSocialAccountOf({}), null);
});

test('the two shared rules: a sealing key is exactly 32 bytes, and a redirect URI is the canonical origin plus one path', () => {
  const key = Buffer.alloc(32, 7);
  assert.deepEqual(Buffer.from(parseSealingKey(key.toString('base64'))!), key);
  assert.deepEqual(Buffer.from(parseSealingKey(key.toString('base64url'))!), key);
  assert.equal(parseSealingKey(Buffer.alloc(31, 7).toString('base64')), null);
  assert.equal(parseSealingKey(Buffer.alloc(33, 7).toString('base64')), null);
  assert.equal(parseSealingKey('not base64 at all!'), null);
  assert.equal(parseSealingKey(''), null);

  assert.equal(oauthRedirectUri('https://app.emgloop.com', TIKTOK_CALLBACK_PATH), 'https://app.emgloop.com/api/integrations/tiktok/callback');
  assert.equal(oauthRedirectUri('https://app.emgloop.com/', TIKTOK_CALLBACK_PATH), 'https://app.emgloop.com/api/integrations/tiktok/callback');
  assert.equal(oauthRedirectUri('http://localhost:3000', TIKTOK_CALLBACK_PATH), 'http://localhost:3000/api/integrations/tiktok/callback');
  for (const origin of ['http://app.emgloop.com', 'https://app.emgloop.com/sub', 'https://user:pw@app.emgloop.com', 'ftp://app.emgloop.com', 'not a url', 'https://app.emgloop.com/?x=1', 'https://app.emgloop.com/#f']) {
    assert.equal(oauthRedirectUri(origin, TIKTOK_CALLBACK_PATH), null, origin);
  }
  // Google's own reader still answers exactly as before the rule was shared.
  assert.equal(googleRedirectUri('https://app.emgloop.com'), `https://app.emgloop.com${GOOGLE_CALLBACK_PATH}`);
  assert.equal(googleRedirectUri('http://example.com'), null);
});
