// The Telegram content-free mapping is the security boundary: only metadata leaves it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { telegramMessageToConversationEvent, telegramCursorAfter, type TelegramMessageFacts } from '../src/telegram/content-free-mapping';
import { CONVERSATION_EVENT_KEYS } from '@emgloop/shared';

const SECRET = 'test-conversation-secret';
const OBSERVED = new Date('2026-09-20T12:00:00Z');
const key = (ns: 'conversation' | 'participant', id: string, secret = SECRET) => createHmac('sha256', secret).update(`${ns}:${id}`).digest('hex');

const facts = (over: Partial<TelegramMessageFacts> = {}): TelegramMessageFacts => ({
  messageId: '100',
  chatId: 'chat-7',
  senderId: 'user-42',
  participantIds: ['self-1', 'user-42'],
  out: false,
  dateSeconds: Math.floor(new Date('2026-09-20T11:59:00Z').getTime() / 1000),
  hadText: true,
  ...over,
});

test('the event carries only metadata -- keyed ids, direction, timestamps, hadText', () => {
  const event = telegramMessageToConversationEvent(facts(), { secret: SECRET, observedAt: OBSERVED, cursor: null });
  // Exactly the allowlisted keys, nothing more.
  assert.deepEqual([...Object.keys(event)].sort(), [...CONVERSATION_EVENT_KEYS].sort());
  // Ids are one-way HMACs, never the raw values.
  assert.equal(event.conversationKey, key('conversation', 'chat-7'));
  assert.equal(event.senderKey, key('participant', 'user-42'));
  assert.ok(!JSON.stringify(event).includes('chat-7'), 'raw chat id must not appear');
  assert.ok(!JSON.stringify(event).includes('user-42'), 'raw sender id must not appear');
  // Metadata is faithful.
  assert.equal(event.provider, 'TELEGRAM');
  assert.equal(event.direction, 'INBOUND');
  assert.equal(event.hadText, true);
  assert.equal(event.occurredAt, '2026-09-20T11:59:00.000Z');
  assert.equal(event.observedAt, OBSERVED.toISOString());
  assert.equal(event.providerEventId, `${key('conversation', 'chat-7')}:100`);
});

test('the same id and secret always key the same; a different secret keys differently', () => {
  const a = telegramMessageToConversationEvent(facts(), { secret: SECRET, observedAt: OBSERVED, cursor: null });
  const b = telegramMessageToConversationEvent(facts(), { secret: SECRET, observedAt: OBSERVED, cursor: null });
  const c = telegramMessageToConversationEvent(facts(), { secret: 'other-secret', observedAt: OBSERVED, cursor: null });
  assert.equal(a.conversationKey, b.conversationKey); // stable
  assert.notEqual(a.conversationKey, c.conversationKey); // secret-bound
});

test('direction follows the out flag; participants are deduped and keyed', () => {
  const outbound = telegramMessageToConversationEvent(facts({ out: true, senderId: 'self-1', participantIds: ['self-1', 'self-1', 'user-42'] }), { secret: SECRET, observedAt: OBSERVED, cursor: null });
  assert.equal(outbound.direction, 'OUTBOUND');
  assert.equal(outbound.senderKey, key('participant', 'self-1'));
  assert.deepEqual([...outbound.participantKeys].sort(), [key('participant', 'self-1'), key('participant', 'user-42')].sort());
});

test('a missing sender is null, not fabricated; hadText false is carried', () => {
  const event = telegramMessageToConversationEvent(facts({ senderId: null, hadText: false }), { secret: SECRET, observedAt: OBSERVED, cursor: null });
  assert.equal(event.senderKey, null);
  assert.equal(event.hadText, false);
});

test('the cursor advances to the highest message id, and holds on an empty batch', () => {
  assert.equal(telegramCursorAfter('100', [facts({ messageId: '105' }), facts({ messageId: '103' })]), '105');
  assert.equal(telegramCursorAfter('100', []), '100');
  assert.equal(telegramCursorAfter(null, [facts({ messageId: '7' })]), '7');
  assert.equal(telegramCursorAfter('200', [facts({ messageId: '150' })]), '200'); // never goes backwards
});
