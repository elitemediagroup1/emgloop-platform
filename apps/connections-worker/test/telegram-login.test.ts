// The Telegram login coordinator: the phone -> code -> (2FA) -> authorized flow, with a fake port.
// Proves the session is sealed+stored via the injected sink, secrets are never returned, and each
// step maps to the status the UI renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TelegramLoginCoordinator, type TelegramAuthorization, type TelegramLoginBinding, type TelegramLoginPort } from '../src/telegram/telegram-login';

const BINDING: TelegramLoginBinding = { organizationId: 'o', userId: 'u' };
const AUTH: TelegramAuthorization = { session: 'SECRET-SESSION-STRING', accountLabel: '@matt', backgroundObservation: 'OPERATIONAL' };

function harness(portOver: Partial<TelegramLoginPort> = {}, storeResult: 'STORED' | 'NOT_PERMITTED' | 'NO_ATTEMPT' = 'STORED') {
  const events: string[] = [];
  let progress = false;
  const port: TelegramLoginPort = {
    async begin() { progress = true; events.push('begin'); return { ok: true }; },
    async submitCode() { return { ok: true, authorization: AUTH }; },
    async submitPassword() { return { ok: true, authorization: AUTH }; },
    async cancel() { progress = false; events.push('cancel'); },
    inProgress: () => progress,
    ...portOver,
  };
  const stored: TelegramAuthorization[] = [];
  const coord = new TelegramLoginCoordinator({
    port,
    async storeAuthorized(_b, a) { stored.push(a); events.push('store'); return storeResult; },
    async markConnecting() { events.push('markConnecting'); },
  });
  return { coord, events, stored, setProgress: (v: boolean) => { progress = v; } };
}

test('happy path: start sends a code, code authorizes, the session is sealed+stored, client released', async () => {
  const h = harness();
  assert.deepEqual(await h.coord.start(BINDING, '+15551234567'), { step: 'CODE_SENT' });
  const status = await h.coord.submitCode(BINDING, '12345');
  assert.deepEqual(status, { step: 'AUTHORIZED', accountLabel: '@matt' });
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0]!.session, 'SECRET-SESSION-STRING'); // handed to the sink, not returned
  // The status the UI sees never contains the raw session.
  assert.ok(!JSON.stringify(status).includes('SECRET-SESSION-STRING'));
  // Connecting was marked, session stored, and the live client released after success.
  assert.deepEqual(h.events, ['markConnecting', 'begin', 'store', 'cancel']);
});

test('2FA path: code needs a password, password authorizes and stores', async () => {
  const h = harness({ async submitCode() { return { ok: 'PASSWORD_NEEDED' }; } });
  await h.coord.start(BINDING, '+15551234567');
  assert.deepEqual(await h.coord.submitCode(BINDING, '12345'), { step: 'PASSWORD_NEEDED' });
  const status = await h.coord.submitPassword(BINDING, 'hunter2');
  assert.deepEqual(status, { step: 'AUTHORIZED', accountLabel: '@matt' });
  assert.equal(h.stored.length, 1);
});

test('an invalid phone fails before any code is sent', async () => {
  const h = harness();
  assert.deepEqual(await h.coord.start(BINDING, '   '), { step: 'FAILED', reason: 'PHONE_INVALID' });
  assert.deepEqual(h.events, []); // nothing happened
});

test('an invalid code fails without storing anything', async () => {
  const h = harness({ async submitCode() { return { ok: false, reason: 'CODE_INVALID' }; } });
  await h.coord.start(BINDING, '+15551234567');
  assert.deepEqual(await h.coord.submitCode(BINDING, '00000'), { step: 'FAILED', reason: 'CODE_INVALID' });
  assert.equal(h.stored.length, 0);
});

test('submitting a code or password with no login in progress is refused, storing nothing', async () => {
  const h = harness();
  h.setProgress(false);
  assert.deepEqual(await h.coord.submitCode(BINDING, '123'), { step: 'NO_LOGIN_IN_PROGRESS' });
  assert.deepEqual(await h.coord.submitPassword(BINDING, 'pw'), { step: 'NO_LOGIN_IN_PROGRESS' });
  assert.equal(h.stored.length, 0);
});

test('if the store refuses (membership gone / no attempt), the login fails closed and releases the client', async () => {
  const h = harness({}, 'NOT_PERMITTED');
  await h.coord.start(BINDING, '+15551234567');
  const status = await h.coord.submitCode(BINDING, '12345');
  assert.equal(status.step, 'FAILED');
  assert.ok(h.events.includes('cancel')); // client released even on store failure
});
