import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATOR_BRAND_REFRESH_MS, verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import { creatorMailHost, readCreatorMailHostConfig, CREATOR_MAIL_TICK_MS } from '../src/creator-mail-host';
const now = new Date('2026-10-29T18:00:00Z');
const config = { url: 'https://app.emgloop.com/api/internal/creator-brand-updates', secret: 'not-a-real-secret' };
test('creator refresh is separate, five-minute, off by default and pinned to trusted Loop endpoints', async () => {
  assert.equal(CREATOR_MAIL_TICK_MS, 60_000);
  assert.equal(CREATOR_BRAND_REFRESH_MS, 300_000);
  assert.equal(readCreatorMailHostConfig({}), null);
  assert.throws(() => readCreatorMailHostConfig({ LOOP_CREATOR_MAIL_REFRESH_URL: 'https://evil.test/api/internal/creator-brand-updates' }));
  assert.throws(() => readCreatorMailHostConfig({ LOOP_CREATOR_MAIL_REFRESH_URL: config.url }));
  let calls = 0;
  const host = creatorMailHost(null, { fetch: (async () => { calls++; throw Error(); }) as typeof fetch, now: () => now, log: () => undefined });
  await host.pass(); assert.equal(calls, 0);
});
test('AWS sends only the fixed signed trigger, refuses redirects, logs no credentials or arbitrary server prose', async () => {
  let calls = 0; const logs: unknown[] = [];
  const host = creatorMailHost(config, { now: () => now, log: (...args) => { logs.push(args); }, fetch: (async (url, init) => {
    calls++; assert.equal(url, config.url); assert.equal(init?.redirect, 'error');
    const headers = init!.headers as Record<string, string>;
    assert.ok(verifyWorkerRequest(config.secret, { body: String(init!.body), signature: headers[WORKER_SIGNATURE_HEADER], timestamp: headers[WORKER_TIMESTAMP_HEADER], now }));
    assert.deepEqual(JSON.parse(String(init!.body)), { purpose: 'creator-brand-updates', version: 1 });
    return Response.json(calls === 1 ? { outcomes: { PUBLISHED: 1, privateProse: config.secret } } : { outcomes: {} });
  }) as typeof fetch });
  await host.pass(); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(logs).includes(config.secret));
  assert.ok(!JSON.stringify(logs).includes('privateProse'));
});
test('single-flight refresh joins the active pass and stop drains it without starting another', async () => {
  let finish!: () => void; let calls = 0;
  const host = creatorMailHost(config, { now: () => now, log: () => undefined, fetch: (async () => { calls++; await new Promise<void>(r => { finish = r; }); return Response.json({ outcomes: {} }); }) as typeof fetch });
  const pass = host.pass(); assert.equal(host.pass(), pass);
  let stopped = false; const stop = host.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); finish(); await stop;
  await host.pass(); assert.equal(calls, 1);
});
