import test from 'node:test';
import assert from 'node:assert/strict';
import { CallGridApiError, fetchCallGridCallsPage } from '../src/adapters/callgrid-api';

test('429 honors documented RateLimit-Reset when Retry-After is absent; requests have a timeout', async () => {
  await assert.rejects(fetchCallGridCallsPage({ apiKey: 'test', since: new Date(), fetchImpl: async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response('{}', { status: 429, headers: { 'RateLimit-Reset': '42' } });
  } }), (e: unknown) => e instanceof CallGridApiError && e.retryAfter === '42');
});
test('standard Retry-After takes precedence over RateLimit-Reset', async () => {
  await assert.rejects(fetchCallGridCallsPage({ apiKey: 'test', since: new Date(), fetchImpl: async () =>
    new Response('{}', { status: 429, headers: { 'Retry-After': '12', 'RateLimit-Reset': '42' } }) }),
    (e: unknown) => e instanceof CallGridApiError && e.retryAfter === '12');
});
