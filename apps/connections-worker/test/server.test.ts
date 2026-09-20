// The control router: only signed requests are honoured, and each path reaches the right handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleControlRequest, type ControlHandlers } from '../src/server';
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';

const SECRET = 'control-secret';
const NOW = new Date('2026-09-20T12:00:00Z');

function handlers(): { h: ControlHandlers; calls: string[] } {
  const calls: string[] = [];
  const h: ControlHandlers = {
    async startLogin(b, phone) { calls.push(`start:${b.organizationId}/${b.userId}:${phone}`); return { step: 'CODE_SENT' }; },
    async submitCode(_b, code) { calls.push(`code:${code}`); return { step: 'AUTHORIZED', accountLabel: '@x' }; },
    async submitPassword() { calls.push('password'); return { step: 'AUTHORIZED', accountLabel: '@x' }; },
    async cancelLogin() { calls.push('cancel'); },
    async disconnect() { calls.push('disconnect'); return 'DISCONNECTED'; },
  };
  return { h, calls };
}

function signed(path: string, payload: object, secret = SECRET) {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = signWorkerRequest(secret, body, NOW);
  return { method: 'POST', path, body, headers: { [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: timestamp } };
}

test('healthz needs no signature', async () => {
  const { h } = handlers();
  const res = await handleControlRequest({ method: 'GET', path: '/healthz', body: '', headers: {} }, { secret: SECRET, handlers: h, now: () => NOW });
  assert.equal(res.status, 200);
});

test('an unsigned or wrongly-signed control call is 401, and never reaches a handler', async () => {
  const { h, calls } = handlers();
  const unsigned = { method: 'POST', path: '/telegram/login/start', body: '{"organizationId":"o","userId":"u","phone":"+1"}', headers: {} };
  assert.equal((await handleControlRequest(unsigned, { secret: SECRET, handlers: h, now: () => NOW })).status, 401);
  const badSig = signed('/telegram/login/start', { organizationId: 'o', userId: 'u', phone: '+1' }, 'wrong-secret');
  assert.equal((await handleControlRequest(badSig, { secret: SECRET, handlers: h, now: () => NOW })).status, 401);
  assert.deepEqual(calls, []);
});

test('a signed start reaches the handler with the binding and phone from the body', async () => {
  const { h, calls } = handlers();
  const res = await handleControlRequest(signed('/telegram/login/start', { organizationId: 'o', userId: 'u', phone: '+15551234567' }), { secret: SECRET, handlers: h, now: () => NOW });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: { step: 'CODE_SENT' } });
  assert.deepEqual(calls, ['start:o/u:+15551234567']);
});

test('code, password, cancel and disconnect each route correctly', async () => {
  const { h, calls } = handlers();
  await handleControlRequest(signed('/telegram/login/code', { organizationId: 'o', userId: 'u', code: '123' }), { secret: SECRET, handlers: h, now: () => NOW });
  await handleControlRequest(signed('/telegram/login/password', { organizationId: 'o', userId: 'u', password: 'pw' }), { secret: SECRET, handlers: h, now: () => NOW });
  await handleControlRequest(signed('/telegram/login/cancel', { organizationId: 'o', userId: 'u' }), { secret: SECRET, handlers: h, now: () => NOW });
  const disc = await handleControlRequest(signed('/telegram/disconnect', { organizationId: 'o', userId: 'u' }), { secret: SECRET, handlers: h, now: () => NOW });
  assert.deepEqual(disc.body, { outcome: 'DISCONNECTED' });
  assert.deepEqual(calls, ['code:123', 'password', 'cancel', 'disconnect']);
});

test('a signed request with no binding is 400', async () => {
  const { h } = handlers();
  const res = await handleControlRequest(signed('/telegram/login/start', { phone: '+1' }), { secret: SECRET, handlers: h, now: () => NOW });
  assert.equal(res.status, 400);
});
