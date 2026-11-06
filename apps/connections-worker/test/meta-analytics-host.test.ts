import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import { metaAnalyticsHost } from '../src/meta-analytics-host';
test('Meta host signs a fixed-purpose request to the existing configured Loop origin and bounds each pass', async () => {
  let calls = 0;
  const now = new Date();
  const host = metaAnalyticsHost({ url: 'https://app.emgloop.com/api/internal/creator-brand-updates', secret: 'test-secret' }, { now: () => now, log: () => {}, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://app.emgloop.com/api/internal/creator-meta-analytics');
    const headers = new Headers(init?.headers);
    assert.equal(init?.body, '{"purpose":"creator-meta-analytics","version":1}');
    assert.equal(verifyWorkerRequest('test-secret', { body: String(init?.body), timestamp: headers.get(WORKER_TIMESTAMP_HEADER), signature: headers.get(WORKER_SIGNATURE_HEADER), toleranceMs: 60_000 }), true);
    return Response.json({ processed: 1, arbitraryProviderText: 'must-not-be-logged' });
  } });
  const a = host.pass(), b = host.pass();
  assert.equal(a, b, 'one worker never overlaps its own pass');
  await a;
  assert.equal(calls, 3);
  await host.stop();
  await host.pass();
  assert.equal(calls, 3);
});
test('Meta host does not call an unconfigured host or continue an empty queue', async () => {
  let calls = 0;
  const ports = { now: () => new Date(), log: () => {}, fetch: async () => { calls++; return Response.json({ processed: 0 }); } };
  await metaAnalyticsHost(null, ports).pass();
  assert.equal(calls, 0);
  await metaAnalyticsHost({ url: 'https://app.emgloop.com/api/internal/creator-brand-updates', secret: 'test-secret' }, ports).pass();
  assert.equal(calls, 1);
});
