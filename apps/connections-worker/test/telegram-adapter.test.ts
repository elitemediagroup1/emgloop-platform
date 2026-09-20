// The Telegram adapter's policy, with a fake MTProto client and the real runConnectionCycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runConnectionCycle } from '@emgloop/database';
import { TelegramAdapter, TelegramAuthError, type TelegramClientHandle, type TelegramClientPort } from '../src/telegram/telegram-adapter';
import type { TelegramMessageFacts } from '../src/telegram/content-free-mapping';

const SECRET = 'conv-secret';
const NOW = new Date('2026-09-20T12:00:00Z');
const HANDLE: TelegramClientHandle = { kind: 'telegram-mtproto', client: {} };

const facts = (id: string, over: Partial<TelegramMessageFacts> = {}): TelegramMessageFacts => ({
  messageId: id, chatId: 'c1', senderId: 'u2', participantIds: ['self', 'u2'], out: false,
  dateSeconds: Math.floor(NOW.getTime() / 1000), hadText: true, ...over,
});

function port(over: Partial<TelegramClientPort> = {}): TelegramClientPort {
  return {
    async connectFromSession() { return HANDLE; },
    async fetchSince() { return []; },
    async close() {},
    ...over,
  };
}

test('observe maps a batch to content-free events, advances the cursor, reports operational', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchSince() { return [facts('10'), facts('12')]; } }) });
  const session = await adapter.resume('session-string', { organizationId: 'o', userId: 'u' });
  const result = await adapter.observe(session, '5', NOW);
  assert.equal(result.events.length, 2);
  assert.equal(result.backgroundObservation, 'OPERATIONAL');
  assert.equal(result.cursor, '12');
  for (const e of result.events) {
    assert.equal(e.provider, 'TELEGRAM');
    assert.ok(!JSON.stringify(e).includes('c1') && !JSON.stringify(e).includes('u2'), 'no raw ids in events');
  }
});

test('through runConnectionCycle: a healthy cycle reads READY with the advanced cursor', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchSince() { return [facts('20')]; } }) });
  const cycle = await runConnectionCycle(adapter, { organizationId: 'o', userId: 'u', cursor: '5', secret: 'session-string' }, NOW);
  assert.equal(cycle.state, 'READY');
  assert.equal(cycle.cursor, '20');
  assert.equal(cycle.observed, 1);
  assert.equal(cycle.failure, null);
});

test('through runConnectionCycle: a stale session reads RECONNECT_REQUIRED, never throws', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async connectFromSession() { throw new TelegramAuthError(); } }) });
  const cycle = await runConnectionCycle(adapter, { organizationId: 'o', userId: 'u', cursor: '5', secret: 'stale' }, NOW);
  assert.equal(cycle.state, 'RECONNECT_REQUIRED');
  assert.equal(cycle.cursor, '5'); // preserved
  assert.equal(cycle.failure, 'AUTH');
});

test('through runConnectionCycle: a transient fetch error reads FAILED, cursor preserved', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchSince() { throw new Error('network blip'); } }) });
  const cycle = await runConnectionCycle(adapter, { organizationId: 'o', userId: 'u', cursor: '9', secret: 'session-string' }, NOW);
  assert.equal(cycle.state, 'FAILED');
  assert.equal(cycle.cursor, '9');
  assert.equal(cycle.failure, 'TRANSIENT');
});

test('disconnect closes the client', async () => {
  let closed = false;
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async close() { closed = true; } }) });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  await adapter.disconnect(session);
  assert.equal(closed, true);
});
