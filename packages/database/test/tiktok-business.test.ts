import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokBusinessService } from '../src/services/tiktok/tiktok-business.service';
import { TikTokBusinessApi, businessAuthorizationUrl } from '../../providers/src/tiktok-business/api';
const p = { organizationId: 'org', userId: 'user', sessionId: 'session' };
const config = { appId: '12345678', secret: 'test-secret', redirectUri: 'https://app.emgloop.com/api/integrations/tiktok-business/creator-callback' };
test('provider uses distinct token endpoints and never follows redirects with secrets', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ code: 0, data: { access_token: 'test-access', refresh_token: 'test-refresh', open_id: 'creator-a', expires_in: 86400 } }));
  };
  const api = new TikTokBusinessApi(config, request);
  assert.equal((await api.exchange('CREATOR', 'test-code')).expiresIn, 86400);
  assert.match(calls[0]!.url, /tt_user\/oauth2\/token\/$/);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { client_id: config.appId, client_secret: config.secret, grant_type: 'authorization_code', auth_code: 'test-code', redirect_uri: config.redirectUri });
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal((await api.exchange('TTO', 'test-code')).expiresIn, null);
  assert.match(calls[1]!.url, /v1.3\/oauth2\/access_token\/$/);
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { app_id: config.appId, secret: config.secret, auth_code: 'test-code' });
});
test('invalid, truncated, refused and non-success grants never become authorizations', async () => {
  for (const body of [{ code: 0, data: {} }, { code: 0, data: { access_token: 'x', open_id: 'y', refresh_token: 'z', expires_in: -1 } }, { code: 40131, message: 'sensitive provider text' }]) {
    const api = new TikTokBusinessApi(config, async () => new Response(JSON.stringify(body)));
    await assert.rejects(api.exchange('CREATOR', 'code'), /TOKEN_/);
  }
  const api = new TikTokBusinessApi(config, async () => new Response('invalid json'));
  await assert.rejects(api.exchange('TTO', 'code'));
});
test('authorization templates retain app settings but replace state and callback; hostile hosts refused', () => {
  const url = new URL(businessAuthorizationUrl('https://business-api.tiktok.com/portal/auth?app_id=12345678&state=old', config.redirectUri, 'new'));
  assert.equal(url.searchParams.get('state'), 'new');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  for (const url of ['https://evil.example/auth', 'https://business-api.tiktok.com.evil.example/', 'http://business-api.tiktok.com/', 'https://user:pass@business-api.tiktok.com/']) assert.throws(() => businessAuthorizationUrl(url, config.redirectUri, 'new'));
});
test('unconfigured, invalid, replayed and declined attempts do not exchange or store tokens', async () => {
  let exchanges = 0, stores = 0;
  let allowed = false;
  const repository = { begin: async () => true, consume: async () => allowed, store: async () => { stores++; return true; } };
  const configured = { key: new Uint8Array(32).fill(1), authorizationUrl: 'https://business-api.tiktok.com/portal/auth?app_id=12345678', redirectUri: config.redirectUri, exchange: async () => { exchanges++; return { accessToken: 'access', refreshToken: 'refresh', openId: 'creator-a', expiresIn: 86400 }; } };
  const absent = new TikTokBusinessService(repository, null);
  assert.equal(await absent.begin(p, 'TTO'), null);
  const service = new TikTokBusinessService(repository, configured);
  assert.equal(await service.complete(p, 'CREATOR', { state: 'invalid', authCode: 'code', error: null }), 'STATE_INVALID');
  const state = 'a'.repeat(64);
  assert.equal(await service.complete(p, 'CREATOR', { state, authCode: 'code', error: null }), 'STATE_INVALID');
  allowed = true;
  assert.equal(await service.complete(p, 'CREATOR', { state, authCode: 'code', error: 'access_denied' }), 'DECLINED');
  assert.equal(exchanges, 0); assert.equal(stores, 0);
});
test('successful callback persists only sealed bytes; withdrawn attempt cannot publish', async () => {
  let stored = true;
  const service = new TikTokBusinessService({ begin: async () => true, consume: async () => true, store: async (_p, _kind, _hash, value) => {
    assert.ok(Buffer.isBuffer(value.tokenSealed));
    assert.equal(value.tokenSealed.includes(Buffer.from('private-access-token')), false);
    assert.equal(value.externalId, 'creator-a');
    return stored;
  } }, { key: new Uint8Array(32).fill(2), authorizationUrl: 'https://business-api.tiktok.com/portal/auth?app_id=12345678', redirectUri: config.redirectUri, exchange: async () => ({ accessToken: 'private-access-token', refreshToken: 'refresh', openId: 'creator-a', expiresIn: 86400 }) });
  const q = { state: 'a'.repeat(64), authCode: 'code', error: null };
  assert.equal(await service.complete(p, 'CREATOR', q), 'CONNECTED');
  stored = false;
  assert.equal(await service.complete(p, 'CREATOR', q), 'WITHDRAWN');
});
