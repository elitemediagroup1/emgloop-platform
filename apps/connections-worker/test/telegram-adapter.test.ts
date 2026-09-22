// The Telegram adapter's policy, with a fake MTProto client and the real runConnectionCycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runConnectionCycle } from '@emgloop/database';
import { TelegramAdapter, TelegramAuthError, type TelegramClientHandle, type TelegramClientPort } from '../src/telegram/telegram-adapter';
import type { TelegramMessageFacts } from '../src/telegram/content-free-mapping';
import type { TelegramContentMessage } from '../src/telegram/telegram-content';

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
    async fetchHistory() { return []; },
    async fetchContentSince() { return []; },
    async fetchDialogWindow() { return []; },
    async fetchHistoricalDialogs() { return { dialogs: [], nextCursor: null, reachedEnd: true }; },
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

// --- Conversation label: Telegram's own, minimized, best-effort, never invented -------------------

const content = (id: string, over: Partial<TelegramContentMessage> = {}): TelegramContentMessage => ({
  messageId: id, chatId: 'c1', senderId: 'u2', out: false, dateSeconds: Math.floor(NOW.getTime() / 1000), text: `hello ${id}`, ...over,
});
const WINDOW_REQUEST = { chatId: 'c1', floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000 };

test('fetchConversationWindow carries Telegram\'s description of the dialog into the window, minimized', async () => {
  const adapter = new TelegramAdapter({
    conversationSecret: SECRET,
    port: port({
      async fetchDialogWindow() { return [content('2'), content('1')]; },
      async describeDialog() { return { label: '  @Dana   Reyes ', kind: 'PRIVATE' }; },
    }),
  });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const { window } = await adapter.fetchConversationWindow(session, WINDOW_REQUEST, NOW);
  assert.deepEqual(window.conversation, { label: 'Dana Reyes', kind: 'PRIVATE' });
  assert.equal(window.messages.length, 2);
  assert.ok(!JSON.stringify(window).includes('c1') && !JSON.stringify(window).includes('u2'), 'no raw ids in the window');
});

test('a client without describeDialog, or one that fails, yields NO label -- the review proceeds and nothing is invented', async () => {
  const without = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchDialogWindow() { return [content('1')]; } }) });
  const s1 = await without.resume('s', { organizationId: 'o', userId: 'u' });
  const r1 = await without.fetchConversationWindow(s1, WINDOW_REQUEST, NOW);
  assert.deepEqual(r1.window.conversation, { label: null, kind: null });
  assert.equal(r1.window.messages.length, 1, 'the window is still read');

  const failing = new TelegramAdapter({
    conversationSecret: SECRET,
    port: port({ async fetchDialogWindow() { return [content('1')]; }, async describeDialog() { throw new Error('entity lookup failed'); } }),
  });
  const s2 = await failing.resume('s', { organizationId: 'o', userId: 'u' });
  const r2 = await failing.fetchConversationWindow(s2, WINDOW_REQUEST, NOW);
  assert.deepEqual(r2.window.conversation, { label: null, kind: null }, 'a failed lookup is no label, never an error and never a guess');
  assert.equal(r2.window.messages.length, 1);
});

test('observeHistoricalConversations carries each dialog\'s description into its window the same way', async () => {
  const adapter = new TelegramAdapter({
    conversationSecret: SECRET,
    port: port({
      async fetchHistoricalDialogs() {
        return {
          dialogs: [
            { chatId: 'c1', messages: [content('1')], description: { label: 'Acme Roofing Crew', kind: 'GROUP' } },
            { chatId: 'c9', messages: [content('5', { chatId: 'c9' })] },
          ],
          nextCursor: 'next',
          reachedEnd: true,
        };
      },
    }),
  });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const page = await adapter.observeHistoricalConversations(session, { cursor: null, floorAt: new Date(0), maxConversations: 10, maxWindowMessages: 40, tokenBudget: 1_000_000 }, NOW);
  assert.deepEqual(page.conversations.map((w) => w.conversation), [{ label: 'Acme Roofing Crew', kind: 'GROUP' }, { label: null, kind: null }]);
});

// --- Historical baseline: observeHistory over fetchHistory ---------------------------------------

import { TelegramFloodWaitError } from '../src/telegram/telegram-adapter';

const FLOOR = new Date('2026-06-22T12:00:00Z'); // ~90 days before NOW
const daysAgoSecs = (n: number) => Math.floor((NOW.getTime() - n * 24 * 60 * 60 * 1000) / 1000);
const hist = (id: string, daysAgo: number): TelegramMessageFacts => ({
  messageId: id, chatId: 'c1', senderId: 'u2', participantIds: ['self', 'u2'], out: false, dateSeconds: daysAgoSecs(daysAgo), hadText: true,
});

test('observeHistory maps a backward page to content-free events, offset = the lowest id, oldest reached', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchHistory() { return [hist('100', 3), hist('90', 20)]; } }) });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const result = await adapter.observeHistory(session, { checkpointCursor: '200', windowFloorAt: FLOOR, pageSize: 2 }, NOW);
  assert.equal(result.events.length, 2);
  assert.equal(result.nextCursor, '90'); // lowest id -> strictly backward from 200
  assert.equal(result.reachedFloor, false); // a full page: more may remain
  assert.ok(result.oldestReachedAt && new Date(result.oldestReachedAt).getTime() === daysAgoSecs(20) * 1000);
  for (const e of result.events) assert.ok(!JSON.stringify(e).includes('c1') && !JSON.stringify(e).includes('u2'), 'no raw ids');
});

test('observeHistory enforces the floor and backward monotonicity, and a short page means the floor is reached', async () => {
  // The client returned a message below the floor and one at/above the offset; both are dropped.
  const belowFloor = hist('40', 200);
  const atOffset = { ...hist('300', 1) }; // id >= beforeId(200)? 300 >= 200 -> dropped
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchHistory() { return [hist('150', 10), belowFloor, atOffset]; } }) });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const result = await adapter.observeHistory(session, { checkpointCursor: '200', windowFloorAt: FLOOR, pageSize: 5 }, NOW);
  assert.equal(result.events.length, 1); // only id 150, within window and below the offset
  assert.equal(result.nextCursor, '150');
  assert.equal(result.reachedFloor, true); // 1 < pageSize(5): the floor (or end of history) is reached
});

test('observeHistory holds on FLOOD_WAIT: no events, offset unchanged, wait reported -- never throws', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchHistory() { throw new TelegramFloodWaitError(30); } }) });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const result = await adapter.observeHistory(session, { checkpointCursor: '77', windowFloorAt: FLOOR, pageSize: 3 }, NOW);
  assert.deepEqual({ events: result.events.length, nextCursor: result.nextCursor, reachedFloor: result.reachedFloor, floodWaitSeconds: result.floodWaitSeconds }, { events: 0, nextCursor: '77', reachedFloor: false, floodWaitSeconds: 30 });
});

test('observeHistory on an empty page reaches the floor and holds the offset', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: SECRET, port: port({ async fetchHistory() { return []; } }) });
  const session = await adapter.resume('s', { organizationId: 'o', userId: 'u' });
  const result = await adapter.observeHistory(session, { checkpointCursor: '55', windowFloorAt: FLOOR, pageSize: 3 }, NOW);
  assert.equal(result.events.length, 0);
  assert.equal(result.reachedFloor, true);
  assert.equal(result.nextCursor, '55'); // nothing older: held
});
