import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaApi, MetaApiError, META_SCOPES, metaAuthorizationUrl } from '../src/meta/api';
const config = { appId: '123', appSecret: 'secret-test-only', version: 'v25.0', redirectUri: 'https://app.emgloop.com/api/integrations/meta/callback' };
function network(bodies: unknown[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(bodies.shift()), { status: 200 }); };
  return { calls, api: new MetaApi(config, fetcher) };
}
test('authorization requests read-only permissions and preserves exact callback and state', () => {
  const url = new URL(metaAuthorizationUrl(config, 'state-a'));
  assert.equal(url.hostname, 'www.facebook.com');
  assert.equal(url.searchParams.get('state'), 'state-a');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.deepEqual(url.searchParams.get('scope')?.split(','), [...META_SCOPES]);
  assert.ok(!url.toString().includes(config.appSecret));
});
test('code exchange is server-side, exchanges long-lived token and records actual granted scopes', async () => {
  const { api, calls } = network([{ access_token: 'short' }, { access_token: 'long', expires_in: 5000 }, { id: '999' }, { data: [{ permission: 'read_insights', status: 'granted' }, { permission: 'instagram_basic', status: 'declined' }] }]);
  const result = await api.exchange('private-code');
  assert.deepEqual(result, { token: 'long', expiresIn: 5000, userId: '999', scopes: ['read_insights'] });
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.ok(!calls.some(c => /private-code|short|long|secret-test-only/.test(c.url)));
  const body = new URLSearchParams(String(calls[1]!.init?.body));
  assert.equal(body.get('grant_type'), 'fb_exchange_token');
});
test('page enumeration uses cursors on fixed origin and filters pages without ANALYZE/MANAGE tasks', async () => {
  const { api, calls } = network([{ data: [{ id: '1', name: 'Allowed', access_token: 'page-token', tasks: ['ANALYZE'], instagram_business_account: { id: '3' } }, { id: '2', access_token: 'other-token', tasks: ['MESSAGING'] }], paging: { next: 'https://attacker.test/?access_token=secret', cursors: { after: 'cursor-a' } } }, { data: [] }]);
  const pages = await api.pages('user-token');
  assert.equal(pages.length, 1); assert.equal(pages[0]!.instagramId, '3');
  assert.equal(new URL(calls[1]!.url).hostname, 'graph.facebook.com');
  assert.equal(new URL(calls[1]!.url).searchParams.get('after'), 'cursor-a');
  assert.ok(!calls.some(c => c.url.includes('user-token')));
});
test('empty/missing metrics are unknown; measured zero remains zero', async () => {
  const { api } = network([{ data: [] }, { data: [{ total_value: { value: 0 } }] }, { data: [{ values: [{ value: 2 }, { value: 3 }] }] }, { error: { code: 100, message: 'secret-provider-text' } }]);
  assert.equal((await api.metric('123', 'token', 'views', {})).value, null);
  assert.equal((await api.metric('123', 'token', 'views', {})).value, 0);
  assert.equal((await api.metric('123', 'token', 'views', {})).value, 5);
  assert.deepEqual(await api.metric('123', 'token', 'views', {}), { name: 'views', value: null, failure: 'METRIC_UNAVAILABLE' });
});
test('expired tokens and throttles abort collection without leaking provider details', async () => {
  const { api } = network([{ error: { code: 190, message: 'secret-token' } }, { error: { code: 4, message: 'secret-token' } }]);
  await assert.rejects(api.metric('123', 'token', 'views', {}), (error: unknown) => error instanceof MetaApiError && error.message === 'TOKEN_EXPIRED');
  await assert.rejects(api.metric('123', 'token', 'views', {}), (error: unknown) => error instanceof MetaApiError && error.message === 'RATE_LIMITED');
});
test('Instagram report uses total_value for deduplicated reach, complete-day window and bounded content', async () => {
  const { api, calls } = network([{ id: '123', username: 'creator', followers_count: 22 }, { data: [{ total_value: { value: 100 } }] }, { data: [{ total_value: { value: 40 } }] }, { data: [{ total_value: { value: 8 } }] }, { data: [] }]);
  const report = await api.report({ id: '45', instagramId: '123', name: 'Page', accessToken: 'token' }, 'INSTAGRAM', new Date('2026-11-06T12:00:00Z'));
  assert.equal(report.windowEnd, '2026-11-06T00:00:00.000Z');
  assert.equal(report.windowStart, '2026-10-09T00:00:00.000Z');
  const reach = calls.find(c => new URL(c.url).searchParams.get('metric') === 'reach')!;
  assert.equal(new URL(reach.url).searchParams.get('metric_type'), 'total_value');
  assert.equal(report.metrics.find(m => m.name === 'reach')?.value, 40);
});
