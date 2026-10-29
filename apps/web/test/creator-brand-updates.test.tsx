import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import { CreatorBrandUpdatesView } from '../src/creator/creator-brand-updates';
import type { PublishedCreatorBrandUpdate } from '@emgloop/database';
const at = new Date('2026-10-29T18:00:00Z');
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, at);
const row = (patch: Partial<PublishedCreatorBrandUpdate> = {}): PublishedCreatorBrandUpdate => ({ id: 'shared1', brandId: 'brand1', brand: 'Brand One', stage: 'AWAITING_BRAND', summary: 'The brand is considering the proposed collaboration.', nextStep: 'EMG is waiting for its reply.', generatedAt: at, evidenceAt: at, checkedAt: at, current: true, ...patch });
test('creator brand cards group canonical brands, stamp evidence times and label earlier readings', () => {
  const html = renderToStaticMarkup(<CreatorBrandUpdatesView rows={[row(), row({ id: 'shared2', current: false, nextStep: '', summary: 'An earlier conversation is awaiting review.' }), row({ id: 'shared3', brandId: 'different-brand', brand: 'Brand Two', summary: null, generatedAt: null, current: false })]} time={time} />);
  assert.equal((html.match(/<h3>/g) ?? []).length, 2);
  assert.match(html, /earlier reading/);
  assert.match(html, /Source conversation through/);
  assert.match(html, /shareable summary is not available yet/);
  assert.match(html, /Last checked/);
  assert.doesNotMatch(html, /ownerUserId|recipientUserId|sourceFingerprint|mail_message:|mailto:/);
});
test('no shared update never claims no outreach, and separate canonical brands with identical labels stay separate', () => {
  assert.match(renderToStaticMarkup(<CreatorBrandUpdatesView rows={[]} time={time} />), /does not mean no outreach/);
  const html = renderToStaticMarkup(<CreatorBrandUpdatesView rows={[row(), row({ id: 'other', brandId: 'other-company' })]} time={time} />);
  assert.equal((html.match(/<h3>/g) ?? []).length, 2);
});
test('publication routes are fixed-purpose signed calls and the browser only refreshes stored views', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
  const route = read('app/api/internal/creator-brand-updates/route.ts');
  assert.match(route, /verifyWorkerRequest/);
  assert.match(route, /body !== '\{"purpose":"creator-brand-updates","version":1\}'/);
  assert.doesNotMatch(route, /request\.json|request\.url|searchParams/);
  const client = read('creator/CreatorUpdatesRefresh.tsx');
  assert.match(client, /document.visibilityState === 'visible'/);
  assert.doesNotMatch(client, /fetch\(|process.env|@emgloop\/database|mail_message/);
  const runtime = read('creator/creator-mail-runtime.ts');
  assert.match(runtime, /excludeLabels: \['SPAM', 'TRASH', 'DRAFT'\]/);
});

import { POST } from '../src/app/api/internal/creator-brand-updates/route';
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
test('the actual refresh endpoint refuses unsigned, stale, changed-purpose and tenant-bearing requests', async () => {
  const oldUrl = process.env.LOOP_CONNECTIONS_WORKER_URL;
  const oldSecret = process.env.LOOP_CONNECTIONS_WORKER_SECRET;
  const oldDecision = process.env.LOOP_CREATOR_MAIL_SHARING_DECISION;
  process.env.LOOP_CONNECTIONS_WORKER_URL = 'https://worker.example.test';
  process.env.LOOP_CONNECTIONS_WORKER_SECRET = 'test-signing-secret';
  delete process.env.LOOP_CREATOR_MAIL_SHARING_DECISION;
  try {
    const body = '{"purpose":"creator-brand-updates","version":1}';
    function request(text: string, signed = true, at = new Date()) {
      const auth = signWorkerRequest('test-signing-secret', text, at);
      return new Request('https://app.example.test/api/internal/creator-brand-updates', { method: 'POST', body: text, headers: signed ? { [WORKER_SIGNATURE_HEADER]: auth.signature, [WORKER_TIMESTAMP_HEADER]: auth.timestamp } : {} });
    }
    assert.equal((await POST(request(body, false))).status, 401);
    assert.equal((await POST(request(body, true, new Date(Date.now() - 61_000)))).status, 401);
    assert.equal((await POST(request('{"purpose":"something-else","version":1}'))).status, 401);
    assert.equal((await POST(request('{"purpose":"creator-brand-updates","version":1,"userId":"someone-else"}'))).status, 401);
    const off = await POST(request(body)); assert.equal(off.status, 200); assert.deepEqual(await off.json(), { ok: true, enabled: false });
  } finally {
    for (const [key, old] of [['LOOP_CONNECTIONS_WORKER_URL', oldUrl], ['LOOP_CONNECTIONS_WORKER_SECRET', oldSecret], ['LOOP_CREATOR_MAIL_SHARING_DECISION', oldDecision]] as const) {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  }
});
